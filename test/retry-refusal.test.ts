import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	computeBranchTarget,
	getRefusalMode,
	registerRetryAfterRefusal,
	shouldHandleRefusal,
	supportsCommandDispatch,
} from "../src/retry-refusal.ts";

type Handler = (...args: unknown[]) => unknown;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ToolCall = { id: string; name: string };

function appendUser(session: SessionManager, content: string): string {
	return session.appendMessage({
		role: "user",
		content,
		timestamp: Date.now(),
	});
}

function appendToolCalls(
	session: SessionManager,
	calls: ToolCall[],
	text?: string,
): string {
	return session.appendMessage({
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...calls.map((call) => ({
				type: "toolCall" as const,
				id: call.id,
				name: call.name,
				arguments: {},
			})),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
}

function appendToolResult(
	session: SessionManager,
	call: ToolCall,
	text: string,
): string {
	return session.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	});
}

let savedMode: string | undefined;
beforeEach(() => {
	savedMode = process.env.PI_CLAUDE_AUTH_REFUSAL_MODE;
	delete process.env.PI_CLAUDE_AUTH_REFUSAL_MODE;
});
afterEach(() => {
	if (savedMode === undefined) delete process.env.PI_CLAUDE_AUTH_REFUSAL_MODE;
	else process.env.PI_CLAUDE_AUTH_REFUSAL_MODE = savedMode;
});

const fableRefusal = {
	role: "assistant",
	provider: "anthropic",
	model: "claude-fable-5",
	stopReason: "error",
	errorMessage: "The request was blocked by a safety classifier",
} as const;

interface HarnessOptions {
	action?: "continue" | "edit";
	mode?: "tui" | "rpc" | "json" | "print";
	refusedModel?: { provider: string; id: string; name: string };
	editorDraft?: string;
	piVersion?: string;
	/** Simulate another extension owning the bare command name (pi renames
	 * duplicates with numeric suffixes, breaking bare-name dispatch). */
	commandNameCollision?: boolean;
	session?: SessionManager;
	trigger?: "toolResult" | "user";
	initializeSession?: boolean;
	setupSession?: (session: SessionManager) => void;
}

function createHarness(options: HarnessOptions = {}) {
	const handlers: Record<string, Handler[]> = {};
	const notifications: unknown[] = [];
	const sentMessages: unknown[] = [];
	const appendedEntries: unknown[] = [];
	const editorValues: string[] = [];
	const selectedModels: unknown[] = [];
	const commands: Record<string, { handler: (...args: unknown[]) => unknown }> =
		{};
	const sentUserMessages: Array<{ text: string; options: unknown }> = [];
	const navigateTreeCalls: Array<{ targetId: string }> = [];
	const dispatches: Promise<unknown>[] = [];
	let menuCalls = 0;
	let editorText = options.editorDraft ?? "";
	let idleGateOpen = true;
	let idleWaiters: Array<() => void> = [];

	const refusedModel = options.refusedModel ?? {
		provider: "anthropic",
		id: "claude-fable-5",
		name: "Claude Fable 5",
	};
	const fallbackModel = {
		provider: "anthropic",
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
	};

	const session = options.session ?? SessionManager.inMemory();
	if (options.initializeSession !== false) {
		if (options.setupSession) {
			options.setupSession(session);
		} else {
			appendUser(session, "Do the task");
			if (options.trigger !== "user") {
				const call = { id: "t1", name: "read" };
				appendToolCalls(session, [call]);
				appendToolResult(session, call, "binary contents");
			}
		}
	}
	const triggerId = session.getLeafId()!;

	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = [...(handlers[event] ?? []), handler];
		},
		registerCommand(name: string, definition: { handler: Handler }) {
			commands[name] = definition;
		},
		getCommands() {
			if (options.commandNameCollision) return [];
			return Object.keys(commands).map((name) => ({
				name,
				source: "extension",
			}));
		},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
			session.appendCustomEntry(customType, data);
		},
		sendMessage(message: unknown, sendOptions: unknown) {
			sentMessages.push({ message, options: sendOptions });
		},
		sendUserMessage(text: string, sendOptions?: { expandPromptTemplates?: boolean }) {
			sentUserMessages.push({ text, options: sendOptions });
			// Mirror AgentSession.prompt(): commands dispatched with
			// expandPromptTemplates execute immediately and record nothing.
			if (sendOptions?.expandPromptTemplates && text.startsWith("/")) {
				const spaceIndex = text.indexOf(" ");
				const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
				const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
				const command = commands[name];
				if (command) {
					dispatches.push(
						(async () => command.handler(args, commandCtx))(),
					);
				}
			}
		},
		async setModel(model: unknown) {
			selectedModels.push(model);
			return true;
		},
	} as unknown as ExtensionAPI;

	const mode = options.mode ?? "tui";
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model: refusedModel,
		modelRegistry: {
			find(provider: string, id: string) {
				if (provider !== "anthropic") return undefined;
				if (id === fallbackModel.id) return fallbackModel;
				if (id === refusedModel.id) return refusedModel;
				return undefined;
			},
		},
		sessionManager: session,
		ui: {
			notify(message: string, kind: string) {
				notifications.push({ message, kind });
			},
			setEditorText(value: string) {
				editorText = value;
				editorValues.push(value);
			},
			getEditorText() {
				return editorText;
			},
			async select(_title: string, choices: string[]) {
				menuCalls++;
				if (options.action === "continue") return choices[0];
				if (options.action === "edit") return choices[1];
				return undefined;
			},
		},
	};

	const commandCtx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model: refusedModel,
		modelRegistry: ctx.modelRegistry,
		sessionManager: session,
		ui: ctx.ui,
		waitForIdle: async () => {
			if (!idleGateOpen) {
				await new Promise<void>((resolve) => idleWaiters.push(resolve));
			}
		},
		navigateTree: async (targetId: string) => {
			navigateTreeCalls.push({ targetId });
			// Mirrors pi 0.84.2 AgentSession.navigateTree() ordering exactly:
			// the current-leaf no-op returns first (before any hook), then
			// session_before_tree handlers are awaited, and only afterwards
			// does the branch move happen.
			if (targetId === session.getLeafId()) return { cancelled: false };
			const oldLeafId = session.getLeafId();
			const entry = session.getEntry(targetId);
			if (!entry) throw new Error(`Entry ${targetId} not found`);
			for (const handler of handlers.session_before_tree ?? []) {
				const result = await handler({}, ctx);
				if (result && typeof result === "object" && "cancel" in result) {
					if ((result as { cancel: boolean }).cancel)
						return { cancelled: true };
				}
			}
			// Real semantics: user and custom messages lift their text to the
			// editor and rewind to their parent; anything else becomes the leaf.
			let newLeafId: string | null;
			let editorText: string | undefined;
			if (
				entry.type === "message" &&
				(entry.message as { role?: string }).role === "user"
			) {
				newLeafId = entry.parentId;
				editorText = "";
			} else if (entry.type === "custom_message") {
				newLeafId = entry.parentId;
				editorText = "";
			} else {
				newLeafId = targetId;
			}
			if (newLeafId === null) session.resetLeaf();
			else session.branch(newLeafId);
			for (const handler of handlers.session_tree ?? []) {
				await handler({ newLeafId, oldLeafId }, ctx);
			}
			return { editorText, cancelled: false };
		},
	};

	registerRetryAfterRefusal(pi, { piVersion: options.piVersion ?? "0.84.2" });
	return {
		appendedEntries,
		blockIdle() {
			idleGateOpen = false;
		},
		commands,
		commandCtx,
		ctx,
		editorValues,
		fallbackModel,
		navigateTreeCalls,
		get menuCalls() {
			return menuCalls;
		},
		handlers,
		notifications,
		/**
		 * Persist the refusal like Pi does, then fire agent_end carrying the same
		 * message object Pi stored. `beforeHandlers` simulates another extension
		 * appending an entry — and moving the leaf — ahead of this one.
		 */
		async refuse(beforeHandlers?: () => void) {
			const refusal = {
				...fableRefusal,
				content: [],
				api: "anthropic-messages",
				usage: ZERO_USAGE,
				timestamp: Date.now(),
			};
			const refusalId = session.appendMessage(refusal);
			beforeHandlers?.();
			for (const handler of handlers.agent_end ?? []) {
				await handler({ messages: [refusal] }, ctx);
			}
			return refusalId;
		},
		selectedModels,
		sentMessages,
		sentUserMessages,
		session,
		releaseIdle() {
			idleGateOpen = true;
			for (const resolve of idleWaiters) resolve();
			idleWaiters = [];
		},
		async settle() {
			await Promise.all(dispatches);
		},
		triggerId,
	};
}

describe("refusal detection", () => {
	it("handles Anthropic Fable 5 and Opus 5 classifier refusals", () => {
		expect(shouldHandleRefusal(fableRefusal)).toBe(true);
		expect(
			shouldHandleRefusal({
				...fableRefusal,
				model: "claude-opus-5",
				errorMessage: "Safeguards flagged this response",
			}),
		).toBe(true);
	});

	it("handles the wording Anthropic and Pi actually send", () => {
		// Anthropic's documented explanation text, which never says "refusal".
		for (const category of ["cyber", "biological", "frontier model"]) {
			expect(
				shouldHandleRefusal({
					...fableRefusal,
					errorMessage: `This request was declined because it could enable ${category} harm.`,
				}),
			).toBe(true);
		}
		// Pi's substitute when Anthropic sends no explanation.
		expect(
			shouldHandleRefusal({
				...fableRefusal,
				errorMessage: "The model refused to complete the request",
			}),
		).toBe(true);
	});

	it("does not handle other model families or unrelated errors", () => {
		expect(
			shouldHandleRefusal({ ...fableRefusal, model: "claude-sonnet-4-5" }),
		).toBe(false);
		for (const errorMessage of [
			"network timeout",
			"overloaded_error: Overloaded",
			"503 service unavailable",
			"fetch failed",
		]) {
			expect(shouldHandleRefusal({ ...fableRefusal, errorMessage })).toBe(false);
		}
	});

	it("ignores runs that did not end in a refusal", async () => {
		const harness = createHarness({ action: "continue" });
		await harness.handlers.agent_end[0](
			{
				messages: [
					{ role: "user", content: "hi" },
					{
						...fableRefusal,
						model: "claude-opus-4-8",
						stopReason: "stop",
						errorMessage: undefined,
					},
				],
			},
			harness.ctx,
		);
		expect(harness.menuCalls).toBe(0);
		expect(harness.sentMessages).toEqual([]);
	});

	it("does not reopen the menu on the continuation run", async () => {
		const harness = createHarness({ action: "continue" });
		await harness.refuse();
		expect(harness.menuCalls).toBe(1);

		// The Opus 4.8 continuation ends in a normal assistant message.
		await harness.handlers.agent_end[0](
			{
				messages: [
					{
						role: "assistant",
						provider: "anthropic",
						model: "claude-opus-4-8",
						stopReason: "stop",
					},
				],
			},
			harness.ctx,
		);
		expect(harness.menuCalls).toBe(1);
		expect(harness.sentMessages).toHaveLength(1);
	});
});

describe("refusal mode", () => {
	it("asks by default and supports automatic continuation", () => {
		expect(getRefusalMode()).toBe("ask");
		process.env.PI_CLAUDE_AUTH_REFUSAL_MODE = "auto";
		expect(getRefusalMode()).toBe("auto");
	});

	it("falls back to ask for unknown values", () => {
		process.env.PI_CLAUDE_AUTH_REFUSAL_MODE = "unknown";
		expect(getRefusalMode()).toBe("ask");
	});
});

describe("branch target computation", () => {
	function makeToolBatchSession() {
		const session = SessionManager.inMemory();
		appendUser(session, "Do the task");
		const call = { id: "t1", name: "read" };
		appendToolCalls(session, [call]);
		appendToolResult(session, call, "file contents");
		return session;
	}

	it("targets the tool-call batch parent when the trigger is a tool result", () => {
		const session = makeToolBatchSession();
		const leafId = session.getLeafId()!;
		const target = computeBranchTarget(session, leafId);
		expect(target).not.toBeNull();
		const targetEntry = session.getEntry(target!);
		expect(targetEntry?.type).toBe("message");
		expect((targetEntry as { message: { role: string } }).message.role).toBe("user");
	});

	it("targets the parent when the trigger is a user message", () => {
		const session = SessionManager.inMemory();
		const userId = appendUser(session, "Risky request");
		const target = computeBranchTarget(session, userId);
		expect(target).toBeNull();
	});

	it("walks back through multiple tool results to find the batch start", () => {
		const session = SessionManager.inMemory();
		appendUser(session, "Do multi-step task");
		const readCall = { id: "a", name: "read" };
		const bashCall = { id: "b", name: "bash" };
		appendToolCalls(session, [readCall, bashCall]);
		appendToolResult(session, readCall, "output a");
		appendToolResult(session, bashCall, "output b");
		const leafId = session.getLeafId()!;
		const target = computeBranchTarget(session, leafId);
		expect(target).not.toBeNull();
		const targetEntry = session.getEntry(target!);
		expect(targetEntry?.type).toBe("message");
		expect((targetEntry as { message: { role: string } }).message.role).toBe("user");
	});
});

describe("interactive refusal handling", () => {
	it("switches after refusal persistence, sends hidden lowercase continue, and keeps Opus selected", async () => {
		const harness = createHarness({ action: "continue" });

		await harness.refuse();
		expect(harness.selectedModels).toEqual([harness.fallbackModel]);
		expect(harness.sentMessages).toEqual([
			{
				message: {
					customType: "claude-refusal-continue",
					content: "continue",
					display: false,
				},
				options: { deliverAs: "followUp", triggerTurn: true },
			},
		]);
	});

	it("dispatches a no-op refresh to the marker leaf and restores the draft", async () => {
		const harness = createHarness({ action: "edit", editorDraft: "steer away" });

		await harness.refuse();
		await harness.settle();

		expect(
			harness.session.buildSessionContext().messages.map((message) => message.role),
		).toEqual(["user"]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "claude-refusal-branch",
			data: { triggerId: harness.triggerId },
		});
		expect(harness.appendedEntries).toHaveLength(1);
		expect(harness.editorValues).toEqual(["steer away"]);
		// The refresh no-op-navigates to the marker leaf: the view re-renders
		// without any branch move, so nothing can be branched over.
		expect(harness.sentUserMessages).toEqual([
			{
				text: "/claude-refusal-rewind",
				options: { expandPromptTemplates: true },
			},
		]);
		expect(harness.navigateTreeCalls).toEqual([
			{ targetId: harness.session.getLeafId() },
		]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "claude-refusal-branch",
		});
	});

	it("preserves tool B and rolls back the separate tool C turn", async () => {
		let toolBResultId = "";
		let toolCAssistantId = "";
		let toolCResultId = "";
		const harness = createHarness({
			action: "edit",
			editorDraft: "change course before tool C",
			setupSession(session) {
				const baselineCall = { id: "baseline-read", name: "read" };
				const logCall = { id: "log-scan", name: "bash" };
				const artifactCall = { id: "artifact-read", name: "read" };

				appendUser(session, "Investigate the failing deployment");
				appendToolCalls(
					session,
					[baselineCall],
					"I found an earlier lead worth preserving.",
				);
				appendToolResult(session, baselineCall, "baseline configuration");
				appendToolCalls(
					session,
					[logCall],
					"The baseline is useful; I will verify it against the logs.",
				);
				toolBResultId = appendToolResult(session, logCall, "log scan output");
				toolCAssistantId = appendToolCalls(
					session,
					[artifactCall],
					"I will inspect the deployed artifact now.",
				);
				toolCResultId = appendToolResult(
					session,
					artifactCall,
					"artifact contents",
				);
			},
		});

		const refusalId = await harness.refuse();
		await harness.settle();

		const activeBranchIds = harness.session.getBranch().map((entry) => entry.id);
		expect(activeBranchIds).toContain(toolBResultId);
		expect(activeBranchIds).not.toContain(toolCAssistantId);
		expect(activeBranchIds).not.toContain(toolCResultId);
		expect(activeBranchIds).not.toContain(refusalId);

		const activeContext = harness.session.buildSessionContext().messages;
		expect(activeContext.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
		]);
		const activeToolCallIds = activeContext.flatMap((message) =>
			message.role === "assistant"
				? message.content
						.filter((content) => content.type === "toolCall")
						.map((content) => content.id)
				: [],
		);
		const activeToolResultIds = activeContext.flatMap((message) =>
			message.role === "toolResult" ? [message.toolCallId] : [],
		);
		expect(activeToolCallIds).toEqual(["baseline-read", "log-scan"]);
		expect(activeToolResultIds).toEqual(activeToolCallIds);
		const fileEntries = harness.session.getEntries();
		expect(fileEntries[fileEntries.length - 1]).toMatchObject({
			type: "custom",
			parentId: toolBResultId,
			customType: "claude-refusal-branch",
		});
		// The no-op refresh keeps the marker as the leaf.
		expect(harness.session.getLeafId()).toBe(
			fileEntries[fileEntries.length - 1].id,
		);
		expect(harness.editorValues).toEqual(["change course before tool C"]);

		// The no-op refresh does not synchronize agent state, so the context
		// repair hook stays armed and repairs provider requests from the branch.
		const repaired = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(repaired.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
		]);
	});

	it("branches from the refusal entry even when another extension moved the leaf", async () => {
		const harness = createHarness({ action: "edit" });
		await harness.refuse(() => {
			harness.session.appendCustomEntry("other-extension", { note: "noise" });
		});

		expect(
			harness.session
				.buildSessionContext()
				.messages.map((message) => message.role),
		).toEqual(["user"]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "claude-refusal-branch",
		});
	});

	it("removes a root user trigger instead of keeping it on the active branch", async () => {
		const harness = createHarness({ action: "edit", trigger: "user" });

		await harness.refuse();

		expect(harness.session.buildSessionContext().messages).toEqual([]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			parentId: null,
			customType: "claude-refusal-branch",
		});
	});

	it("rebuilds every later provider context until Pi performs supported tree navigation", async () => {
		const harness = createHarness({ action: "edit" });
		await harness.refuse();

		const first = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(first.messages.map((message) => message.role)).toEqual(["user"]);

		appendUser(harness.session, "Try a safer approach");
		const second = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(second.messages.map((message) => message.role)).toEqual([
			"user",
			"user",
		]);

		await harness.handlers.session_tree[0]({}, harness.ctx);
		expect(await harness.handlers.context[0]({}, harness.ctx)).toBeUndefined();
	});

	it("restores context repair after the extension reloads", async () => {
		const first = createHarness({ action: "edit" });
		await first.refuse();

		const reloaded = createHarness({
			session: first.session,
			initializeSession: false,
		});
		await reloaded.handlers.session_start[0]({ reason: "reload" }, reloaded.ctx);
		const context = (await reloaded.handlers.context[0]({}, reloaded.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(context.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("reopens on the selected branch instead of the abandoned refusal", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-claude-auth-refusal-"));
		try {
			const session = SessionManager.create("/tmp/refusal-test", sessionDir);
			const harness = createHarness({ action: "edit", session });
		await harness.refuse();

			const reopened = SessionManager.open(session.getSessionFile()!, sessionDir);
			expect(
				reopened.buildSessionContext().messages.map((message) => message.role),
			).toEqual(["user"]);
			expect(reopened.getLeafEntry()).toMatchObject({
				type: "custom",
				customType: "claude-refusal-branch",
			});
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("leaves the refused branch unchanged when the menu is cancelled", async () => {
		const harness = createHarness();
		const refusalId = await harness.refuse();
		expect(harness.sentMessages).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.selectedModels).toEqual([]);
		expect(harness.session.getLeafId()).toBe(refusalId);
		expect(harness.appendedEntries).toEqual([]);
	});
});

describe("dispatched rewind (pi >= 0.84.2)", () => {
	it("rewinds synchronously, then no-op-refreshes the transcript at the marker leaf", async () => {
		let toolAResultId = "";
		const harness = createHarness({
			action: "edit",
			editorDraft: "try a safer tool",
			setupSession(session) {
				const callA = { id: "read-a", name: "read" };
				const callB = { id: "bash-b", name: "bash" };
				appendUser(session, "Investigate the deployment");
				appendToolCalls(session, [callA]);
				toolAResultId = appendToolResult(session, callA, "configuration");
				appendToolCalls(session, [callB]);
				appendToolResult(session, callB, "log scan output");
			},
		});

		const refusalId = await harness.refuse();
		await harness.settle();

		// The rewind targets the first batch's tool result; the marker that
		// persists the selection becomes the leaf the refresh navigates to.
		expect(harness.navigateTreeCalls).toEqual([
			{ targetId: harness.session.getLeafId() },
		]);
		expect(harness.sentUserMessages).toEqual([
			{
				text: "/claude-refusal-rewind",
				options: { expandPromptTemplates: true },
			},
		]);

		// The marker is appended when the rewind runs (before the dispatch), so
		// the selected branch survives session reopenings: the file's last entry
		// is the marker, parented at the navigation target.
		expect(harness.appendedEntries).toEqual([
			{
				customType: "claude-refusal-branch",
				data: { triggerId: harness.triggerId, targetId: toolAResultId },
			},
		]);
		const fileEntries = harness.session.getEntries();
		expect(fileEntries[fileEntries.length - 1]).toMatchObject({
			type: "custom",
			parentId: toolAResultId,
			customType: "claude-refusal-branch",
		});
		// The no-op navigation moves nothing: the marker stays the leaf.
		expect(harness.session.getLeafId()).toBe(
			fileEntries[fileEntries.length - 1].id,
		);
		expect(
			harness.session.getBranch().map((entry) => entry.id),
		).not.toContain(refusalId);
		expect(
			harness.session
				.buildSessionContext()
				.messages.map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult"]);
		// The no-op refresh does not synchronize agent state, so the context
		// repair hook stays armed and keeps provider requests on the branch.
		const repaired = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(repaired.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		// The draft survives: the TUI wrapper only fills an empty editor.
		expect(harness.editorValues).toEqual(["try a safer tool"]);
	});

	it("keeps the rewound branch when the session is reopened", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-claude-auth-rewind-"));
		try {
			const session = SessionManager.create("/tmp/rewind-test", sessionDir);
			let toolResultId = "";
			const harness = createHarness({
				action: "edit",
				session,
				setupSession(sm) {
					const callA = { id: "read-a", name: "read" };
					const callB = { id: "bash-b", name: "bash" };
					appendUser(sm, "Do the task");
					appendToolCalls(sm, [callA]);
					toolResultId = appendToolResult(sm, callA, "configuration");
					appendToolCalls(sm, [callB]);
					appendToolResult(sm, callB, "log scan output");
				},
			});
			await harness.refuse();
			await harness.settle();

			const reopened = SessionManager.open(session.getSessionFile()!, sessionDir);
			expect(
				reopened.buildSessionContext().messages.map((message) => message.role),
			).toEqual(["user", "assistant", "toolResult"]);
			expect(reopened.getLeafEntry()).toMatchObject({
				type: "custom",
				parentId: toolResultId,
				customType: "claude-refusal-branch",
			});
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("cannot branch over input arriving during the navigation window", async () => {
		const harness = createHarness({
			action: "edit",
			setupSession(session) {
				const callA = { id: "read-a", name: "read" };
				const callB = { id: "bash-b", name: "bash" };
				appendUser(session, "Investigate the deployment");
				appendToolCalls(session, [callA]);
				appendToolResult(session, callA, "configuration");
				appendToolCalls(session, [callB]);
				appendToolResult(session, callB, "log scan output");
			},
		});

		// Worst case from the first iteration: input lands while pi awaits
		// session_before_tree hooks inside navigateTree(). A branch-moving
		// navigation would run this handler and drop that input off the active
		// branch; the no-op refresh returns before any hook, so the window
		// never opens.
		let treeHookRan = false;
		harness.handlers.session_before_tree = [
			async () => {
				treeHookRan = true;
				appendUser(harness.session, "input during tree hooks");
				return undefined;
			},
		];

		await harness.refuse();
		await harness.settle();

		expect(treeHookRan).toBe(false);
		expect(harness.navigateTreeCalls).toEqual([
			{ targetId: harness.session.getLeafId() },
		]);
		expect(
			harness.session.buildSessionContext().messages.map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult"]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "claude-refusal-branch",
		});
		// The repair hook stays active because no supported navigation ran.
		const context = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});

	it("stays on the pre-0.84.2 behavior when command dispatch is unavailable", async () => {
		const harness = createHarness({
			action: "edit",
			piVersion: "0.84.1",
		});

		await harness.refuse();
		await harness.settle();

		expect(harness.commands).toEqual({});
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.navigateTreeCalls).toEqual([]);
		// Direct rewind exactly as before: same branch, marker, and repair hook.
		expect(
			harness.session.buildSessionContext().messages.map((message) => message.role),
		).toEqual(["user"]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "claude-refusal-branch",
		});
		const context = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(context.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("rewinds without dispatching a refresh outside the TUI (rpc)", async () => {
		// RPC has a remote UI, so the menu opens, but there is no TUI
		// transcript to rebuild: the rewind and context repair must work
		// without dispatching anything.
		const harness = createHarness({ action: "edit", mode: "rpc" });

		await harness.refuse();
		await harness.settle();

		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.navigateTreeCalls).toEqual([]);
		expect(
			harness.session.buildSessionContext().messages.map((message) => message.role),
		).toEqual(["user"]);
		expect(harness.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "claude-refusal-branch",
		});
		const context = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(context.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("keeps queued input that ran after the rewind instead of branching over it", async () => {
		const harness = createHarness({
			action: "edit",
			setupSession(session) {
				const callA = { id: "read-a", name: "read" };
				const callB = { id: "bash-b", name: "bash" };
				appendUser(session, "Investigate the deployment");
				appendToolCalls(session, [callA]);
				appendToolResult(session, callA, "configuration");
				appendToolCalls(session, [callB]);
				appendToolResult(session, callB, "log scan output");
			},
		});

		// The dispatched refresh parks on waitForIdle() while pi drains the
		// input the user submitted during the refusal onto the repaired branch.
		harness.blockIdle();
		await harness.refuse();
		// Nothing runs while the agent is still settling.
		expect(harness.navigateTreeCalls).toEqual([]);
		appendUser(harness.session, "queued while the refusal settled");
		harness.releaseIdle();
		await harness.settle();

		// The navigation was skipped: branching to the rewind target would have
		// removed the queued prompt from the active conversation.
		expect(harness.navigateTreeCalls).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message:
				"New input arrived after the rewind, so the transcript was not refreshed. Visit /tree to refresh the view.",
			kind: "info",
		});
		expect(
			harness.session
				.buildSessionContext()
				.messages.map((message) => message.role),
		).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user", // the queued prompt, still on the repaired branch
		]);
		// The context repair hook stays armed because no supported navigation ran.
		const context = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
	});

	it("ignores manual invocations with no pending refresh", async () => {
		const harness = createHarness({
			action: "edit",
			setupSession(session) {
				const callA = { id: "read-a", name: "read" };
				const callB = { id: "bash-b", name: "bash" };
				appendUser(session, "Investigate the deployment");
				appendToolCalls(session, [callA]);
				appendToolResult(session, callA, "configuration");
				appendToolCalls(session, [callB]);
				appendToolResult(session, callB, "log scan output");
			},
		});
		await harness.refuse();
		await harness.settle();

		const command = harness.commands["claude-refusal-rewind"];
		expect(command).toBeDefined();
		const navigationsBefore = harness.navigateTreeCalls.length;
		const markersBefore = harness.appendedEntries.length;
		const targetEntry = harness.session.getLeafId()!;

		// After the dispatched refresh consumed the pending leaf, further manual
		// runs have nothing to act on and must not touch the session.
		await command.handler("anything", harness.commandCtx);
		await command.handler("", harness.commandCtx);
		expect(harness.navigateTreeCalls).toHaveLength(navigationsBefore);
		expect(harness.appendedEntries).toHaveLength(markersBefore);
		expect(harness.session.getLeafId()).toBe(targetEntry);
		expect(harness.notifications).toEqual([]);
	});

	it("falls back to the legacy behavior when another extension owns the command name", async () => {
		const harness = createHarness({
			action: "edit",
			commandNameCollision: true,
			setupSession(session) {
				const callA = { id: "read-a", name: "read" };
				const callB = { id: "bash-b", name: "bash" };
				appendUser(session, "Investigate the deployment");
				appendToolCalls(session, [callA]);
				appendToolResult(session, callA, "configuration");
				appendToolCalls(session, [callB]);
				appendToolResult(session, callB, "log scan output");
			},
		});

		await harness.refuse();
		await harness.settle();

		// pi renamed the duplicate command, so bare-name dispatch would submit
		// literal text: the extension must not dispatch at all.
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.navigateTreeCalls).toEqual([]);
		expect(
			harness.session
				.buildSessionContext()
				.messages.map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult"]);
		const context = (await harness.handlers.context[0]({}, harness.ctx)) as {
			messages: Array<{ role: string }>;
		};
		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});
});

describe("command dispatch support", () => {
	it("tracks the pi release that added expandPromptTemplates", () => {
		expect(supportsCommandDispatch("0.84.2")).toBe(true);
		expect(supportsCommandDispatch("0.84.3")).toBe(true);
		expect(supportsCommandDispatch("0.85.0")).toBe(true);
		expect(supportsCommandDispatch("1.0.0")).toBe(true);
		expect(supportsCommandDispatch("0.84.1")).toBe(false);
		expect(supportsCommandDispatch("0.84.0")).toBe(false);
		expect(supportsCommandDispatch("0.83.9")).toBe(false);
	});
	it("rejects prerelease, branch, and unparseable versions", () => {
		// These may predate the dispatch feature; fail closed instead of
		// guessing (a wrong guess submits command text as a literal prompt).
		expect(supportsCommandDispatch("0.84.2-beta.1")).toBe(false);
		expect(supportsCommandDispatch("0.84.2-dev.1")).toBe(false);
		expect(supportsCommandDispatch("0.85.0-rc.1")).toBe(false);
		expect(supportsCommandDispatch("0.84.2+build.5")).toBe(false);
		expect(supportsCommandDispatch("main")).toBe(false);
		expect(supportsCommandDispatch("")).toBe(false);
		expect(supportsCommandDispatch("0.84")).toBe(false);
	});
});

describe("automatic and non-interactive handling", () => {
	it("auto mode skips the menu and continues after the refusal is persisted", async () => {
		process.env.PI_CLAUDE_AUTH_REFUSAL_MODE = "auto";
		const harness = createHarness();
		await harness.refuse();
		expect(harness.menuCalls).toBe(0);
		expect(harness.sentMessages).toHaveLength(1);
	});

	it("ask mode stops instead of silently choosing without an interactive UI", async () => {
		const harness = createHarness({ mode: "print" });
		await harness.refuse();
		expect(harness.menuCalls).toBe(0);
		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toEqual([
			{
				message:
					"Claude Fable 5 returned an Anthropic classifier refusal. Interactive refusal handling requires an interactive UI.",
				kind: "error",
			},
		]);
	});
});
