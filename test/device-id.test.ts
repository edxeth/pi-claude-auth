import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClaudeCodeIdentity } from "../src/device-id.ts";

/**
 * Device identity discovery from ~/.claude.json. A missing userID means "no
 * identity" (metadata omitted); a missing oauthAccount means an empty
 * account_uuid, which is exactly what a logged-out Claude Code sends.
 */

describe("loadClaudeCodeIdentity", () => {
	const dirs: string[] = [];

	function fixturePath(contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-device-"));
		dirs.push(dir);
		writeFileSync(join(dir, ".claude.json"), contents);
		return join(dir, ".claude.json");
	}

	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("reads userID and the OAuth account uuid", async () => {
		const path = fixturePath(
			JSON.stringify({
				userID: "ab".repeat(32),
				oauthAccount: { accountUuid: "uuid-1" },
			}),
		);
		expect(await loadClaudeCodeIdentity(path)).toEqual({
			deviceId: "ab".repeat(32),
			accountUuid: "uuid-1",
		});
	});

	it("returns an empty account uuid without an oauthAccount entry", async () => {
		const path = fixturePath(JSON.stringify({ userID: "ab".repeat(32) }));
		expect(await loadClaudeCodeIdentity(path)).toEqual({
			deviceId: "ab".repeat(32),
			accountUuid: "",
		});
	});

	it("returns null when userID is missing or empty", async () => {
		const noUser = fixturePath(JSON.stringify({ oauthAccount: {} }));
		expect(await loadClaudeCodeIdentity(noUser)).toBeNull();
		const emptyUser = fixturePath(JSON.stringify({ userID: "" }));
		expect(await loadClaudeCodeIdentity(emptyUser)).toBeNull();
	});

	it("returns null for an unreadable or malformed file", async () => {
		const malformed = fixturePath("{ not json");
		expect(await loadClaudeCodeIdentity(malformed)).toBeNull();
		expect(
			await loadClaudeCodeIdentity(join(dirs[0], "does-not-exist.json")),
		).toBeNull();
	});

	it("caches per path so repeat calls do not re-read the file", async () => {
		const path = fixturePath(JSON.stringify({ userID: "cd".repeat(32) }));
		const first = loadClaudeCodeIdentity(path);
		expect(loadClaudeCodeIdentity(path)).toBe(first);
		expect(await first).toEqual({ deviceId: "cd".repeat(32), accountUuid: "" });
	});
});
