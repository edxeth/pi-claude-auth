import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { log } from "./logger.ts"
import { getAuthJsonPath } from "./paths.ts"

export interface ClaudeCredentials {
    accessToken: string
    refreshToken: string
    expiresAt: number
    subscriptionType?: string
}

export interface ClaudeAccount {
    label: string
    source: string
    credentials: ClaudeCredentials
}

const SOURCE = "pi-auth"

function readPiAuthCredentials(): ClaudeCredentials | null {
    try {
        const authPath = getAuthJsonPath()
        const raw = readFileSync(authPath, "utf-8")
        const parsed = JSON.parse(raw) as {
            anthropic?: {
                type?: unknown
                access?: unknown
                refresh?: unknown
                expires?: unknown
            }
        }
        const auth = parsed.anthropic
        if (
            auth?.type !== "oauth" ||
            typeof auth.access !== "string" ||
            typeof auth.refresh !== "string" ||
            typeof auth.expires !== "number"
        ) {
            log("pi_auth_read", { success: false, reason: "invalid_shape" })
            return null
        }
        log("pi_auth_read", { success: true })
        return {
            accessToken: auth.access,
            refreshToken: auth.refresh,
            expiresAt: auth.expires,
        }
    } catch {
        log("pi_auth_read", { success: false, reason: "missing_or_unreadable" })
        return null
    }
}

function writePiAuthCredentials(creds: ClaudeCredentials): boolean {
    try {
        const authPath = getAuthJsonPath()
        let parsed: Record<string, unknown> = {}
        if (existsSync(authPath)) {
            try {
                parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
                    string,
                    unknown
                >
            } catch {
                parsed = {}
            }
        }
        parsed.anthropic = {
            type: "oauth",
            access: creds.accessToken,
            refresh: creds.refreshToken,
            expires: creds.expiresAt,
        }
        const dir = dirname(authPath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
        const tempPath = join(
            dir,
            `.auth.json.tmp-${process.pid}-${Date.now()}`,
        )
        writeFileSync(tempPath, JSON.stringify(parsed, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        })
        if (process.platform !== "win32") chmodSync(tempPath, 0o600)
        renameSync(tempPath, authPath)
        log("pi_auth_write", { success: true })
        return true
    } catch {
        log("pi_auth_write", { success: false })
        return false
    }
}

export function buildAccountLabels(_credsList: ClaudeCredentials[]): string[] {
    return ["Pi auth.json Anthropic"]
}

export function readAllClaudeAccounts(): ClaudeAccount[] {
    const creds = readPiAuthCredentials()
    if (!creds) return []
    return [
        { label: "Pi auth.json Anthropic", source: SOURCE, credentials: creds },
    ]
}

export function writeBackCredentials(
    source: string,
    creds: ClaudeCredentials,
): boolean {
    if (source !== SOURCE) return false
    return writePiAuthCredentials(creds)
}

export function refreshAccount(source: string): ClaudeCredentials | null {
    if (source !== SOURCE) return null
    return readPiAuthCredentials()
}

/** @deprecated Use readAllClaudeAccounts() instead */
export function readClaudeCredentials(): ClaudeCredentials | null {
    return readPiAuthCredentials()
}
