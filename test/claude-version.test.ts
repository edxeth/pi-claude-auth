import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeClaudeCodeVersion } from "../src/claude-version.ts";
import {
	buildUserAgent,
	getCliVersion,
	getEntrypoint,
	setDiscoveredCliVersion,
} from "../src/signing.ts";

const originalFetch = globalThis.fetch;

function withCache(dir: string, version: string, fetchedAt = Date.now()) {
	writeFileSync(
		join(dir, "claude-code-version.json"),
		JSON.stringify({ version, fetchedAt, source: "npm" }),
	);
}

describe("initializeClaudeCodeVersion", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-ver-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.ANTHROPIC_CLI_VERSION;
		delete process.env.PI_OFFLINE;
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.ANTHROPIC_CLI_VERSION;
		delete process.env.PI_OFFLINE;
		delete process.env.CLAUDE_CODE_ENTRYPOINT;
		delete process.env.ANTHROPIC_USER_AGENT;
		globalThis.fetch = originalFetch;
	});

	it("uses a valid ANTHROPIC_CLI_VERSION override with status 'env'", async () => {
		process.env.ANTHROPIC_CLI_VERSION = "1.2.3";
		const res = await initializeClaudeCodeVersion();
		expect(res.version).toBe("1.2.3");
		expect(res.status).toBe("env");
	});

	it("ignores an invalid ANTHROPIC_CLI_VERSION (falls through to npm)", async () => {
		process.env.ANTHROPIC_CLI_VERSION = "not-a-version";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ version: "9.9.9" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const res = await initializeClaudeCodeVersion();
		expect(res.version).toBe("9.9.9");
		expect(res.status).toBe("npm");
	});

	it("returns 'npm' when the registry responds", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ version: "8.8.8" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const res = await initializeClaudeCodeVersion();
		expect(res.version).toBe("8.8.8");
		expect(res.status).toBe("npm");
	});

	it("returns 'cache-after-fetch-failed' when fetch fails but a cache exists", async () => {
		withCache(dir, "7.7.7");
		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof fetch;
		const res = await initializeClaudeCodeVersion();
		expect(res.version).toBe("7.7.7");
		expect(res.status).toBe("cache-after-fetch-failed");
		expect(res.cachedAt).toBeDefined();
	});

	it("returns 'fallback-after-fetch-failed' when fetch fails and there is no cache", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const res = await initializeClaudeCodeVersion();
		expect(res.status).toBe("fallback-after-fetch-failed");
	});

	it("returns 'cache-offline' under PI_OFFLINE=1 when a cache exists", async () => {
		process.env.PI_OFFLINE = "1";
		withCache(dir, "6.6.6");
		const res = await initializeClaudeCodeVersion();
		expect(res.version).toBe("6.6.6");
		expect(res.status).toBe("cache-offline");
	});

	it("returns 'fallback-offline' under PI_OFFLINE=1 with no cache", async () => {
		process.env.PI_OFFLINE = "1";
		const res = await initializeClaudeCodeVersion();
		expect(res.status).toBe("fallback-offline");
	});
});

describe("signing overrides", () => {
	afterEach(() => {
		delete process.env.ANTHROPIC_CLI_VERSION;
		delete process.env.CLAUDE_CODE_ENTRYPOINT;
		delete process.env.ANTHROPIC_USER_AGENT;
		setDiscoveredCliVersion("2.1.198");
	});

	it("getCliVersion honors a valid env override and ignores an invalid one", () => {
		setDiscoveredCliVersion("2.1.198");
		process.env.ANTHROPIC_CLI_VERSION = "3.4.5";
		expect(getCliVersion()).toBe("3.4.5");
		process.env.ANTHROPIC_CLI_VERSION = "garbage";
		expect(getCliVersion()).toBe("2.1.198");
	});

	it("getEntrypoint honors CLAUDE_CODE_ENTRYPOINT", () => {
		process.env.CLAUDE_CODE_ENTRYPOINT = "vscode";
		expect(getEntrypoint()).toBe("vscode");
	});

	it("buildUserAgent uses the full claude-cli form by default and ANTHROPIC_USER_AGENT when set", () => {
		setDiscoveredCliVersion("1.0.0");
		delete process.env.ANTHROPIC_CLI_VERSION;
		delete process.env.ANTHROPIC_USER_AGENT;
		expect(buildUserAgent()).toBe("claude-cli/1.0.0 (external, cli)");
		process.env.ANTHROPIC_USER_AGENT = "custom-agent/1";
		expect(buildUserAgent()).toBe("custom-agent/1");
	});
});
