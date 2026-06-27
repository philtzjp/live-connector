import {
    AudioClip,
    AudioTrack,
    type Clip,
    type CuePoint,
    MidiClip,
    MidiTrack,
    type Track,
} from "@ableton-extensions/sdk"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerDeps, TargetApiVersion } from "../deps"

function trackKind(track: Track<TargetApiVersion>): string {
    if (track instanceof MidiTrack) {
        return "midi"
    }
    if (track instanceof AudioTrack) {
        return "audio"
    }
    return "other"
}

function clipLabel(clip: Clip<TargetApiVersion>): string {
    if (clip instanceof MidiClip) {
        return "MidiClip"
    }
    if (clip instanceof AudioClip) {
        return "AudioClip"
    }
    return "Clip"
}

function arrangementClipSummary(
    clip: Clip<TargetApiVersion>,
    index: number,
): Record<string, unknown> {
    return {
        index,
        _label: clipLabel(clip),
        name: clip.name,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
    }
}

function cuePointSummary(cue: CuePoint<TargetApiVersion>, index: number): Record<string, unknown> {
    return {
        index,
        name: cue.name,
        time: cue.time,
    }
}

/**
 * `get_overview` ツール: tempo・スケール・トラック概要などを 1 コールで返す。
 * コマンドコールバック外（MCP リクエストハンドラ）から SDK 読み取りが成立するかの実証も兼ねる。
 */
export function registerOverviewTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "get_overview",
        {
            title: "Live Set 概要",
            description:
                "tempo・スケール・トラック概要（index/name/kind/mute/solo/arm）・シーン数などを 1 コールで返す。方向付けに使う。",
        },
        async () => {
            try {
                const song = deps.context.application.song
                let arrangement_end_time = 0
                const tracks = song.tracks.map((track, index) => {
                    const arrangement_clips = track.arrangementClips.map((clip, clip_index) => {
                        arrangement_end_time = Math.max(arrangement_end_time, clip.endTime)
                        return arrangementClipSummary(clip, clip_index)
                    })
                    return {
                        index,
                        name: track.name,
                        kind: trackKind(track),
                        mute: track.mute,
                        solo: track.solo,
                        arm: track.arm,
                        arrangementClipCount: arrangement_clips.length,
                        arrangementClips: arrangement_clips,
                    }
                })
                const cue_points = song.cuePoints.map((cue, index) => {
                    arrangement_end_time = Math.max(arrangement_end_time, cue.time)
                    return cuePointSummary(cue, index)
                })
                const overview = {
                    tempo: song.tempo,
                    scale: {
                        name: song.scaleName,
                        mode: song.scaleMode,
                        rootNote: song.rootNote,
                    },
                    trackCount: tracks.length,
                    returnTrackCount: song.returnTracks.length,
                    sceneCount: song.scenes.length,
                    cuePointCount: song.cuePoints.length,
                    arrangementEndTime: arrangement_end_time,
                    cuePoints: cue_points,
                    tracks,
                }
                return {
                    content: [{ type: "text", text: JSON.stringify(overview, null, 2) }],
                }
            } catch (error) {
                deps.log.error("get_overview failed", { error: String(error) })
                return {
                    content: [{ type: "text", text: JSON.stringify(toMcpError(error), null, 2) }],
                    isError: true,
                }
            }
        },
    )
}
