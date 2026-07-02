import type { NoteDescription } from "@ableton-extensions/sdk"
import { describe, expect, it, vi } from "vitest"

// notes.ts は SDK の MidiClip を import するため、フェイクへ差し替える。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiClip, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import {
    clearNotesInRange,
    clipNoteLength,
    findOutOfRangeNotes,
    mergeNotes,
    registerNotesTool,
} from "./notes"

function note(pitch: number, startTime: number, duration = 1): NoteDescription {
    return { pitch, startTime, duration } as unknown as NoteDescription
}

type ClipArg = Parameters<typeof clipNoteLength>[0]
function fakeClip(duration: number, loopEnd: number, endMarker: number): ClipArg {
    return { duration, loopEnd, endMarker } as unknown as ClipArg
}

describe("findOutOfRangeNotes", () => {
    it("returns nothing when all notes are within [0, clipLength)", () => {
        expect(findOutOfRangeNotes([{ startTime: 0 }, { startTime: 3.99 }], 4)).toEqual([])
    })

    it("flags notes at or beyond the clip length (arrangement-absolute mistake)", () => {
        expect(findOutOfRangeNotes([{ startTime: 4 }, { startTime: 64 }], 4)).toEqual([
            { index: 0, startTime: 4 },
            { index: 1, startTime: 64 },
        ])
    })

    it("flags negative startTimes", () => {
        expect(findOutOfRangeNotes([{ startTime: -1 }], 4)).toEqual([{ index: 0, startTime: -1 }])
    })
})

describe("clipNoteLength", () => {
    it("uses the max of duration, loopEnd and endMarker to avoid false positives", () => {
        expect(clipNoteLength(fakeClip(4, 16, 8))).toBe(16)
        expect(clipNoteLength(fakeClip(8, 4, 4))).toBe(8)
    })
})

describe("mergeNotes", () => {
    it("keeps existing notes and appends incoming ones", () => {
        const merged = mergeNotes([note(60, 0)], [note(64, 1)])
        expect(merged).toHaveLength(2)
        expect(merged.map((entry) => entry.pitch)).toEqual([60, 64])
    })

    it("replaces on a pitch + startTime collision (incoming wins)", () => {
        const merged = mergeNotes([note(60, 0, 1)], [note(60, 0, 4)])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.duration).toBe(4)
    })

    it("does not treat same pitch at a different startTime as a collision", () => {
        expect(mergeNotes([note(60, 0)], [note(60, 2)])).toHaveLength(2)
    })
})

describe("clearNotesInRange", () => {
    it("removes notes whose startTime falls in [start, end)", () => {
        const result = clearNotesInRange([note(60, 0), note(62, 2), note(64, 4)], 1, 4)
        expect(result.removed).toBe(1)
        expect(result.kept.map((entry) => entry.startTime)).toEqual([0, 4])
    })

    it("keeps notes at the exclusive end boundary", () => {
        const result = clearNotesInRange([note(60, 4)], 0, 4)
        expect(result.removed).toBe(0)
        expect(result.kept).toHaveLength(1)
    })
})

function buildNotesServer(): { server: FakeMcpServer; clip: { notes: NoteDescription[] } } {
    const clip = Object.assign(Object.create(MidiClip.prototype), {
        name: "Bass",
        notes: [note(60, 0), note(62, 2)] as NoteDescription[],
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
            environment: { storageDirectory: "/tmp/lc-notes-test" },
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerNotesTool(server.asMcpServer(), deps)
    return { server, clip }
}

const BASS_SELECT = 'MATCH (c:MidiClip {name:"Bass"}) RETURN c'

describe("write_notes handler validation", () => {
    it("rejects replace with an empty or omitted notes array instead of wiping the clip", async () => {
        const { server, clip } = buildNotesServer()
        const { isError, json } = await server.call("write_notes", {
            select: BASS_SELECT,
            notes: [],
            mode: "replace",
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("requires a non-empty notes array")
        expect(payload.hint).toContain("clear_range")
        expect(clip.notes).toHaveLength(2)
    })

    it("rejects merge with an empty notes array", async () => {
        const { server } = buildNotesServer()
        const { isError, json } = await server.call("write_notes", {
            select: BASS_SELECT,
            mode: "merge",
            notes: [],
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("merge mode requires")
    })

    it("attaches a hint to a reversed clear_range range", async () => {
        const { server } = buildNotesServer()
        const { isError, json } = await server.call("write_notes", {
            select: BASS_SELECT,
            notes: [],
            mode: "clear_range",
            range: { start: 4, end: 2 },
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("must be greater than")
        expect(payload.hint).toContain("end > start")
    })

    it("rejects a clear_range range entirely outside the clip with a coordinate hint", async () => {
        const { server } = buildNotesServer()
        const { isError, json } = await server.call("write_notes", {
            select: BASS_SELECT,
            notes: [],
            mode: "clear_range",
            range: { start: 16, end: 20 },
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("entirely outside")
        expect(payload.hint).toContain("CLIP-RELATIVE")
    })

    it("rejects out-of-range startTimes without allowOutOfRange and accepts them with it", async () => {
        const { server } = buildNotesServer()
        const rejected = await server.call("write_notes", {
            select: BASS_SELECT,
            notes: [{ pitch: 60, startTime: 64, duration: 1 }],
            mode: "replace",
            preview: true,
        })
        expect(rejected.isError).toBe(true)
        expect((rejected.json as { hint?: string }).hint).toContain("CLIP-RELATIVE")

        const accepted = await server.call("write_notes", {
            select: BASS_SELECT,
            notes: [{ pitch: 60, startTime: 64, duration: 1 }],
            mode: "replace",
            allowOutOfRange: true,
            preview: true,
        })
        expect(accepted.isError).toBe(false)
        expect(accepted.json).toMatchObject({ status: "preview", outOfRange: 1 })
    })

    it("accepts tail-overflowing notes and reports the count in the preview response", async () => {
        const { server, clip } = buildNotesServer()
        const { isError, json } = await server.call("write_notes", {
            select: BASS_SELECT,
            notes: [
                { pitch: 60, startTime: 3.5, duration: 2 },
                { pitch: 62, startTime: 0, duration: 1 },
            ],
            mode: "replace",
            preview: true,
        })
        expect(isError).toBe(false)
        expect(json).toMatchObject({ status: "preview", tailOverflow: 1, noteCount: 2 })
        expect(clip.notes).toHaveLength(2)
    })
})
