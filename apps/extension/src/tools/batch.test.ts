import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerBatchTool } from "./batch"

type FakeSong = { tempo: number }

function buildDeps(): { deps: ServerDeps; song: FakeSong } {
    const song = Object.assign(Object.create(Song.prototype), {
        tempo: 120,
        tracks: [],
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    }) as FakeSong
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    return { deps, song }
}

describe("batch", () => {
    let server: FakeMcpServer
    let song: FakeSong

    beforeEach(() => {
        const built = buildDeps()
        song = built.song
        server = new FakeMcpServer()
        registerBatchTool(server.asMcpServer(), built.deps)
    })

    it("previews a resolved plan without applying", async () => {
        const { json } = (await server.call("batch", {
            steps: [{ tool: "set_song", set: { tempo: 130 } }],
            preview: true,
        })) as { json: { status: string; stepCount: number } }
        expect(json.status).toBe("preview")
        expect(json.stepCount).toBe(1)
        expect(song.tempo).toBe(120)
    })

    it("applies all steps in one call", async () => {
        const { json } = (await server.call("batch", {
            steps: [{ tool: "set_song", set: { tempo: 140 } }],
        })) as { json: { status: string; appliedSteps: number } }
        expect(json.status).toBe("ok")
        expect(json.appliedSteps).toBe(1)
        expect(song.tempo).toBe(140)
    })

    it("aborts without applying when a step fails to resolve (all-or-nothing)", async () => {
        const { json } = (await server.call("batch", {
            steps: [
                { tool: "set_song", set: { tempo: 150 } },
                { tool: "set_track", select: "MATCH (s:Song) RETURN s", set: { name: "X" } },
            ],
        })) as { json: { status: string; failedStep: number; appliedSteps: unknown[] } }
        expect(json.status).toBe("failed")
        expect(json.failedStep).toBe(1)
        expect(json.appliedSteps).toEqual([])
        expect(song.tempo).toBe(120)
    })
})
