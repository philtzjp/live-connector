import { describe, expect, it, vi } from "vitest"
import type { ServerDeps } from "../deps"

// SDK 実体をロードせずに register* を通す。version.ts の注入はグローバルで代替する。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

async function loadBuildHealthPayload() {
    vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
    const module = await import("./http")
    return module.buildHealthPayload
}

function fakeLog(): { errors: string[]; log: { error(message: string): void } } {
    const errors: string[] = []
    return {
        errors,
        log: {
            debug() {},
            info() {},
            warn() {},
            error(message: string) {
                errors.push(message)
            },
        } as never,
    }
}

function buildDeps(song: unknown): ServerDeps {
    return {
        context: {
            application: { song },
            environment: { storageDirectory: "/tmp/live-connector" },
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
}

describe("buildHealthPayload", () => {
    it("serializes a bigint song handle into a JSON-safe structure", async () => {
        const buildHealthPayload = await loadBuildHealthPayload()
        const { log } = fakeLog()
        // 実機 SDK の Handle.id は bigint。生のまま含めると JSON.stringify が TypeError を投げる。
        const deps = buildDeps({
            handle: { id: 42n },
            tracks: [],
            scenes: [],
            cuePoints: [],
        })

        const payload = buildHealthPayload({ deps, log: log as never })

        expect(payload.status).toBe("pass")
        expect(payload.structure).not.toBeNull()
        expect(payload.structure?.songHandle).toBe("42")
        expect(payload.structure?.digest).toMatch(/^[0-9a-f]{8}$/)
        expect(() => JSON.stringify(payload)).not.toThrow()
    })

    it("returns structure null and logs when the song is unreadable", async () => {
        const buildHealthPayload = await loadBuildHealthPayload()
        const { errors, log } = fakeLog()
        const deps = {
            context: {
                application: {
                    get song(): never {
                        throw new Error("song unavailable")
                    },
                },
            },
            log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as ServerDeps

        const payload = buildHealthPayload({ deps, log: log as never })

        expect(payload.structure).toBeNull()
        expect(errors.length).toBe(1)
        expect(() => JSON.stringify(payload)).not.toThrow()
    })
})
