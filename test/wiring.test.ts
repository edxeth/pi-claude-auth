import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import loadExtension from "../src/index.ts"

interface SpyPi {
    registerProviderCalls: { name: string; config: Record<string, unknown> }[]
    handlers: Record<string, Function[]>
}

function makeSpyPi(): SpyPi & {
    registerProvider(name: string, config: Record<string, unknown>): void
    on(event: string, handler: Function): void
} {
    const registerProviderCalls: { name: string; config: Record<string, unknown> }[] = []
    const handlers: Record<string, Function[]> = {}
    return {
        registerProviderCalls,
        handlers,
        registerProvider(name, config) {
            registerProviderCalls.push({ name, config })
        },
        on(event, handler) {
            ;(handlers[event] ??= []).push(handler)
        },
    }
}

describe("extension wiring (Pi owns the OAuth lifecycle)", () => {
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-"))
        process.env.PI_CODING_AGENT_DIR = dir
        // Valid semver -> version resolver takes the "env" path (no network),
        // and produces no degraded-version alert, so session_start stays quiet.
        process.env.ANTHROPIC_CLI_VERSION = "1.2.3"
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        delete process.env.PI_CODING_AGENT_DIR
        delete process.env.ANTHROPIC_CLI_VERSION
    })

    it("registers the anthropic provider with headers and NO custom oauth lifecycle", async () => {
        // No auth.json present: the user has not logged in yet. The extension
        // must still register the provider so `/login anthropic` (Pi's built-in
        // browser flow) is available.
        const spy = makeSpyPi()
        await loadExtension(spy as unknown as ExtensionAPI)

        const reg = spy.registerProviderCalls.find((c) => c.name === "anthropic")
        expect(reg).toBeDefined()
        // The whole point: the extension must NOT shadow Pi's built-in OAuth
        // provider. A registered `oauth` field would overwrite it.
        expect(reg!.config.oauth).toBeUndefined()
        expect(reg!.config.headers).toBeDefined()
        const ua = (reg!.config.headers as Record<string, unknown>)["user-agent"]
        expect(typeof ua).toBe("string")
        expect(ua as string).toContain("claude-cli/")
    })

    it("registers before_provider_request and session_start hooks even when logged out", async () => {
        const spy = makeSpyPi()
        await loadExtension(spy as unknown as ExtensionAPI)

        expect(spy.handlers["before_provider_request"]?.length).toBeGreaterThan(0)
        expect(spy.handlers["session_start"]?.length).toBeGreaterThan(0)
    })

    it("does not write to auth storage on session_start (Pi owns auth.json)", async () => {
        // The extension must not re-set or persist the OAuth credential. Pi
        // already loaded auth.json at startup and getApiKey already prefers the
        // OAuth token over ANTHROPIC_API_KEY, so any re-write is pointless and
        // risks clobbering a fresher token rotated by another pi process.
        const spy = makeSpyPi()
        await loadExtension(spy as unknown as ExtensionAPI)

        let setCalled = false
        const ctx = {
            mode: "tui",
            modelRegistry: { authStorage: { set: () => { setCalled = true } } },
            ui: { custom: async () => {} },
        }
        await spy.handlers["session_start"]![0]!({ reason: "startup" }, ctx)
        expect(setCalled).toBe(false)
    })
})
