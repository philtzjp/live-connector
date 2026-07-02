import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NoteDescription } from "@ableton-extensions/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiClip, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerSnapshotTools } from "./snapshots"
import { registerTransformNotesTool, transformNotes } from "./transform-notes"

function note(
    pitch: number,
    startTime: number,
    extra: Partial<NoteDescription> = {},
): NoteDescription {
    return { pitch, startTime, duration: 1, ...extra } as unknown as NoteDescription
}

describe("transformNotes: transpose", () => {
    it("shifts pitch and drops notes pushed out of the MIDI range when drop is chosen", () => {
        const result = transformNotes(
            [note(60, 0), note(120, 0)],
            { type: "transpose", semitones: 12 },
            {},
            8,
            "drop",
        )
        expect(result.affected).toBe(2)
        expect(result.droppedPitch).toBe(1)
        expect(result.notes.map((entry) => entry.pitch)).toEqual([72])
    })

    it("throws when onOutOfRange is error and a pitch leaves the MIDI range", () => {
        try {
            transformNotes(
                [note(60, 0), note(120, 0)],
                { type: "transpose", semitones: 12 },
                {},
                8,
                "error",
            )
            expect.unreachable("transformNotes should have thrown")
        } catch (error) {
            expect(String(error)).toMatch(/outside the clip time range or MIDI pitch range/)
            const metadata = (error as { metadata?: { hint?: string } }).metadata
            expect(metadata?.hint).toMatch(/pitches outside \[0, 127\]: 132/)
        }
    })

    it("keeps notes transposed exactly to the pitch boundaries 0 and 127", () => {
        const result = transformNotes(
            [note(115, 0), note(12, 0)],
            { type: "transpose", semitones: 12 },
            {},
            8,
            "error",
        )
        expect(result.notes.map((entry) => entry.pitch)).toEqual([127, 24])
        const lower = transformNotes(
            [note(12, 0)],
            { type: "transpose", semitones: -12 },
            {},
            8,
            "error",
        )
        expect(lower.notes.map((entry) => entry.pitch)).toEqual([0])
    })
})

describe("transformNotes: time_shift", () => {
    it("shifts startTime and drops notes beyond the clip", () => {
        const result = transformNotes(
            [note(60, 0), note(60, 7)],
            { type: "time_shift", delta: 2 },
            {},
            8,
            "drop",
        )
        expect(result.droppedTime).toBe(1)
        expect(result.notes.map((entry) => entry.startTime)).toEqual([2])
    })

    it("throws when onOutOfRange is error and a result leaves the clip", () => {
        expect(() =>
            transformNotes([note(60, 4)], { type: "time_shift", delta: 10 }, {}, 8, "error"),
        ).toThrow(/outside the clip time range or MIDI pitch range/)
    })
})

describe("transformNotes: velocity / quantize", () => {
    it("scales and offsets velocity with clamping", () => {
        const result = transformNotes(
            [note(60, 0, { velocity: 100 })],
            { type: "velocity", scale: 0.5, offset: 10 },
            {},
            8,
            "drop",
        )
        expect(result.notes[0]?.velocity).toBe(60)
    })

    it("snaps startTime to the grid at full strength", () => {
        const result = transformNotes([note(60, 0.9)], { type: "quantize", grid: 1 }, {}, 8, "drop")
        expect(result.notes[0]?.startTime).toBeCloseTo(1)
    })

    it("rounds a halfway tie up to the next grid line", () => {
        const result = transformNotes([note(60, 0.5)], { type: "quantize", grid: 1 }, {}, 8, "drop")
        expect(result.notes[0]?.startTime).toBeCloseTo(1)
    })

    it("never deletes a note whose rounding target reaches the clip end", () => {
        // クリップ長 16・note@15.9・grid 1: 最近接 16 は範囲外なので直前グリッド 15 へ丸める。
        const result = transformNotes(
            [note(60, 15.9, { velocity: 90 })],
            { type: "quantize", grid: 1 },
            {},
            16,
            "error",
        )
        expect(result.after).toBe(1)
        expect(result.droppedTime).toBe(0)
        expect(result.notes[0]?.startTime).toBeCloseTo(15)
        expect(result.notes[0]?.velocity).toBe(90)
    })

    it("applies strength toward the in-range grid target near the clip end", () => {
        const result = transformNotes(
            [note(60, 15.9)],
            { type: "quantize", grid: 1, strength: 0.5 },
            {},
            16,
            "error",
        )
        expect(result.notes[0]?.startTime).toBeCloseTo(15.45)
    })
})

describe("transformNotes: duplicate", () => {
    it("keeps the original and appends copies at the offset", () => {
        const result = transformNotes(
            [note(60, 0)],
            { type: "duplicate", offset: 4, count: 2 },
            {},
            16,
            "drop",
        )
        expect(result.notes.map((entry) => entry.startTime)).toEqual([0, 4, 8])
        expect(result.affected).toBe(1)
    })

    it("drops copies that fall beyond the clip", () => {
        const result = transformNotes(
            [note(60, 0)],
            { type: "duplicate", offset: 4, count: 2 },
            {},
            6,
            "drop",
        )
        expect(result.notes.map((entry) => entry.startTime)).toEqual([0, 4])
        expect(result.droppedTime).toBe(1)
    })
})

describe("transformNotes: filter", () => {
    it("only transforms notes matching the filter and passes the rest through", () => {
        const result = transformNotes(
            [note(60, 0), note(64, 4)],
            { type: "transpose", semitones: 1 },
            { pitchMin: 64 },
            8,
            "drop",
        )
        expect(result.affected).toBe(1)
        expect(result.notes.map((entry) => entry.pitch)).toEqual([60, 65])
    })
})

let storage_dir: string

beforeEach(async () => {
    storage_dir = await mkdtemp(path.join(tmpdir(), "lc-transform-"))
})

afterEach(async () => {
    await rm(storage_dir, { recursive: true, force: true })
})

describe("transform_notes handler snapshot", () => {
    it("captures a notes snapshot before applying and returns its id for restore", async () => {
        const clip = Object.assign(Object.create(MidiClip.prototype), {
            name: "Bass",
            notes: [note(60, 0)],
            duration: 4,
            loopEnd: 4,
            endMarker: 4,
        })
        const song = Object.assign(Object.create(Song.prototype), {
            tracks: [{ clipSlots: [{ clip }], arrangementClips: [], devices: [] }],
            returnTracks: [],
            scenes: [],
            cuePoints: [],
            mainTrack: {},
        })
        const deps = {
            context: {
                application: { song },
                withinTransaction: (fn: () => unknown) => fn(),
                environment: { storageDirectory: storage_dir },
            },
            log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as ServerDeps
        const server = new FakeMcpServer()
        registerTransformNotesTool(server.asMcpServer(), deps)
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("transform_notes", {
            select: 'MATCH (c:MidiClip {name:"Bass"}) RETURN c',
            transform: { type: "transpose", semitones: 5 },
            onOutOfRange: "error",
        })
        expect(isError).toBe(false)
        const payload = json as { status: string; snapshotId: string }
        expect(payload.status).toBe("ok")
        expect(payload.snapshotId).toMatch(/^snap-/)
        expect(clip.notes.map((entry: NoteDescription) => entry.pitch)).toEqual([65])

        const restore = await server.call("restore_snapshot", { snapshotId: payload.snapshotId })
        expect(restore.isError).toBe(false)
        expect(clip.notes.map((entry: NoteDescription) => entry.pitch)).toEqual([60])
    })
})
