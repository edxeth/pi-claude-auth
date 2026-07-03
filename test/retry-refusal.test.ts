import { describe, expect, it } from "bun:test";
import {
	createRetryAfterRefusalState,
	registerRetryAfterRefusal,
	shouldRetryWithOpus,
} from "../src/retry-refusal.ts";

type Handler = (...args: unknown[]) => unknown;

describe("retry-after-refusal detection", () => {
	it("retries Anthropic Fable classifier refusals with Opus", () => {
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				stopReason: "error",
				errorMessage: "The model refused to complete the request",
			}),
		).toBe(true);
	});

	it("matches the live Anthropic policy-block wording", () => {
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				stopReason: "error",
				errorMessage:
					"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
			}),
		).toBe(true);
	});

	it("stays inert for unrelated assistant errors", () => {
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "error",
				errorMessage: "The model refused to complete the request",
			}),
		).toBe(false);
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "openrouter",
				model: "claude-fable-5",
				stopReason: "error",
				errorMessage: "The model refused to complete the request",
			}),
		).toBe(false);
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				stopReason: "stop",
				errorMessage: "The model refused to complete the request",
			}),
		).toBe(false);
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				stopReason: "error",
				errorMessage: "network timeout",
			}),
		).toBe(false);
		expect(
			shouldRetryWithOpus({
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				stopReason: "error",
				errorMessage: "request blocked by proxy",
			}),
		).toBe(false);
	});
});

describe("retry-after-refusal state", () => {
	it("returns the last user prompt once and prevents retry loops", () => {
		const state = createRetryAfterRefusalState();
		state.noteMessage({ role: "user", content: "Explain a risky topic" });

		const refusal = {
			role: "assistant",
			provider: "anthropic",
			model: "claude-fable-5",
			stopReason: "error",
			errorMessage: "The request was blocked by a safety classifier",
		};

		expect(state.consumeRetry(refusal)).toEqual({
			content: "Explain a risky topic",
			fallbackModelId: "claude-opus-4-8",
		});
		expect(state.consumeRetry(refusal)).toBeUndefined();

		state.noteMessage({ role: "user", content: "Explain a risky topic" });
		expect(state.consumeRetry(refusal)).toBeUndefined();

		state.completeRetry();
		state.noteMessage({ role: "user", content: "Explain a risky topic" });
		expect(state.consumeRetry(refusal)).toEqual({
			content: "Explain a risky topic",
			fallbackModelId: "claude-opus-4-8",
		});
	});

	it("preserves structured user content when retrying", () => {
		const state = createRetryAfterRefusalState();
		const content = [{ type: "text", text: "Explain a risky topic" }];
		state.noteMessage({ role: "user", content });

		expect(
			state.consumeRetry({
				role: "assistant",
				provider: "anthropic",
				model: "claude-mythos-5",
				stopReason: "error",
				errorMessage: "The request was blocked by a safety classifier",
			}),
		).toEqual({
			content,
			fallbackModelId: "claude-opus-4-8",
		});
	});
});

describe("retry-after-refusal extension wiring", () => {
	it("announces the retry, switches to Opus, resends the last user prompt, and restores the previous model", async () => {
		const handlers: Record<string, Handler[]> = {};
		const notifications: unknown[] = [];
		const sentUserMessages: unknown[] = [];
		const selectedModels: unknown[] = [];
		const fableModel = {
			provider: "anthropic",
			id: "claude-fable-5",
			name: "Claude Fable 5",
		};
		const opusModel = {
			provider: "anthropic",
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
		};
		const pi = {
			on(event: string, handler: Handler) {
				handlers[event] = [...(handlers[event] ?? []), handler];
			},
			sendUserMessage(content: unknown, options: unknown) {
				sentUserMessages.push({ content, options });
			},
			async setModel(model: unknown) {
				selectedModels.push(model);
				return true;
			},
		};
		const ctx = {
			model: fableModel,
			modelRegistry: {
				find(provider: string, id: string) {
					return provider === "anthropic" && id === "claude-opus-4-8"
						? opusModel
						: undefined;
				},
			},
			ui: {
				notify(message: string, kind: string) {
					notifications.push({ message, kind });
				},
			},
		};

		registerRetryAfterRefusal(pi);

		await handlers.message_end?.[0]?.(
			{ message: { role: "user", content: "Explain a risky topic" } },
			ctx,
		);
		await handlers.message_end?.[0]?.(
			{
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-fable-5",
					stopReason: "error",
					errorMessage: "The request was blocked by a safety classifier",
				},
			},
			ctx,
		);

		expect(notifications).toEqual([
			{
				message:
					"Claude Fable 5 returned an Anthropic classifier refusal. Retrying the last user request with Claude Opus 4.8.",
				kind: "warning",
			},
		]);
		expect(selectedModels).toEqual([opusModel]);
		expect(sentUserMessages).toEqual([
			{
				content: "Explain a risky topic",
				options: { deliverAs: "followUp" },
			},
		]);

		await handlers.agent_end?.[0]?.(
			{ messages: [{ role: "assistant", model: "claude-fable-5" }] },
			ctx,
		);
		expect(selectedModels).toEqual([opusModel]);

		await handlers.agent_end?.[0]?.(
			{ messages: [{ role: "assistant", model: "claude-opus-4-8" }] },
			ctx,
		);
		expect(selectedModels).toEqual([opusModel, fableModel]);
	});

	it("does not restore to Fable before the queued Opus retry completes", async () => {
		const handlers: Record<string, Handler[]> = {};
		const selectedModels: unknown[] = [];
		const fableModel = { provider: "anthropic", id: "claude-fable-5" };
		const opusModel = {
			provider: "anthropic",
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
		};
		const pi = {
			on(event: string, handler: Handler) {
				handlers[event] = [...(handlers[event] ?? []), handler];
			},
			sendUserMessage() {},
			async setModel(model: unknown) {
				selectedModels.push(model);
				return true;
			},
		};
		const ctx = {
			model: fableModel,
			modelRegistry: {
				find() {
					return opusModel;
				},
			},
			ui: { notify() {} },
		};

		registerRetryAfterRefusal(pi);

		await handlers.message_end?.[0]?.(
			{ message: { role: "user", content: "Explain a risky topic" } },
			ctx,
		);
		await handlers.message_end?.[0]?.(
			{
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-fable-5",
					stopReason: "error",
					errorMessage: "The request was blocked by a safety classifier",
				},
			},
			ctx,
		);

		await handlers.agent_end?.[0]?.(
			{ messages: [{ role: "assistant", model: "claude-fable-5" }] },
			ctx,
		);
		expect(selectedModels).toEqual([opusModel]);
	});

	it("clears restore state on the immediate retry cycle even if no Opus message appears", async () => {
		const handlers: Record<string, Handler[]> = {};
		const selectedModels: unknown[] = [];
		const fableModel = { provider: "anthropic", id: "claude-fable-5" };
		const opusModel = {
			provider: "anthropic",
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
		};
		const pi = {
			on(event: string, handler: Handler) {
				handlers[event] = [...(handlers[event] ?? []), handler];
			},
			sendUserMessage() {},
			async setModel(model: unknown) {
				selectedModels.push(model);
				return true;
			},
		};
		const ctx = {
			model: fableModel,
			modelRegistry: { find: () => opusModel },
			ui: { notify() {} },
		};

		registerRetryAfterRefusal(pi);

		await handlers.message_end?.[0]?.(
			{ message: { role: "user", content: "Explain a risky topic" } },
			ctx,
		);
		await handlers.message_end?.[0]?.(
			{
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-fable-5",
					stopReason: "error",
					errorMessage: "The request was blocked by a safety classifier",
				},
			},
			ctx,
		);

		await handlers.agent_end?.[0]?.(
			{ messages: [{ role: "assistant", model: "claude-fable-5" }] },
			ctx,
		);
		expect(selectedModels).toEqual([opusModel]);

		await handlers.agent_end?.[0]?.({ messages: [] }, ctx);
		expect(selectedModels).toEqual([opusModel, fableModel]);

		await handlers.agent_end?.[0]?.(
			{ messages: [{ role: "assistant", model: "claude-opus-4-8" }] },
			ctx,
		);
		expect(selectedModels).toEqual([opusModel, fableModel]);
	});

	it("does not claim a retry when Opus cannot be selected", async () => {
		const handlers: Record<string, Handler[]> = {};
		const notifications: unknown[] = [];
		const sentUserMessages: unknown[] = [];
		const pi = {
			on(event: string, handler: Handler) {
				handlers[event] = [...(handlers[event] ?? []), handler];
			},
			sendUserMessage(content: unknown, options: unknown) {
				sentUserMessages.push({ content, options });
			},
			async setModel() {
				return false;
			},
		};
		const ctx = {
			model: {
				provider: "anthropic",
				id: "claude-fable-5",
				name: "Claude Fable 5",
			},
			modelRegistry: {
				find(_provider: string, id: string) {
					if (id === "claude-fable-5")
						return { provider: "anthropic", id, name: "Claude Fable 5" };
					if (id === "claude-opus-4-8")
						return { provider: "anthropic", id, name: "Claude Opus 4.8" };
					return undefined;
				},
			},
			ui: {
				notify(message: string, kind: string) {
					notifications.push({ message, kind });
				},
			},
		};

		registerRetryAfterRefusal(pi);

		await handlers.message_end?.[0]?.(
			{ message: { role: "user", content: "Explain a risky topic" } },
			ctx,
		);
		await handlers.message_end?.[0]?.(
			{
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-fable-5",
					stopReason: "error",
					errorMessage: "The request was blocked by a safety classifier",
				},
			},
			ctx,
		);

		expect(notifications).toEqual([
			{
				message:
					"Claude Fable 5 refusal detected, but Claude Opus 4.8 could not be selected.",
				kind: "error",
			},
		]);
		expect(sentUserMessages).toEqual([]);
	});
});
