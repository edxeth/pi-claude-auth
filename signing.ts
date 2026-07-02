import { createHash } from "node:crypto"

// Same salt CortexKit exposes as CCH_SALT. This local extension keeps the
// original pi-claude-auth cch algorithm because it runs in pi's
// before_provider_request hook and does not own the final JSON serialization.
// A CortexKit-style full-body xxHash signature would be more fragile here
// unless this extension also replaced the whole Anthropic stream transport.
const BILLING_SALT = "59cf53e54c78"

// Fallback Claude Code CLI version used when startup version discovery fails.
// The active version is normally resolved from @anthropic-ai/claude-code's npm
// metadata before provider registration. The billing header's cc_version semver
// must match the user-agent version for Anthropic's subscription-billing
// validation to route the request to the Claude Pro/Max plan instead of
// pay-as-you-go / extra usage.
// Overridable via ANTHROPIC_CLI_VERSION.
export const FALLBACK_CC_VERSION = "2.1.198"

let activeCliVersion = FALLBACK_CC_VERSION

export function setDiscoveredCliVersion(version: string): void {
    activeCliVersion = version
}

// Billing entrypoint, mirrored in the user-agent's `(external, <entrypoint>)`
// suffix. `cli` is the Claude Code CLI route we emulate for pi.
// Overridable via CLAUDE_CODE_ENTRYPOINT.
export const CC_ENTRYPOINT = "cli"

/** Resolve the Claude Code CLI version (env override wins). */
export function getCliVersion(): string {
    return process.env.ANTHROPIC_CLI_VERSION ?? activeCliVersion
}

/** Resolve the billing entrypoint (env override wins). */
export function getEntrypoint(): string {
    return process.env.CLAUDE_CODE_ENTRYPOINT ?? CC_ENTRYPOINT
}

/**
 * Build the Claude Code user-agent string. pi sends a bare
 * `claude-cli/<version>`; Anthropic's plan-billing validation expects the full
 * `claude-cli/<version> (external, <entrypoint>)` form, so we override it.
 */
export function buildUserAgent(): string {
    return (
        process.env.ANTHROPIC_USER_AGENT ??
        `claude-cli/${getCliVersion()} (external, ${getEntrypoint()})`
    )
}

interface Message {
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
}

/**
 * Extract text from the first user message's first text block.
 * Mirrors Claude Code's billing-header input selection: find the first message
 * with role "user", then return the text of its first text content block.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
    const userMsg = messages.find((m) => m.role === "user")
    if (!userMsg) return ""
    const content = userMsg.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        const textBlock = content.find((b) => b.type === "text")
        if (textBlock && textBlock.type === "text" && textBlock.text) {
            return textBlock.text
        }
    }
    return ""
}

/**
 * Compute cch using the original pi-claude-auth hook-safe scheme.
 *
 * CortexKit signs the final serialized request body with xxHash because its
 * custom stream transport owns serialization. This extension only mutates pi's
 * provider payload before the built-in Anthropic transport serializes it, so we
 * keep the already-validated hook-safe cch behavior.
 */
export function computeCch(messageText: string): string {
    return createHash("sha256").update(messageText).digest("hex").slice(0, 5)
}

/**
 * Compute the 3-char cc_version suffix.
 *
 * Current Claude Code does not use a fixed per-release build hash here. In
 * @anthropic-ai/claude-code 2.1.198, the suffix is:
 * sha256("59cf53e54c78" + chars[4,7,20] of first user text + semver).slice(0, 3).
 * Different prompts can therefore produce different suffixes for the same
 * Claude Code semver, and different semvers produce different suffixes for the
 * same prompt.
 */
export function computeVersionSuffix(
    messageText: string,
    version: string,
): string {
    const sampled = [4, 7, 20]
        .map((i) => (i < messageText.length ? messageText[i] : "0"))
        .join("")
    const input = `${BILLING_SALT}${sampled}${version}`
    return createHash("sha256").update(input).digest("hex").slice(0, 3)
}

/**
 * Build the complete billing header string for insertion into system[0].
 * Format: x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;
 */
export function buildBillingHeaderValue(
    messages: Message[],
    version: string,
    entrypoint: string,
): string {
    const text = extractFirstUserMessageText(messages)
    const suffix = computeVersionSuffix(text, version)
    const cch = computeCch(text)
    return (
        `x-anthropic-billing-header: ` +
        `cc_version=${version}.${suffix}; ` +
        `cc_entrypoint=${entrypoint}; ` +
        `cch=${cch};`
    )
}
