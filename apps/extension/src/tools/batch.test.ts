import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiClip, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { batchStepSchema, registerBatchTool } from "./batch"

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
        })) as {
            json: { status: string; phase: string; failedStep: number; appliedSteps: unknown[] }
        }
        expect(json.status).toBe("failed")
        expect(json.phase).toBe("resolve")
        expect(json.failedStep).toBe(1)
        expect(json.appliedSteps).toEqual([])
        expect(song.tempo).toBe(120)
    })
})

describe("batch step schema equivalence with single tools", () => {
    it("rejects a negative tempo like set_song does", () => {
        expect(() => batchStepSchema.parse({ tool: "set_song", set: { tempo: -10 } })).toThrow()
    })

    it("rejects an unknown warpMode like set_clip does", () => {
        expect(() =>
            batchStepSchema.parse({
                tool: "set_clip",
                select: "MATCH (c:Clip) RETURN c",
                set: { warpMode: "Bogus" },
            }),
        ).toThrow()
    })

    it("rejects a non-numeric device parameter value like set_device_parameter does", () => {
        expect(() =>
            batchStepSchema.parse({
                tool: "set_device_parameter",
                select: "MATCH (p:Parameter) RETURN p",
                set: { value: "loud" },
            }),
        ).toThrow()
    })

    it("accepts the same valid inputs as the single tools", () => {
        expect(() => batchStepSchema.parse({ tool: "set_song", set: { tempo: 128 } })).not.toThrow()
        expect(() =>
            batchStepSchema.parse({
                tool: "write_notes",
                select: "MATCH (c:MidiClip) RETURN c",
                notes: [{ pitch: 60, startTime: 0, duration: 1 }],
            }),
        ).not.toThrow()
    })
})

type FailedBatchJson = {
    status: string
    phase: string
    appliedSteps: { index: number; tool: string }[]
    failedSteps: { index: number; tool: string; reason: string }[]
    unappliedSteps: { index: number; tool: string }[]
}

function buildDepsWithClip(options: { failing_tempo: boolean }): {
    deps: ServerDeps
    clip: { notes: { pitch: number; startTime: number; duration: number }[] }
} {
    const clip = Object.assign(Object.create(MidiClip.prototype), {
        name: "Bass",
        notes: [{ pitch: 60, startTime: 0, duration: 1 }],
        duration: 4,
        loopEnd: 4,
        endMarker: 4,
    })
    const song_fields: Record<string, unknown> = {
        tracks: [{ clipSlots: [{ clip }], arrangementClips: [], devices: [] }],
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    }
    const song = Object.assign(Object.create(Song.prototype), song_fields)
    if (options.failing_tempo) {
        Object.defineProperty(song, "tempo", {
            get: () => 120,
            set: () => {
                throw new Error("tempo write rejected by host")
            },
        })
    } else {
        song.tempo = 120
    }
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    return { deps, clip }
}

const BATCH_BASS_SELECT = 'MATCH (c:MidiClip {name:"Bass"}) RETURN c'

describe("batch apply-phase failure and sequential note steps", () => {
    it("identifies applied, failed and unapplied steps when the apply phase fails", async () => {
        const { deps, clip } = buildDepsWithClip({ failing_tempo: true })
        const failing_server = new FakeMcpServer()
        registerBatchTool(failing_server.asMcpServer(), deps)

        const { isError, json } = await failing_server.call("batch", {
            steps: [
                { tool: "set_song", set: { tempo: 150 } },
                {
                    tool: "write_notes",
                    select: BATCH_BASS_SELECT,
                    notes: [{ pitch: 64, startTime: 1, duration: 1 }],
                    mode: "merge",
                },
            ],
        })
        expect(isError).toBe(true)
        const payload = json as FailedBatchJson
        expect(payload.status).toBe("failed")
        expect(payload.phase).toBe("apply")
        expect(payload.failedSteps.map((step) => step.index)).toEqual([0])
        expect(payload.failedSteps[0]?.reason).toContain("tempo write rejected")
        expect(payload.appliedSteps.map((step) => step.index)).toEqual([1])
        // 部分適用: write_notes ステップは適用済みのまま残る（SDK はロールバックしない）。
        expect(clip.notes.map((entry) => entry.pitch)).toEqual([60, 64])
    })

    it("re-resolves sequential write_notes steps on the same clip so earlier results survive", async () => {
        const { deps, clip } = buildDepsWithClip({ failing_tempo: false })
        const sequential_server = new FakeMcpServer()
        registerBatchTool(sequential_server.asMcpServer(), deps)

        const { isError, json } = await sequential_server.call("batch", {
            steps: [
                {
                    tool: "write_notes",
                    select: BATCH_BASS_SELECT,
                    notes: [{ pitch: 64, startTime: 1, duration: 1 }],
                    mode: "merge",
                },
                {
                    tool: "write_notes",
                    select: BATCH_BASS_SELECT,
                    notes: [{ pitch: 67, startTime: 2, duration: 1 }],
                    mode: "merge",
                },
            ],
        })
        expect(isError).toBe(false)
        expect((json as { status: string }).status).toBe("ok")
        expect(clip.notes.map((entry) => entry.pitch).sort()).toEqual([60, 64, 67])
    })

    it("rejects a reversed clear_range range at the resolve phase like the single tool", async () => {
        const { deps } = buildDepsWithClip({ failing_tempo: false })
        const range_server = new FakeMcpServer()
        registerBatchTool(range_server.asMcpServer(), deps)

        const { json } = await range_server.call("batch", {
            steps: [
                {
                    tool: "write_notes",
                    select: BATCH_BASS_SELECT,
                    notes: [],
                    mode: "clear_range",
                    range: { start: 4, end: 2 },
                },
            ],
        })
        const payload = json as { status: string; phase: string; reason: string }
        expect(payload.status).toBe("failed")
        expect(payload.phase).toBe("resolve")
        expect(payload.reason).toContain("must be greater than")
    })
})
