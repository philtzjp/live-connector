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
import { EXAMPLE_QUERIES, LOM_SCHEMA, query_contract } from "@live-connector/lom-schema"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { collectSetFeatures, setIdentity, structureDigest } from "../lom/fingerprint"
import { SERVICE_VERSION } from "../version"
import { textResult } from "./common"

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
    return { index, name: cue.name, time: cue.time }
}

async function buildOverview(
    deps: ServerDeps,
    include_clips: boolean,
    track_offset: number,
    track_limit: number | undefined,
): Promise<Record<string, unknown>> {
    const song = deps.context.application.song
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

    const shown = all_tracks.slice(track_offset, track_offset + (track_limit ?? all_tracks.length))
    const tracks = shown.map((track, position) => {
        const arrangement_clips = track.arrangementClips
        const base = {
            index: track_offset + position,
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

    return {
        identity: setIdentity(deps.context),
        structureDigest: structureDigest(collectSetFeatures(song)),
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
        trackOffset: track_offset,
        tracksShown: tracks.length,
        includeClips: include_clips,
        cuePoints: song.cuePoints.map((cue, index) => cuePointSummary(cue, index)),
        tracks,
    }
}

export function registerMetaTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "meta",
        {
            title: "サービス・スキーマ・概要",
            description:
                "service 情報、LOM スキーマ、do 文法契約（読み書き）、例文、時刻座標、仮想ラベル（WriteEvent / RenderJob）、Live Set overview を返す。操作前に必ず呼ぶ。",
            inputSchema: {
                includeClips: z
                    .boolean()
                    .optional()
                    .describe("overview のトラックにアレンジメントクリップ明細を含める"),
                trackOffset: z.number().int().min(0).optional(),
                trackLimit: z.number().int().positive().optional(),
            },
        },
        async ({ includeClips, trackOffset, trackLimit }) => {
            try {
                await deps.runtime.refreshOscStatus()
                const capability_pair = deps.runtime.capabilities()
                const payload = {
                    service: { name: "live-connector", version: SERVICE_VERSION },
                    schema: LOM_SCHEMA,
                    query_contract,
                    examples: EXAMPLE_QUERIES,
                    capabilities: capability_pair.render,
                    runtime: capability_pair.runtime,
                    virtual_labels: {
                        WriteEvent: {
                            description: "do 書き込みの undo ログエントリ（読み取り専用）",
                            query: "MATCH (e:WriteEvent) RETURN e",
                        },
                        RenderJob: {
                            description:
                                "render ジョブ状態（id, status, source, method, phase, progress, audioStatus, cleanupStatus, filePath?）— 読み取り専用",
                            query: "MATCH (j:RenderJob) RETURN j",
                        },
                        Transport: {
                            description:
                                "Transport 状態（isPlaying, currentSongTime, tempo, recordMode, loop, punch）— 読み取り専用。鮮度は runtime.osc の connected を参照",
                            query: "MATCH (t:Transport) RETURN t",
                        },
                    },
                    overview: await buildOverview(
                        deps,
                        includeClips ?? true,
                        trackOffset ?? 0,
                        trackLimit,
                    ),
                }
                return textResult(payload)
            } catch (error) {
                deps.log.error("meta failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
