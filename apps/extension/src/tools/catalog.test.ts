import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiTrack } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerCatalogTools, summarizeCatalogResults } from "./catalog"

describe("summarizeCatalogResults", () => {
    it("separates insertable from failed and lists failed names", () => {
        const summary = summarizeCatalogResults([
            { name: "Operator", insertable: true },
            { name: "Bass", insertable: false, error: "failed to insert" },
            { name: "Reverb", insertable: true },
        ])
        expect(summary.total).toBe(3)
        expect(summary.insertable).toBe(2)
        expect(summary.failed).toBe(1)
        expect(summary.failedNames).toEqual(["Bass"])
        expect(summary.results).toHaveLength(3)
    })

    it("reports all insertable when nothing failed", () => {
        const summary = summarizeCatalogResults([{ name: "Delay", insertable: true }])
        expect(summary.failed).toBe(0)
        expect(summary.failedNames).toEqual([])
    })
})

function buildCatalogServer(options: { fail_cleanup: boolean }): {
    server: FakeMcpServer
    created_tracks: () => number
} {
    let created = 0
    const song = {
        createMidiTrack: () => {
            created++
            const track = Object.assign(Object.create(MidiTrack.prototype), {
                name: "temp",
                devices: [] as unknown[],
            })
            track.insertDevice = (_name: string, _index: number) => Promise.resolve({ name: _name })
            track.deleteDevice = () => Promise.resolve()
            return Promise.resolve(track)
        },
        deleteTrack: () => {
            if (options.fail_cleanup) {
                return Promise.reject(new Error("track is locked"))
            }
            created--
            return Promise.resolve()
        },
    }
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerCatalogTools(server.asMcpServer(), deps)
    return { server, created_tracks: () => created }
}

describe("verify_device_catalog guard and cleanup reporting", () => {
    it("returns confirm_required with the probe plan and does not execute", async () => {
        const { server, created_tracks } = buildCatalogServer({ fail_cleanup: false })
        const { isError, json } = await server.call("verify_device_catalog", {})
        expect(isError).toBe(false)
        const payload = json as { status: string; devices: number; hint?: string }
        expect(payload.status).toBe("confirm_required")
        expect(payload.devices).toBeGreaterThan(0)
        expect(payload.hint).toContain("confirm:true")
        expect(created_tracks()).toBe(0)
    })

    it("previews the plan without executing", async () => {
        const { server, created_tracks } = buildCatalogServer({ fail_cleanup: false })
        const { json } = await server.call("verify_device_catalog", { preview: true })
        expect((json as { status: string }).status).toBe("preview")
        expect(created_tracks()).toBe(0)
    })

    it("executes with confirm:true and reports a clean cleanup", async () => {
        const { server, created_tracks } = buildCatalogServer({ fail_cleanup: false })
        const { isError, json } = await server.call("verify_device_catalog", { confirm: true })
        expect(isError).toBe(false)
        const payload = json as { status: string; cleanup: string; total: number }
        expect(payload.status).toBe("ok")
        expect(payload.cleanup).toBe("ok")
        expect(payload.total).toBeGreaterThan(0)
        expect(created_tracks()).toBe(0)
    })

    it("reports a failed cleanup so the caller can detect the leftover track", async () => {
        const { server, created_tracks } = buildCatalogServer({ fail_cleanup: true })
        const { isError, json } = await server.call("verify_device_catalog", { confirm: true })
        expect(isError).toBe(false)
        const payload = json as {
            status: string
            cleanup: string
            cleanupError?: string
            warning?: string
        }
        expect(payload.status).toBe("ok")
        expect(payload.cleanup).toBe("failed")
        expect(payload.cleanupError).toContain("track is locked")
        expect(payload.warning).toContain("remains in the Set")
        expect(created_tracks()).toBe(1)
    })
})
