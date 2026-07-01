import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerWriteTools } from "./write"

function buildServer(): FakeMcpServer {
    const song = Object.assign(Object.create(Song.prototype), {
        tracks: [],
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    })
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
            environment: { storageDirectory: "/tmp/lc" },
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerWriteTools(server.asMcpServer(), deps)
    return server
}

describe("set tool error hints", () => {
    it("guides to create_cue_point when set_cue_point selects a non-CuePoint node", async () => {
        const server = buildServer()
        const { isError, json } = await server.call("set_cue_point", {
            select: "MATCH (s:Song) RETURN s",
            set: { name: "Verse" },
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("CuePoint")
        expect(payload.hint).toContain("create_cue_point")
    })

    it("reports no CuePoint to edit and guides to create_cue_point when none match", async () => {
        const server = buildServer()
        const { isError, json } = await server.call("set_cue_point", {
            select: 'MATCH (c:CuePoint {name:"Nope"}) RETURN c',
            set: { name: "Verse" },
        })
        expect(isError).toBe(true)
        const payload = json as { error?: string; hint?: string }
        expect(payload.error).toBe("not_found")
        expect(payload.hint).toContain("create_cue_point")
    })
})
