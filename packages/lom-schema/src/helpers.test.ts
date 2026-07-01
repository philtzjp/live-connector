import { describe, expect, it } from "vitest"
import { getNodeDef, isSubtypeOf, propertiesForLabel } from "./helpers"

describe("isSubtypeOf", () => {
    it("treats a label as a subtype of itself", () => {
        expect(isSubtypeOf("Track", "Track")).toBe(true)
    })

    it("follows the extends chain", () => {
        expect(isSubtypeOf("MidiTrack", "Track")).toBe(true)
        expect(isSubtypeOf("AudioClip", "Clip")).toBe(true)
        expect(isSubtypeOf("DrumRack", "Device")).toBe(true)
    })

    it("returns false for unrelated labels", () => {
        expect(isSubtypeOf("Note", "Track")).toBe(false)
        expect(isSubtypeOf("Track", "MidiTrack")).toBe(false)
        expect(isSubtypeOf("Unknown", "Track")).toBe(false)
    })
})

describe("propertiesForLabel", () => {
    it("merges inherited properties from the base label", () => {
        const names = propertiesForLabel("MidiTrack").map((property) => property.name)
        expect(names).toContain("name")
        expect(names).toContain("kind")
        expect(names).toContain("mutedViaSolo")
    })

    it("keeps subtype-specific properties alongside inherited ones", () => {
        const names = propertiesForLabel("AudioClip").map((property) => property.name)
        expect(names).toContain("filePath")
        expect(names).toContain("warpMode")
        expect(names).toContain("startTime")
    })

    it("returns an empty list for an unknown label", () => {
        expect(propertiesForLabel("Unknown")).toEqual([])
    })
})

describe("getNodeDef", () => {
    it("returns the definition for a known label", () => {
        expect(getNodeDef("Song")?.label).toBe("Song")
    })

    it("returns undefined for an unknown label", () => {
        expect(getNodeDef("Nope")).toBeUndefined()
    })
})
