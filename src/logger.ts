import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Writable } from "node:stream"
import { getPiAgentDir } from "./paths.ts"

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{10,}/

type LogMode = "disabled" | "file" | "stream"

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null

function getDefaultLogPath(): string {
    return join(getPiAgentDir(), "pi-claude-auth-debug.log")
}

/**
 * Initialize the diagnostic logger.
 *
 * Logging is opt-in via PI_CLAUDE_AUTH_DEBUG: set to `1` for the default log
 * path, or to a custom file path. All secrets are redacted before writing, so
 * the log file is safe to share when reporting issues.
 */
export function initLogger(options?: { stream?: Writable }): void {
    closeLogger()

    if (options?.stream) {
        mode = "stream"
        logStream = options.stream
        return
    }

    const envVal = process.env.PI_CLAUDE_AUTH_DEBUG
    if (!envVal) {
        mode = "disabled"
        return
    }

    mode = "file"
    logFilePath = envVal === "1" ? getDefaultLogPath() : envVal

    const dir = dirname(logFilePath)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
    writeFileSync(logFilePath, "", "utf-8")
}

export function log(event: string, data?: Record<string, unknown>): void {
    if (mode === "disabled") return

    const entry = {
        ts: new Date().toISOString(),
        event,
        ...redact(data ?? {}),
    }
    const line = JSON.stringify(entry) + "\n"

    if (mode === "file" && logFilePath) {
        appendFileSync(logFilePath, line, "utf-8")
    } else if (mode === "stream" && logStream) {
        logStream.write(line)
    }
}

export function closeLogger(): void {
    mode = "disabled"
    logFilePath = null
    logStream = null
}

function redactValue(key: string, value: unknown): unknown {
    if (typeof value !== "string") return value

    if (key === "refreshToken" || key === "x-api-key") {
        return "REDACTED"
    }

    if (key === "accessToken") {
        const prefix = value.slice(0, 8)
        return `${prefix}...REDACTED`
    }

    if (JWT_PATTERN.test(value)) {
        return `${value.slice(0, 8)}...REDACTED`
    }

    return value
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
        result[key] = redactValue(key, value)
    }
    return result
}
