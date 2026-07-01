import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { summarizeCatalogResults } from "./catalog"

describe("summarizeCatalogResults", () => {
    it("separates insertable from failed and lists failed names", () => {
        const summary = summarizeCatalogResults([
            { name: "Operator", insertable: true },
            { name: "Bass", insertable: false, error: "failed to insert" },
            { name: "Reverb", insertable: true },
        ])
        expect(summary.total).toBe(3)
        expect(summary.insertable).toBe(2)
        expect(summary.failed).toBe(1)
        expect(summary.failedNames).toEqual(["Bass"])
        expect(summary.results).toHaveLength(3)
    })

    it("reports all insertable when nothing failed", () => {
        const summary = summarizeCatalogResults([{ name: "Delay", insertable: true }])
        expect(summary.failed).toBe(0)
        expect(summary.failedNames).toEqual([])
    })
})
