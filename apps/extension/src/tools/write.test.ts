import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiTrack, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerWriteTools } from "./write"

let storage_dir: string

beforeEach(async () => {
    storage_dir = await mkdtemp(path.join(tmpdir(), "lc-write-"))
})

afterEach(async () => {
    await rm(storage_dir, { recursive: true, force: true })
})

function buildServer(track_count = 0): { server: FakeMcpServer; tracks: { mute: boolean }[] } {
    const tracks = Array.from({ length: track_count }, (_, index) =>
        Object.assign(Object.create(MidiTrack.prototype), {
            name: `Track-${index}`,
            handle: { id: BigInt(index + 1) },
            mute: false,
            clipSlots: [],
            arrangementClips: [],
            devices: [],
        }),
    )
    const song = Object.assign(Object.create(Song.prototype), {
        tracks,
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    })
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
            environment: { storageDirectory: storage_dir },
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerWriteTools(server.asMcpServer(), deps)
    return { server, tracks }
}

describe("set tool error hints", () => {
    it("guides to create_cue_point when set_cue_point selects a non-CuePoint node", async () => {
        const { server } = buildServer()
        const { isError, json } = await server.call("set_cue_point", {
            select: "MATCH (s:Song) RETURN s",
            set: { name: "Verse" },
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("CuePoint")
        expect(payload.hint).toContain("create_cue_point")
    })

    it("reports no CuePoint to edit and guides to create_cue_point when none match", async () => {
        const { server } = buildServer()
        const { isError, json } = await server.call("set_cue_point", {
            select: 'MATCH (c:CuePoint {name:"Nope"}) RETURN c',
            set: { name: "Verse" },
        })
        expect(isError).toBe(true)
        const payload = json as { error?: string; hint?: string }
        expect(payload.error).toBe("not_found")
        expect(payload.hint).toContain("create_cue_point")
    })
})

const ALL_MIDI_TRACKS = "MATCH (t:MidiTrack) RETURN t"

describe("set tool preview / confirm guardrails", () => {
    it("previews matched targets without applying", async () => {
        const { server, tracks } = buildServer(2)
        const { isError, json } = await server.call("set_track", {
            select: ALL_MIDI_TRACKS,
            set: { mute: true },
            preview: true,
        })
        expect(isError).toBe(false)
        const payload = json as { status: string; matched: number; targets: unknown[] }
        expect(payload.status).toBe("preview")
        expect(payload.matched).toBe(2)
        expect(payload.targets).toHaveLength(2)
        expect(tracks.every((track) => track.mute === false)).toBe(true)
    })

    it("requires confirm above CONFIRM_THRESHOLD targets and does not apply", async () => {
        const { server, tracks } = buildServer(21)
        const { isError, json } = await server.call("set_track", {
            select: ALL_MIDI_TRACKS,
            set: { mute: true },
        })
        expect(isError).toBe(false)
        const payload = json as { status: string; matched: number; hint?: string }
        expect(payload.status).toBe("confirm_required")
        expect(payload.matched).toBe(21)
        expect(payload.hint).toContain("confirm:true")
        expect(tracks.every((track) => track.mute === false)).toBe(true)
    })

    it("applies over the threshold with confirm:true and returns a snapshotId", async () => {
        const { server, tracks } = buildServer(21)
        const { isError, json } = await server.call("set_track", {
            select: ALL_MIDI_TRACKS,
            set: { mute: true },
            confirm: true,
        })
        expect(isError).toBe(false)
        const payload = json as { status: string; modified: number; snapshotId: string }
        expect(payload.status).toBe("ok")
        expect(payload.modified).toBe(21)
        expect(payload.snapshotId).toMatch(/^snap-/)
        expect(tracks.every((track) => track.mute === true)).toBe(true)
    })

    it("applies at or below the threshold without confirm", async () => {
        const { server, tracks } = buildServer(20)
        const { json } = await server.call("set_track", {
            select: ALL_MIDI_TRACKS,
            set: { mute: true },
        })
        expect((json as { status: string }).status).toBe("ok")
        expect(tracks.every((track) => track.mute === true)).toBe(true)
    })
})

describe("input schema validation through the zod path", () => {
    it("rejects a non-positive tempo before the handler runs", async () => {
        const { server } = buildServer()
        await expect(
            server.callValidated("set_song", { set: { tempo: -10 } }),
        ).rejects.toThrowError(ZodError)
    })

    it("rejects an unknown warpMode for set_clip", async () => {
        const { server } = buildServer(1)
        await expect(
            server.callValidated("set_clip", {
                select: "MATCH (c:Clip) RETURN c",
                set: { warpMode: "Bogus" },
            }),
        ).rejects.toThrowError(ZodError)
    })

    it("applies zod defaults exactly like the production MCP layer", async () => {
        // callValidated は default を適用してからハンドラへ渡す（call は素通し）。
        const { server } = buildServer(1)
        const { isError, json } = await server.callValidated("set_track", {
            select: ALL_MIDI_TRACKS,
            set: {},
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("at least one property")
    })
})
