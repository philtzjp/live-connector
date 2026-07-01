import { beforeEach, describe, expect, it, vi } from "vitest"

// SDK 実体（Live 実機依存）をロードせずに instanceof 判定だけを再現する。
vi.mock("@ableton-extensions/sdk", () => {
    class Track {}
    class MidiTrack extends Track {}
    class AudioTrack extends Track {}
    class Clip {}
    class MidiClip extends Clip {}
    class AudioClip extends Clip {}
    class CuePoint {}
    return { Track, MidiTrack, AudioTrack, Clip, MidiClip, AudioClip, CuePoint }
})

import { AudioTrack, MidiClip, MidiTrack } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerOverviewTool } from "./overview"

/** モック済みクラスの prototype を持つフェイクを作る（SDK コンストラクタは非公開のため new を避ける）。 */
function fakeInstance(ctor: { prototype: object }, fields: Record<string, unknown>): object {
    return Object.assign(Object.create(ctor.prototype), fields)
}

function buildDeps(): ServerDeps {
    const drums = fakeInstance(MidiTrack, {
        name: "Drums",
        mute: false,
        solo: false,
        arm: true,
        arrangementClips: [
            fakeInstance(MidiClip, { name: "Beat", startTime: 0, endTime: 4, duration: 4 }),
        ],
    })
    const bass = fakeInstance(AudioTrack, {
        name: "Bass",
        mute: true,
        solo: false,
        arm: false,
        arrangementClips: [],
    })
    const song = {
        tempo: 128,
        scaleName: "Minor",
        scaleMode: true,
        rootNote: 2,
        tracks: [drums, bass],
        returnTracks: [{}],
        scenes: [{}, {}],
        cuePoints: [{ name: "Verse", time: 8 }],
    }
    return {
        context: { application: { song } },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
}

describe("get_overview", () => {
    let server: FakeMcpServer
    beforeEach(() => {
        server = new FakeMcpServer()
        registerOverviewTool(server.asMcpServer(), buildDeps())
    })

    it("summarizes tempo, scale, counts and tracks in one call", async () => {
        const { isError, json } = await server.call("get_overview")
        expect(isError).toBe(false)
        expect(json).toMatchObject({
            tempo: 128,
            scale: { name: "Minor", mode: true, rootNote: 2 },
            trackCount: 2,
            returnTrackCount: 1,
            sceneCount: 2,
            cuePointCount: 1,
        })
    })

    it("classifies track kinds via instanceof and reports arrangement clips", async () => {
        const { json } = (await server.call("get_overview")) as {
            json: { tracks: { name: string; kind: string; arrangementClipCount: number }[] }
        }
        expect(json.tracks.map((track) => [track.name, track.kind])).toEqual([
            ["Drums", "midi"],
            ["Bass", "audio"],
        ])
        expect(json.tracks[0]?.arrangementClipCount).toBe(1)
    })

    it("derives arrangementEndTime from the furthest clip and cue point", async () => {
        const { json } = (await server.call("get_overview")) as {
            json: { arrangementEndTime: number }
        }
        expect(json.arrangementEndTime).toBe(8)
    })
})
