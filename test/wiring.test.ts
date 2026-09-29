import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import loadExtension from "../src/index.ts";

const originalFetch = globalThis.fetch;

type Handler = (...args: unknown[]) => unknown;

interface RegisteredOverlay {
	id: string;
	config: ProviderConfig;
}

/** The ExtensionAPI surface the extension uses, plus recorded call state. */
interface SpyPi {
	registerProvider(name: string, config: ProviderConfig): void;
	on(event: string, handler: Handler): void;
	registerCommand(
		name: string,
		definition: { description?: string },
	): void;
	getCommands(): { name: string; source: string }[];
	registeredOverlays: RegisteredOverlay[];
	handlers: Record<string, Handler[]>;
	commands: Record<string, { description?: string }>;
}

function makeSpyPi(): SpyPi {
	const registeredOverlays: RegisteredOverlay[] = [];
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, { description?: string }> = {};
	return {
		registeredOverlays,
		handlers,
		commands,
		// The extension calls the two-arg `registerProvider(name, config)`
		// overload: a named stream overlay, not a replacement native provider.
		registerProvider(name: string, config: ProviderConfig) {
			registeredOverlays.push({ id: name, config });
		},
		on(event: string, handler: Handler) {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerCommand(name: string, definition: { description?: string }) {
			commands[name] = definition;
		},
		getCommands() {
			return Object.keys(commands).map((name) => ({
				name,
				source: "extension",
			}));
		},
	};
}

describe("extension wiring (Pi owns the OAuth lifecycle)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		// Valid semver -> version resolver takes the "env" path (no network),
		// and produces no degraded-version alert, so session_start stays quiet.
		process.env.ANTHROPIC_CLI_VERSION = "1.2.3";
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.ANTHROPIC_CLI_VERSION;
		globalThis.fetch = originalFetch;
	});

	it("registers a named stream overlay (preserving catalog and OAuth lifecycle)", async () => {
		// No auth.json present: the user has not logged in yet. The extension
		// must still register the overlay so `/login anthropic` (pi's built-in
		// browser flow, kept by leaving the built-in provider as the base) is
		// available.
		const spy = makeSpyPi();
		await loadExtension(spy as unknown as ExtensionAPI);

		expect(spy.registeredOverlays).toHaveLength(1);
		const overlay = spy.registeredOverlays[0];
		expect(overlay.id).toBe("anthropic");
		// The overlay only substitutes the stream handler for anthropic-messages
		// models. No models/baseUrl/oauth fields: the catalog-enabled built-in
		// provider stays the base, so the refreshed catalog and /login survive.
		expect(overlay.config.api).toBe("anthropic-messages");
		expect(typeof overlay.config.streamSimple).toBe("function");
		expect(overlay.config.models).toBeUndefined();
		expect(overlay.config.baseUrl).toBeUndefined();
		expect(overlay.config.oauth).toBeUndefined();
	});

	it("registers session_start hooks and no before_provider_request hook", async () => {
		// Billing injection now lives in the overlay's onPayload, so the
		// before_provider_request hook is intentionally gone.
		const spy = makeSpyPi();
		await loadExtension(spy as unknown as ExtensionAPI);

		expect(spy.handlers.session_start?.length).toBeGreaterThan(0);
		expect(spy.handlers.before_provider_request).toBeUndefined();
		// pi >= 0.84.2: the internal rewind command powers automatic transcript
		// refresh after "Edit and retry".
		expect(spy.commands["claude-refusal-rewind"]).toMatchObject({
			description: expect.stringContaining("classifier refusal"),
		});
	});

	it("does not write to auth storage on session_start (Pi owns auth.json)", async () => {
		// The extension must not re-set or persist the OAuth credential. Pi
		// already loaded auth.json at startup and getApiKey already prefers the
		// OAuth token over ANTHROPIC_API_KEY, so any re-write is pointless and
		// risks clobbering a fresher token rotated by another pi process.
		const spy = makeSpyPi();
		await loadExtension(spy as unknown as ExtensionAPI);

		let setCalled = false;
		const ctx = {
			mode: "tui",
			modelRegistry: {
				authStorage: {
					set: () => {
						setCalled = true;
					},
				},
			},
			sessionManager: { getBranch: () => [] },
			ui: { custom: async () => {} },
		};
		for (const handler of spy.handlers.session_start ?? []) {
			await handler({ reason: "startup" }, ctx);
		}
		expect(setCalled).toBe(false);
	});

	it("reports a version fetch failure without opening a blocking custom UI", async () => {
		delete process.env.ANTHROPIC_CLI_VERSION;
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as typeof fetch;

		const spy = makeSpyPi();
		await loadExtension(spy as unknown as ExtensionAPI);

		const notifications: { message: string; kind: string }[] = [];
		let customCalled = false;
		const ctx = {
			mode: "tui",
			sessionManager: { getBranch: () => [] },
			ui: {
				notify(message: string, kind: string) {
					notifications.push({ message, kind });
				},
				async custom() {
					customCalled = true;
					return new Promise(() => {});
				},
			},
		};

		for (const handler of spy.handlers.session_start ?? []) {
			await handler({ reason: "startup" }, ctx);
		}

		expect(customCalled).toBe(false);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.kind).toBe("error");
		expect(notifications[0]?.message).toContain("version fetch failed");
	});
});
