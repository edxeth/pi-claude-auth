import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
    initializeClaudeCodeVersion,
    type ClaudeCodeVersionResolution,
    type ClaudeCodeVersionStatus,
} from "./claude-version.ts"
import { initLogger, log } from "./logger.ts"
import { buildUserAgent, FALLBACK_CC_VERSION } from "./signing.ts"
import { injectBillingHeader } from "./transforms.ts"
import { registerRetryAfterRefusal } from "./retry-refusal.ts"
import { Container, matchesKey, Text } from "@earendil-works/pi-tui"

const PROVIDER_ID = "anthropic"

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
 * Pi's built-in `anthropic` provider owns the full OAuth lifecycle (browser
 * login, token refresh, credential storage in `~/.pi/agent/auth.json`) and the
 * Claude Code identity prompt. This extension adds only the pieces pi's
 * provider does not send, so requests bill against the Claude Pro/Max
 * subscription plan instead of pay-as-you-go API credits or "extra usage":
 *
 * - Sets the full Claude Code user-agent (`claude-cli/<version> (external, …)`)
 *   via the provider `headers`, and keeps the version synced to the latest
 *   `@anthropic-ai/claude-code` release.
 * - Injects the `x-anthropic-billing-header` system block on every request and
 *   relocates pi's own system prompt into the first user message (Anthropic
 *   rejects third-party system prompts alongside the Claude Code identity).
 * - Retries Anthropic Fable/Mythos classifier refusals on Opus 4.8.
 *
 * It deliberately does NOT register a custom `oauth` lifecycle: doing so would
 * overwrite pi's built-in `anthropic` OAuth provider and break `/login`. Run
 * `/login anthropic` the usual pi way; pi loads the resulting `auth.json` entry
 * at startup, and its `getApiKey` already prefers that OAuth token over any
 * `ANTHROPIC_API_KEY` env var, so no credential re-injection is needed.
 */
const extension = async (pi: ExtensionAPI): Promise<void> => {
    initLogger()
    const versionResolution = await initializeClaudeCodeVersion()

    // Register only the Claude Code user-agent header. No `oauth` field: pi's
    // built-in anthropic OAuth provider must stay registered so `/login
    // anthropic` keeps doing the real browser flow and writing auth.json.
    pi.registerProvider(PROVIDER_ID, {
        headers: { "user-agent": buildUserAgent() },
    })

    registerRetryAfterRefusal(pi)

    // Surface a degraded-version alert on startup (offline resolutions stay
    // silent). No credential work here: pi already loaded auth.json and prefers
    // the OAuth token over ANTHROPIC_API_KEY.
    pi.on("session_start", async (event, ctx) => {
        if (event.reason === "startup") {
            await showVersionAlert(ctx, versionResolution).catch(() => {})
        }
    })

    // Inject the Claude Code billing header so requests bill against the
    // Claude Pro/Max subscription rather than pay-as-you-go API credits.
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
