import type { Row } from "@live-connector/cypher"
import { describe, expect, it, vi } from "vitest"

// query.ts は LomGraphAdapter 経由で SDK を読み込むため、フェイクへ差し替える。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { applyRowCap, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT } from "./query"

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

    it("lets an explicit LIMIT exceed the default cap up to the absolute cap", () => {
        const result = applyRowCap(makeRows(DEFAULT_ROW_LIMIT + 50), true, DEFAULT_ROW_LIMIT)
        expect(result.truncated).toBe(false)
        expect(result.count).toBe(DEFAULT_ROW_LIMIT + 50)
    })

    it("clamps an explicit LIMIT to the absolute cap with a hint", () => {
        const result = applyRowCap(makeRows(MAX_ROW_LIMIT + 100), true, DEFAULT_ROW_LIMIT)
        expect(result.truncated).toBe(true)
        expect(result.count).toBe(MAX_ROW_LIMIT)
        expect(result.rows).toHaveLength(MAX_ROW_LIMIT)
        expect(result.hint).toMatch(/absolute cap/)
        expect(result.hint).toMatch(/SKIP/)
    })
})

import { MidiClip, MidiTrack, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerQueryTool } from "./query"

function buildQueryServer(note_count: number): FakeMcpServer {
    const notes = Array.from({ length: note_count }, (_, index) => ({
        pitch: 60 + (index % 12),
        startTime: index * 0.25,
        duration: 0.25,
    }))
    const clip = Object.assign(Object.create(MidiClip.prototype), {
        name: "Long",
        handle: { id: 41n },
        notes,
    })
    const track = Object.assign(Object.create(MidiTrack.prototype), {
        name: "Drums",
        handle: { id: 1n },
        clipSlots: [{ clip }],
        arrangementClips: [],
        devices: [],
    })
    const song = Object.assign(Object.create(Song.prototype), {
        tracks: [track],
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    })
    const deps = {
        context: { application: { song } },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerQueryTool(server.asMcpServer(), deps)
    return server
}

describe("query handler row-cap wiring", () => {
    it("truncates at the default cap when LIMIT is omitted", async () => {
        const server = buildQueryServer(DEFAULT_ROW_LIMIT + 20)
        const { isError, json } = await server.call("query", {
            cypher: "MATCH (c:MidiClip)-[:HAS_NOTE]->(n:Note) RETURN n.pitch",
        })
        expect(isError).toBe(false)
        const payload = json as { count: number; truncated: boolean; hint?: string }
        expect(payload.truncated).toBe(true)
        expect(payload.count).toBe(DEFAULT_ROW_LIMIT)
        expect(payload.hint).toContain("LIMIT")
    })

    it("honours an explicit LIMIT below the absolute cap", async () => {
        const server = buildQueryServer(DEFAULT_ROW_LIMIT + 20)
        const { json } = await server.call("query", {
            cypher: `MATCH (c:MidiClip)-[:HAS_NOTE]->(n:Note) RETURN n.pitch LIMIT ${DEFAULT_ROW_LIMIT + 10}`,
        })
        const payload = json as { count: number; truncated: boolean }
        expect(payload.truncated).toBe(false)
        expect(payload.count).toBe(DEFAULT_ROW_LIMIT + 10)
    })
})
