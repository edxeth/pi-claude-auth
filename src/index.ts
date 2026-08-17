import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ClaudeCodeVersionResolution,
	type ClaudeCodeVersionStatus,
	initializeClaudeCodeVersion,
	revalidateClaudeCodeVersion,
} from "./claude-version.ts";
import { initLogger, log } from "./logger.ts";
import { registerRetryAfterRefusal } from "./retry-refusal.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { wrapAnthropicProvider } from "./anthropic-provider.ts";
import { FALLBACK_CC_VERSION } from "./signing.ts";

const PROVIDER_ID = "anthropic";

function buildVersionAlert(
	status: ClaudeCodeVersionStatus,
): { kind: "error" | "warning"; title: string; message: string } | null {
	if (status === "fallback-after-fetch-failed") {
		return {
			kind: "error",
			title: "pi-claude-auth: version fetch failed",
			message: `No cached version — using fallback ${FALLBACK_CC_VERSION} which may be stale; requests may be rejected or billed as extra usage. Set ANTHROPIC_CLI_VERSION or restore network and restart pi.`,
		};
	}
	return null;
}

/**
 * Report a red/yellow version-discovery notification without taking input
 * focus. Only live fetch failures are surfaced; PI_OFFLINE resolutions are
 * intentional and stay silent.
 */
function showVersionAlert(
	ctx: ExtensionContext,
	res: ClaudeCodeVersionResolution,
): void {
	if (ctx.mode !== "tui") return;
	const alert = buildVersionAlert(res.status);
	if (!alert) return;
	ctx.ui.notify(`${alert.title}\n${alert.message}`, alert.kind);
}

/**
 * pi-claude-auth extension.
 *
 * Pi's built-in `anthropic` provider owns the full OAuth lifecycle (browser
 * login, token refresh, credential storage in `~/.pi/agent/auth.json`) and the
 * Claude Code identity prompt. This extension wraps that provider so requests
 * bill against the Claude Pro/Max
 * subscription plan instead of pay-as-you-go API credits or "extra usage":
 *
 * - Sets the full Claude Code user-agent (`claude-cli/<version> (external, …)`)
 *   via the provider `headers`, and keeps the version synced to the latest
 *   `@anthropic-ai/claude-code` release.
 * - Injects the `x-anthropic-billing-header` system block on every request and
 *   relocates pi's own system prompt into the first user message (Anthropic
 *   rejects third-party system prompts alongside the Claude Code identity).
 * - Resolves the `cch` body checksum with a seeded XXH64 digest of the
 *   normalized, serialized request body (via a wrapped `fetch`), matching
 *   Claude Code 2.1.224 so requests stay valid even if Anthropic enforces cch.
 * - Handles Anthropic Fable 5 and Opus 5 classifier refusals with an
 *   interactive branch-or-continue workflow.
 *
 * It deliberately does NOT register a custom `oauth` lifecycle: doing so would
 * overwrite pi's built-in `anthropic` OAuth provider and break `/login`. Run
 * `/login anthropic` the usual pi way; pi loads the resulting `auth.json` entry
 * at startup, and its `getApiKey` already prefers that OAuth token over any
 * `ANTHROPIC_API_KEY` env var, so no credential re-injection is needed.
 */
const extension = async (pi: ExtensionAPI): Promise<void> => {
	initLogger();
	const versionResolution = await initializeClaudeCodeVersion();

	// Wrap pi's built-in anthropic provider (preserving its OAuth lifecycle) so
	// OAuth requests carry the Claude Code billing header, identity headers, and
	// a real cch body checksum. No `oauth` field is registered, so `/login
	// anthropic` keeps doing the real browser flow and writing auth.json.
	const anthropic = builtinProviders().find(
		(provider) => provider.id === PROVIDER_ID,
	);
	if (!anthropic)
		throw new Error(
			"pi-claude-auth could not load pi's built-in Anthropic provider",
		);
	pi.registerProvider(wrapAnthropicProvider(anthropic));

	registerRetryAfterRefusal(pi);

	// Surface a degraded-version alert on startup (offline resolutions stay
	// silent). No credential work here: pi already loaded auth.json and prefers
	// the OAuth token over ANTHROPIC_API_KEY.
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;
		showVersionAlert(ctx, versionResolution);
		// Long-lived sessions refresh the cached version in the background.
		// Headless (print) runs serve the cache as-is: a pending fetch would
		// hold the process open at exit and tax every subagent child.
		if (ctx.mode === "tui" && versionResolution.status === "cache") {
			void revalidateClaudeCodeVersion();
		}
	});

	log("provider_registered", { provider: PROVIDER_ID });
};

export const ClaudeAuthExtension = extension;
export default extension;
