import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { Device, MidiTrack } from "@ableton-extensions/sdk"
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
