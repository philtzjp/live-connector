import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { assertSamplePath, isSupportedAudioPath } from "./samples"

describe("isSupportedAudioPath", () => {
    it("accepts common audio extensions case-insensitively", () => {
        expect(isSupportedAudioPath("/a/kick.wav")).toBe(true)
        expect(isSupportedAudioPath("/a/loop.AIFF")).toBe(true)
        expect(isSupportedAudioPath("/a/take.mp3")).toBe(true)
    })

    it("rejects non-audio extensions", () => {
        expect(isSupportedAudioPath("/a/preset.adv")).toBe(false)
        expect(isSupportedAudioPath("/a/notes.txt")).toBe(false)
    })
})

describe("assertSamplePath", () => {
    it("passes for an absolute supported path", () => {
        expect(() => assertSamplePath("/Users/x/Samples/kick.wav")).not.toThrow()
    })

    it("rejects relative paths", () => {
        expect(() => assertSamplePath("Samples/kick.wav")).toThrow(/absolute path/)
    })

    it("rejects unsupported formats with a hint", () => {
        expect(() => assertSamplePath("/Users/x/preset.adv")).toThrow(/unsupported audio format/)
    })
})
