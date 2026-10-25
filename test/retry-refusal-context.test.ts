import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerRetryAfterRefusal } from "../src/retry-refusal.ts";

const resources: Array<{ session: AgentSession; dir: string }> = [];
afterEach(() => {
	for (const { session, dir } of resources.splice(0)) {
		session.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

async function createSession() {
	const dir = mkdtempSync(join(tmpdir(), "pi-refusal-context-"));
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "models-store.json"),
		refreshOnCreate: false,
	});
	await runtime.setRuntimeApiKey("anthropic", "synthetic-test-key");
	const model = runtime.getModel("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Missing static Claude Opus 5.5 model");
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "fixture_probe",
					label: "Fixture probe",
					description: "Read a synthetic fixture value.",
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [{ type: "text", text: "probe-result" }],
							details: {},
						};
					},
				});
			},
			registerRetryAfterRefusal,
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "high",
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(dir),
		resourceLoader: loader,
		tools: ["fixture_probe"],
	});
	resources.push({ session, dir });
	const requests: Message[][] = [];
	const responses: Array<"answer" | "tool" | "refusal"> = [];
	let onRefusal: (() => Promise<void>) | undefined;
	// Fake only the provider and UI boundaries. Pi owns persistence, dispatch,
	// context projection, and the real extension's refusal/rewind lifecycle.
	session.agent.streamFunction = (_model, context) => {
		requests.push(structuredClone(context.messages));
		const response = responses.shift() ?? "answer";
		const refused = response === "refusal";
		const message: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			content: refused
				? []
				: [
						{
							type: "thinking",
							thinking: "Retained reasoning",
							thinkingSignature: "signed-test-thinking",
						},
						...(response === "tool"
							? [
									{
										type: "toolCall" as const,
										id: `probe-${requests.length}`,
										name: "fixture_probe",
										arguments: {},
									},
								]
							: [{ type: "text" as const, text: "Ready." }]),
					],
			stopReason: refused ? "error" : response === "tool" ? "toolUse" : "stop",
			...(refused
				? { errorMessage: "The model refused to complete the request" }
				: {}),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		if (refused)
			stream.push({ type: "error", reason: "error", error: message });
		else
			stream.push({
				type: "done",
				reason: response === "tool" ? "toolUse" : "stop",
				message,
			});
		return stream;
	};
	// No terminal renderer is involved; only the refusal dialog/editor methods
	// of this external UI boundary are used by the extension under test.
	await session.bindExtensions({
		mode: "rpc",
		uiContext: {
			select: async (_title, options) => {
				await onRefusal?.();
				return options[1];
			},
			notify: () => {},
			getEditorText: () => "",
			setEditorText: () => {},
		} as ExtensionUIContext,
		onError: (error) => {
			throw new Error(error.error);
		},
	});
	return {
		session,
		requests,
		refuseNext() {
			responses.push("refusal");
		},
		respondWith(...next: Array<"answer" | "tool" | "refusal">) {
			responses.push(...next);
		},
		whenRefused(callback: () => Promise<void>) {
			onRefusal = callback;
		},
	};
}

it("preserves the signed request prefix after Edit and retry", async () => {
	const { session, requests, refuseNext } = await createSession();
	await session.prompt("Keep this successful turn.");
	refuseNext();
	await session.prompt("Abandon this trigger.");
	const retainedPrefix = requests[1].slice(0, -1);
	expect(retainedPrefix.some((message) => message.role === "assistant")).toBe(
		true,
	);
	expect(session.sessionManager.getLeafEntry()).toMatchObject({
		type: "custom",
		customType: "claude-refusal-branch",
	});

	await session.prompt("Retry with this new input.");
	// Contract: rewinding a suffix must leave the retained instruction/thinking
	// prefix unchanged, not fold it into another system checkpoint.
	expect(requests[2].slice(0, retainedPrefix.length)).toEqual(retainedPrefix);
	expect(requests[2]).toHaveLength(retainedPrefix.length + 1);
	expect(requests[2].at(-1)).toMatchObject({
		role: "user",
		content: [{ type: "text", text: "Retry with this new input." }],
	});
});

it("keeps input queued during the refusal on the repaired branch", async () => {
	const { session, requests, refuseNext, whenRefused } = await createSession();
	await session.prompt("Keep this successful turn.");
	whenRefused(async () => {
		expect(await session.followUp("Queued replacement input.")).toBe("queued");
	});
	refuseNext();
	await session.prompt("Abandon this trigger.");

	const retainedPrefix = requests[1].slice(0, -1);
	expect(requests).toHaveLength(3);
	expect(requests[2].slice(0, retainedPrefix.length)).toEqual(retainedPrefix);
	expect(requests[2]).toHaveLength(retainedPrefix.length + 1);
	expect(requests[2].at(-1)).toMatchObject({
		role: "user",
		content: [{ type: "text", text: "Queued replacement input." }],
	});
});

it("preserves completed tool work and drops only the refused tool batch", async () => {
	const { session, requests, respondWith } = await createSession();
	respondWith("tool", "answer");
	await session.prompt("Keep the completed probe.");
	const completedToolResult = requests[1].find(
		(message) => message.role === "toolResult",
	);
	expect(completedToolResult).toBeDefined();

	respondWith("tool", "refusal");
	await session.prompt("Abandon the next probe batch.");
	const retainedPrefix = requests[2];
	await session.prompt("Retry without the abandoned batch.");

	expect(requests).toHaveLength(5);
	expect(requests[4].slice(0, retainedPrefix.length)).toEqual(retainedPrefix);
	expect(requests[4]).toHaveLength(retainedPrefix.length + 1);
	expect(
		requests[4].filter((message) => message.role === "toolResult"),
	).toEqual([completedToolResult]);
});

it("keeps the repaired prefix across extension reload and later prompts", async () => {
	const { session, requests, refuseNext } = await createSession();
	await session.prompt("Keep this successful turn.");
	refuseNext();
	await session.prompt("Abandon this trigger.");
	const retainedPrefix = requests[1].slice(0, -1);

	await session.reload();
	await session.prompt("Continue after reload.");
	expect(requests[2].slice(0, retainedPrefix.length)).toEqual(retainedPrefix);
	expect(requests[2]).toHaveLength(retainedPrefix.length + 1);
	await session.prompt("One more turn.");
	expect(requests[3].slice(0, requests[2].length)).toEqual(requests[2]);
});

it("keeps a compaction checkpoint unchanged when a later turn is rewound", async () => {
	const { session, requests, refuseNext } = await createSession();
	await session.prompt("History that will be summarized.");
	session.sessionManager.appendCompaction("Synthetic summary.", null, 100);
	session.refreshContext();
	await session.prompt("Keep reasoning produced after compaction.");
	refuseNext();
	await session.prompt("Abandon this trigger.");
	const retainedPrefix = requests[2].slice(0, -1);

	await session.prompt("Continue from the retained summary and answer.");
	expect(requests[3].slice(0, retainedPrefix.length)).toEqual(retainedPrefix);
	expect(requests[3]).toHaveLength(retainedPrefix.length + 1);
	expect(
		requests[3].filter((message) => message.role === "system"),
	).toHaveLength(1);
});
