import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeTransportError } from "../src/transport-errors.ts";

function failed(errorMessage: string): AssistantMessage {
	return {
		role: "assistant", provider: "anthropic", api: "anthropic-messages",
		model: "claude-sonnet-4-5", stopReason: "error", errorMessage, timestamp: 1,
		content: [{ type: "text", text: "Partial output" }],
		usage: {
			input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

// Source: the observed Anthropic SSE api_error contract. Text may be bare for
// transport exceptions; the provider's error type takes precedence in envelopes.
test.each([
	"connection reset by peer",
	"read tcp [2001:db8::1]:12345->[2001:db8::2]:443: read: connection reset by peer",
	"ECONNRESET",
	"read ECONNRESET",
	"unexpected EOF",
])("normalizes only the diagnostic for transport failure: %s", (text) => {
	for (const original of [text, JSON.stringify({ type: "error", error: { type: "api_error", message: text } })]) {
		const message = failed(original);
		const before = structuredClone(message);
		const result = normalizeTransportError({ type: "message_end", message });
		expect(result?.message).toEqual({ ...before, errorMessage: `connection error: ${original}` });
		expect(message).toEqual(before);
		expect(result?.message?.content).toBe(message.content);
	}
});

test("normalization is idempotent and preserves the raw JSON diagnostic", () => {
	const message = failed('{"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}');
	const result = normalizeTransportError({ type: "message_end", message });
	if (!result?.message) throw new Error("Transport failure was not normalized");
	expect(normalizeTransportError({ type: "message_end", message: result.message })).toBeUndefined();
});

test.each([
	"",
	"Connection error.",
	"503 service unavailable",
	"The request was blocked by a safety classifier",
	"Anthropic performed an unsupported mid-output model fallback",
	"prompt is too long",
	"input contains the words connection reset by peer",
	"unexpected EOF while parsing input JSON",
	"401 authentication error: connection reset by peer",
	'{"type":"error","error":{"type":"authentication_error","message":"unexpected EOF"}}',
	'{"type":"error","error":{"type":"permission_error","message":"connection reset by peer"}}',
	'{"type":"error","error":{"type":"invalid_request_error","message":"ECONNRESET"}}',
	'{"type":"error","error":{"type":"rate_limit_error","message":"unexpected EOF"}}',
	'{"type":"error","error":{"type":"api_error","message":"billing: unexpected EOF"}}',
	'{"type":"error","error":{"type":"api_error","message":null}}',
	'{"type":"error","error":{"type":"api_error"}}',
	'{"type":"error","error":{"message":"unexpected EOF"}}',
	'{"type":"error","error":null}',
	'{"type":"error","error":[]}',
	'{"error":{"type":"api_error","message":"unexpected EOF"}}',
	'{"type":"other","error":{"type":"api_error","message":"unexpected EOF"}}',
	'{"type":"error","error":{"type":"api_error","message":"unexpected EOF"',
	'{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"fixture"}}\n{"type":"error","error":{"type":"api_error","message":"connection reset by peer"}}',
	"null",
	'["unexpected EOF"]',
])("leaves unrelated, permanent or malformed errors unchanged: %s", (error) => {
	expect(normalizeTransportError({ type: "message_end", message: failed(error) })).toBeUndefined();
});

test("does not change other providers, APIs, successful responses or cancellation", () => {
	const base = failed("unexpected EOF");
	const missingError = failed("");
	delete missingError.errorMessage;
	const messages: AssistantMessage[] = [
		{ ...base, provider: "openai" },
		{ ...base, provider: "anthropic-kiro" },
		{ ...base, api: "openai-responses" },
		{ ...base, stopReason: "stop" },
		{ ...base, stopReason: "toolUse" },
		{ ...base, stopReason: "aborted" },
		{ ...base, stopReason: "length" },
		missingError,
	];
	for (const message of messages)
		expect(normalizeTransportError({ type: "message_end", message })).toBeUndefined();
});

test("does not treat user content or tool failures as model transport failures", () => {
	expect(normalizeTransportError({
		type: "message_end",
		message: { role: "user", content: "connection reset by peer", timestamp: 1 },
	})).toBeUndefined();
	expect(normalizeTransportError({
		type: "message_end",
		message: {
			role: "toolResult", toolCallId: "call_fixture", toolName: "bash",
			content: [{ type: "text", text: "unexpected EOF" }], isError: true, timestamp: 1,
		},
	})).toBeUndefined();
});
