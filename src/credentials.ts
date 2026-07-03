import { execFileSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import {
    readAllClaudeAccounts,
    refreshAccount,
    writeBackCredentials,
    writePiAuthCredentials,
    type ClaudeAccount,
    type ClaudeCredentials,
} from "./auth-json.ts"
import { log } from "./logger.ts"
import { getAuthJsonPath, getPiAgentDir } from "./paths.ts"

export type { ClaudeCredentials } from "./auth-json.ts"
export type { ClaudeAccount } from "./auth-json.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

const accountCacheMap = new Map<
    string,
    { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
    allAccounts = accounts
}

export function getAccounts(): ClaudeAccount[] {
    return allAccounts
}

export function setActiveAccountSource(source: string): void {
    const previous = activeAccountSource
    activeAccountSource = source
    accountCacheMap.delete(source)
    if (previous && previous !== source) {
        log("account_switch", { newSource: source, previousSource: previous })
    }
}

export function refreshAccountsList(): ClaudeAccount[] {
    allAccounts = readAllClaudeAccounts()
    return allAccounts
}

function getActiveAccount(): ClaudeAccount | null {
    if (allAccounts.length === 0) return null
    if (activeAccountSource) {
        const found = allAccounts.find((a) => a.source === activeAccountSource)
        if (found) return found
    }
    return allAccounts[0]
}

function getAccountStateFile(): string {
    return join(getPiAgentDir(), "claude-account-source.txt")
}

export function loadPersistedAccountSource(): string | null {
    try {
        const path = getAccountStateFile()
        if (existsSync(path)) {
            return readFileSync(path, "utf-8").trim() || null
        }
    } catch {
        // ignore
    }
    return null
}

export function saveAccountSource(source: string): void {
    try {
        const path = getAccountStateFile()
        const dir = dirname(path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(path, source, "utf-8")
    } catch {
        // Non-fatal
    }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
    const authPath = getAuthJsonPath()
    try {
        const ok = writePiAuthCredentials(creds)
        if (!ok) throw new Error("atomic auth.json write returned false")
        log("sync_auth_json", { path: authPath, success: true })
    } catch (err) {
        log("sync_auth_json", {
            path: authPath,
            success: false,
            error: err instanceof Error ? err.message : String(err),
        })
        throw err
    }
}

export const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Parse a raw OAuth token response into ClaudeCredentials.
 * Returns null if the response is missing a valid access_token.
 * Defaults expires_in to 36000s (10h) to match observed Claude token lifetime.
 */
export function parseOAuthResponse(
    raw: string,
    currentRefreshToken: string,
    now: number = Date.now(),
): ClaudeCredentials | null {
    let data: {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        error?: string
    }
    try {
        data = JSON.parse(raw)
    } catch {
        return null
    }

    if (!data.access_token) return null

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? currentRefreshToken,
        expiresAt: now + (data.expires_in ?? 36_000) * 1000,
    }
}

export function refreshViaOAuth(
    refreshToken: string,
): ClaudeCredentials | null {
    // Use a Node subprocess to perform the HTTP request synchronously.
    // The refresh token is passed via stdin to avoid exposure in process args.
    const script = `
    process.stdin.resume();
    let input = '';
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: '${OAUTH_CLIENT_ID}',
        refresh_token: input.trim()
      });
      fetch('${OAUTH_TOKEN_URL}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(d => { process.stdout.write(JSON.stringify(d)); })
      .catch(e => { process.stdout.write(JSON.stringify({ error: String(e) })); process.exit(1); });
    });
  `

    try {
        log("refresh_started", { source: "oauth" })
        const result = execFileSync(process.execPath, ["-e", script], {
            input: refreshToken,
            timeout: 15_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        })

        const creds = parseOAuthResponse(result, refreshToken)
        if (!creds) {
            log("refresh_failed", {
                source: "oauth",
                error: "no access_token in response",
            })
            return null
        }

        log("refresh_success", { source: "oauth" })
        return creds
    } catch (err) {
        log("refresh_failed", {
            source: "oauth",
            error: err instanceof Error ? err.message : String(err),
        })
        return null
    }
}

export function refreshIfNeeded(
    account?: ClaudeAccount,
): ClaudeCredentials | null {
    const target = account ?? getActiveAccount()
    if (!target) return null

    const latest = refreshAccount(target.source)
    if (latest) target.credentials = latest

    const creds = target.credentials
    if (creds.expiresAt > Date.now() + 60_000) return creds

    log("refresh_needed", {
        source: target.source,
        expiresAt: creds.expiresAt,
        expiresIn: creds.expiresAt - Date.now(),
    })

    // Try direct OAuth refresh first (zero LLM tokens consumed)
    if (creds.refreshToken) {
        const oauthCreds = refreshViaOAuth(creds.refreshToken)
        if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
            target.credentials = oauthCreds
            writeBackCredentials(target.source, oauthCreds)
            return oauthCreds
        }
    }

    log("refresh_exhausted", {
        source: target.source,
        hadCredentials: true,
        expiresAt: target.credentials.expiresAt,
    })
    return null
}

/**
 * Force a refresh of the active account's credentials and write the rotated
 * tokens back to storage. Used by pi's `oauth.refreshToken` hook, which is
 * invoked when the token stored in auth.json is at/near expiry.
 *
 * Re-reads auth.json first in case another pi process already rotated the
 * token, then falls back to a direct OAuth refresh.
 */
export function forceRefreshActiveCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    accountCacheMap.delete(account.source)

    // auth.json may already hold a fresher token from another pi process.
    const onDisk = refreshAccount(account.source)
    if (onDisk) account.credentials = onDisk
    if (account.credentials.expiresAt > Date.now() + 60_000) {
        accountCacheMap.set(account.source, {
            creds: account.credentials,
            cachedAt: Date.now(),
        })
        return account.credentials
    }

    const fresh = refreshIfNeeded(account)
    if (fresh) {
        accountCacheMap.set(account.source, {
            creds: fresh,
            cachedAt: Date.now(),
        })
    }
    return fresh
}

/**
 * Returns the active account's credentials for auth.json sync purposes.
 * Unlike getCachedCredentials(), this does NOT trigger a refresh.
 * Returns null if no account or credentials are expired.
 */
export function getCredentialsForSync(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const creds = account.credentials
    if (creds.expiresAt > Date.now() + 60_000) {
        return creds
    }

    // Near expiry -- don't refresh here, let the per-request path handle it.
    return null
}

export function getCachedCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const now = Date.now()
    const cached = accountCacheMap.get(account.source)
    if (
        cached &&
        now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
        cached.creds.expiresAt > now + 60_000
    ) {
        log("cache_hit", {
            source: account.source,
            ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
        })
        return cached.creds
    }

    log("cache_miss", {
        source: account.source,
        reason: cached ? "stale or expiring" : "empty",
    })

    const fresh = refreshIfNeeded(account)
    if (!fresh) {
        log("credentials_unavailable", { source: account.source })
        accountCacheMap.delete(account.source)
        return null
    }

    accountCacheMap.set(account.source, { creds: fresh, cachedAt: now })
    return fresh
}
