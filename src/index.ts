import type {
    ExtensionAPI,
    ExtensionContext,
    OAuthCredential,
    ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import {
    forceRefreshActiveCredentials,
    getCachedCredentials,
    getCredentialsForSync,
    initAccounts,
    loadPersistedAccountSource,
    refreshAccountsList,
    saveAccountSource,
    setActiveAccountSource,
    syncAuthJson,
    type ClaudeCredentials,
} from "./credentials.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./auth-json.ts"
import {
    initializeClaudeCodeVersion,
    type ClaudeCodeVersionResolution,
    type ClaudeCodeVersionStatus,
} from "./claude-version.ts"
import { initLogger, log } from "./logger.ts"
import { buildUserAgent, FALLBACK_CC_VERSION } from "./signing.ts"
import { injectBillingHeader } from "./transforms.ts"
import { registerRetryAfterRefusal } from "./retry-refusal.ts"
import { Container, matchesKey, Spacer, Text } from "@earendil-works/pi-tui"

export {
    getCachedCredentials,
    syncAuthJson,
    refreshAccountsList,
    type ClaudeCredentials,
} from "./credentials.ts"
export { readAllClaudeAccounts, type ClaudeAccount } from "./auth-json.ts"

// Derive the OAuth types from the official ProviderConfig so the extension
// stays fully typed without importing @earendil-works/pi-ai directly.
type OAuthConfig = NonNullable<ProviderConfig["oauth"]>
type OAuthCreds = Awaited<ReturnType<OAuthConfig["refreshToken"]>>
type LoginCallbacks = Parameters<OAuthConfig["login"]>[0]

const PROVIDER_ID = "anthropic"
const PROVIDER_LABEL = "Claude Code (subscription)"
const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

function toOAuthCreds(creds: ClaudeCredentials): OAuthCreds {
    return {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }
}

/**
 * Inject the active Claude Code credentials into pi's in-memory AuthStorage.
 *
 * pi builds its AuthStorage at startup, before extensions load, so writing
 * auth.json on disk alone is not picked up for the current session (and an
 * existing ANTHROPIC_API_KEY env var would shadow it). Setting the credential
 * directly on the live AuthStorage makes pi use the Claude Code OAuth token
 * immediately — and AuthStorage persists it to auth.json too.
 */
function applyCredential(ctx: ExtensionContext): boolean {
    const creds = getCachedCredentials()
    if (!creds) return false

    const credential: OAuthCredential = {
        type: "oauth",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }

    try {
        ctx.modelRegistry.authStorage.set(PROVIDER_ID, credential)
        log("credential_applied", { provider: PROVIDER_ID })
        return true
    } catch (err) {
        log("credential_apply_error", {
            error: err instanceof Error ? err.message : String(err),
        })
        return false
    }
}

function formatRelativeDate(ms: number): string {
    const diff = Date.now() - ms
    if (diff < 60_000) return "just now"
    const mins = Math.floor(diff / 60_000)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return new Date(ms).toISOString().slice(0, 10)
}

function buildVersionAlert(
    status: ClaudeCodeVersionStatus,
    version: string,
    cachedAt?: number,
): { kind: "error" | "warning"; title: string; message: string } | null {
    if (status === "fallback-after-fetch-failed") {
        return {
            kind: "error",
            title: "pi-claude-auth: version fetch failed",
            message: `No cached version — using fallback ${FALLBACK_CC_VERSION} which may be stale; requests may be rejected or billed as extra usage. Set ANTHROPIC_CLI_VERSION or restore network and restart pi.`,
        }
    }
    if (status === "cache-after-fetch-failed") {
        const when = cachedAt ? formatRelativeDate(cachedAt) : "cache"
        return {
            kind: "warning",
            title: "pi-claude-auth: version fetch failed",
            message: `Using cached ${version} (from ${when}); requests should still work but are not safe.`,
        }
    }
    return null
}

/**
 * Focused-component alert overlay. The TUI input loop routes keys to the focused
 * component's `handleInput`; `Text` has none, so a plain Text silently drops
 * keys and the alert can never be dismissed. This Container subclass dismisses
 * on Enter or Escape and otherwise consumes the key.
 */
class VersionAlertComponent extends Container {
    private readonly dismiss: () => void
    constructor(content: string, dismiss: () => void) {
        super()
        this.dismiss = dismiss
        this.addChild(new Text(content, 0, 0))
    }
    handleInput(data: string): void {
        if (matchesKey(data, "return") || matchesKey(data, "escape")) {
            this.dismiss()
        }
    }
}

/**
 * Show a red/yellow version-discovery alert via the TUI custom widget. Only live
 * fetch failures are surfaced; PI_OFFLINE resolutions are treated as
 * intentional and stay silent.
 */
async function showVersionAlert(
    ctx: ExtensionContext,
    res: ClaudeCodeVersionResolution,
): Promise<void> {
    if (ctx.mode !== "tui") return
    const alert = buildVersionAlert(res.status, res.version, res.cachedAt)
    if (!alert) return
    const color = alert.kind === "error" ? "error" : "warning"
    await ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) => {
        const content = [
            "",
            theme.bold(theme.fg(color, alert.title)),
            "",
            theme.fg(color, alert.message),
            "",
            theme.fg("dim", "  Enter / Esc to dismiss"),
        ].join("\n")
        return new VersionAlertComponent(content, () => done(true))
    })
}

/**
 * pi-claude-auth extension.
 *
 * Reads your existing Anthropic OAuth credentials from
 * `~/.pi/agent/auth.json` and makes pi authenticate as Claude Code with no
 * separate login:
 *
 * - Injects the credentials into pi's live AuthStorage on every session start
 *   (and seeds auth.json) so they take priority over any ANTHROPIC_API_KEY.
 * - Overrides the `anthropic` provider's OAuth lifecycle: refresh goes through
 *   Anthropic's OAuth endpoint and rotated tokens are written back to
 *   `~/.pi/agent/auth.json`.
 * - Overrides the user-agent to the full Claude Code form and injects the
 *   Claude Code billing header, so requests bill against the Claude Pro/Max
 *   subscription plan rather than pay-as-you-go API credits or extra usage.
 *
 * pi's built-in Anthropic provider supplies the remaining Claude Code fidelity
 * (identity prompt, beta flags, tool naming) for OAuth tokens.
 */
const extension = async (pi: ExtensionAPI): Promise<void> => {
    initLogger()
    const versionResolution = await initializeClaudeCodeVersion()

    let accounts: ClaudeAccount[] = []
    try {
        accounts = readAllClaudeAccounts()
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log("extension_init_error", { error })
        console.warn(
            "pi-claude-auth: Failed to read ~/.pi/agent/auth.json Anthropic credentials:",
            error,
        )
        return
    }

    initAccounts(accounts)

    if (accounts.length === 0) {
        log("extension_init_no_accounts", { reason: "no credentials found" })
        console.warn(
            "pi-claude-auth: No Anthropic OAuth credentials found in ~/.pi/agent/auth.json. Restore a valid anthropic OAuth entry first."
        )
        return
    }

    const persistedSource = loadPersistedAccountSource()
    const defaultAccount =
        (persistedSource &&
            accounts.find((a) => a.source === persistedSource)) ||
        accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("extension_init", {
        accountCount: accounts.length,
        sources: accounts.map((a) => a.source),
        activeSource: defaultAccount.source,
    })

    // Seed auth.json so pi uses the Claude Code credentials with zero login.
    const initialCreds = getCachedCredentials()
    if (initialCreds) {
        syncAuthJson(initialCreds)
    } else {
        console.warn(
            "pi-claude-auth: Anthropic credentials in ~/.pi/agent/auth.json are expired and could not be refreshed. Restore a valid refresh token."
        )
    }

    // Keep auth.json synced with current credentials (no refresh triggered).
    const syncTimer = setInterval(() => {
        try {
            const creds = getCredentialsForSync()
            if (creds) syncAuthJson(creds)
        } catch {
            // Non-fatal
        }
    }, SYNC_INTERVAL)
    syncTimer.unref()

    const oauth: OAuthConfig = {
        name: PROVIDER_LABEL,

        async login(callbacks: LoginCallbacks): Promise<OAuthCreds> {
            const latestAccounts = refreshAccountsList()
            if (latestAccounts.length === 0) {
                throw new Error(
                    "No Anthropic OAuth credentials found in ~/.pi/agent/auth.json.",
                )
            }

            const currentSource =
                loadPersistedAccountSource() ?? defaultAccount.source
            let chosen =
                latestAccounts.find((a) => a.source === currentSource) ??
                latestAccounts[0]

            // This local fork intentionally uses only ~/.pi/agent/auth.json, so
            // there is normally a single account. Keep this branch harmless if
            // that ever changes.
            if (latestAccounts.length > 1 && callbacks.onSelect) {
                const picked = await callbacks.onSelect({
                    message: "Select which Claude Code account to use:",
                    options: latestAccounts.map((a) => ({
                        id: a.source,
                        label:
                            a.source === currentSource
                                ? `${a.label} (active)`
                                : a.label,
                    })),
                })
                if (picked) {
                    chosen =
                        latestAccounts.find((a) => a.source === picked) ??
                        chosen
                }
            }

            setActiveAccountSource(chosen.source)
            saveAccountSource(chosen.source)

            const creds = getCachedCredentials() ?? chosen.credentials
            syncAuthJson(creds)
            log("login", { source: chosen.source, label: chosen.label })
            return toOAuthCreds(creds)
        },

        async refreshToken(credentials: OAuthCreds): Promise<OAuthCreds> {
            const fresh = forceRefreshActiveCredentials()
            if (fresh) {
                syncAuthJson(fresh)
                return toOAuthCreds(fresh)
            }
            log("refresh_token_fallback", {
                reason: "force refresh returned null",
            })
            // Return the supplied credentials unchanged so pi can surface a
            // clear auth error rather than crashing.
            return credentials
        },

        getApiKey(credentials: OAuthCreds): string {
            const latest = getCachedCredentials()
            return latest?.accessToken ?? credentials.access
        },
    }

    // Override the user-agent to the full Claude Code form
    // (`claude-cli/<version> (external, <entrypoint>)`). pi sends a bare
    // `claude-cli/<version>`, which Anthropic's plan-billing validation does
    // not accept — without this the request bills against extra usage instead
    // of the subscription plan.
    pi.registerProvider(PROVIDER_ID, {
        oauth,
        headers: { "user-agent": buildUserAgent() },
    })

    registerRetryAfterRefusal(pi)

    // Inject the live credential into pi's AuthStorage on every session start.
    // This is what makes pi actually use the Claude Code OAuth token (and
    // therefore enter Claude Code stealth mode) instead of falling back to an
    // ANTHROPIC_API_KEY env var or reporting "No API key found".
    pi.on("session_start", async (event, ctx) => {
        applyCredential(ctx)
        if (event.reason === "startup") {
            await showVersionAlert(ctx, versionResolution).catch(() => {})
        }
    })

    // Inject the Claude Code billing header so requests bill against the
    // Claude Pro/Max subscription rather than pay-as-you-go API credits.
    // pi's built-in Anthropic provider supplies the identity, betas, and
    // user-agent for OAuth tokens but not this header.
    pi.on("before_provider_request", (event) => {
        try {
            const updated = injectBillingHeader(event.payload)
            if (updated) {
                log("billing_header_injected", {})
                return updated
            }
        } catch (err) {
            log("billing_header_error", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
        return undefined
    })

    log("provider_registered", { provider: PROVIDER_ID })
}

export const ClaudeAuthExtension = extension
export default extension
