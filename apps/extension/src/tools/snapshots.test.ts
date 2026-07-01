import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { captureNotesSnapshot, capturePropertiesSnapshot, registerSnapshotTools } from "./snapshots"

let storageDir: string

beforeEach(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "lc-snapshots-"))
})

afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true })
})

function buildDeps(): ServerDeps {
    return {
        context: { environment: { storageDirectory: storageDir } },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
}

describe("snapshots", () => {
    it("captures property and notes snapshots and lists them newest-first", async () => {
        const deps = buildDeps()
        const id1 = await capturePropertiesSnapshot(deps, {
            tool: "set_track",
            select: "MATCH (t:Track) RETURN t",
            requiredLabel: "Track",
            properties: ["name"],
            oldTargets: [{ _label: "MidiTrack", name: "Old" }],
        })
        const id2 = await captureNotesSnapshot(deps, {
            tool: "write_notes",
            select: "MATCH (c:MidiClip) RETURN c",
            oldNotes: [],
        })

        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)
        const { json } = (await server.call("list_snapshots", {})) as {
            json: { total: number; snapshots: { id: string; tool: string; kind: string }[] }
        }
        expect(json.total).toBe(2)
        expect(json.snapshots[0]?.id).toBe(id2)
        expect(json.snapshots.map((entry) => entry.id)).toContain(id1)
        expect(json.snapshots.find((entry) => entry.id === id1)?.tool).toBe("set_track")
    })

    it("returns a not_found error when restoring an unknown snapshot id", async () => {
        const deps = buildDeps()
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)
        const { isError, json } = await server.call("restore_snapshot", { snapshotId: "nope" })
        expect(isError).toBe(true)
        expect((json as { error?: string }).error).toBe("not_found")
    })
})
