import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { injectBillingHeader } from "../src/transforms.ts";

const LEGACY_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const AGENT_SDK_IDENTITY =
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const BILLING_PREFIX = "x-anthropic-billing-header";

function claudePayload(overrides: Record<string, unknown> = {}) {
	return {
		model: "claude-sonnet-4-5",
		system: [{ type: "text", text: LEGACY_IDENTITY }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Say hello." }] },
		],
		...overrides,
	};
}

describe("injectBillingHeader", () => {
	beforeEach(() => {
		process.env.ANTHROPIC_CLI_VERSION = "1.2.3";
	});
	afterEach(() => {
		delete process.env.ANTHROPIC_CLI_VERSION;
	});

	describe("guard clauses", () => {
		it("does nothing for non-Claude models", () => {
			expect(
				injectBillingHeader(claudePayload({ model: "gpt-5" })),
			).toBeUndefined();
		});

		it("does nothing when messages is not an array", () => {
			expect(
				injectBillingHeader({
					model: "claude-sonnet-4-5",
					system: [],
					messages: "nope",
				}),
			).toBeUndefined();
		});

		it("does nothing outside OAuth mode (no legacy identity block)", () => {
			// A plain API-key request: system has pi's own prompt, not the identity.
			expect(
				injectBillingHeader({
					model: "claude-sonnet-4-5",
					system: [{ type: "text", text: "You are a helpful assistant." }],
					messages: [{ role: "user", content: "hi" }],
				}),
			).toBeUndefined();
		});

		it("is idempotent (does not inject twice)", () => {
			const once = injectBillingHeader(claudePayload()) as {
				system: { text: string }[];
			};
			expect(once).toBeDefined();
			// Running the already-injected payload through again must be a no-op.
			expect(injectBillingHeader(once)).toBeUndefined();
		});
	});

	describe("injection + system handling", () => {
		it("prepends the billing header and swaps the legacy identity for the Agent SDK line", () => {
			const out = injectBillingHeader(claudePayload()) as {
				system: { type: string; text: string }[];
			};
			expect(out.system[0].text.startsWith(BILLING_PREFIX)).toBe(true);
			expect(out.system[1].text).toBe(AGENT_SDK_IDENTITY);
			// The legacy identity pi sent is dropped entirely.
			expect(out.system.some((e) => e.text === LEGACY_IDENTITY)).toBe(false);
		});

		it("formats the header as cc_version / cc_entrypoint / cch plus prompt and turn stamps", () => {
			const out = injectBillingHeader(claudePayload()) as {
				system: { text: string }[];
			};
			const header = out.system[0].text;
			// Field order matches real 2.1.295 first-party traffic. The cch is a
			// placeholder; the wrapped transport resolves it post-serialization.
			expect(header).toMatch(
				/^x-anthropic-billing-header: cc_version=1\.2\.3\.\d{3}; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}; cc_turn_origin=sdk; cc_prompt_index=\d+; cc_turn_index=\d+;$/,
			);
		});

		it("stamps the first prompt of a session as index 0, turn 1", () => {
			const out = injectBillingHeader(claudePayload(), {
				sessionId: "turn-shape",
				device: null,
			}) as { system: { text: string }[] };
			expect(out.system[0].text).toContain("cc_prompt_index=0;");
			expect(out.system[0].text).toContain("cc_turn_index=1;");
		});

		it("advances the turn within one prompt and starts a new one per user message", () => {
			const ctx = { sessionId: "turn-tracking", device: null };
			const first = injectBillingHeader(claudePayload(), ctx) as {
				system: { text: string }[];
			};
			// Tool-result continuation: same prompt, next turn.
			const continuation = injectBillingHeader(
				claudePayload({
					messages: [
						{ role: "user", content: [{ type: "text", text: "Say hello." }] },
					{ role: "assistant", content: [{ type: "text", text: "Hi." }] },
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "t1" }],
					},
					],
				}),
				ctx,
			) as { system: { text: string }[] };
			// A new user text prompt: prompt index advances, prompt id changes.
			const second = injectBillingHeader(
				claudePayload({
					messages: [
					{ role: "user", content: [{ type: "text", text: "Say hello." }] },
					{ role: "assistant", content: [{ type: "text", text: "Hi." }] },
					{ role: "user", content: [{ type: "text", text: "Now goodbye." }] },
				],
				}),
				ctx,
			) as { system: { text: string }[] };

			const idOf = (t: { text: string }) =>
				t.text.match(/cc_prompt_id=([0-9a-f-]{36});/)?.[1];
			expect(first.system[0].text).toContain("cc_prompt_index=0;");
			expect(continuation.system[0].text).toContain("cc_turn_index=2;");
			expect(idOf(continuation.system[0])).toBe(idOf(first.system[0]));
			expect(second.system[0].text).toContain("cc_prompt_index=1;");
			expect(second.system[0].text).toContain("cc_turn_index=1;");
			expect(idOf(second.system[0])).not.toBe(idOf(first.system[0]));
		});

		it("relocates third-party system text into the first user message (array content)", () => {
			const payload = {
				model: "claude-sonnet-4-5",
				system: [
					{ type: "text", text: LEGACY_IDENTITY },
					{ type: "text", text: "You are pi, a coding agent." },
				],
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Do the thing." }],
					},
				],
			};
			const out = injectBillingHeader(payload) as {
				system: { text: string }[];
				messages: { role: string; content: { type: string; text: string }[] }[];
			};
			// Only billing header + Agent SDK identity remain in system[].
			expect(out.system.map((e) => e.text)).toEqual([
				expect.stringMatching(new RegExp(`^${BILLING_PREFIX}`)),
				AGENT_SDK_IDENTITY,
			]);
			// pi's prompt was prepended to the first user message's content blocks.
			const firstUserContent = out.messages[0].content;
			expect(firstUserContent[0].text).toBe("You are pi, a coding agent.");
			expect(firstUserContent[1].text).toBe("Do the thing.");
		});

		it("relocates third-party system text into the first user message (string content)", () => {
			const payload = {
				model: "claude-sonnet-4-5",
				system: [
					{ type: "text", text: LEGACY_IDENTITY },
					{ type: "text", text: "Extra system instructions." },
				],
				messages: [{ role: "user", content: "Hello there." }],
			};
			const out = injectBillingHeader(payload) as {
				system: { text: string }[];
				messages: {
					role: string;
					content: Array<{ type: string; text: string }>;
				}[];
			};
			expect(out.system.length).toBe(2);
			const firstUser = out.messages.find((m) => m.role === "user");
			expect(firstUser).toBeDefined();
			if (!firstUser) return;
			expect(firstUser.content.map((block) => block.text)).toEqual([
				"Extra system instructions.",
				"Hello there.",
			]);
		});

		it("preserves one-hour cache controls while relocating system text", () => {
			const oneHour = { type: "ephemeral", ttl: "1h" };
			const payload = {
				model: "claude-sonnet-4-5",
				system: [
					{
						type: "text",
						text: LEGACY_IDENTITY,
						cache_control: oneHour,
					},
					{
						type: "text",
						text: "Stable Pi system prompt.",
						cache_control: oneHour,
					},
				],
				messages: [{ role: "user", content: "Hello." }],
			};

			const out = injectBillingHeader(payload) as {
				system: Array<{ text: string; cache_control?: typeof oneHour }>;
				messages: Array<{
					content: Array<{
						text: string;
						cache_control?: typeof oneHour;
					}>;
				}>;
			};

			expect(out.system[0].cache_control).toBeUndefined();
			expect(out.system[1].cache_control).toEqual(oneHour);
			expect(out.messages[0].content[0]).toEqual({
				type: "text",
				text: "Stable Pi system prompt.",
				cache_control: oneHour,
			});
		});
	});

	describe("metadata.user_id device fingerprint", () => {
		it("adds the device identity with the session id, real-CC key order", () => {
			const out = injectBillingHeader(claudePayload(), {
				sessionId: "sess-1",
				device: { deviceId: "ab".repeat(32), accountUuid: "" },
			}) as { metadata?: { user_id?: string } };
			expect(out.metadata?.user_id).toBe(
				JSON.stringify({
					device_id: "ab".repeat(32),
					account_uuid: "",
					session_id: "sess-1",
			}),
			);
		});

		it("sends no metadata without a device identity", () => {
			const out = injectBillingHeader(claudePayload(), {
				device: null,
			}) as { metadata?: unknown };
			expect(out.metadata).toBeUndefined();
		});

		it("merges into existing payload metadata instead of replacing it", () => {
			const out = injectBillingHeader(
				claudePayload({ metadata: { trace: "keep" } }),
				{ device: { deviceId: "cd".repeat(32), accountUuid: "u-1" } },
			) as { metadata?: Record<string, string> };
			expect(out.metadata?.trace).toBe("keep");
			expect(out.metadata?.user_id).toContain('"account_uuid":"u-1"');
		});
	});
});
