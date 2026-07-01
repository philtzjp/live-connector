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
import { z } from "zod"
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
                "tempo・スケール・トラック概要（index/name/kind/mute/solo/arm）・シーン数などを 1 コールで返す。方向付けに使う。大規模プロジェクトでは includeClips:false でクリップ明細を省略し、trackOffset/trackLimit でトラック範囲を絞れる。",
            inputSchema: {
                includeClips: z
                    .boolean()
                    .optional()
                    .describe(
                        "各トラックのアレンジメントクリップ明細を含めるか（既定 true）。false で件数のみ",
                    ),
                trackOffset: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("返すトラックの開始 index（既定 0）"),
                trackLimit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("返すトラックの最大数（既定は全件）"),
            },
        },
        async ({ includeClips, trackOffset, trackLimit }) => {
            try {
                const song = deps.context.application.song
                const include_clips = includeClips ?? true
                const all_tracks = song.tracks

                let arrangement_end_time = 0
                for (const track of all_tracks) {
                    for (const clip of track.arrangementClips) {
                        arrangement_end_time = Math.max(arrangement_end_time, clip.endTime)
                    }
                }
                for (const cue of song.cuePoints) {
                    arrangement_end_time = Math.max(arrangement_end_time, cue.time)
                }

                const offset = trackOffset ?? 0
                const shown = all_tracks.slice(offset, offset + (trackLimit ?? all_tracks.length))
                const tracks = shown.map((track, position) => {
                    const arrangement_clips = track.arrangementClips
                    const base = {
                        index: offset + position,
                        name: track.name,
                        kind: trackKind(track),
                        mute: track.mute,
                        solo: track.solo,
                        arm: track.arm,
                        arrangementClipCount: arrangement_clips.length,
                    }
                    if (!include_clips) {
                        return base
                    }
                    return {
                        ...base,
                        arrangementClips: arrangement_clips.map((clip, clip_index) =>
                            arrangementClipSummary(clip, clip_index),
                        ),
                    }
                })

                const overview = {
                    tempo: song.tempo,
                    scale: {
                        name: song.scaleName,
                        mode: song.scaleMode,
                        rootNote: song.rootNote,
                    },
                    trackCount: all_tracks.length,
                    returnTrackCount: song.returnTracks.length,
                    sceneCount: song.scenes.length,
                    cuePointCount: song.cuePoints.length,
                    arrangementEndTime: arrangement_end_time,
                    trackOffset: offset,
                    tracksShown: tracks.length,
                    includeClips: include_clips,
                    cuePoints: song.cuePoints.map((cue, index) => cuePointSummary(cue, index)),
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
