import { AudioTrack, type Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type RenderAudioParams = {
    select: string
    startTime: number
    endTime: number
}

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function selectDescription(): string {
    return 'AudioTrack を単一ノード変数で RETURN する Cypher。query のようなプロパティ射影（RETURN t.name）や複数変数（RETURN t, c）は不可。例: MATCH (t:AudioTrack {name:"Print"}) RETURN t'
}

function resolveSingleAudioTrack(nodes: LomNode[]): LomNode {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `render_audio requires the selection to match exactly one AudioTrack, but matched ${nodes.length}`,
            {
                hint: 'Change select so it returns exactly one AudioTrack node, e.g. MATCH (t:AudioTrack {name:"Print"}) RETURN t.',
            },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof AudioTrack)) {
        throw new BadRequestError("select must return an AudioTrack", {
            hint: "Use a select query that returns one AudioTrack node. MidiTrack cannot be rendered by renderPreFxAudio.",
        })
    }
    return node
}

function validateBeatRange(start_time: number, end_time: number): void {
    if (end_time <= start_time) {
        throw new BadRequestError("endTime must be greater than startTime", {
            hint: "Pass a positive beat range, e.g. startTime:0 and endTime:16.",
        })
    }
}

function trackIndex(
    tracks: Track<TargetApiVersion>[],
    track: AudioTrack<TargetApiVersion>,
): number {
    const index = tracks.findIndex((candidate) => candidate.handle === track.handle)
    if (index < 0) {
        throw new BadRequestError("selected AudioTrack is not in Song.tracks")
    }
    return index
}

async function runRenderAudioTool(
    deps: ServerDeps,
    params: RenderAudioParams,
): Promise<ToolResult> {
    try {
        validateBeatRange(params.startTime, params.endTime)
        const adapter = new LomGraphAdapter(deps.context)
        const node = resolveSingleAudioTrack(await selectNodes(parseQuery(params.select), adapter))
        const track = node.value as AudioTrack<TargetApiVersion>
        const track_index = trackIndex(deps.context.application.song.tracks, track)
        const file_path = await deps.context.resources.renderPreFxAudio(
            track,
            params.startTime,
            params.endTime,
        )

        return textResult({
            status: "ok",
            filePath: file_path,
            startTime: params.startTime,
            endTime: params.endTime,
            duration: params.endTime - params.startTime,
            track: {
                index: track_index,
                name: track.name,
                kind: "audio",
            },
        })
    } catch (error) {
        deps.log.error("render_audio failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** `render_audio` ツール: AudioTrack のアレンジメント pre-FX 音声を WAV にレンダリングする。 */
export function registerAudioTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "render_audio",
        {
            title: "AudioTrack 音声レンダリング",
            description:
                "select で選んだ 1 つの AudioTrack のアレンジメント上の pre-FX 音声を、startTime/endTime（beats）範囲で WAV にレンダリングし、生成ファイルパスを返す。MidiTrack、send、return、post-FX 音声は対象外。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                startTime: z.number().min(0).describe("レンダリング開始位置（beats）"),
                endTime: z.number().positive().describe("レンダリング終了位置（beats）"),
            },
        },
        async ({ select, startTime, endTime }) =>
            runRenderAudioTool(deps, { select, startTime, endTime }),
    )
}
