import { createHash } from "node:crypto";
import { CCH_PLACEHOLDER } from "./cch.ts";
import { TURN_ORIGIN, type TurnStamp } from "./turn.ts";

// Salt used in Claude Code's cc_version prompt fingerprint:
// sha256("59cf53e54c78" + chars[4,7,20] of first user text + semver)[:3].
// The `cch` body checksum is separate: the billing header carries a
// `cch=00000` placeholder (CCH_PLACEHOLDER) that cch.ts resolves
// post-serialization with a seeded XXH64 digest of the normalized body.
const BILLING_SALT = "59cf53e54c78";

// Fallback Claude Code CLI version used when startup version discovery fails.
// The active version is normally resolved from @anthropic-ai/claude-code's npm
// metadata before provider registration. The billing header's cc_version semver
// must match the user-agent version for Anthropic's subscription-billing
// validation to route the request to the Claude Pro/Max plan instead of
// pay-as-you-go / extra usage.
// Overridable via ANTHROPIC_CLI_VERSION.
export const FALLBACK_CC_VERSION = "2.1.295";

let activeCliVersion = FALLBACK_CC_VERSION;

export function setDiscoveredCliVersion(version: string): void {
	activeCliVersion = version;
}

// Billing entrypoint, mirrored in the user-agent's `(external, <entrypoint>)`
// suffix. `cli` is the Claude Code CLI route we emulate for pi.
// Overridable via CLAUDE_CODE_ENTRYPOINT.
const CC_ENTRYPOINT = "sdk-cli";

/** Resolve the Claude Code CLI version (validated env override wins). */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export function getCliVersion(): string {
	const envVersion = process.env.ANTHROPIC_CLI_VERSION;
	return envVersion && SEMVER_RE.test(envVersion)
		? envVersion
		: activeCliVersion;
}

/** Resolve the billing entrypoint (env override wins). */
export function getEntrypoint(): string {
	return process.env.CLAUDE_CODE_ENTRYPOINT ?? CC_ENTRYPOINT;
}

/**
 * Build the Claude Code user-agent string. pi's built-in Anthropic provider
 * already sends a bare `claude-cli/<version>` for OAuth tokens; Anthropic's
 * plan-billing validation expects the full
 * `claude-cli/<version> (external, <entrypoint>)` form, so the wrapped provider
 * overrides it via request headers.
 */
export function buildUserAgent(): string {
	return (
		process.env.ANTHROPIC_USER_AGENT ??
		`claude-cli/${getCliVersion()} (external, ${getEntrypoint()})`
	);
}

interface Message {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

/**
 * Extract the text of the first user message, joining every text block. Mirrors
 * Claude Code's billing-header prompt selection: first user message, then all of
 * its text blocks concatenated. Used only for the cc_version fingerprint.
 */
function extractFirstUserMessageText(messages: Message[]): string {
	const userMsg = messages.find((m) => m.role === "user");
	if (!userMsg) return "";
	const content = userMsg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
	}
	return "";
}

/**
 * Compute the 3-char cc_version suffix.
 *
 * sha256("59cf53e54c78" + chars[4,7,20] of first user text + semver).slice(0,3).
 * Different prompts produce different suffixes for the same Claude Code semver,
 * and different semvers produce different suffixes for the same prompt.
 */
function computeVersionSuffix(messageText: string, version: string): string {
	const sampled = [4, 7, 20]
		.map((i) => (i < messageText.length ? messageText[i] : "0"))
		.join("");
	const input = `${BILLING_SALT}${sampled}${version}`;
	return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Build the complete billing header string for insertion into system[0].
 * Format (field order and turn semantics verified against real 2.1.295
 * first-party traffic):
 * x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=00000;
 *   cc_prompt_id=<uuid>; cc_turn_origin=sdk; cc_prompt_index=N; cc_turn_index=N;
 *
 * The `cch` is written as a placeholder. The wrapped transport (cch.ts) owns the
 * final serialized body and replaces it with the real 5-hex XXH64 digest of the
 * normalized body once the SDK has serialized it — so the digest is computed
 * over the exact bytes that go on the wire, not a pre-serialization guess.
 */
export function buildBillingHeaderValue(
	messages: Message[],
	version: string,
	entrypoint: string,
	turn: TurnStamp,
): string {
	const text = extractFirstUserMessageText(messages);
	const suffix = computeVersionSuffix(text, version);
	return (
		`x-anthropic-billing-header: ` +
		`cc_version=${version}.${suffix}; ` +
		`cc_entrypoint=${entrypoint}; ` +
		`${CCH_PLACEHOLDER}; ` +
		`cc_prompt_id=${turn.promptId}; ` +
		`cc_turn_origin=${TURN_ORIGIN}; ` +
		`cc_prompt_index=${turn.promptIndex}; ` +
		`cc_turn_index=${turn.turnIndex};`
	);
}
