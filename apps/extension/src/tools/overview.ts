import { AudioTrack, MidiTrack, type Track } from "@ableton-extensions/sdk"
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
                const tracks = song.tracks.map((track, index) => ({
                    index,
                    name: track.name,
                    kind: trackKind(track),
                    mute: track.mute,
                    solo: track.solo,
                    arm: track.arm,
                }))
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
