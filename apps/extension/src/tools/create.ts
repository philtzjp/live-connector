import { ClipSlot, type MidiClip, MidiTrack, type Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type CreateClipParams = {
    select: string
    length: number
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
            hint: "Use a select query that starts from MidiTrack and returns a ClipSlot node.",
        })
    }
    return node
}

function resolveMidiTrack(slot: ClipSlot<TargetApiVersion>): MidiTrack<TargetApiVersion> {
    const parent = slot.parent
    if (!(parent instanceof MidiTrack)) {
        throw new BadRequestError("create_clip requires a ClipSlot on a MidiTrack", {
            hint: "Select a ClipSlot reached from a MidiTrack. AudioTrack slots cannot create empty MidiClip instances.",
        })
    }
    return parent
}

function trackIndex(tracks: Track<TargetApiVersion>[], track: MidiTrack<TargetApiVersion>): number {
    const index = tracks.findIndex((candidate) => candidate.handle === track.handle)
    if (index < 0) {
        throw new BadRequestError("selected ClipSlot parent track is not in Song.tracks")
    }
    return index
}

function clipSummary(clip: MidiClip<TargetApiVersion>): Record<string, unknown> {
    return {
        _label: "MidiClip",
        name: clip.name,
        duration: clip.duration,
        startTime: clip.startTime,
        endTime: clip.endTime,
        noteCount: clip.notes.length,
    }
}

async function runCreateClipTool(deps: ServerDeps, params: CreateClipParams): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const node = resolveSingleClipSlot(await selectNodes(parseQuery(params.select), adapter))
        const slot = node.value as ClipSlot<TargetApiVersion>
        const track = resolveMidiTrack(slot)
        if (slot.clip !== null) {
            throw new BadRequestError("selected ClipSlot already contains a clip", {
                hint: "Select a ClipSlot where hasClip is false.",
            })
        }
        const track_index = trackIndex(deps.context.application.song.tracks, track)
        const target = await adapter.serialize(node)
        const summary = {
            track: { index: track_index, name: track.name, kind: "midi" },
            clipSlot: target,
            length: params.length,
        }

        if (params.preview === true) {
            return textResult({ status: "preview", ...summary })
        }

        const clip = await deps.context.withinTransaction(() => slot.createMidiClip(params.length))

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

/** `create_clip` ツール: 空の MidiTrack ClipSlot に空 MidiClip を生成する。 */
export function registerCreateTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "create_clip",
        {
            title: "空 MidiClip 生成",
            description:
                "select で選んだ 1 つの空 ClipSlot に、指定 length（beats）の空 MidiClip を生成する。対象は MidiTrack 配下の ClipSlot のみ。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                length: z.number().positive().describe("生成する MidiClip の長さ（beats）"),
                preview: z.boolean().optional().describe("生成せず対象と生成内容を返すドライラン"),
            },
        },
        async ({ select, length, preview }) => runCreateClipTool(deps, { select, length, preview }),
    )
}
