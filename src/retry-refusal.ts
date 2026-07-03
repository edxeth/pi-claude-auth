export const OPUS_FALLBACK_MODEL_ID = "claude-opus-4-8"

export interface AssistantRefusalCandidate {
    role?: unknown
    provider?: unknown
    model?: unknown
    stopReason?: unknown
    errorMessage?: unknown
}

function isAnthropicFableOrMythos(model: unknown): boolean {
    if (typeof model !== "string") return false
    const id = model.toLowerCase()
    return id.includes("claude-fable-5") || id.includes("claude-mythos-5")
}

function isRefusalError(message: unknown): boolean {
    if (typeof message !== "string") return false
    return /refus|classifier|safety|usage policy|violative|refusals-and-fallback/i.test(message)
}

export function shouldRetryWithOpus(message: AssistantRefusalCandidate): boolean {
    return (
        message.role === "assistant" &&
        message.provider === "anthropic" &&
        isAnthropicFableOrMythos(message.model) &&
        message.stopReason === "error" &&
        isRefusalError(message.errorMessage)
    )
}

export interface RetryableUserMessage {
    role?: unknown
    content?: unknown
}

export type RetryUserContent = string | unknown[]

export interface RetryDecision {
    content: RetryUserContent
    fallbackModelId: string
}

function getRetryableUserContent(content: unknown): RetryUserContent | undefined {
    if (typeof content === "string") return content.trim().length > 0 ? content : undefined
    if (!Array.isArray(content) || content.length === 0) return undefined
    return content
}

function getContentKey(content: RetryUserContent): string {
    return typeof content === "string" ? `text:${content}` : `blocks:${JSON.stringify(content)}`
}

export function createRetryAfterRefusalState() {
    let lastUserContent: RetryUserContent | undefined
    let lastUserKey: string | undefined
    let retriedUserKey: string | undefined

    return {
        noteMessage(message: RetryableUserMessage): void {
            if (message.role !== "user") return
            const content = getRetryableUserContent(message.content)
            if (!content) return
            const key = getContentKey(content)
            lastUserContent = content
            lastUserKey = key
            if (retriedUserKey !== key) {
                retriedUserKey = undefined
            }
        },

        consumeRetry(message: AssistantRefusalCandidate): RetryDecision | undefined {
            if (!lastUserContent || !lastUserKey || retriedUserKey === lastUserKey) return undefined
            if (!shouldRetryWithOpus(message)) return undefined
            retriedUserKey = lastUserKey
            return {
                content: lastUserContent,
                fallbackModelId: OPUS_FALLBACK_MODEL_ID,
            }
        },

        completeRetry(): void {
            retriedUserKey = undefined
        },
    }
}

export interface RetryAfterRefusalPi {
    on(event: "message_end", handler: (event: { message: unknown }, ctx: RetryAfterRefusalContext) => unknown): void
    on(event: "agent_end", handler: (event: { messages?: unknown[] }, ctx: RetryAfterRefusalContext) => unknown): void
    sendUserMessage(content: RetryUserContent, options: { deliverAs: "followUp" }): void
    setModel(model: unknown): Promise<boolean> | boolean
}

export interface RetryAfterRefusalContext {
    model?: unknown
    modelRegistry: {
        find(provider: string, id: string): unknown
    }
    ui?: {
        notify(message: string, kind: "info" | "warning" | "error"): void
    }
}

function modelField(model: unknown, field: "id" | "name"): string | undefined {
    if (!model || typeof model !== "object") return undefined
    const value = (model as Record<string, unknown>)[field]
    return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function displayModelName(ctx: RetryAfterRefusalContext, provider: string, modelId: unknown): string {
    if (typeof modelId !== "string" || modelId.trim().length === 0) return "unknown model"

    const selectedId = modelField(ctx.model, "id")
    const selectedName = modelField(ctx.model, "name")
    if (selectedId === modelId && selectedName) return selectedName

    const registryModel = ctx.modelRegistry.find(provider, modelId)
    return modelField(registryModel, "name") ?? modelId
}

export function registerRetryAfterRefusal(pi: RetryAfterRefusalPi): void {
    const state = createRetryAfterRefusalState()
    let pendingRestoreModel: unknown
    let restorePhase: "skip-current" | "await-retry" | undefined

    pi.on("message_end", async (event, ctx) => {
        const message = event.message as RetryableUserMessage & AssistantRefusalCandidate
        state.noteMessage(message)
        const retry = state.consumeRetry(message)
        if (!retry) return

        const refusedModelName = displayModelName(ctx, "anthropic", message.model)
        const fallbackModel = ctx.modelRegistry.find("anthropic", retry.fallbackModelId)
        const fallbackModelName = displayModelName(ctx, "anthropic", retry.fallbackModelId)
        if (!fallbackModel) {
            ctx.ui?.notify(`${refusedModelName} refusal detected, but ${fallbackModelName} could not be selected.`, "error")
            return
        }

        const previousModel = ctx.model
        const switched = await pi.setModel(fallbackModel)
        if (!switched) {
            ctx.ui?.notify(`${refusedModelName} refusal detected, but ${fallbackModelName} could not be selected.`, "error")
            return
        }
        pendingRestoreModel = previousModel
        restorePhase = "skip-current"
        ctx.ui?.notify(
            `${refusedModelName} returned an Anthropic classifier refusal. Retrying the last user request with ${fallbackModelName}.`,
            "warning",
        )
        pi.sendUserMessage(retry.content, { deliverAs: "followUp" })
    })

    pi.on("agent_end", async () => {
        if (!pendingRestoreModel) return
        if (restorePhase === "skip-current") {
            restorePhase = "await-retry"
            return
        }
        const model = pendingRestoreModel
        pendingRestoreModel = undefined
        restorePhase = undefined
        state.completeRetry()
        await pi.setModel(model)
    })
}
