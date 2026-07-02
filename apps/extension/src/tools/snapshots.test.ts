import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiTrack, Song } from "@ableton-extensions/sdk"
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

type TrackFixture = { name: string; handle?: { id: bigint } }

function buildSongDeps(tracks: TrackFixture[]): {
    deps: ServerDeps
    track_instances: { name: string }[]
} {
    const track_instances = tracks.map((track) =>
        Object.assign(Object.create(MidiTrack.prototype), {
            ...track,
            clipSlots: [],
            arrangementClips: [],
            devices: [],
        }),
    )
    const song = Object.assign(Object.create(Song.prototype), {
        tracks: track_instances,
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    })
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
            environment: { storageDirectory: storageDir },
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    return { deps, track_instances }
}

const TRACK_SELECT = "MATCH (t:MidiTrack) RETURN t"

describe("restore_snapshot identity matching", () => {
    it("restores by identity so reordered tracks do not receive shifted values", async () => {
        // 取得時: [id1=Drums, id2=Bass]。復元時はトラック順が入れ替わっている。
        const { deps, track_instances } = buildSongDeps([
            { name: "Bass-renamed", handle: { id: 2n } },
            { name: "Drums-renamed", handle: { id: 1n } },
        ])
        const snapshot_id = await capturePropertiesSnapshot(deps, {
            tool: "set_track",
            select: TRACK_SELECT,
            requiredLabel: "Track",
            properties: ["name"],
            oldTargets: [
                { _label: "MidiTrack", name: "Drums" },
                { _label: "MidiTrack", name: "Bass" },
            ],
            targetIdentities: ["1", "2"],
        })
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: snapshot_id,
        })
        expect(isError).toBe(false)
        const payload = json as { restored: number; undoSnapshotId: string }
        expect(payload.restored).toBe(2)
        expect(payload.undoSnapshotId).toMatch(/^snap-/)
        // index 照合なら Drums の旧値が id2 に載る順ズレになるが、identity 照合で正しく戻る。
        expect(track_instances[0]?.name).toBe("Bass")
        expect(track_instances[1]?.name).toBe("Drums")
    })

    it("partially restores and reports counts when a captured target disappeared", async () => {
        const { deps, track_instances } = buildSongDeps([{ name: "Now", handle: { id: 1n } }])
        const snapshot_id = await capturePropertiesSnapshot(deps, {
            tool: "set_track",
            select: TRACK_SELECT,
            requiredLabel: "Track",
            properties: ["name"],
            oldTargets: [
                { _label: "MidiTrack", name: "Old-1" },
                { _label: "MidiTrack", name: "Old-3" },
            ],
            targetIdentities: ["1", "3"],
        })
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: snapshot_id,
        })
        expect(isError).toBe(false)
        const payload = json as {
            restored: number
            missingFromSet: number
            unmatchedNow: number
            note?: string
        }
        expect(payload.restored).toBe(1)
        expect(payload.missingFromSet).toBe(1)
        expect(payload.note).toContain("partial restore")
        expect(track_instances[0]?.name).toBe("Old-1")
    })

    it("rejects the restore when none of the captured targets resolve anymore", async () => {
        const { deps } = buildSongDeps([{ name: "Other", handle: { id: 9n } }])
        const snapshot_id = await capturePropertiesSnapshot(deps, {
            tool: "set_track",
            select: TRACK_SELECT,
            requiredLabel: "Track",
            properties: ["name"],
            oldTargets: [{ _label: "MidiTrack", name: "Gone" }],
            targetIdentities: ["1"],
        })
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: snapshot_id,
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("matched none")
    })

    it("rejects an index fallback when identities are unavailable and counts differ", async () => {
        const { deps } = buildSongDeps([{ name: "A" }, { name: "B" }])
        const snapshot_id = await capturePropertiesSnapshot(deps, {
            tool: "set_track",
            select: TRACK_SELECT,
            requiredLabel: "Track",
            properties: ["name"],
            oldTargets: [{ _label: "MidiTrack", name: "Old-A" }],
        })
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: snapshot_id,
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("identities are unavailable")
    })

    it("validates the stored requiredLabel against the re-resolved nodes", async () => {
        const { deps } = buildSongDeps([{ name: "A", handle: { id: 1n } }])
        const snapshot_id = await capturePropertiesSnapshot(deps, {
            tool: "set_track",
            select: "MATCH (s:Song) RETURN s",
            requiredLabel: "Track",
            properties: ["name"],
            oldTargets: [{ _label: "MidiTrack", name: "Old" }],
            targetIdentities: ["1"],
        })
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: snapshot_id,
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("expects Track")
    })
})

describe("restore_snapshot file validation", () => {
    it("rejects a corrupted snapshot file with a hint", async () => {
        const { deps } = buildSongDeps([])
        const directory = path.join(storageDir, "snapshots")
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, "snap-bad.json"), "{ not json", "utf8")
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: "snap-bad",
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("corrupted")
    })

    it("rejects a snapshot with a mismatching schemaVersion", async () => {
        const { deps } = buildSongDeps([])
        const directory = path.join(storageDir, "snapshots")
        await mkdir(directory, { recursive: true })
        await writeFile(
            path.join(directory, "snap-old.json"),
            JSON.stringify({
                schemaVersion: "1.0",
                id: "snap-old",
                at: "2026-01-01T00:00:00.000Z",
                tool: "set_track",
                kind: "properties",
                select: TRACK_SELECT,
                requiredLabel: "Track",
                properties: ["name"],
                oldTargets: [],
            }),
            "utf8",
        )
        const server = new FakeMcpServer()
        registerSnapshotTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("restore_snapshot", {
            snapshotId: "snap-old",
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("schemaVersion")
    })
})
