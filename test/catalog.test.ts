import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	type ExtensionAPI,
	type ProviderConfig,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import loadExtension from "../src/index.ts";

/**
 * Regression tests for the provider-registration defect: the extension used to
 * replace pi's catalog-enabled built-in Anthropic provider with a fresh static
 * provider object, which dropped every model that only existed in the cached
 * pi.dev catalog (in production: `anthropic/claude-sonnet-5-5` vanished from
 * `pi --list-models`). The extension must instead register a named stream
 * overlay so the runtime's own provider — static list plus persisted catalog
 * overlay — stays the base.
 *
 * The tests run against a real ModelRuntime whose models-store.json is seeded
 * with a catalog model that is NOT in the static built-in list (synthetic id,
 * so the test stays valid even if a future pi-ai ships the same id statically).
 * No user files are touched: everything lives in a temp agent dir.
 */

const CATALOG_ONLY_MODEL_ID = "claude-test-catalog-only";
const STATIC_MODEL_ID = "claude-sonnet-4-5";

function catalogOnlyModel(): Model<Api> {
	return {
		id: CATALOG_ONLY_MODEL_ID,
		name: "Claude Test Catalog Only",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	} as Model<Api>;
}

/**
 * A pi facade whose registerProvider calls apply directly to a real
 * ModelRuntime — the same composition layer the CLI uses — so the test fails
 * on the old whole-provider registration (catalog model vanishes) and passes
 * on the overlay registration (catalog model survives).
 */
function makeRuntimePi(runtime: ModelRuntime) {
	return {
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
	};
}

describe("catalog preservation under the extension (stream overlay, not provider replacement)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-catalog-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		// Valid semver -> version resolver takes the "env" path (no network).
		process.env.ANTHROPIC_CLI_VERSION = "1.2.3";
		// Seed a persisted catalog whose entry is fresher than the built-in
		// model data, mirroring a real `pi update --models` refresh.
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "models-store.json"),
			JSON.stringify({
				anthropic: {
					models: [catalogOnlyModel()],
					lastModified: Date.now(),
					checkedAt: Date.now(),
				},
			}),
		);
		// Empty models.json: the store overlay must work without provider config.
		writeFileSync(join(dir, "models.json"), "{}");
	});

	afterEach(async () => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.ANTHROPIC_CLI_VERSION;
	});

	async function createRuntime(): Promise<ModelRuntime> {
		return ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
			modelsStorePath: join(dir, "models-store.json"),
			allowModelNetwork: false,
		});
	}

	it("keeps the cached catalog model listed after the extension registers", async () => {
		const runtime = await createRuntime();

		// Sanity: the offline refresh restored the seeded catalog entry.
		expect(runtime.getModel("anthropic", CATALOG_ONLY_MODEL_ID)).toBeDefined();
		expect(runtime.getModel("anthropic", STATIC_MODEL_ID)).toBeDefined();

		await loadExtension(makeRuntimePi(runtime) as unknown as ExtensionAPI);

		expect(runtime.getModel("anthropic", CATALOG_ONLY_MODEL_ID)).toBeDefined();
		expect(runtime.getModel("anthropic", STATIC_MODEL_ID)).toBeDefined();
	});

	it("keeps the catalog model listed after an offline model refresh", async () => {
		const runtime = await createRuntime();
		await loadExtension(makeRuntimePi(runtime) as unknown as ExtensionAPI);

		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getModel("anthropic", CATALOG_ONLY_MODEL_ID)).toBeDefined();
	});
});
