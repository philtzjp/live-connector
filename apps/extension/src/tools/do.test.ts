import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { ClipSlot, Device, MidiClip, MidiTrack, Scene, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { createSdkOnlyRuntime } from "../test-support/fake-runtime"
import { FakeMcpServer } from "../test-support/fake-server"
import * as undoLog from "../undo/log"
import type { UndoLogEntry } from "../undo/types"
import { DEFAULT_ROW_LIMIT } from "./do/row-cap"
import { clearRenderJobsForTest } from "./render"
import { undoLogEntry } from "./undo"

type TrackFixture = InstanceType<typeof MidiTrack> & {
    arrangementClips: InstanceType<typeof MidiClip>[]
    clipSlots: InstanceType<typeof ClipSlot>[]
    devices: InstanceType<typeof Device>[]
    createMidiClip: ReturnType<typeof vi.fn>
    deleteClip: ReturnType<typeof vi.fn>
    insertDevice: ReturnType<typeof vi.fn>
    deleteDevice: ReturnType<typeof vi.fn>
    clearClipsInRange: ReturnType<typeof vi.fn>
}

function makeDeps(
    overrides: Record<string, unknown> = {},
    storage_directory = "/tmp/live-connector-test",
): ServerDeps {
    let next_clip_id = 100n

    const midi_clip = Object.assign(Object.create(MidiClip.prototype), {
        name: "Bass",
        handle: { id: 41n },
        notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
        duration: 4,
        loopEnd: 4,
        endMarker: 4,
        startTime: 0,
        startMarker: 0,
        color: 0,
        muted: false,
        looping: false,
        parent: null as unknown,
    })

    const session_slot = Object.assign(Object.create(ClipSlot.prototype), {
        clip: null as InstanceType<typeof MidiClip> | null,
        parent: null as unknown,
        createMidiClip: vi.fn(),
        deleteClip: vi.fn(),
    })

    const track = Object.assign(Object.create(MidiTrack.prototype), {
        name: "Drums",
        handle: { id: 1n },
        mute: false,
        arm: false,
        solo: false,
        clipSlots: [session_slot],
        arrangementClips: [midi_clip],
        devices: [] as InstanceType<typeof Device>[],
        createMidiTrack: vi.fn(),
        createMidiClip: vi.fn(),
        deleteClip: vi.fn(),
        insertDevice: vi.fn(),
        deleteDevice: vi.fn(),
        clearClipsInRange: vi.fn(async () => {}),
    }) as TrackFixture

    track.createMidiClip.mockImplementation(async (start: number, dur: number) => {
        next_clip_id += 1n
        const created = Object.assign(Object.create(MidiClip.prototype), {
            name: "New",
            handle: { id: next_clip_id },
            notes: [] as typeof midi_clip.notes,
            startTime: start,
            duration: dur,
            loopEnd: dur,
            endMarker: dur,
            startMarker: 0,
            color: 0,
            muted: false,
            looping: false,
            parent: track,
        })
        track.arrangementClips.push(created)
        return created
    })

    track.deleteClip.mockImplementation((clip?: InstanceType<typeof MidiClip>) => {
        if (clip === undefined) {
            return
        }
        const index = track.arrangementClips.indexOf(clip)
        if (index >= 0) {
            track.arrangementClips.splice(index, 1)
        }
    })

    track.insertDevice.mockImplementation(async (name: string, index?: number) => {
        const device = Object.assign(Object.create(Device.prototype), {
            name,
            handle: { id: 50n + BigInt(track.devices.length) },
            parameters: [],
            parent: track,
        })
        const insert_at = index ?? track.devices.length
        track.devices.splice(insert_at, 0, device)
        return device
    })

    track.deleteDevice.mockImplementation((device: InstanceType<typeof Device>) => {
        const index = track.devices.indexOf(device)
        if (index >= 0) {
            track.devices.splice(index, 1)
        }
    })

    session_slot.createMidiClip.mockImplementation(async (length: number) => {
        next_clip_id += 1n
        const created = Object.assign(Object.create(MidiClip.prototype), {
            name: "Session",
            handle: { id: next_clip_id },
            notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 90 }],
            duration: length,
            loopEnd: length,
            endMarker: length,
            startMarker: 0,
            startTime: 0,
            color: 0,
            muted: false,
            looping: false,
            parent: session_slot,
        })
        session_slot.clip = created
        return created
    })

    session_slot.deleteClip.mockImplementation(() => {
        session_slot.clip = null
    })

    midi_clip.parent = track
    session_slot.parent = track

    const song = Object.assign(Object.create(Song.prototype), {
        tempo: 120,
        scaleName: "Major",
        scaleMode: true,
        rootNote: 0,
        handle: { id: 100n },
        tracks: [track],
        returnTracks: [],
        scenes: [
            Object.assign(Object.create(Scene.prototype), {
                name: "Intro",
                handle: { id: 10n },
            }),
        ],
        cuePoints: [],
        mainTrack: Object.assign(Object.create(MidiTrack.prototype), {
            name: "Main",
            handle: { id: 2n },
            arm: false,
            mute: false,
            solo: false,
            clipSlots: [],
            arrangementClips: [],
            devices: [],
        }),
        createMidiTrack: vi.fn(async () => {
            const created = Object.assign(Object.create(MidiTrack.prototype), {
                name: "Created",
                handle: { id: 77n },
                clipSlots: [],
                arrangementClips: [],
                devices: [],
            })
            song.tracks.push(created)
            return created
        }),
        createScene: vi.fn(async (index: number) => {
            const created = Object.assign(Object.create(Scene.prototype), {
                name: "New Scene",
                handle: { id: 11n },
            })
            song.scenes.splice(index, 0, created)
            return created
        }),
        deleteScene: vi.fn(),
        duplicateScene: vi.fn(async (scene: InstanceType<typeof Scene>) => scene),
        deleteTrack: vi.fn((deleted_track: TrackFixture) => {
            const index = song.tracks.findIndex(
                (candidate: TrackFixture) => candidate === deleted_track,
            )
            if (index >= 0) {
                song.tracks.splice(index, 1)
            }
        }),
        duplicateTrack: vi.fn(async (source: TrackFixture) => {
            const duplicated = Object.assign(Object.create(MidiTrack.prototype), {
                name: `${source.name} Copy`,
                handle: { id: 88n },
                clipSlots: [],
                arrangementClips: [],
                devices: [],
            })
            song.tracks.push(duplicated)
            return duplicated
        }),
    })

    const context = {
        application: { song },
        withinTransaction: async <T>(fn: () => T | Promise<T>) => fn(),
        environment: { storageDirectory: storage_directory },
        resources: {
            importIntoProject: vi.fn(async (path: string) => path),
            renderPreFxAudio: vi.fn(async () => "/tmp/render.wav"),
        },
        ...overrides,
    }

    return {
        context,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        runtime: createSdkOnlyRuntime(),
    } as unknown as ServerDeps
}

async function buildRegisteredServer(deps: ServerDeps): Promise<FakeMcpServer> {
    vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
    const { registerAllTools } = await import("../server/mcp")
    const server = new FakeMcpServer()
    registerAllTools(server.asMcpServer(), deps)
    return server
}

async function listSerializedUndoEntries(deps: ServerDeps): Promise<UndoLogEntry[]> {
    const entries = await undoLog.listUndoEntries(deps)
    return entries.map((entry) => JSON.parse(JSON.stringify(entry)) as UndoLogEntry)
}

async function undoViaSerializedLog(
    deps: ServerDeps,
    params: { steps?: number; writeId?: string } = {},
): Promise<Record<string, unknown>> {
    const entries = await listSerializedUndoEntries(deps)
    const applied = entries.filter((entry) => entry.status === "applied")
    if (applied.length === 0) {
        return { status: "no_match" }
    }

    const undone: Record<string, unknown>[] = []
    if (params.writeId !== undefined) {
        const entry = applied.find((candidate) => candidate.writeId === params.writeId)
        if (entry === undefined) {
            throw new Error(`writeId ${params.writeId} not found`)
        }
        undone.push(await undoLogEntry(deps, entry))
    } else {
        const steps = params.steps ?? 1
        for (const entry of applied.slice(-steps).reverse()) {
            undone.push(await undoLogEntry(deps, entry))
        }
    }
    return { status: "ok", undone }
}

function songTrack(deps: ServerDeps): TrackFixture {
    return deps.context.application.song.tracks[0] as TrackFixture
}

function arrangementClip(track: TrackFixture): InstanceType<typeof MidiClip> {
    const clip = track.arrangementClips[0]
    if (clip === undefined) {
        throw new Error("expected arrangement clip fixture")
    }
    return clip
}

function firstClipSlot(track: TrackFixture): InstanceType<typeof ClipSlot> & {
    clip: InstanceType<typeof MidiClip> | null
} {
    const slot = track.clipSlots[0]
    if (slot === undefined) {
        throw new Error("expected clip slot fixture")
    }
    return slot as InstanceType<typeof ClipSlot> & { clip: InstanceType<typeof MidiClip> | null }
}

describe("four-tool surface", () => {
    let storage_directory = "/tmp/live-connector-test"

    beforeEach(() => {
        clearRenderJobsForTest()
        storage_directory = `/tmp/live-connector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    })

    it("registers meta, do, undo, render only", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        expect([...server.tools.keys()].sort()).toEqual(["do", "meta", "render", "undo"])
    })

    it("meta returns schema, contract, and overview", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const { isError, json } = await server.call("meta", { includeClips: false })
        expect(isError).toBe(false)
        const payload = json as {
            service: { name: string }
            schema: { nodes: unknown[] }
            query_contract: { write: { tool: string } }
            overview: { tempo: number }
        }
        expect(payload.service.name).toBe("live-connector")
        expect(payload.schema.nodes.length).toBeGreaterThan(0)
        expect(payload.query_contract.write.tool).toBe("do")
        expect(payload.overview.tempo).toBe(120)
    })

    it("do read returns rows with status ok", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const { isError, json } = await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) RETURN t.name',
        })
        if (isError) {
            throw new Error(`do read failed: ${JSON.stringify(json)}`)
        }
        expect((json as { status: string }).status).toBe("ok")
        expect((json as { count: number }).count).toBeGreaterThan(0)
    })

    it("do read truncates without LIMIT", async () => {
        const notes = Array.from({ length: DEFAULT_ROW_LIMIT + 5 }, (_, index) => ({
            pitch: 60,
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
        const deps = makeDeps({}, storage_directory)
        Object.assign(deps.context.application.song, {
            tracks: [track],
        })
        const server = await buildRegisteredServer(deps)
        const { json } = await server.call("do", {
            statement: "MATCH (c:MidiClip)-[:HAS_NOTE]->(n:Note) RETURN n.pitch",
        })
        expect((json as { truncated: boolean }).truncated).toBe(true)
        expect((json as { count: number }).count).toBe(DEFAULT_ROW_LIMIT)
    })

    it("do set returns diff on track mute", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const statement = 'MATCH (t:MidiTrack {name:"Drums"}) SET t.mute = true'
        const { json } = await server.call("do", { statement })
        const payload = json as { status: string; changed: unknown[]; writeId: string }
        expect(payload.status).toBe("ok")
        expect(payload.writeId).toMatch(/^write-/)
        expect(payload.changed.length).toBe(1)
    })

    it("do set no_match when pattern matches nothing", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const { json } = await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Missing"}) SET t.mute = true',
        })
        expect((json as { status: string }).status).toBe("no_match")
    })

    it("do create track", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const { json } = await server.call("do", {
            statement: 'CREATE (t:MidiTrack {name:"Pads"})',
        })
        expect((json as { status: string }).status).toBe("ok")
        expect((json as { created: unknown[] }).created.length).toBe(1)
    })

    it("do delete track requires confirm", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const { json } = await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) DELETE t',
        })
        expect((json as { status: string }).status).toBe("confirm_required")
    })

    it("undo no_match when log empty", async () => {
        const server = await buildRegisteredServer(makeDeps({}, storage_directory))
        const { json } = await server.call("undo", {})
        expect((json as { status: string }).status).toBe("no_match")
    })

    it("undo reverts a set write", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) SET t.mute = true',
        })
        const track = songTrack(deps)
        expect(track.mute).toBe(true)
        const undone = await undoViaSerializedLog(deps)
        expect(undone.status).toBe("ok")
        expect(track.mute).toBe(false)
    })
})

describe("undo jsonl roundtrip", () => {
    let storage_directory = "/tmp/live-connector-test"

    beforeEach(() => {
        clearRenderJobsForTest()
        storage_directory = `/tmp/live-connector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    })

    it("notes SET undo restores old notes", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)
        const clip = arrangementClip(track)
        const statement =
            'MATCH (c:MidiClip {name:"Bass"}) SET c.notes = [{pitch:72,startTime:0,duration:1,velocity:100}]'
        await server.call("do", { statement })
        expect(clip.notes[0]?.pitch).toBe(72)

        await undoViaSerializedLog(deps)
        expect(clip.notes[0]?.pitch).toBe(60)
    })

    it("arrangement MidiClip DELETE undo restores position and notes", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)
        const clip = arrangementClip(track)
        const original_start = clip.startTime
        const original_notes = [...clip.notes]

        const statement = 'MATCH (c:MidiClip {name:"Bass"}) DELETE c'
        await server.call("do", { statement })
        expect(track.arrangementClips.length).toBe(0)

        await undoViaSerializedLog(deps)
        expect(track.arrangementClips.length).toBe(1)
        expect(track.arrangementClips[0]?.startTime).toBe(original_start)
        expect(track.arrangementClips[0]?.notes).toEqual(original_notes)
    })

    it("session MidiClip DELETE undo restores slot clip", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)
        const slot = firstClipSlot(track)
        await server.call("do", {
            statement:
                'MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot) CREATE (s)-[:HAS_CLIP]->(c:MidiClip {length: 4})',
        })
        expect(slot.clip).not.toBeNull()
        const session_clip = slot.clip as InstanceType<typeof MidiClip>
        const original_notes = [...session_clip.notes]

        await server.call("do", {
            statement:
                'MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(:ClipSlot)-[:HAS_CLIP]->(c:MidiClip) DELETE c',
        })
        expect(slot.clip).toBeNull()

        await undoViaSerializedLog(deps, { steps: 1 })
        expect(slot.clip).not.toBeNull()
        expect((slot.clip as InstanceType<typeof MidiClip>).notes).toEqual(original_notes)
    })

    it("move SET startTime undo restores original position", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)
        const clip = arrangementClip(track)
        Object.assign(clip, { startTime: 0 })

        const statement = 'MATCH (c:MidiClip {name:"Bass"}) SET c.startTime = 8'
        await server.call("do", { statement })
        const moved = track.arrangementClips[0]
        expect(moved?.startTime).toBe(8)

        await undoViaSerializedLog(deps)
        const restored = track.arrangementClips[0]
        expect(restored?.startTime).toBe(0)
    })

    it("multiple Note DELETE removes correct notes", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)
        const clip = arrangementClip(track)
        clip.notes = [
            { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
            { pitch: 62, startTime: 1, duration: 1, velocity: 100 },
            { pitch: 64, startTime: 2, duration: 1, velocity: 100 },
        ]

        const statement =
            'MATCH (c:MidiClip {name:"Bass"})-[:HAS_NOTE]->(n:Note) WHERE n.pitch IN [60, 64] DELETE n'
        await server.call("do", { statement })
        expect(clip.notes.map((note) => note.pitch)).toEqual([62])
    })

    it("Device DELETE undo re-inserts catalog device (partial)", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)
        await track.insertDevice("EQ Eight", 0)

        const statement = 'MATCH (d:Device {name:"EQ Eight"}) DELETE d'
        const deleted = await server.call("do", { statement, confirm: true })
        expect((deleted.json as { status: string }).status).toBe("ok")
        expect(track.devices.length).toBe(0)

        const undone = await undoViaSerializedLog(deps)
        const first = (undone.undone as Record<string, unknown>[])[0]
        expect(first?.note).toContain("Partial undo")
        expect(track.devices.length).toBe(1)
        expect(track.devices[0]?.name).toBe("EQ Eight")
    })

    it("create undo deletes created track", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const song = deps.context.application.song
        const before = song.tracks.length

        await server.call("do", { statement: 'CREATE (t:MidiTrack {name:"Pads"})' })
        expect(song.tracks.length).toBe(before + 1)

        await undoViaSerializedLog(deps)
        expect(song.tracks.length).toBe(before)
    })

    it("session clip create undo deletes slot clip", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const slot = firstClipSlot(songTrack(deps))

        await server.call("do", {
            statement:
                'MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot) CREATE (s)-[:HAS_CLIP]->(c:MidiClip {length: 4})',
        })
        expect(slot.clip).not.toBeNull()

        await undoViaSerializedLog(deps)
        expect(slot.clip).toBeNull()
    })

    it("copy undo deletes duplicated track", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const song = deps.context.application.song
        const before = song.tracks.length

        await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) COPY t',
        })
        expect(song.tracks.length).toBe(before + 1)

        await undoViaSerializedLog(deps)
        expect(song.tracks.length).toBe(before)
    })

    it("do read returns WriteEvent and RenderJob virtual labels", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) SET t.mute = true',
        })
        const { setRenderJob, nextRenderJobId } = await import("../render/jobs")
        setRenderJob({
            id: nextRenderJobId(),
            status: "running",
            at: new Date().toISOString(),
            source: "audio-track-pre-fx",
            method: "sdk-pre-fx",
            phase: "exporting",
            track: { index: 0, name: "Drums", kind: "audio" },
            startTime: 0,
            endTime: 4,
            duration: 4,
            audioStatus: "pending",
            cleanupStatus: "complete",
        })

        const write_events = await server.call("do", {
            statement: "MATCH (e:WriteEvent) RETURN e.id, e.statement, e.kind, e.status",
        })
        expect((write_events.json as { count: number }).count).toBeGreaterThan(0)

        const render_jobs = await server.call("do", {
            statement: "MATCH (j:RenderJob) RETURN j.id, j.status",
        })
        expect((render_jobs.json as { count: number }).count).toBeGreaterThan(0)
    })

    it("undo steps:2 LIFO, writeId, and skips undone entries", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const track = songTrack(deps)

        await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) SET t.mute = true',
        })
        const second = await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) SET t.solo = true',
        })
        const second_write_id = (second.json as { writeId: string }).writeId

        await undoViaSerializedLog(deps, { writeId: second_write_id })
        expect(track.solo).toBe(false)
        expect(track.mute).toBe(true)

        await undoViaSerializedLog(deps, { steps: 2 })
        expect(track.mute).toBe(false)
    })

    it("write responses record actual statement in WriteEvent", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        const set_statement = 'MATCH (t:MidiTrack {name:"Drums"}) SET t.mute = true'
        const create_statement = 'CREATE (t:MidiTrack {name:"Pads"})'
        const delete_statement = 'MATCH (t:MidiTrack {name:"Drums"}) DELETE t'

        await server.call("do", { statement: set_statement })
        await server.call("do", { statement: create_statement })
        await server.call("do", { statement: delete_statement, confirm: true })

        const events = await listSerializedUndoEntries(deps)
        expect(
            events.some((entry) => entry.statement === set_statement && entry.kind === "set"),
        ).toBe(true)
        expect(
            events.some((entry) => entry.statement === create_statement && entry.kind === "create"),
        ).toBe(true)
        expect(
            events.some((entry) => entry.statement === delete_statement && entry.kind === "delete"),
        ).toBe(true)
    })

    it("undoable none reports restored:0 with note", async () => {
        const deps = makeDeps({}, storage_directory)
        const server = await buildRegisteredServer(deps)
        await server.call("do", {
            statement: 'MATCH (t:MidiTrack {name:"Drums"}) DELETE t',
            confirm: true,
        })

        const result = await undoViaSerializedLog(deps)
        const first = (result.undone as Record<string, unknown>[])[0]
        expect(first?.restored).toBe(0)
        expect(first?.note).toContain("undoable: none")
    })
})

describe("row-cap unit", () => {
    it("re-exports applyRowCap", async () => {
        const { applyRowCap } = await import("./do/row-cap")
        const result = applyRowCap([{ a: 1 }], false, 500)
        expect(result.truncated).toBe(false)
    })
})
