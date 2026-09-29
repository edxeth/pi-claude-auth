import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Provider } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ProviderConfig,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import loadExtension from "../src/index.ts";

/**
 * Request-behavior regression tests through the real composition layer: after
 * the extension registers its stream overlay, OAuth requests leaving pi must
 * carry the Claude Code billing header with a resolved `cch` checksum, while
 * API-key requests must stay untouched. A stubbed global fetch captures the
 * outgoing request; no network is used.
 */

const OAUTH_TOKEN = "sk-ant-oat01-test-token";
const API_KEY = "sk-ant-api03-test-key";

interface CapturedRequest {
	url: string;
	body: string;
	headers: Headers;
}

const originalFetch = globalThis.fetch;

function stubFetch(captured: CapturedRequest[]): typeof fetch {
	return (async (input: unknown, init?: RequestInit) => {
		captured.push({
			url: String(input),
			body:
				typeof init?.body === "string"
					? init.body
					: input instanceof Request
						? await input.clone().text()
						: "",
			headers: new Headers(
				input instanceof Request ? input.headers : init?.headers,
			),
		});
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "api_error", message: "request-path test stub" },
			}),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
}

describe("request behavior under the registered overlay", () => {
	let dir: string;
	let runtime: ModelRuntime;
	let captured: CapturedRequest[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-request-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		process.env.ANTHROPIC_CLI_VERSION = "1.2.3";
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "models.json"), "{}");
		captured = [];
		globalThis.fetch = stubFetch(captured);

		runtime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
			modelsStorePath: join(dir, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		await loadExtension(
			{
				registerProvider(
					nameOrProvider: string | Provider,
					config?: ProviderConfig,
				) {
					if (typeof nameOrProvider === "string") {
						runtime.registerProvider(nameOrProvider, config as never);
					} else {
						runtime.registerNativeProvider(nameOrProvider as never);
					}
				},
				on() {},
				registerCommand() {},
				getCommands() {
					return [];
				},
			} as unknown as ExtensionAPI,
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.ANTHROPIC_CLI_VERSION;
	});

	function context(): Context {
		return {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			],
			systemPrompt: "You are a helpful assistant.",
		} as Context;
	}

	async function captureRequest(
		apiKey: string,
	): Promise<CapturedRequest> {
		const model = runtime.getModels("anthropic").find(
			(entry) => entry.id === "claude-haiku-4-5",
		);
		if (!model) throw new Error("static anthropic model missing");
		const stream = runtime.streamSimple(model, context(), {
			apiKey,
			maxRetries: 0,
		} as never);
		await stream.result().catch(() => undefined); // the 500 stub errors the stream; the request is what we assert on
		const request = captured[0];
		if (!request) throw new Error("no request reached the transport");
		return request;
	}

	it("sends Claude Code billing headers with a resolved cch on OAuth requests", async () => {
		const request = await captureRequest(OAUTH_TOKEN);

		expect(request.url).toContain("api.anthropic.com");
		expect(request.body).toContain("x-anthropic-billing-header: cc_version=");
		// The cch placeholder must be resolved to a real digest before send.
		expect(request.body).toMatch(/cch=[0-9a-f]{5};/u);
		expect(request.body).not.toContain("cch=00000");
		expect(request.headers.get("user-agent") ?? "").toMatch(
			/^claude-cli\/\d+\.\d+\.\d+ \(external, /u,
		);
		expect(request.headers.get("x-app")).toBe("cli");
	});

	it("leaves API-key requests untouched", async () => {
		const request = await captureRequest(API_KEY);

		expect(request.url).toContain("api.anthropic.com");
		expect(request.body).not.toContain("x-anthropic-billing-header");
		expect(request.headers.get("x-app")).not.toBe("cli");
	});
});
