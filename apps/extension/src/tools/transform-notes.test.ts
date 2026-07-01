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
    it("shifts pitch and drops notes pushed out of the MIDI range", () => {
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
        ).toThrow(/outside the clip range/)
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
