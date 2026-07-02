import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiTrack } from "@ableton-extensions/sdk"
import { collectSetFeatures, type SetFeatures, structureDigest } from "./fingerprint"

const base: SetFeatures = {
    trackCount: 1,
    sceneCount: 2,
    cuePointCount: 0,
    tracks: [
        {
            name: "Drums",
            kind: "midi",
            arrangementClipCount: 1,
            sessionClipCount: 0,
            deviceCount: 1,
        },
    ],
}

describe("structureDigest", () => {
    it("is deterministic for identical structure and hex-formatted", () => {
        expect(structureDigest(base)).toBe(structureDigest(base))
        expect(structureDigest(base)).toMatch(/^[0-9a-f]{8}$/)
    })

    it("changes when the structure changes", () => {
        const withExtraTrack: SetFeatures = {
            ...base,
            trackCount: 2,
            tracks: [
                ...base.tracks,
                {
                    name: "Bass",
                    kind: "audio",
                    arrangementClipCount: 0,
                    sessionClipCount: 0,
                    deviceCount: 0,
                },
            ],
        }
        expect(structureDigest(withExtraTrack)).not.toBe(structureDigest(base))
    })

    it("changes when a track is renamed but count is unchanged", () => {
        const first_track = base.tracks[0]
        if (first_track === undefined) {
            throw new Error("fixture must contain at least one track")
        }
        const renamed: SetFeatures = {
            ...base,
            tracks: [{ ...first_track, name: "Perc" }],
        }
        expect(structureDigest(renamed)).not.toBe(structureDigest(base))
    })
})

describe("collectSetFeatures", () => {
    it("derives track features including session clip and device counts", () => {
        const track = Object.assign(Object.create(MidiTrack.prototype), {
            name: "Drums",
            clipSlots: [{ clip: {} }, { clip: null }, { clip: {} }],
            devices: [{}, {}],
            arrangementClips: [{}],
        })
        const song = {
            tracks: [track],
            scenes: [{}, {}, {}],
            cuePoints: [{}],
        } as unknown as Parameters<typeof collectSetFeatures>[0]

        const features = collectSetFeatures(song)
        expect(features.trackCount).toBe(1)
        expect(features.sceneCount).toBe(3)
        expect(features.cuePointCount).toBe(1)
        expect(features.tracks[0]).toEqual({
            name: "Drums",
            kind: "midi",
            arrangementClipCount: 1,
            sessionClipCount: 2,
            deviceCount: 2,
        })
    })
})
