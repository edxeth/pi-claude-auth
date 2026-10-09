import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Device identity for the request-body fingerprint real Claude Code sends.
 *
 * Real CC writes a machine-stable `userID` (64-hex device id) into
 * `~/.claude.json` on first run and, once signed in, an
 * `oauthAccount.accountUuid`. Every request body carries
 * `metadata.user_id` as a JSON string of device_id/account_uuid/session_id
 * (verified against 2.1.295 first-party traffic; a logged-out CC sends an
 * empty account_uuid).
 *
 * This module is the only place that knows the file format. Callers get a
 * resolved identity or null; a missing or unreadable file means "send no
 * metadata" (the pre-fingerprint shape), never a synthetic id: an invented
 * device id would itself be a signal no real install produces.
 */

export interface DeviceIdentity {
	deviceId: string;
	accountUuid: string;
}

interface ClaudeJson {
	userID?: unknown;
	oauthAccount?: { accountUuid?: unknown };
}

function defaultClaudeJsonPath(): string {
	return join(homedir(), ".claude.json");
}

async function readIdentity(path: string): Promise<DeviceIdentity | null> {
	const parsed = JSON.parse(await readFile(path, "utf-8")) as ClaudeJson;
	if (typeof parsed.userID !== "string" || parsed.userID.length === 0) {
		return null;
	}
	const accountUuid =
		typeof parsed.oauthAccount?.accountUuid === "string"
			? parsed.oauthAccount.accountUuid
			: "";
	return { deviceId: parsed.userID, accountUuid };
}

// One in-flight read per path, so startup and tests share the first result
// and repeated calls stay cheap.
const cache = new Map<string, Promise<DeviceIdentity | null>>();

export function loadClaudeCodeIdentity(
	claudeJsonPath = defaultClaudeJsonPath(),
): Promise<DeviceIdentity | null> {
	let pending = cache.get(claudeJsonPath);
	if (!pending) {
		pending = readIdentity(claudeJsonPath).catch(() => null);
		cache.set(claudeJsonPath, pending);
	}
	return pending;
}
