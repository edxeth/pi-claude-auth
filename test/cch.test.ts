import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { patchClaudeCodeCch, xxHash64 } from "../src/cch.ts";
import { injectBillingHeader } from "../src/transforms.ts";

const encoder = new TextEncoder();

describe("xxHash64", () => {
	// Standard XXH64 reference vectors (also used by the pi-black reference).
	it("matches the empty-input vector", () => {
		expect(xxHash64(encoder.encode("")).toString(16)).toBe("ef46db3751d8e999");
	});

	it("matches the \"hello\" vector", () => {
		expect(xxHash64(encoder.encode("hello")).toString(16)).toBe(
			"26c7827d889f6da3",
		);
	});
});

describe("patchClaudeCodeCch", () => {
	it("resolves the placeholder to the recovered normalized-body checksum", () => {
		// Body + seed recovered from real Claude Code traffic; pi-black asserts
		// the same `cch=7ba34` value.
		const body =
			'{"model":"claude-opus-5","messages":[{"role":"user","content":"A"}],"max_tokens":64000,"stream":true,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;"}]}';
		expect(patchClaudeCodeCch(body)).toContain("cch=7ba34");
	});

	it("patches only system[0] despite placeholder and nested-field collisions", () => {
		// `model`, `max_tokens`, and `cch=00000` appear inside user content, a
		// second system block, and a tool description. Only the real top-level
		// fields must feed the checksum; everything else stays byte-for-byte.
		const body = {
			model: "claude-opus-5",
			messages: [
				{
					role: "user",
					content: "cch=00000",
					model: "nested-model",
					max_tokens: 7,
				},
			],
			max_tokens: 64000,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;",
				},
				{ type: "text", text: "fake cch=00000" },
			],
			tools: [
				{
					name: "probe",
					description: "model max_tokens cch=00000",
					input_schema: { type: "object" },
				},
			],
		};
		const patched = JSON.parse(
			patchClaudeCodeCch(JSON.stringify(body)),
		) as typeof body;
		expect(patched.system[0].text).toMatch(/cch=[0-9a-f]{5};$/u);
		expect(patched.system[0].text).not.toContain("cch=00000");
		expect(patched.messages[0]).toEqual(body.messages[0]);
		expect(patched.system[1]).toEqual(body.system[1]);
		expect(patched.tools).toEqual(body.tools);
	});

	it("is idempotent: a body whose billing block already has a valid cch is unchanged", () => {
		const body = JSON.stringify({
			model: "claude-haiku-4-5",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 128,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.224.f97; cc_entrypoint=cli; cch=7ba34;",
				},
			],
		});
		expect(patchClaudeCodeCch(body)).toBe(body);
	});

	it("throws when the billing system block is missing", () => {
		expect(() =>
			patchClaudeCodeCch(
				JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [] }),
			),
		).toThrow();
	});
});

describe("billing -> cch end-to-end pipeline", () => {
	beforeEach(() => {
		process.env.ANTHROPIC_CLI_VERSION = "2.1.198";
	});
	afterEach(() => {
		delete process.env.ANTHROPIC_CLI_VERSION;
	});

	it("injects a placeholder billing header that patchClaudeCodeCch resolves", () => {
		// onPayload (injectBillingHeader) runs first, writing cch=00000; then the
		// SDK serializes; then the wrapped fetch runs patchClaudeCodeCch.
		const payload = {
			model: "claude-haiku-4-5",
			max_tokens: 128,
			stream: true,
			system: [
				{
					type: "text",
					text: "You are Claude Code, Anthropic's official CLI for Claude.",
				},
			],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Say hi." }] },
			],
		};
		const injected = injectBillingHeader(payload) as {
			system: { text: string }[];
		};
		expect(injected).toBeDefined();
		expect(injected.system[0].text).toContain("cch=00000");

		const patched = JSON.parse(patchClaudeCodeCch(JSON.stringify(injected))) as {
			system: { text: string }[];
		};
		// The digest now sits mid-block: prompt/turn fields follow cch.
		expect(patched.system[0].text).toMatch(/cch=[0-9a-f]{5}; cc_prompt_id=/u);
		expect(patched.system[0].text).not.toContain("cch=00000");
	});

	it("passes a real-CC-shaped billing block (resolved cch, trailing fields) through unchanged", () => {
		// Shape recovered from live 2.1.295 first-party traffic: the cch digest
		// is mid-block and prompt/turn fields follow it.
		const real =
			"x-anthropic-billing-header: cc_version=2.1.295.cf5; cc_entrypoint=sdk-cli; cch=fa0a2; cc_prompt_id=631fca7c-d9fd-456c-b19e-21516a3fc319; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;";
		const body = JSON.stringify({
			model: "claude-haiku-4-5",
			max_tokens: 128,
			system: [{ type: "text", text: real }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Say hi." }] },
			],
		});
		expect(patchClaudeCodeCch(body)).toBe(body);
	});
});
