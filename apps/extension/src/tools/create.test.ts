import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { AudioTrack, ClipSlot, MidiTrack } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerCreateTools } from "./create"

function buildServer(kind: "midi" | "audio"): FakeMcpServer {
    const track_proto = kind === "midi" ? MidiTrack.prototype : AudioTrack.prototype
    const track: Record<string, unknown> = Object.assign(Object.create(track_proto), {
        name: "Target",
        handle: { id: 1n },
        arrangementClips: [],
        devices: [],
    })
    const slot = Object.assign(Object.create(ClipSlot.prototype), {
        clip: null,
        hasClip: false,
        index: 0,
        parent: track,
    })
    track.clipSlots = [slot]
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
    registerCreateTools(server.asMcpServer(), deps)
    return server
}

function slotSelect(kind: "midi" | "audio"): string {
    const label = kind === "midi" ? "MidiTrack" : "AudioTrack"
    return `MATCH (t:${label} {name:"Target"})-[:HAS_CLIPSLOT]->(s:ClipSlot) RETURN s`
}

describe("create_clip argument validation", () => {
    it("rejects audioFilePath on a MidiTrack slot instead of ignoring it", async () => {
        const server = buildServer("midi")
        const { isError, json } = await server.call("create_clip", {
            select: slotSelect("midi"),
            audioFilePath: "/tmp/kick.wav",
            length: 4,
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("audioFilePath cannot be used on a MidiTrack slot")
        expect(payload.hint).toContain("length")
    })

    it("rejects length on an AudioTrack slot instead of ignoring it", async () => {
        const server = buildServer("audio")
        const { isError, json } = await server.call("create_clip", {
            select: slotSelect("audio"),
            length: 4,
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain(
            "length cannot be used on an AudioTrack slot",
        )
    })

    it("rejects a relative audioFilePath with a hint like load_sample", async () => {
        const server = buildServer("audio")
        const { isError, json } = await server.call("create_clip", {
            select: slotSelect("audio"),
            audioFilePath: "samples/kick.wav",
        })
        expect(isError).toBe(true)
        expect((json as { detail?: string }).detail).toContain("absolute path")
    })

    it("rejects a missing audio file with not_found instead of a raw SDK error", async () => {
        const server = buildServer("audio")
        const { isError, json } = await server.call("create_clip", {
            select: slotSelect("audio"),
            audioFilePath: "/tmp/definitely-missing-lc-test.wav",
        })
        expect(isError).toBe(true)
        const payload = json as { error?: string; hint?: string }
        expect(payload.error).toBe("not_found")
        expect(payload.hint).toContain("absolute path exists")
    })
})
