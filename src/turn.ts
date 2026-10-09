import { randomUUID } from "node:crypto";

/**
 * Claude Code turn bookkeeping for the billing header.
 *
 * Real Claude Code (verified against 2.1.295 first-party traffic) stamps every
 * request with the prompt it belongs to:
 *
 *   cc_prompt_id=<uuid>     stable across the requests of one user prompt
 *   cc_turn_origin=sdk      fixed for SDK-shaped traffic
 *   cc_prompt_index=<n>     0-based count of prompts in the session
 *   cc_turn_index=<n>       1-based count of API requests within the prompt
 *
 * A "prompt" spans every request of one agentic loop: the initial call and
 * each tool-result continuation. This module recovers the same bookkeeping
 * from the wire messages alone, so the single resolution point stays inside
 * the payload transform:
 *
 * - The last user message whose content is not purely tool_result blocks
 *   starts a new prompt.
 * - A trailing user message that is purely tool_result blocks continues the
 *   current prompt (turnIndex advances).
 * - A rewound or compacted history (prompt position moved or vanished)
 *   starts a new prompt rather than guessing at the old one.
 */

export const TURN_ORIGIN = "sdk";

export interface TurnStamp {
	promptId: string;
	promptIndex: number;
	turnIndex: number;
}

interface WireMessage {
	role?: string;
	content?: string | Array<{ type?: string }>;
}

interface SessionTurnState {
	promptId: string;
	promptIndex: number;
	promptMessageIndex: number;
	turnIndex: number;
}

// Keyed by session id; entries are tiny (two numbers, an index, a UUID) and
// pi runs few sessions per process, so entries are kept for the process
// lifetime.
const sessions = new Map<string, SessionTurnState>();

function isToolResultContinuation(message: WireMessage): boolean {
	const content = message.content;
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every((block) => block.type === "tool_result")
	);
}

function findLastUserIndex(messages: WireMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

/**
 * Resolve the turn stamp for one request. Called exactly once per outgoing
 * request; every later consumer (billing header fields, the prompt-id
 * transport header) reads the returned stamp so the values cannot diverge.
 */
export function nextTurn(
	sessionKey: string,
	messages: WireMessage[],
): TurnStamp {
	const lastUserIndex = findLastUserIndex(messages);
	const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
	const continuation =
		lastUser !== undefined && isToolResultContinuation(lastUser);

	const state = sessions.get(sessionKey);
	if (!state || (!continuation && lastUserIndex !== state.promptMessageIndex)) {
		const fresh: SessionTurnState = {
			promptId: randomUUID(),
			promptIndex: (state?.promptIndex ?? -1) + 1,
			promptMessageIndex: lastUserIndex,
			turnIndex: 1,
		};
		sessions.set(sessionKey, fresh);
		return { ...fresh };
	}

	state.turnIndex += 1;
	return { ...state };
}
