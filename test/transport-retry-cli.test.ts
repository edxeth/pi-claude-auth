import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const model = "claude-sonnet-4-5";
const reset = "read tcp 192.0.2.1:12345->192.0.2.2:443: read: connection reset by peer";

function event(type: string, fields: Record<string, unknown> = {}): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function start(): string {
	return event("message_start", {
		message: {
			id: "msg_fixture", type: "message", role: "assistant", model,
			content: [], stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	});
}

function text(value: string): string {
	return event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
		+ event("content_block_delta", { index: 0, delta: { type: "text_delta", text: value } })
		+ event("content_block_stop", { index: 0 });
}

function finish(reason = "end_turn"): string {
	return event("message_delta", {
		delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 },
	}) + event("message_stop");
}

function failure(message = reset, type = "api_error"): string {
	return event("error", { error: { type, message } });
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected a JSON record in CLI fixture");
	// SAFETY: the runtime check establishes an object indexed by JSON field names.
	return value as JsonRecord;
}

async function runFixture(responses: string[], options: {
	enabled?: boolean; maxRetries?: number; toolCalls?: boolean; abortDuringRetry?: boolean;
} = {}) {
	const executable = Bun.which("pi");
	if (!executable) throw new Error("CLI integration tests require pi on PATH");
	const directory = await mkdtemp(join(tmpdir(), "claude-transport-retry-"));
	const requests: JsonRecord[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(record(await request.json()));
			const response = responses[Math.min(requests.length - 1, responses.length - 1)];
			if (response === undefined) throw new Error("CLI fixture has no response");
			return new Response(response, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await writeFile(join(directory, "settings.json"), JSON.stringify({
			retry: { enabled: options.enabled ?? true, maxRetries: options.maxRetries ?? 2,
				baseDelayMs: options.abortDuringRetry ? 1_000 : 10, provider: { maxRetries: 0 } },
			compaction: { enabled: false },
		}));
		await writeFile(join(directory, "models.json"), JSON.stringify({
			providers: { anthropic: {
				baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "synthetic-fixture-key",
			} },
		}));
		const running = Bun.spawn([
			executable, "--offline", "--no-extensions", "-e", extension,
			"--no-skills", "--no-context-files", "--no-mcp", "--no-session",
			...(options.toolCalls ? ["--tools", "bash"] : ["--no-tools"]),
			"--no-prompt-templates", "--no-themes", "--thinking", "off",
			"--model", `anthropic/${model}`, "--mode", options.abortDuringRetry ? "rpc" : "json",
			"--system-prompt", "Reply concisely.",
			...(options.abortDuringRetry ? [] : ["Reply with exactly OK."]),
		], {
			cwd: directory,
			env: {
				PATH: process.env.PATH, HOME: directory,
				PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1",
				PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
				ANTHROPIC_CLI_VERSION: "2.1.295",
			},
			stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		child = running;
		timer = setTimeout(() => running.kill(), 20_000);
		const events: JsonRecord[] = [];
		const output = (async () => {
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of running.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line.trim()) continue;
					const value = record(JSON.parse(line));
					events.push(value);
					if (options.abortDuringRetry && value.type === "auto_retry_start")
						running.stdin.write('{"id":"cancel","type":"abort"}\n');
					if (options.abortDuringRetry && value.type === "agent_settled")
						running.stdin.end();
				}
			}
			expect(buffer + decoder.decode()).toBe("");
		})();
		if (options.abortDuringRetry)
			running.stdin.write('{"id":"prompt","type":"prompt","message":"Reply with exactly OK."}\n');
		else running.stdin.end();
		const [, stderr, exitCode] = await Promise.all([
			output, new Response(running.stderr).text(), running.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(events.filter(e => e.type === "extension_error")).toEqual([]);
		const messages = events.filter(e => e.type === "message_end").map(e => record(e.message));
		const toolEffects = options.toolCalls ? await readFile(join(directory, "calls.txt"), "utf8") : undefined;
		return { requests, events, messages, toolEffects };
	} finally {
		if (timer) clearTimeout(timer);
		if (child && child.exitCode === null) {
			child.kill();
			await child.exited;
		}
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
}

// Contract: one transient streaming failure must recover through native retry,
// preserving the original prompt rather than manufacturing a user continuation.
test("recovers from a streamed reset without adding a user message", async () => {
	const result = await runFixture([
		start() + text("Partial") + failure(),
		start() + text("OK") + finish(),
	]);
	const assistants = result.messages.filter(m => m.role === "assistant");
	expect(assistants.at(-1)?.stopReason).toBe("stop");
	expect(result.requests).toHaveLength(2);
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(1);
	expect(result.messages.filter(m => m.role === "user")).toHaveLength(1);
	expect(result.requests[1]?.messages).toEqual(result.requests[0]?.messages);
	expect(result.messages.some(m => m.role === "custom")).toBe(false);
}, 25_000);

test.each(["unexpected EOF", "ECONNRESET"])("recovers from streamed %s", async (error) => {
	const result = await runFixture([start() + failure(error), start() + text("OK") + finish()]);
	expect(result.requests).toHaveLength(2);
	expect(result.messages.filter(m => m.role === "assistant").at(-1)?.stopReason).toBe("stop");
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(1);
}, 25_000);

test("persistent transport failure stops at Pi's configured retry budget", async () => {
	const result = await runFixture([start() + failure()], { maxRetries: 2 });
	expect(result.requests).toHaveLength(3);
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(2);
	expect(result.events.filter(e => e.type === "auto_retry_end")).toMatchObject([
		{ success: false, attempt: 2 },
	]);
	expect(result.messages.filter(m => m.role === "assistant").at(-1)?.stopReason).toBe("error");
	expect(result.messages.filter(m => m.role === "user")).toHaveLength(1);
}, 25_000);

test("does not override disabled native retry", async () => {
	const result = await runFixture([start() + failure()], { enabled: false });
	expect(result.requests).toHaveLength(1);
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(0);
	expect(result.messages.filter(m => m.role === "assistant").at(-1)?.stopReason).toBe("error");
}, 25_000);

test("does not reinterpret an authentication error as a transport failure", async () => {
	const result = await runFixture([start() + failure("unexpected EOF", "authentication_error")]);
	expect(result.requests).toHaveLength(1);
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(0);
	expect(result.messages.filter(m => m.role === "assistant").at(-1)?.stopReason).toBe("error");
}, 25_000);

test("honors abort during native retry backoff without another request", async () => {
	const result = await runFixture([start() + failure()], { abortDuringRetry: true });
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(1);
	expect(result.events.filter(e => e.type === "auto_retry_end")).toMatchObject([{ success: false }]);
	expect(result.events.filter(e => e.type === "agent_settled")).toMatchObject([{ aborted: true }]);
	expect(result.requests).toHaveLength(1);
	expect(result.messages.filter(m => m.role === "user")).toHaveLength(1);
}, 25_000);

function tool(id: string, command: string, complete: boolean): string {
	return event("content_block_start", {
		index: 0, content_block: { type: "tool_use", id, name: "bash", input: {} },
	}) + event("content_block_delta", {
		index: 0, delta: {
			type: "input_json_delta",
			partial_json: complete ? JSON.stringify({ command }) : '{"command":"printf y >> calls.txt"',
		},
	}) + (complete ? event("content_block_stop", { index: 0 }) + finish("tool_use") : failure());
}

// Contract: retry only the failed model response. Keep completed tool work and
// its result, and never execute the incomplete call from the failed response.
test("preserves completed tool work and discards an interrupted tool call", async () => {
	const result = await runFixture([
		start() + tool("call_completed", "printf x >> calls.txt", true),
		start() + tool("call_incomplete", "unused", false),
		start() + text("OK") + finish(),
	], { toolCalls: true });
	expect(result.toolEffects).toBe("x");
	expect(result.requests).toHaveLength(3);
	expect(result.events.filter(e => e.type === "auto_retry_start")).toHaveLength(1);
	expect(result.events.filter(e => e.type === "tool_execution_start")).toMatchObject([
		{ toolCallId: "call_completed", toolName: "bash" },
	]);
	expect(result.requests[2]?.messages).toEqual(result.requests[1]?.messages);
	expect(JSON.stringify(result.requests[2]?.messages)).toContain("call_completed");
	expect(JSON.stringify(result.requests[2]?.messages)).not.toContain("call_incomplete");
	expect(result.messages.filter(m => m.role === "user")).toHaveLength(1);
	expect(result.messages.filter(m => m.role === "assistant").at(-1)?.stopReason).toBe("stop");
}, 25_000);
