import type {
	ExtensionAPI,
	ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

const OPUS_FALLBACK_MODEL_ID = "claude-opus-4-8";
const CONTINUE_MESSAGE_TYPE = "claude-refusal-continue";
const BRANCH_ENTRY_TYPE = "claude-refusal-branch";
const REWIND_COMMAND = "claude-refusal-rewind";
const MIN_PI_VERSION_FOR_DISPATCH = "0.84.2";

interface AssistantRefusalCandidate {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

function isAnthropicFableOrOpus5(model: unknown): boolean {
	if (typeof model !== "string") return false;
	const id = model.toLowerCase();
	return id.includes("claude-fable-5") || id.includes("claude-opus-5");
}

/**
 * Match Anthropic's refusal wording.
 *
 * Anthropic returns a refusal as a normal response carrying a stable category
 * (`cyber`, `bio`, ...) plus a free-text explanation, and Pi keeps only the
 * explanation. Anthropic documents that text as unstable and asks callers to
 * display rather than parse it, so this pattern is the widest net available:
 * live refusals read "This request was declined because it could enable cyber
 * harm", while Pi substitutes "The model refused to complete the request" when
 * Anthropic sends no explanation.
 */
function isRefusalError(message: unknown): boolean {
	if (typeof message !== "string") return false;
	return /refus|declin|classifier|safety|safeguard|usage policy|violative|refusals-and-fallback/i.test(
		message,
	);
}

export function shouldHandleRefusal(
	message: AssistantRefusalCandidate,
): boolean {
	return (
		message.role === "assistant" &&
		message.provider === "anthropic" &&
		isAnthropicFableOrOpus5(message.model) &&
		message.stopReason === "error" &&
		isRefusalError(message.errorMessage)
	);
}

export function getRefusalMode(): "ask" | "auto" {
	return process.env.PI_CLAUDE_AUTH_REFUSAL_MODE?.toLowerCase() === "auto"
		? "auto"
		: "ask";
}

function parseVersion(version: string): [number, number, number] | null {
	// Prerelease/build metadata ("0.84.2-beta.1"), branch names ("main"), and
	// anything else non-numeric are unknown quantities: fail closed instead of
	// guessing whether command dispatch exists.
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match
		? [Number(match[1]), Number(match[2]), Number(match[3])]
		: null;
}

/**
 * Dispatching commands from event handlers requires pi >= 0.84.2, which added
 * `expandPromptTemplates` to `pi.sendUserMessage()`. Older, prerelease, and
 * unparseable versions record the command text as a literal user message, so
 * they must keep the old behavior.
 */
export function supportsCommandDispatch(piVersion: string): boolean {
	const version = parseVersion(piVersion);
	const minimum = parseVersion(MIN_PI_VERSION_FOR_DISPATCH);
	if (version === null || minimum === null) return false;
	for (let i = 0; i < 3; i++) {
		if (version[i] !== minimum[i]) return version[i] > minimum[i];
	}
	return true;
}

function displayModelName(
	ctx: ExtensionContext,
	provider: string,
	modelId: unknown,
): string {
	if (typeof modelId !== "string" || modelId.trim().length === 0)
		return "unknown model";
	if (ctx.model?.id === modelId && ctx.model.name) return ctx.model.name;
	return ctx.modelRegistry.find(provider, modelId)?.name || modelId;
}

interface SessionMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	message: { role?: string };
}

function messageEntry(
	sessionManager: ExtensionContext["sessionManager"],
	id: string,
): SessionMessageEntry | undefined {
	const entry = sessionManager.getEntry(id);
	return entry?.type === "message"
		? (entry as unknown as SessionMessageEntry)
		: undefined;
}

/**
 * Compute the active leaf that skips both the trigger event and the refusal.
 *
 * Tool results are climbed first: a tool-call batch and its results are atomic,
 * so the whole batch is abandoned by keeping the parent of the assistant message
 * that started it. Any other trigger keeps its own parent, which drops the
 * triggering message itself.
 *
 * A null result means the trigger was the root entry and the leaf must be reset.
 */
export function computeBranchTarget(
	sessionManager: ExtensionContext["sessionManager"],
	triggerId: string,
): string | null {
	let current = messageEntry(sessionManager, triggerId);
	if (!current) return triggerId;

	while (current.message.role === "toolResult") {
		if (!current.parentId) return null;
		const parent = messageEntry(sessionManager, current.parentId);
		if (!parent) return current.parentId;
		current = parent;
	}

	return current.parentId;
}

function hasRefusalBranchMarker(
	sessionManager: ExtensionContext["sessionManager"],
): boolean {
	return sessionManager
		.getBranch()
		.some(
			(entry) =>
				entry.type === "custom" && entry.customType === BRANCH_ENTRY_TYPE,
		);
}

/**
 * navigateTree() moves the leaf *before* user and custom messages and lifts
 * their text into the editor (pi's "edit that prompt" semantics). The refusal
 * rewind must keep those entries in context, so targets navigateTree() would
 * lift cannot use it.
 */
async function chooseRefusalAction(
	ctx: ExtensionContext,
	refusedModelName: string,
	fallbackModelName: string,
	canEdit: boolean,
): Promise<"continue" | "edit" | undefined> {
	const continueLabel = `Continue with ${fallbackModelName}`;
	const editLabel = `Edit and retry with ${refusedModelName}`;
	const choice = await ctx.ui.select(
		`${refusedModelName}'s safeguards flagged this response.`,
		canEdit ? [continueLabel, editLabel] : [continueLabel],
	);
	if (choice === continueLabel) return "continue";
	if (choice === editLabel) return "edit";
	return undefined;
}

/**
 * Find the entry Pi persisted for this exact message object.
 *
 * The leaf is not reliable here: extension `agent_end` handlers run serially,
 * so another extension can append an entry and move the leaf before this one
 * runs. SessionManager stores the message object itself, so identity is exact.
 */
function findEntryIdByMessage(
	sessionManager: ExtensionContext["sessionManager"],
	message: unknown,
): string | undefined {
	const entries = sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message === message) return entry.id;
	}
	return undefined;
}

function lastAssistantMessage(
	messages: unknown[],
): AssistantRefusalCandidate | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as AssistantRefusalCandidate;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

export function registerRetryAfterRefusal(
	pi: ExtensionAPI,
	options: { piVersion?: string } = {},
): void {
	let needsContextRebuild = false;
	const dispatchSupported = supportsCommandDispatch(
		options.piVersion ?? VERSION,
	);
	// The session leaf the dispatched refresh command must still find before it
	// rebuilds the transcript. Set right after the synchronous rewind; consumed
	// once by the command.
	let pendingRefreshLeafId: string | undefined;

	// Only an extension reload leaves Pi's agent state behind: every other entry
	// path rebuilds it from the session branch, which is already the repaired one.
	pi.on("session_start", (event, ctx) => {
		needsContextRebuild =
			event.reason === "reload" && hasRefusalBranchMarker(ctx.sessionManager);
	});

	async function continueWithFallback(
		ctx: ExtensionContext,
		refusedModelName: string,
	): Promise<void> {
		const fallbackModelName = displayModelName(
			ctx,
			"anthropic",
			OPUS_FALLBACK_MODEL_ID,
		);
		const fallbackModel = ctx.modelRegistry.find(
			"anthropic",
			OPUS_FALLBACK_MODEL_ID,
		);
		const switched = fallbackModel ? await pi.setModel(fallbackModel) : false;
		if (!switched) {
			ctx.ui.notify(
				`${refusedModelName} refusal detected, but ${fallbackModelName} could not be selected.`,
				"error",
			);
			return;
		}

		ctx.ui.notify(
			`Switched to ${fallbackModelName} and continuing from the current state.`,
			"warning",
		);
		pi.sendMessage(
			{
				customType: CONTINUE_MESSAGE_TYPE,
				content: "continue",
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	// Rewind the session to `targetId` by direct SessionManager mutation and
	// persist the selection with a hidden marker entry. Returns false when the
	// leaf move itself failed.
	function rewindDirectly(
		ctx: ExtensionContext,
		triggerId: string,
		targetId: string | null,
	): boolean {
		const sm = ctx.sessionManager as unknown as SessionManager;
		try {
			if (targetId === null) sm.resetLeaf();
			else sm.branch(targetId);
		} catch {
			ctx.ui.notify(
				"Could not branch to the point before the refusal.",
				"error",
			);
			return false;
		}

		try {
			pi.appendEntry(BRANCH_ENTRY_TYPE, { triggerId, targetId });
		} catch {
			ctx.ui.notify(
				"Branched before the refusal, but could not persist that branch selection.",
				"warning",
			);
		}

		needsContextRebuild = true;
		return true;
	}

	if (dispatchSupported) {
		pi.registerCommand(REWIND_COMMAND, {
			description:
				"Rewind the session after a classifier refusal (used automatically by pi-claude-auth)",
			handler: async (_args, ctx) => {
				const expectedLeafId = pendingRefreshLeafId;
				pendingRefreshLeafId = undefined;
				// The command is visible to users (autocomplete, getCommands()):
				// without a pending refresh, manual runs are no-ops.
				if (!expectedLeafId) return;

				try {
					await ctx.waitForIdle();
					if (ctx.sessionManager.getLeafId() !== expectedLeafId) {
						ctx.ui.notify(
							"New input arrived after the rewind, so the transcript was not refreshed. Visit /tree to refresh the view.",
							"info",
						);
						return;
					}
					// Navigating to the current leaf is a no-op in pi core — it
					// returns before the awaited session_before_tree hooks, so no
					// input can interleave and nothing is ever branched over —
					// while the TUI wrapper still clears and re-renders the
					// transcript. Agent state stays stale; the context hook
					// below repairs every provider request.
					await ctx.navigateTree(expectedLeafId);
				} catch (error) {
					ctx.ui.notify(
						`Branched before the refusal, but could not refresh the transcript (${error instanceof Error ? error.message : String(error)}). Visit /tree or /reload to refresh it.`,
						"warning",
					);
				}
			},
		});
	}

	// Fail closed on a name collision: pi gives duplicate commands
	// colon-suffixed invocation names (e.g. `claude-refusal-rewind:1`), and
	// dispatching the bare name would fall through to a literal user prompt
	// instead of the command. Command names can change at runtime, and
	// getCommands() cannot run during extension loading, so this is checked on
	// every dispatch.
	const dispatchAvailable = (): boolean =>
		dispatchSupported &&
		pi.getCommands().some((command) => command.name === REWIND_COMMAND);

	// A classifier refusal ends the run, so `agent_end` always follows it, fires
	// once, and — unlike `message_end` — runs after Pi has persisted the refusal.
	// That persistence is what gives Edit a session entry to rewind from.
	pi.on("agent_end", async (event, ctx) => {
		const message = lastAssistantMessage(event.messages);
		if (!message || !shouldHandleRefusal(message)) return;

		const refusedModelName = displayModelName(ctx, "anthropic", message.model);
		if (getRefusalMode() === "auto") {
			await continueWithFallback(ctx, refusedModelName);
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify(
				`${refusedModelName} returned an Anthropic classifier refusal. Interactive refusal handling requires an interactive UI.`,
				"error",
			);
			return;
		}

		// The event that triggered the refusal is the refusal entry's parent.
		const refusalId = findEntryIdByMessage(ctx.sessionManager, message);
		const triggerId = refusalId
			? (messageEntry(ctx.sessionManager, refusalId)?.parentId ?? null)
			: null;

		const action = await chooseRefusalAction(
			ctx,
			refusedModelName,
			displayModelName(ctx, "anthropic", OPUS_FALLBACK_MODEL_ID),
			triggerId !== null,
		);

		if (action === "continue") {
			await continueWithFallback(ctx, refusedModelName);
			return;
		}
		if (action !== "edit" || !triggerId) return;

		const targetId = computeBranchTarget(ctx.sessionManager, triggerId);
		const draft = ctx.ui.getEditorText();

		// Edit: rewind synchronously — the same direct leaf move the extension
		// has always done — then hand the prompt box back. The synchronous move
		// is what keeps input queued while the refusal was settling safe: pi
		// drains its queue only after this handler returns, so the queued prompt
		// lands on the repaired branch. Afterwards the rewind marker is the
		// session leaf; on pi >= 0.84.2 a dispatched internal command waits for
		// idle, confirms the leaf is still that marker, and no-op-navigates to
		// it so the TUI re-renders the repaired transcript.
		if (!rewindDirectly(ctx, triggerId, targetId)) return;

		// Only the TUI has a transcript to refresh; RPC has no view and print
		// mode never reaches the interactive menu.
		if (ctx.mode === "tui" && dispatchAvailable()) {
			pendingRefreshLeafId = ctx.sessionManager.getLeafId() ?? undefined;
			if (pendingRefreshLeafId) {
				pi.sendUserMessage(`/${REWIND_COMMAND}`, {
					expandPromptTemplates: true,
				});
			}
		}
		ctx.ui.setEditorText(draft);
	});

	// Safety net: direct branching does not mutate agent.state.messages. Rebuild
	// every provider context from the active session branch until Pi performs an
	// operation that synchronizes its own state.
	pi.on("context", async (_event, ctx) => {
		if (!needsContextRebuild) return undefined;
		const sessionContext = (
			ctx.sessionManager as unknown as SessionManager
		).buildSessionContext();
		return { messages: sessionContext.messages };
	});

	const markContextSynchronized = () => {
		needsContextRebuild = false;
	};
	pi.on("session_tree", markContextSynchronized);
	pi.on("session_compact", markContextSynchronized);
}
