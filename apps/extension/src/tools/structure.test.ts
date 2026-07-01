import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { guardDestructive } from "./structure"

function parse(result: { content: { text: string }[] } | null): unknown {
    if (result === null) {
        return null
    }
    return JSON.parse(result.content.map((part) => part.text).join(""))
}

describe("guardDestructive", () => {
    it("returns a preview result carrying the summary when preview is true", () => {
        expect(parse(guardDestructive({ track: "Drums" }, true, undefined))).toMatchObject({
            status: "preview",
            track: "Drums",
        })
    })

    it("requires confirm for a destructive op with neither preview nor confirm", () => {
        expect(parse(guardDestructive({ track: "Drums" }, undefined, undefined))).toMatchObject({
            status: "confirm_required",
            track: "Drums",
        })
    })

    it("returns null (proceed) when confirm is true", () => {
        expect(guardDestructive({ track: "Drums" }, undefined, true)).toBeNull()
    })

    it("prefers preview over confirm when both are set", () => {
        expect(parse(guardDestructive({}, true, true))).toMatchObject({ status: "preview" })
    })
})
