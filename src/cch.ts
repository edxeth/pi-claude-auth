import type { FetchFunction } from "@earendil-works/pi-ai";
import { log } from "./logger.ts";

/**
 * Claude Code `cch` (content checksum) engine.
 *
 * The billing header carries a `cch=00000` placeholder. After the Anthropic SDK
 * serializes the final request body, {@link patchClaudeCodeCch} replaces that
 * placeholder with a 5-hex XXH64 digest of the normalized body. Verified
 * byte-for-byte against real `@anthropic-ai/claude-code` 2.1.295 first-party
 * traffic, so the request bills against the Claude Pro/Max subscription
 * instead of pay-as-you-go / "extra usage".
 *
 * Ported from the pi-black reference implementation, which was recovered from
 * real Claude Code traffic and is verified against the same test vectors.
 */

export const CCH_PLACEHOLDER = "cch=00000";

const CCH_SEED = 0x4d659218e32a3268n;
const MASK_64 = 0xffffffffffffffffn;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

interface JsonObject {
	[key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rotateLeft(value: bigint, bits: bigint): bigint {
	const normalized = value & MASK_64;
	return ((normalized << bits) | (normalized >> (64n - bits))) & MASK_64;
}

function readUint32LE(bytes: Uint8Array, offset: number): bigint {
	return BigInt(
		((bytes[offset] |
			(bytes[offset + 1] << 8) |
			(bytes[offset + 2] << 16) |
			(bytes[offset + 3] << 24)) >>>
			0),
	);
}

function readUint64LE(bytes: Uint8Array, offset: number): bigint {
	return readUint32LE(bytes, offset) | (readUint32LE(bytes, offset + 4) << 32n);
}

function round(accumulator: bigint, input: bigint): bigint {
	const mixed = (accumulator + input * PRIME64_2) & MASK_64;
	return (rotateLeft(mixed, 31n) * PRIME64_1) & MASK_64;
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
	return ((accumulator ^ round(0n, value)) * PRIME64_1 + PRIME64_4) & MASK_64;
}

/** XXH64 over a byte array, returning the unsigned 64-bit digest. */
export function xxHash64(bytes: Uint8Array, seed = 0n): bigint {
	let offset = 0;
	let hash: bigint;

	if (bytes.length >= 32) {
		let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK_64;
		let v2 = (seed + PRIME64_2) & MASK_64;
		let v3 = seed & MASK_64;
		let v4 = (seed - PRIME64_1) & MASK_64;
		while (offset <= bytes.length - 32) {
			v1 = round(v1, readUint64LE(bytes, offset));
			v2 = round(v2, readUint64LE(bytes, offset + 8));
			v3 = round(v3, readUint64LE(bytes, offset + 16));
			v4 = round(v4, readUint64LE(bytes, offset + 24));
			offset += 32;
		}
		hash =
			(rotateLeft(v1, 1n) +
				rotateLeft(v2, 7n) +
				rotateLeft(v3, 12n) +
				rotateLeft(v4, 18n)) &
			MASK_64;
		hash = mergeRound(hash, v1);
		hash = mergeRound(hash, v2);
		hash = mergeRound(hash, v3);
		hash = mergeRound(hash, v4);
	} else {
		hash = (seed + PRIME64_5) & MASK_64;
	}

	hash = (hash + BigInt(bytes.length)) & MASK_64;
	while (offset <= bytes.length - 8) {
		const lane = round(0n, readUint64LE(bytes, offset));
		hash = (rotateLeft(hash ^ lane, 27n) * PRIME64_1 + PRIME64_4) & MASK_64;
		offset += 8;
	}
	if (offset <= bytes.length - 4) {
		hash ^= readUint32LE(bytes, offset) * PRIME64_1;
		hash = (rotateLeft(hash, 23n) * PRIME64_2 + PRIME64_3) & MASK_64;
		offset += 4;
	}
	while (offset < bytes.length) {
		hash ^= BigInt(bytes[offset]) * PRIME64_5;
		hash = (rotateLeft(hash, 11n) * PRIME64_1) & MASK_64;
		offset++;
	}

	hash ^= hash >> 33n;
	hash = (hash * PRIME64_2) & MASK_64;
	hash ^= hash >> 29n;
	hash = (hash * PRIME64_3) & MASK_64;
	hash ^= hash >> 32n;
	return hash & MASK_64;
}

/**
 * Replace the `cch=00000` placeholder in `system[0]` with a 5-hex XXH64 digest
 * of the normalized body (model blanked, `max_tokens` removed).
 *
 * Idempotent: a billing block that already carries a valid `cch=<5hex>;` value
 * is returned unchanged, so double-wrapping is safe.
 *
 * The digest is computed over a STRUCTURED clone, not via a regex on the
 * serialized string. That makes `model` / `max_tokens` / `cch=00000`
 * substrings embedded inside user content, tool descriptions, or extra system
 * blocks irrelevant to the checksum — only the real top-level fields are.
 */
export function patchClaudeCodeCch(serializedBody: string): string {
	let body: JsonObject;
	try {
		const parsed = JSON.parse(serializedBody);
		if (!isObject(parsed)) throw new Error("not an object");
		body = parsed;
	} catch {
		throw new Error(
			"pi-claude-auth expected the Anthropic SDK to serialize a JSON object",
		);
	}
	if (
		!Array.isArray(body.system) ||
		!isObject(body.system[0]) ||
		typeof body.system[0].text !== "string"
	) {
		throw new Error(
			"pi-claude-auth OAuth request is missing the billing system block",
		);
	}
	const billingText = body.system[0].text;
	if (!billingText.startsWith("x-anthropic-billing-header: ")) {
		throw new Error("pi-claude-auth OAuth request has an invalid billing block");
	}
	if (!billingText.includes(CCH_PLACEHOLDER)) {
		// Already-resolved bodies are passed through untouched. The check is not
		// end-anchored: real billing blocks carry prompt/turn fields after cch.
		if (/; cch=[0-9a-f]{5};/u.test(billingText)) return serializedBody;
		throw new Error(
			"pi-claude-auth OAuth request has an invalid cch billing value",
		);
	}
	if (typeof body.model !== "string" || !("max_tokens" in body)) {
		throw new Error(
			"pi-claude-auth OAuth request is missing model or max_tokens",
		);
	}

	const normalized = structuredClone(body);
	normalized.model = "";
	delete normalized.max_tokens;
	const hash = xxHash64(
		new TextEncoder().encode(JSON.stringify(normalized)),
		CCH_SEED,
	);
	const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
	body.system[0].text = billingText.replace(CCH_PLACEHOLDER, `cch=${cch}`);
	return JSON.stringify(body);
}

function requestHeaders(
	input: Parameters<FetchFunction>[0],
	init?: RequestInit,
): Headers {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	if (init?.headers) {
		for (const [name, value] of new Headers(init.headers))
			headers.set(name, value);
	}
	return headers;
}

/**
 * Extract the resolved prompt id from a patched billing block, so the
 * x-claude-code-prompt-id transport header carries the same UUID the billing
 * header already stamped (real CC keeps the two in lockstep).
 */
function promptIdFromBilling(serializedBody: string): string | null {
	return serializedBody.match(/cc_prompt_id=([0-9a-f-]{36});/)?.[1] ?? null;
}

/**
 * Wrap a fetch implementation so every Claude Code OAuth request carries a
 * fresh `x-client-request-id`, the billing block's prompt id as
 * `x-claude-code-prompt-id`, and has its `cch` placeholder resolved against
 * the final serialized body (the only point that owns the real body bytes).
 */
export function createClaudeCodeFetch(
	fetchImplementation: FetchFunction,
): FetchFunction {
	return async (input, init) => {
		const headers = requestHeaders(input, init);
		if (!headers.has("x-client-request-id"))
			headers.set("x-client-request-id", crypto.randomUUID());

		if (typeof init?.body === "string") {
			const patched = patchClaudeCodeCch(init.body);
			const cch = patched.match(/cch=([0-9a-f]{5});/)?.[1];
			log("cch_patched", { cch });
			const promptId = promptIdFromBilling(patched);
			if (promptId && !headers.has("x-claude-code-prompt-id"))
				headers.set("x-claude-code-prompt-id", promptId);
			return fetchImplementation(input, {
				...init,
				headers,
				body: patched,
			});
		}
		if (input instanceof Request) {
			const body = await input.clone().text();
			const patched = patchClaudeCodeCch(body);
			const cch = patched.match(/cch=([0-9a-f]{5});/)?.[1];
			log("cch_patched", { cch });
			const promptId = promptIdFromBilling(patched);
			if (promptId && !headers.has("x-claude-code-prompt-id"))
				headers.set("x-claude-code-prompt-id", promptId);
			const request = new Request(input, { headers, body: patched });
			return fetchImplementation(request);
		}
		throw new Error(
			"pi-claude-auth OAuth request body is not available for cch patching",
		);
	};
}

/** Whether an Anthropic credential is an OAuth token (not an API key). */
export function isAnthropicOAuthToken(apiKey: string | undefined): boolean {
	return apiKey?.includes("sk-ant-oat") === true;
}
