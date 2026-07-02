import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { ClipSlot, Device, MidiClip, MidiTrack, Scene } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { guardDestructive, registerStructureTools } from "./structure"

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

describe("create_track", () => {
    function buildServer(): { server: FakeMcpServer; track: { name: string } } {
        const track = Object.assign(Object.create(MidiTrack.prototype), { handle: 1, name: "" })
        const song = {
            tracks: [track],
            createMidiTrack: () => Promise.resolve(track),
            createAudioTrack: () => Promise.resolve(track),
        }
        const deps = {
            context: {
                application: { song },
                withinTransaction: (fn: () => unknown) => fn(),
            },
            log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as ServerDeps
        const server = new FakeMcpServer()
        registerStructureTools(server.asMcpServer(), deps)
        return { server, track }
    }

    it("previews without creating", async () => {
        const { server, track } = buildServer()
        const { json } = (await server.call("create_track", { kind: "midi", preview: true })) as {
            json: { status: string; kind: string }
        }
        expect(json.status).toBe("preview")
        expect(json.kind).toBe("midi")
        expect(track.name).toBe("")
    })

    it("creates a track and applies the name", async () => {
        const { server, track } = buildServer()
        const { json } = (await server.call("create_track", { kind: "midi", name: "Lead" })) as {
            json: { status: string; track: { index: number; name: string; kind: string } }
        }
        expect(json.status).toBe("ok")
        expect(json.track).toMatchObject({ index: 0, name: "Lead", kind: "midi" })
        expect(track.name).toBe("Lead")
    })
})

describe("duplicate_device", () => {
    it("returns the index of the duplicated device so it can be selected uniquely", async () => {
        const original = Object.assign(Object.create(Device.prototype), {
            name: "Operator",
            handle: { id: 31n },
        })
        const track: Record<string, unknown> = Object.assign(Object.create(MidiTrack.prototype), {
            name: "Lead",
            handle: { id: 1n },
            clipSlots: [],
            arrangementClips: [],
            devices: [original],
        })
        original.parent = track
        track.duplicateDevice = (source: { name: string }) => {
            const copy = Object.assign(Object.create(Device.prototype), {
                name: source.name,
                handle: { id: 32n },
                parent: track,
            })
            // SDK 仕様: 複製は元の直後に挿入される。
            ;(track.devices as unknown[]).splice(1, 0, copy)
            return Promise.resolve(copy)
        }
        const song = {
            tracks: [track],
            returnTracks: [],
            scenes: [],
            cuePoints: [],
            mainTrack: {},
        }
        const deps = {
            context: {
                application: { song },
                withinTransaction: (fn: () => unknown) => fn(),
            },
            log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as ServerDeps
        const server = new FakeMcpServer()
        registerStructureTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("duplicate_device", {
            select: 'MATCH (:MidiTrack {name:"Lead"})-[:HAS_DEVICE]->(d:Device {name:"Operator"}) RETURN d',
        })
        expect(isError).toBe(false)
        const payload = json as { status: string; device: { name: string; index: number } }
        expect(payload.status).toBe("ok")
        expect(payload.device).toEqual({ name: "Operator", index: 1 })
    })
})

type StructureFixture = {
    server: FakeMcpServer
    song: {
        tracks: unknown[]
        scenes: { name: string }[]
    }
    slot: { clip: unknown }
    device_list: () => unknown[]
}

/** scenes / tracks / devices / session clip を備えた Set で structure 系 8 ツールを検証する。 */
function buildStructureFixture(): StructureFixture {
    const device = Object.assign(Object.create(Device.prototype), {
        name: "Operator",
        handle: { id: 31n },
    })
    const clip = Object.assign(Object.create(MidiClip.prototype), {
        name: "Loop",
        handle: { id: 41n },
    })
    const slot: Record<string, unknown> = Object.assign(Object.create(ClipSlot.prototype), {
        clip,
        hasClip: true,
        index: 0,
    })
    slot.deleteClip = () => {
        slot.clip = null
        return Promise.resolve()
    }
    const track: Record<string, unknown> = Object.assign(Object.create(MidiTrack.prototype), {
        name: "Drums",
        handle: { id: 1n },
        clipSlots: [slot],
        arrangementClips: [],
        devices: [device],
    })
    device.parent = track
    slot.parent = track
    track.deleteDevice = (target: unknown) => {
        track.devices = (track.devices as unknown[]).filter((candidate) => candidate !== target)
        return Promise.resolve()
    }
    const scenes: Record<string, unknown>[] = [
        Object.assign(Object.create(Scene.prototype), { name: "Intro", handle: { id: 51n } }),
        Object.assign(Object.create(Scene.prototype), { name: "Verse", handle: { id: 52n } }),
    ]
    const song: Record<string, unknown> = Object.assign(Object.create(Object.prototype), {
        tracks: [track],
        returnTracks: [],
        scenes,
        cuePoints: [],
        mainTrack: {},
    })
    song.createScene = () => {
        const created = Object.assign(Object.create(Scene.prototype), {
            name: "",
            handle: { id: 59n },
        })
        ;(song.scenes as unknown[]).push(created)
        return Promise.resolve(created)
    }
    song.deleteScene = (target: unknown) => {
        song.scenes = (song.scenes as unknown[]).filter((candidate) => candidate !== target)
        return Promise.resolve()
    }
    song.duplicateScene = (source: { name: string }) => {
        const scene_list = song.scenes as { name: string }[]
        const source_index = scene_list.indexOf(source as never)
        const copy = Object.assign(Object.create(Scene.prototype), {
            name: source.name,
            handle: { id: 60n },
        })
        scene_list.splice(source_index + 1, 0, copy as never)
        return Promise.resolve(copy)
    }
    song.deleteTrack = (target: unknown) => {
        song.tracks = (song.tracks as unknown[]).filter((candidate) => candidate !== target)
        return Promise.resolve()
    }
    song.duplicateTrack = (source: { name: string }) => {
        const copy = Object.assign(Object.create(MidiTrack.prototype), {
            name: source.name,
            handle: { id: 2n },
            clipSlots: [],
            arrangementClips: [],
            devices: [],
        })
        ;(song.tracks as unknown[]).splice(1, 0, copy)
        return Promise.resolve(copy)
    }
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerStructureTools(server.asMcpServer(), deps)
    return {
        server,
        song: song as StructureFixture["song"],
        slot: slot as { clip: unknown },
        device_list: () => track.devices as unknown[],
    }
}

describe("structure tools handler coverage", () => {
    it("create_scene appends a scene and reports its index", async () => {
        const { server, song } = buildStructureFixture()
        const { isError, json } = await server.call("create_scene", { name: "Drop" })
        expect(isError).toBe(false)
        const payload = json as { status: string; scene: { index: number; name: string } }
        expect(payload.status).toBe("ok")
        expect(payload.scene).toMatchObject({ index: 2, name: "Drop" })
        expect(song.scenes).toHaveLength(3)
    })

    it("delete_scene requires confirm and deletes with confirm:true", async () => {
        const { server, song } = buildStructureFixture()
        const guarded = await server.call("delete_scene", {
            select: 'MATCH (s:Scene {name:"Intro"}) RETURN s',
        })
        expect((guarded.json as { status: string }).status).toBe("confirm_required")
        expect(song.scenes).toHaveLength(2)

        const deleted = await server.call("delete_scene", {
            select: 'MATCH (s:Scene {name:"Intro"}) RETURN s',
            confirm: true,
        })
        expect((deleted.json as { status: string }).status).toBe("ok")
        expect(song.scenes.map((scene) => scene.name)).toEqual(["Verse"])
    })

    it("duplicate_scene inserts the copy right after the original and reports its index", async () => {
        const { server, song } = buildStructureFixture()
        const { json } = await server.call("duplicate_scene", {
            select: 'MATCH (s:Scene {name:"Intro"}) RETURN s',
        })
        const payload = json as { status: string; scene: { index: number; name: string } }
        expect(payload.status).toBe("ok")
        expect(payload.scene).toMatchObject({ index: 1, name: "Intro" })
        expect(song.scenes.map((scene) => scene.name)).toEqual(["Intro", "Intro", "Verse"])
    })

    it("delete_track requires confirm and deletes a regular track with confirm:true", async () => {
        const { server, song } = buildStructureFixture()
        const guarded = await server.call("delete_track", {
            select: 'MATCH (t:MidiTrack {name:"Drums"}) RETURN t',
        })
        expect((guarded.json as { status: string }).status).toBe("confirm_required")
        expect(song.tracks).toHaveLength(1)

        const deleted = await server.call("delete_track", {
            select: 'MATCH (t:MidiTrack {name:"Drums"}) RETURN t',
            confirm: true,
        })
        expect((deleted.json as { status: string }).status).toBe("ok")
        expect(song.tracks).toHaveLength(0)
    })

    it("duplicate_track reports the index of the copy inserted after the original", async () => {
        const { server, song } = buildStructureFixture()
        const { json } = await server.call("duplicate_track", {
            select: 'MATCH (t:MidiTrack {name:"Drums"}) RETURN t',
        })
        const payload = json as { status: string; track: { index: number; name: string } }
        expect(payload.status).toBe("ok")
        expect(payload.track).toMatchObject({ index: 1, name: "Drums" })
        expect(song.tracks).toHaveLength(2)
    })

    it("delete_device requires confirm and removes the device with confirm:true", async () => {
        const { server, device_list } = buildStructureFixture()
        const guarded = await server.call("delete_device", {
            select: 'MATCH (:MidiTrack {name:"Drums"})-[:HAS_DEVICE]->(d:Device) RETURN d',
        })
        expect((guarded.json as { status: string }).status).toBe("confirm_required")
        expect(device_list()).toHaveLength(1)

        const deleted = await server.call("delete_device", {
            select: 'MATCH (:MidiTrack {name:"Drums"})-[:HAS_DEVICE]->(d:Device) RETURN d',
            confirm: true,
        })
        expect((deleted.json as { status: string }).status).toBe("ok")
        expect(device_list()).toHaveLength(0)
    })

    it("delete_session_clip requires confirm and clears the slot with confirm:true", async () => {
        const { server, slot } = buildStructureFixture()
        const guarded = await server.call("delete_session_clip", {
            select: 'MATCH (:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s',
        })
        expect((guarded.json as { status: string }).status).toBe("confirm_required")
        expect(slot.clip).not.toBeNull()

        const deleted = await server.call("delete_session_clip", {
            select: 'MATCH (:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s',
            confirm: true,
        })
        expect((deleted.json as { status: string }).status).toBe("ok")
        expect(slot.clip).toBeNull()
    })
})
