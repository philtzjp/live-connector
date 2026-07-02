import {
    AudioClip,
    AudioTrack,
    type Clip,
    ClipSlot,
    MidiClip,
    MidiTrack,
    type Track,
} from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"
import { assertSampleFile } from "./samples"

type V = TargetApiVersion
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type CreateClipParams = {
    select: string
    length: number | undefined
    audioFilePath: string | undefined
    preview: boolean | undefined
}

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function selectDescription(): string {
    return '空の ClipSlot を単一ノード変数で RETURN する Cypher。query のようなプロパティ射影（RETURN s.hasClip）や複数変数（RETURN t, s）は不可。例: MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s'
}

function resolveSingleClipSlot(nodes: LomNode[]): LomNode {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `create_clip requires the selection to match exactly one ClipSlot, but matched ${nodes.length}`,
            {
                hint: 'Change select so it returns exactly one ClipSlot node, e.g. MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s.',
            },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof ClipSlot)) {
        throw new BadRequestError("select must return a ClipSlot", {
            hint: "Use a select query that starts from a Track and returns a ClipSlot node.",
        })
    }
    return node
}

function resolveClipTrack(slot: ClipSlot<V>): MidiTrack<V> | AudioTrack<V> {
    const parent = slot.parent
    if (parent instanceof MidiTrack || parent instanceof AudioTrack) {
        return parent
    }
    throw new BadRequestError("create_clip requires a ClipSlot on a MidiTrack or AudioTrack", {
        hint: "Select a ClipSlot reached from a MidiTrack (empty MidiClip) or an AudioTrack (audio clip with audioFilePath).",
    })
}

function trackIndex(tracks: Track<V>[], track: Track<V>): number {
    const index = tracks.findIndex((candidate) => candidate.handle === track.handle)
    if (index < 0) {
        throw new BadRequestError("selected ClipSlot parent track is not in Song.tracks")
    }
    return index
}

function clipSummary(clip: Clip<V>): Record<string, unknown> {
    return {
        _label:
            clip instanceof MidiClip
                ? "MidiClip"
                : clip instanceof AudioClip
                  ? "AudioClip"
                  : "Clip",
        name: clip.name,
        duration: clip.duration,
        startTime: clip.startTime,
        endTime: clip.endTime,
    }
}

async function createClip(
    context: ServerDeps["context"],
    slot: ClipSlot<V>,
    track: MidiTrack<V> | AudioTrack<V>,
    params: CreateClipParams,
): Promise<Clip<V>> {
    if (track instanceof MidiTrack) {
        if (params.audioFilePath !== undefined) {
            throw new BadRequestError(
                "audioFilePath cannot be used on a MidiTrack slot (it creates a MidiClip)",
                { hint: "Pass length (beats) for MidiTrack slots, or select an AudioTrack slot." },
            )
        }
        if (params.length === undefined) {
            throw new BadRequestError("length (beats) is required to create a MidiClip", {
                hint: "Pass length for MidiTrack slots.",
            })
        }
        const length = params.length
        return context.withinTransaction(() => slot.createMidiClip(length))
    }
    if (params.length !== undefined) {
        throw new BadRequestError(
            "length cannot be used on an AudioTrack slot (the clip length follows the audio file)",
            { hint: "Pass audioFilePath for AudioTrack slots, or select a MidiTrack slot." },
        )
    }
    if (params.audioFilePath === undefined) {
        throw new BadRequestError("audioFilePath is required to create an audio session clip", {
            hint: "Pass audioFilePath for AudioTrack slots.",
        })
    }
    // load_sample と同等の事前検証（絶対パス・対応形式・存在）。SDK の生エラーを防ぐ。
    await assertSampleFile(params.audioFilePath)
    const filePath = params.audioFilePath
    return context.withinTransaction(() => slot.createAudioClip({ filePath }))
}

async function runCreateClipTool(deps: ServerDeps, params: CreateClipParams): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const node = resolveSingleClipSlot(await selectNodes(parseQuery(params.select), adapter))
        const slot = node.value as ClipSlot<V>
        const track = resolveClipTrack(slot)
        if (slot.clip !== null) {
            throw new BadRequestError("selected ClipSlot already contains a clip", {
                hint: "Select a ClipSlot where hasClip is false.",
            })
        }
        const kind = track instanceof MidiTrack ? "midi" : "audio"
        const summary = {
            track: {
                index: trackIndex(deps.context.application.song.tracks, track),
                name: track.name,
                kind,
            },
            clipSlot: await adapter.serialize(node),
            length: params.length ?? null,
            audioFilePath: params.audioFilePath ?? null,
        }

        if (params.preview === true) {
            return textResult({ status: "preview", ...summary })
        }

        const clip = await createClip(deps.context, slot, track, params)

        return textResult({
            status: "ok",
            ...summary,
            clipSlot: await adapter.serialize(node),
            clip: clipSummary(clip),
        })
    } catch (error) {
        deps.log.error("create_clip failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** `create_clip` ツール: 空 ClipSlot に MidiClip（length）または AudioClip（audioFilePath）を生成する。 */
export function registerCreateTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "create_clip",
        {
            title: "Session Clip 生成",
            description:
                "select で選んだ 1 つの空 ClipSlot にセッションクリップを生成する。MidiTrack の ClipSlot は length（beats）で空 MidiClip、AudioTrack の ClipSlot は audioFilePath（絶対パス・対応形式・存在を事前検証）で AudioClip を作る。無効な組み合わせ（MidiTrack + audioFilePath / AudioTrack + length）は明示エラー。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                length: z
                    .number()
                    .positive()
                    .optional()
                    .describe("MidiTrack の ClipSlot で生成する MidiClip の長さ（beats）"),
                audioFilePath: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("AudioTrack の ClipSlot で読み込むオーディオファイルの絶対パス"),
                preview: z.boolean().optional().describe("生成せず対象と生成内容を返すドライラン"),
            },
        },
        async ({ select, length, audioFilePath, preview }) =>
            runCreateClipTool(deps, { select, length, audioFilePath, preview }),
    )
}
