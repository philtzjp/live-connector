import { describe, expect, it, vi } from "vitest"

// notes.ts は SDK の MidiClip を import するため、フェイクへ差し替える。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { clipNoteLength, findOutOfRangeNotes } from "./notes"

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
