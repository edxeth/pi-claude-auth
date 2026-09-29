import { afterEach, describe, expect, it } from "bun:test";
import type {
	Api,
	Model,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
	createAnthropicStreamOverlay,
	type AnthropicStreamOverlay,
} from "../src/anthropic-provider.ts";

interface RecordedCall {
	method: "stream" | "streamSimple";
	options: unknown;
}

const MODEL = {
	id: "claude-sonnet-4-5",
	api: "anthropic-messages",
} as Model<Api>;

/**
 * Minimal provider that records delegated calls. Only `id`/`stream`/`streamSimple`
 * matter for the overlay, so the rest of the Provider shape is stubbed out.
 */
function recordingAnthropicProvider():
	Provider & { calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	return {
		id: "anthropic",
		name: "anthropic",
		stream(_model: unknown, _context: unknown, options: unknown) {
			calls.push({ method: "stream", options });
			return {} as never;
		},
		streamSimple(_model: unknown, _context: unknown, options: unknown) {
			calls.push({ method: "streamSimple", options });
			return {} as never;
		},
		calls,
	} as unknown as Provider & { calls: RecordedCall[] };
}

function overlayOver(fake: Provider & { calls: RecordedCall[] }): AnthropicStreamOverlay {
	return createAnthropicStreamOverlay(fake);
}

describe("createAnthropicStreamOverlay", () => {
	afterEach(() => {
		delete process.env.ENABLE_PROMPT_CACHING_1H;
	});

	it("rejects a non-anthropic base provider", () => {
		expect(() =>
			createAnthropicStreamOverlay({ id: "openai" } as Provider),
		).toThrow(/cannot overlay/);
	});

	it("declares the anthropic-messages api and only a streamSimple handler", () => {
		const overlay = overlayOver(recordingAnthropicProvider());
		expect(overlay.api).toBe("anthropic-messages");
		expect(typeof overlay.streamSimple).toBe("function");
		// No models/baseUrl/oauth: the built-in provider must stay the base for
		// the catalog and /login.
		expect(overlay).not.toHaveProperty("models");
		expect(overlay).not.toHaveProperty("baseUrl");
		expect(overlay).not.toHaveProperty("oauth");
	});

	it("passes API-key requests through to the built-in provider unchanged", () => {
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);
		const opts = { apiKey: "sk-ant-api03-realapikey" };

		overlay.streamSimple(MODEL, {} as never, opts as never);

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].method).toBe("streamSimple");
		// Same object reference: the overlay must not merge anything for API keys.
		expect(fake.calls[0].options).toBe(opts);
	});

	it("passes through when no options are given", () => {
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		overlay.streamSimple(MODEL, {} as never, undefined);

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].method).toBe("streamSimple");
		expect(fake.calls[0].options).toBeUndefined();
	});

	it("routes simple-shaped OAuth requests through streamSimple with Claude Code options merged", () => {
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		overlay.streamSimple(MODEL, {} as never, {
			apiKey: "sk-ant-oat-xyz",
			reasoning: "high",
		} as never);

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].method).toBe("streamSimple");
		const merged = fake.calls[0].options as Record<string, unknown>;
		expect(merged.reasoning).toBe("high"); // simple fields survive the merge
		const headers = merged.headers as ProviderHeaders;
		expect(headers["user-agent"]).toMatch(/^claude-cli\/.*\(external, /);
		expect(headers["x-app"]).toBe("cli");
		expect(typeof merged.fetch).toBe("function");
		expect(typeof merged.onPayload).toBe("function");
	});

	it("routes api-shaped options through the api-shaped stream entry point", () => {
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		overlay.streamSimple(MODEL, {} as never, {
			apiKey: "sk-ant-api03-realapikey",
			thinkingEnabled: true,
			thinkingBudgetTokens: 2048,
		} as never);

		expect(fake.calls).toHaveLength(1);
		// The api-shaped entry point keeps the caller's thinking options
		// authoritative instead of re-deriving them from a reasoning level.
		expect(fake.calls[0].method).toBe("stream");
		const passed = fake.calls[0].options as Record<string, unknown>;
		expect(passed.thinkingEnabled).toBe(true);
		expect(passed.thinkingBudgetTokens).toBe(2048);
	});

	it("merges Claude Code options for api-shaped OAuth requests too", () => {
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		overlay.streamSimple(MODEL, {} as never, {
			apiKey: "sk-ant-oat-xyz",
			effort: "high",
		} as never);

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].method).toBe("stream");
		const merged = fake.calls[0].options as Record<string, unknown>;
		expect(merged.effort).toBe("high");
		const headers = merged.headers as ProviderHeaders;
		expect(headers["user-agent"]).toMatch(/^claude-cli\/.*\(external, /);
		expect(typeof merged.fetch).toBe("function");
		expect(typeof merged.onPayload).toBe("function");
	});

	it("runs an existing onPayload before injecting the billing header", async () => {
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		const seen: unknown[] = [];
		const priorTransform = (payload: unknown) => {
			seen.push(payload);
			return { ...(payload as object), priorRan: true };
		};

		overlay.streamSimple(MODEL, {} as never, {
			apiKey: "sk-ant-oat-xyz",
			onPayload: priorTransform,
		} as never);
		const merged = fake.calls[0].options as {
			onPayload: (p: unknown, m: unknown) => Promise<unknown>;
		};

		const base = {
			model: "claude-haiku-4-5",
			max_tokens: 64,
			stream: true,
			system: [
				{
					type: "text",
					text: "You are Claude Code, Anthropic's official CLI for Claude.",
				},
			],
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		};
		const result = (await merged.onPayload(base, {})) as {
			priorRan: boolean;
			system: { text: string }[];
		};

		expect(seen).toHaveLength(1); // the prior transform ran on the original payload
		expect(result.priorRan).toBe(true); // its output was preserved
		expect(result.system[0].text).toContain("x-anthropic-billing-header"); // billing injected after
	});

	it("maps Claude Code's one-hour cache env var to Pi's long retention", () => {
		process.env.ENABLE_PROMPT_CACHING_1H = "1";
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		overlay.streamSimple(MODEL, {} as never, {
			apiKey: "sk-ant-oat-xyz",
			cacheRetention: "short",
		} as never);

		const merged = fake.calls[0].options as Record<string, unknown>;
		expect(merged.cacheRetention).toBe("long");
	});

	it("does not change cache retention when the env var is disabled", () => {
		process.env.ENABLE_PROMPT_CACHING_1H = "0";
		const fake = recordingAnthropicProvider();
		const overlay = overlayOver(fake);

		overlay.streamSimple(MODEL, {} as never, {
			apiKey: "sk-ant-oat-xyz",
			cacheRetention: "short",
		} as never);

		const merged = fake.calls[0].options as Record<string, unknown>;
		expect(merged.cacheRetention).toBe("short");
	});
});
