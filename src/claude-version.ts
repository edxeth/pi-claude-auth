import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./logger.ts";
import { getPiAgentDir } from "./paths.ts";
import { FALLBACK_CC_VERSION, setDiscoveredCliVersion } from "./signing.ts";

const REGISTRY_LATEST_URL =
	"https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest";
const CACHE_FILE = "claude-code-version.json";
const FETCH_TIMEOUT_MS = 2500;

export type ClaudeCodeVersionStatus =
	| "env"
	| "npm"
	| "cache-after-fetch-failed"
	| "fallback-after-fetch-failed"
	| "cache-offline"
	| "fallback-offline";

export interface ClaudeCodeVersionResolution {
	version: string;
	status: ClaudeCodeVersionStatus;
	cachedAt?: number;
}

interface CachedClaudeCodeVersion {
	version: string;
	fetchedAt: number;
	source: "npm" | "env" | "fallback";
}

interface RegistryLatestResponse {
	version?: unknown;
}

function isValidSemver(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
	);
}

function getCachePath(): string {
	return join(getPiAgentDir(), CACHE_FILE);
}

async function readCachedVersion(): Promise<CachedClaudeCodeVersion | null> {
	try {
		const raw = await readFile(getCachePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<CachedClaudeCodeVersion>;
		if (!isValidSemver(parsed.version)) return null;
		if (typeof parsed.fetchedAt !== "number") return null;
		return {
			version: parsed.version,
			fetchedAt: parsed.fetchedAt,
			source:
				parsed.source === "npm" || parsed.source === "env"
					? parsed.source
					: "fallback",
		};
	} catch {
		return null;
	}
}

async function writeCachedVersion(version: string, source: "npm" | "env") {
	const path = getCachePath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `.${CACHE_FILE}.tmp-${process.pid}-${Date.now()}`);
	const body: CachedClaudeCodeVersion = {
		version,
		fetchedAt: Date.now(),
		source,
	};
	await writeFile(tmp, JSON.stringify(body, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	if (process.platform !== "win32") chmodSync(tmp, 0o600);
	await rename(tmp, path);
}

async function fetchLatestVersion(): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(REGISTRY_LATEST_URL, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const json = (await response.json()) as RegistryLatestResponse;
		return isValidSemver(json.version) ? json.version : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve the Claude Code semver used by the user-agent and billing header.
 *
 * The cc_version suffix is computed per request in signing.ts; this resolver
 * only discovers the semver prefix. There is no fixed current "build hash" to
 * fetch for the suffix.
 *
 * Returns a status so callers can decide whether to surface a degraded/fallback
 * warning to the user. Offline resolutions (PI_OFFLINE=1) are treated as
 * intentional and not flagged; only live fetch failures are surfaced.
 */
export async function initializeClaudeCodeVersion(): Promise<ClaudeCodeVersionResolution> {
	const envVersion = process.env.ANTHROPIC_CLI_VERSION;
	if (isValidSemver(envVersion)) {
		setDiscoveredCliVersion(envVersion);
		await writeCachedVersion(envVersion, "env").catch(() => {});
		log("claude_code_version", { version: envVersion, source: "env" });
		return { version: envVersion, status: "env" };
	}

	if (process.env.PI_OFFLINE === "1") {
		const cached = await readCachedVersion();
		if (cached) {
			setDiscoveredCliVersion(cached.version);
			log("claude_code_version", {
				version: cached.version,
				source: "cache_offline",
			});
			return {
				version: cached.version,
				status: "cache-offline",
				cachedAt: cached.fetchedAt,
			};
		}
		setDiscoveredCliVersion(FALLBACK_CC_VERSION);
		log("claude_code_version", {
			version: FALLBACK_CC_VERSION,
			source: "fallback_offline",
		});
		return { version: FALLBACK_CC_VERSION, status: "fallback-offline" };
	}

	const latest = await fetchLatestVersion();
	if (latest) {
		setDiscoveredCliVersion(latest);
		await writeCachedVersion(latest, "npm").catch(() => {});
		log("claude_code_version", { version: latest, source: "npm" });
		return { version: latest, status: "npm" };
	}

	const cached = await readCachedVersion();
	if (cached) {
		setDiscoveredCliVersion(cached.version);
		log("claude_code_version", {
			version: cached.version,
			source: "cache_after_fetch_failed",
		});
		return {
			version: cached.version,
			status: "cache-after-fetch-failed",
			cachedAt: cached.fetchedAt,
		};
	}

	setDiscoveredCliVersion(FALLBACK_CC_VERSION);
	log("claude_code_version", {
		version: FALLBACK_CC_VERSION,
		source: "fallback_after_fetch_failed",
	});
	return {
		version: FALLBACK_CC_VERSION,
		status: "fallback-after-fetch-failed",
	};
}
