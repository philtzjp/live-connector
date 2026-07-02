import type { NoteDescription } from "@ableton-extensions/sdk"
import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { transformNotes } from "./transform-notes"

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
