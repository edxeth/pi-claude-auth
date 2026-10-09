import { describe, expect, it } from "bun:test";
import { nextTurn } from "../src/turn.ts";

/**
 * Turn bookkeeping derived from real Claude Code 2.1.295 first-party traffic:
 * one prompt id per user prompt (0-based index), a 1-based request counter
 * within the prompt, and tool-result continuations advancing the counter
 * without starting a new prompt.
 */

function userText(text: string) {
	return { role: "user", content: [{ type: "text", text }] };
}

function toolResults() {
	return {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t1" }],
	};
}

describe("nextTurn", () => {
	it("stamps the first prompt as index 0, turn 1", () => {
		const stamp = nextTurn("s1", [userText("hello")]);
		expect(stamp.promptIndex).toBe(0);
		expect(stamp.turnIndex).toBe(1);
		expect(stamp.promptId).toMatch(
			/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
		);
	});

	it("keeps one prompt id across tool-result continuations", () => {
		const first = nextTurn("s2", [userText("hello")]);
		const next = nextTurn("s2", [
			userText("hello"),
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			toolResults(),
		]);
		expect(next.promptId).toBe(first.promptId);
		expect(next.promptIndex).toBe(0);
		expect(next.turnIndex).toBe(2);
	});

	it("starts a new prompt for a later user text message", () => {
		const first = nextTurn("s3", [userText("hello")]);
		const second = nextTurn("s3", [
			userText("hello"),
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			userText("next prompt"),
		]);
		expect(second.promptId).not.toBe(first.promptId);
		expect(second.promptIndex).toBe(1);
		expect(second.turnIndex).toBe(1);
	});

	it("treats a rewound history (prompt position vanished) as a new prompt", () => {
		const first = nextTurn("s4", [
			userText("one"),
			userText("two that gets rewound away"),
		]);
		const rewound = nextTurn("s4", [userText("one")]);
		expect(rewound.promptId).not.toBe(first.promptId);
		expect(rewound.promptIndex).toBe(1);
		expect(rewound.turnIndex).toBe(1);
	});

	it("counts a repeated identical request as the next turn of the same prompt", () => {
		const messages = [userText("hello")];
		const first = nextTurn("s5", messages);
		const retry = nextTurn("s5", messages);
		expect(retry.promptId).toBe(first.promptId);
		expect(retry.turnIndex).toBe(2);
	});

	it("tracks sessions independently", () => {
		const a = nextTurn("session-a", [userText("hello")]);
		const b = nextTurn("session-b", [
			userText("hello"),
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			userText("second"),
		]);
		expect(b.promptId).not.toBe(a.promptId);
		expect(b.promptIndex).toBe(0);
	});

	it("handles a user message with mixed tool_result and text as a new prompt", () => {
		const first = nextTurn("s6", [userText("hello")]);
		const mixed = nextTurn("s6", [
			userText("hello"),
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1" },
					{ type: "text", text: "and this" },
				],
			},
		]);
		expect(mixed.promptId).not.toBe(first.promptId);
		expect(mixed.promptIndex).toBe(1);
	});

	it("falls back to a fresh prompt when no user message exists", () => {
		const stamp = nextTurn("s7", [
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		]);
		expect(stamp.promptIndex).toBe(0);
		expect(stamp.turnIndex).toBe(1);
	});
});
