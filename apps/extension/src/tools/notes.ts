import { type Clip, MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"
import { captureNotesSnapshot, objectIdentity } from "./snapshots"

export const noteSchema = z.object({
    pitch: z.number().int().min(0).max(127).describe("MIDI ノート番号 0-127（60=C3）"),
    startTime: z.number().min(0).describe("クリップ相対拍（beats、クリップ先頭からの位置）"),
    duration: z.number().positive().describe("音価（beats）"),
    velocity: z.number().min(0).max(127).optional().describe("ベロシティ 0-127（既定 100）"),
    muted: z.boolean().optional().describe("ノートをミュートする"),
    probability: z.number().min(0).max(1).optional().describe("発音確率 0-1"),
    releaseVelocity: z.number().min(0).max(127).optional().describe("リリースベロシティ 0-127"),
    velocityDeviation: z.number().optional().describe("ベロシティのランダム偏差"),
})

export type NoteInput = z.infer<typeof noteSchema>

type NoteStartTime = { startTime: number }

/** クリップ相対のノート配置に使うクリップ長。ループ・内容窓を含む上限を採用し誤検出を避ける。 */
export function clipNoteLength(clip: Clip<TargetApiVersion>): number {
    return Math.max(clip.duration, clip.loopEnd, clip.endMarker)
}

/**
 * クリップ相対座標 [0, clipLength) を外れるノートの index / startTime を返す。
 * ノートの startTime はクリップ相対拍。アレンジメント絶対拍を混入させると境界外になる。
 */
export function findOutOfRangeNotes(
    notes: readonly NoteStartTime[],
    clipLength: number,
): { index: number; startTime: number }[] {
    const offending: { index: number; startTime: number }[] = []
    notes.forEach((note, index) => {
        if (note.startTime < 0 || note.startTime >= clipLength) {
            offending.push({ index, startTime: note.startTime })
        }
    })
    return offending
}

function collisionKey(note: { pitch: number; startTime: number }): string {
    return `${note.pitch}:${note.startTime}`
}

/**
 * 既存ノートへ入力ノートを追加する。同一 pitch かつ同一 startTime の衝突は入力側で置換する
 * （重複ノートの積み上げを避ける）。
 */
export function mergeNotes(
    existing: readonly NoteDescription[],
    incoming: readonly NoteDescription[],
): NoteDescription[] {
    const incoming_keys = new Set(incoming.map(collisionKey))
    const kept = existing.filter((note) => !incoming_keys.has(collisionKey(note)))
    return [...kept, ...incoming]
}

/** 指定範囲 [start, end)（クリップ相対拍）の startTime を持つノートを取り除く。 */
export function clearNotesInRange(
    existing: readonly NoteDescription[],
    start: number,
    end: number,
): { kept: NoteDescription[]; removed: number } {
    const kept = existing.filter((note) => note.startTime < start || note.startTime >= end)
    return { kept, removed: existing.length - kept.length }
}

function selectDescription(): string {
    return 'MidiClip を単一ノード変数で RETURN する Cypher。query のようなプロパティ射影（RETURN c.name）や複数変数（RETURN t, c）は不可。例: MATCH (c:MidiClip {name:"Bass"}) RETURN c'
}

export function toNoteDescription(input: NoteInput): NoteDescription {
    const note: NoteDescription = {
        pitch: input.pitch,
        startTime: input.startTime,
        duration: input.duration,
    }
    if (input.velocity !== undefined) {
        note.velocity = input.velocity
    }
    if (input.muted !== undefined) {
        note.muted = input.muted
    }
    if (input.probability !== undefined) {
        note.probability = input.probability
    }
    if (input.releaseVelocity !== undefined) {
        note.releaseVelocity = input.releaseVelocity
    }
    if (input.velocityDeviation !== undefined) {
        note.velocityDeviation = input.velocityDeviation
    }
    return note
}

type WriteNotesParams = {
    select: string
    notes: NoteInput[]
    mode: "replace" | "merge" | "clear_range"
    range: { start: number; end: number } | undefined
    allowOutOfRange: boolean | undefined
    preview: boolean | undefined
}

export type NoteWriteParams = {
    tool_name: string
    notes: NoteInput[]
    mode: "replace" | "merge" | "clear_range"
    range: { start: number; end: number } | undefined
    allowOutOfRange: boolean | undefined
}

export type NoteWritePlan = {
    summary: Record<string, unknown>
    /** 適用時点の clip.notes から変換後ノート列を計算する（batch の逐次再解決に使う）。 */
    computeNextNotes: () => NoteDescription[]
}

/**
 * write_notes の検証と変換計画。単体ツールと batch ステップの両方がこれを通ることで
 * 入力検証を等価に保つ。summary の件数は計画時点の clip.notes に基づく。
 */
export function planNoteWrite(
    clip: MidiClip<TargetApiVersion>,
    params: NoteWriteParams,
): NoteWritePlan {
    // notes 省略（既定 []）+ mode 省略（既定 replace）の呼び出しが全ノート無言消去にならないようにする。
    if (params.mode !== "clear_range" && params.notes.length === 0) {
        throw new BadRequestError(
            `${params.tool_name}: ${params.mode} mode requires a non-empty notes array`,
            {
                hint: 'Pass notes like [{pitch:60, startTime:0, duration:1, velocity:100}]. To intentionally remove notes, use mode:"clear_range" with range:{start:0, end:<clipLength>}.',
            },
        )
    }
    const clip_length = clipNoteLength(clip)
    const incoming = params.notes.map(toNoteDescription)

    const out_of_range =
        params.mode === "clear_range" ? [] : findOutOfRangeNotes(params.notes, clip_length)
    if (out_of_range.length > 0 && params.allowOutOfRange !== true) {
        throw new BadRequestError(
            `${out_of_range.length} note(s) fall outside the clip's relative range [0, ${clip_length}). Note startTime is clip-relative beats, not arrangement-absolute beats.`,
            {
                hint: `LOM has two time coordinate systems: note startTime / clip markers are CLIP-RELATIVE beats in [0, clipLength); Clip.startTime/endTime and create_arrangement_clip startTime are ARRANGEMENT-ABSOLUTE beats. Recompute the offending notes relative to the clip start, or pass allowOutOfRange:true. Offending indices: ${out_of_range.map((entry) => `${entry.index}@${entry.startTime}`).join(", ")}.`,
            },
        )
    }

    // startTime はクリップ内だが startTime + duration が末尾を超えるノートは受理し、件数を応答で申告する。
    // （startTime 自体の境界検証と異なり、末尾に食い込む音価は打ち込みとして正当なため拒否しない。）
    const tail_overflow =
        params.mode === "clear_range"
            ? 0
            : params.notes.filter(
                  (input) =>
                      input.startTime >= 0 &&
                      input.startTime < clip_length &&
                      input.startTime + input.duration > clip_length,
              ).length

    const summary: Record<string, unknown> = {
        mode: params.mode,
        clipLength: clip_length,
        outOfRange: out_of_range.length,
        tailOverflow: tail_overflow,
    }

    if (params.mode === "replace") {
        summary.noteCount = incoming.length
        return { summary, computeNextNotes: () => incoming }
    }
    if (params.mode === "merge") {
        const existing = clip.notes
        summary.added = incoming.length
        summary.previous = existing.length
        summary.noteCount = mergeNotes(existing, incoming).length
        return { summary, computeNextNotes: () => mergeNotes(clip.notes, incoming) }
    }
    const range = params.range
    if (range === undefined) {
        throw new BadRequestError(
            `${params.tool_name}: clear_range mode requires a range {start, end}`,
            {
                hint: "Pass range as clip-relative beats, e.g. range:{start:0, end:4}.",
            },
        )
    }
    if (range.end <= range.start) {
        throw new BadRequestError(
            `range.end (${range.end}) must be greater than range.start (${range.start})`,
            {
                hint: "range is [start, end) in clip-relative beats and must satisfy end > start, e.g. range:{start:0, end:4}.",
            },
        )
    }
    if (range.start >= clip_length) {
        throw new BadRequestError(
            `range [${range.start}, ${range.end}) is entirely outside the clip's relative range [0, ${clip_length})`,
            {
                hint: `range uses CLIP-RELATIVE beats in [0, clipLength=${clip_length}); Clip.startTime/endTime are ARRANGEMENT-ABSOLUTE beats and belong to a different coordinate system. Recompute the range relative to the clip start.`,
            },
        )
    }
    const cleared = clearNotesInRange(clip.notes, range.start, range.end)
    summary.removed = cleared.removed
    summary.range = range
    summary.noteCount = cleared.kept.length
    return {
        summary,
        computeNextNotes: () => clearNotesInRange(clip.notes, range.start, range.end).kept,
    }
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

async function runWriteNotes(deps: ServerDeps, params: WriteNotesParams): Promise<ToolResult> {
    const adapter = new LomGraphAdapter(deps.context)
    const nodes = await selectNodes(parseQuery(params.select), adapter)
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `write_notes requires the selection to match exactly one MidiClip, but matched ${nodes.length}`,
            {
                hint: 'Change select so it returns exactly one MidiClip node, e.g. MATCH (c:MidiClip {name:"Bass"}) RETURN c.',
            },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof MidiClip)) {
        throw new BadRequestError("select must return a MidiClip", {
            hint: "Use a select query that returns a MidiClip node.",
        })
    }
    const clip = node.value
    const plan = planNoteWrite(clip, {
        tool_name: "write_notes",
        notes: params.notes,
        mode: params.mode,
        range: params.range,
        allowOutOfRange: params.allowOutOfRange,
    })

    if (params.preview === true) {
        return textResult({ status: "preview", ...plan.summary })
    }

    const snapshot_id = await captureNotesSnapshot(deps, {
        tool: "write_notes",
        select: params.select,
        oldNotes: clip.notes,
        targetIdentity: objectIdentity(clip),
    })

    deps.context.withinTransaction(() => {
        clip.notes = plan.computeNextNotes()
    })

    return textResult({ status: "ok", ...plan.summary, snapshotId: snapshot_id })
}

/** `write_notes` ツール: select で選んだ単一 MidiClip の notes を replace / merge / clear_range する。 */
export function registerNotesTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "write_notes",
        {
            title: "MIDI ノート書き込み",
            description:
                "select で選んだ 1 つの MidiClip の notes を編集する。mode: replace（全置換）/ merge（既存を保持し追加。同一 pitch+startTime は入力で置換）/ clear_range（range のノートを削除）。replace / merge は notes 必須（全削除は clear_range を使う）。startTime/duration はクリップ相対拍（[0, クリップ長)）。アレンジメント絶対拍とは座標系が異なる。クリップ長を超える startTime は既定で拒否（allowOutOfRange:true で許容）。startTime + duration が末尾を超えるノートは受理し、応答の tailOverflow に件数を返す。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                notes: z
                    .array(noteSchema)
                    .default([])
                    .describe(
                        "replace / merge の対象ノート（1 件以上必須。空だとエラー）。各要素は {pitch, startTime, duration, velocity?}。例: [{pitch:60, startTime:0, duration:1, velocity:100}]。clear_range では無視する",
                    ),
                mode: z.enum(["replace", "merge", "clear_range"]).default("replace"),
                range: z
                    .object({ start: z.number().min(0), end: z.number().positive() })
                    .optional()
                    .describe("clear_range で削除する範囲（クリップ相対拍 [start, end)）"),
                allowOutOfRange: z
                    .boolean()
                    .optional()
                    .describe("クリップ長を超える startTime のノートを許容する（既定 false）"),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, notes, mode, range, allowOutOfRange, preview }) => {
            try {
                return await runWriteNotes(deps, {
                    select,
                    notes,
                    mode,
                    range,
                    allowOutOfRange,
                    preview,
                })
            } catch (error) {
                deps.log.error("write_notes failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
