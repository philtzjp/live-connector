import type { Row } from "@live-connector/cypher"
import { describe, expect, it, vi } from "vitest"

// query.ts は LomGraphAdapter 経由で SDK を読み込むため、フェイクへ差し替える。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { applyRowCap, DEFAULT_ROW_LIMIT } from "./query"

function makeRows(count: number): Row[] {
    return Array.from({ length: count }, (_, index) => ({ index }))
}

describe("applyRowCap", () => {
    it("passes rows through unchanged when under the cap", () => {
        const result = applyRowCap(makeRows(10), false, DEFAULT_ROW_LIMIT)
        expect(result.truncated).toBe(false)
        expect(result.count).toBe(10)
        expect(result.rows).toHaveLength(10)
        expect(result.hint).toBeUndefined()
    })

    it("truncates to the cap and hints when there is no explicit LIMIT", () => {
        const result = applyRowCap(makeRows(DEFAULT_ROW_LIMIT + 50), false, DEFAULT_ROW_LIMIT)
        expect(result.truncated).toBe(true)
        expect(result.count).toBe(DEFAULT_ROW_LIMIT)
        expect(result.rows).toHaveLength(DEFAULT_ROW_LIMIT)
        expect(result.hint).toMatch(/truncated/i)
    })

    it("never truncates when the query has an explicit LIMIT", () => {
        const result = applyRowCap(makeRows(DEFAULT_ROW_LIMIT + 50), true, DEFAULT_ROW_LIMIT)
        expect(result.truncated).toBe(false)
        expect(result.count).toBe(DEFAULT_ROW_LIMIT + 50)
    })
})
