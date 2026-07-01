import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiTrack } from "@ableton-extensions/sdk"
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
