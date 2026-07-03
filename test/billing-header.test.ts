import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { injectBillingHeader } from "../src/transforms.ts"

const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BILLING_PREFIX = "x-anthropic-billing-header"

function claudePayload(overrides: Record<string, unknown> = {}) {
    return {
        model: "claude-sonnet-4-5",
        system: [{ type: "text", text: CC_IDENTITY }],
        messages: [
            { role: "user", content: [{ type: "text", text: "Say hello." }] },
        ],
        ...overrides,
    }
}

describe("injectBillingHeader", () => {
    beforeEach(() => {
        process.env.ANTHROPIC_CLI_VERSION = "1.2.3"
    })
    afterEach(() => {
        delete process.env.ANTHROPIC_CLI_VERSION
    })

    describe("guard clauses", () => {
        it("does nothing for non-Claude models", () => {
            expect(injectBillingHeader(claudePayload({ model: "gpt-5" }))).toBeUndefined()
        })

        it("does nothing when messages is not an array", () => {
            expect(
                injectBillingHeader({ model: "claude-sonnet-4-5", system: [], messages: "nope" }),
            ).toBeUndefined()
        })

        it("does nothing outside OAuth stealth mode (no Claude Code identity block)", () => {
            // A plain API-key request: system has pi's own prompt, not the CC identity.
            expect(
                injectBillingHeader({
                    model: "claude-sonnet-4-5",
                    system: [{ type: "text", text: "You are a helpful assistant." }],
                    messages: [{ role: "user", content: "hi" }],
                }),
            ).toBeUndefined()
        })

        it("is idempotent (does not inject twice)", () => {
            const once = injectBillingHeader(claudePayload()) as { system: { text: string }[] }
            expect(once).toBeDefined()
            // Running the already-injected payload through again must be a no-op.
            expect(injectBillingHeader(once)).toBeUndefined()
        })
    })

    describe("injection + system relocation", () => {
        it("prepends the billing header as system[0] ahead of the identity block", () => {
            const out = injectBillingHeader(claudePayload()) as {
                system: { type: string; text: string }[]
            }
            expect(out.system[0].text.startsWith(BILLING_PREFIX)).toBe(true)
            // Identity block is preserved right after the header.
            expect(out.system[1].text).toBe(CC_IDENTITY)
        })

        it("formats the header as cc_version / cc_entrypoint / cch", () => {
            const out = injectBillingHeader(claudePayload()) as { system: { text: string }[] }
            const header = out.system[0].text
            expect(header).toMatch(/^x-anthropic-billing-header: cc_version=1\.2\.3\.\d{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/)
        })

        it("relocates third-party system text into the first user message (array content)", () => {
            const payload = {
                model: "claude-sonnet-4-5",
                system: [
                    { type: "text", text: CC_IDENTITY },
                    { type: "text", text: "You are pi, a coding agent." },
                ],
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Do the thing." }],
                    },
                ],
            }
            const out = injectBillingHeader(payload) as {
                system: { text: string }[]
                messages: { role: string; content: { type: string; text: string }[] }[]
            }
            // Only billing header + identity remain in system[].
            expect(out.system.map((e) => e.text)).toEqual([
                expect.stringMatching(new RegExp(`^${BILLING_PREFIX}`)),
                CC_IDENTITY,
            ])
            // pi's prompt was prepended to the first user message's content blocks.
            const firstUserContent = out.messages[0].content
            expect(firstUserContent[0].text).toContain("You are pi, a coding agent.")
            expect(firstUserContent[1].text).toBe("Do the thing.")
        })

        it("relocates third-party system text into the first user message (string content)", () => {
            const payload = {
                model: "claude-sonnet-4-5",
                system: [
                    { type: "text", text: CC_IDENTITY },
                    { type: "text", text: "Extra system instructions." },
                ],
                messages: [{ role: "user", content: "Hello there." }],
            }
            const out = injectBillingHeader(payload) as {
                system: { text: string }[]
                messages: { role: string; content: string }[]
            }
            expect(out.system.length).toBe(2)
            const firstUser = out.messages.find((m) => m.role === "user")!
            expect(firstUser.content).toContain("Extra system instructions.")
            expect(firstUser.content).toContain("Hello there.")
        })
    })
})
