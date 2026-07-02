import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { CuePoint, MidiClip, MidiTrack, Song } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerArrangementTools } from "./arrangement"

function buildServer(): {
    server: FakeMcpServer
    track: { arrangementClips: unknown[] }
    song: { cuePoints: unknown[] }
} {
    const clip = Object.assign(Object.create(MidiClip.prototype), {
        name: "Beat",
        handle: { id: 11n },
        startTime: 0,
        endTime: 4,
        duration: 4,
    })
    const track: Record<string, unknown> = Object.assign(Object.create(MidiTrack.prototype), {
        name: "Drums",
        handle: { id: 1n },
        clipSlots: [],
        devices: [],
        arrangementClips: [clip],
    })
    track.deleteClip = (target: unknown) => {
        track.arrangementClips = (track.arrangementClips as unknown[]).filter(
            (candidate) => candidate !== target,
        )
        return Promise.resolve()
    }
    // resolveArrangementClip は clip.parent が Track であることでアレンジメント Clip と判定する。
    clip.parent = track
    const cue = Object.assign(Object.create(CuePoint.prototype), {
        name: "Verse",
        time: 8,
        handle: { id: 21n },
    })
    const song: Record<string, unknown> = Object.assign(Object.create(Song.prototype), {
        tracks: [track],
        returnTracks: [],
        scenes: [],
        cuePoints: [cue],
        mainTrack: {},
    })
    song.deleteCuePoint = (target: unknown) => {
        song.cuePoints = (song.cuePoints as unknown[]).filter((candidate) => candidate !== target)
        return Promise.resolve()
    }
    const deps = {
        context: {
            application: { song },
            withinTransaction: (fn: () => unknown) => fn(),
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerArrangementTools(server.asMcpServer(), deps)
    return {
        server,
        track: track as { arrangementClips: unknown[] },
        song: song as { cuePoints: unknown[] },
    }
}

const CLIP_SELECT = 'MATCH (c:MidiClip {name:"Beat"}) RETURN c'
const CUE_SELECT = 'MATCH (c:CuePoint {name:"Verse"}) RETURN c'

describe("delete_arrangement_clip confirm guard", () => {
    it("returns confirm_required without confirm and does not delete", async () => {
        const { server, track } = buildServer()
        const { isError, json } = await server.call("delete_arrangement_clip", {
            select: CLIP_SELECT,
        })
        expect(isError).toBe(false)
        expect((json as { status: string }).status).toBe("confirm_required")
        expect(track.arrangementClips).toHaveLength(1)
    })

    it("previews without deleting", async () => {
        const { server, track } = buildServer()
        const { json } = await server.call("delete_arrangement_clip", {
            select: CLIP_SELECT,
            preview: true,
        })
        expect((json as { status: string }).status).toBe("preview")
        expect(track.arrangementClips).toHaveLength(1)
    })

    it("deletes with confirm:true", async () => {
        const { server, track } = buildServer()
        const { json } = await server.call("delete_arrangement_clip", {
            select: CLIP_SELECT,
            confirm: true,
        })
        expect((json as { status: string }).status).toBe("ok")
        expect(track.arrangementClips).toHaveLength(0)
    })
})

describe("delete_cue_point confirm guard", () => {
    it("returns confirm_required without confirm and does not delete", async () => {
        const { server, song } = buildServer()
        const { json } = await server.call("delete_cue_point", { select: CUE_SELECT })
        expect((json as { status: string }).status).toBe("confirm_required")
        expect(song.cuePoints).toHaveLength(1)
    })

    it("deletes with confirm:true", async () => {
        const { server, song } = buildServer()
        const { json } = await server.call("delete_cue_point", {
            select: CUE_SELECT,
            confirm: true,
        })
        expect((json as { status: string }).status).toBe("ok")
        expect(song.cuePoints).toHaveLength(0)
    })
})
