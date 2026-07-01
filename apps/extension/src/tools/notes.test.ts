import type { NoteDescription } from "@ableton-extensions/sdk"
import { describe, expect, it, vi } from "vitest"

// notes.ts は SDK の MidiClip を import するため、フェイクへ差し替える。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { clearNotesInRange, clipNoteLength, findOutOfRangeNotes, mergeNotes } from "./notes"

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
