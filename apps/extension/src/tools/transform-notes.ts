import { MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"
import { clipNoteLength } from "./notes"
import { captureNotesSnapshot, objectIdentity } from "./snapshots"

export type TransformSpec =
    | { type: "transpose"; semitones: number }
    | { type: "time_shift"; delta: number }
    | { type: "velocity"; scale?: number | undefined; offset?: number | undefined }
    | { type: "quantize"; grid: number; strength?: number | undefined }
    | { type: "duplicate"; offset: number; count?: number | undefined }

export type NoteFilter = {
    timeStart?: number | undefined
    timeEnd?: number | undefined
    pitchMin?: number | undefined
    pitchMax?: number | undefined
}

export type TransformResult = {
    notes: NoteDescription[]
    affected: number
    droppedPitch: number
    droppedTime: number
    before: number
    after: number
}

const DEFAULT_VELOCITY = 100

function noteInFilter(note: NoteDescription, filter: NoteFilter): boolean {
    if (filter.timeStart !== undefined && note.startTime < filter.timeStart) {
        return false
    }
    if (filter.timeEnd !== undefined && note.startTime >= filter.timeEnd) {
        return false
    }
    if (filter.pitchMin !== undefined && note.pitch < filter.pitchMin) {
        return false
    }
    if (filter.pitchMax !== undefined && note.pitch > filter.pitchMax) {
        return false
    }
    return true
}

function clampVelocity(value: number): number {
    return Math.max(0, Math.min(127, Math.round(value)))
}

/**
 * 最近接グリッドへ丸める。丸め先がクリップ末尾以降になる場合は範囲内の直前グリッドへ丸め、
 * quantize がノートを削除しないことを保証する（Live 本体の quantize もノートを削除しない）。
 */
function quantizeStart(
    startTime: number,
    grid: number,
    strength: number,
    clipLength: number,
): number {
    let nearest = Math.round(startTime / grid) * grid
    if (nearest >= clipLength) {
        nearest = Math.max(0, nearest - grid)
    }
    return startTime + (nearest - startTime) * strength
}

/** フィルタに合致した 1 ノートから変換後ノート列を生成する（duplicate は原本＋複製）。 */
function expandNote(
    note: NoteDescription,
    spec: TransformSpec,
    clipLength: number,
): NoteDescription[] {
    switch (spec.type) {
        case "transpose":
            return [{ ...note, pitch: note.pitch + spec.semitones }]
        case "time_shift":
            return [{ ...note, startTime: note.startTime + spec.delta }]
        case "velocity":
            return [
                {
                    ...note,
                    velocity: clampVelocity(
                        (note.velocity ?? DEFAULT_VELOCITY) * (spec.scale ?? 1) +
                            (spec.offset ?? 0),
                    ),
                },
            ]
        case "quantize":
            return [
                {
                    ...note,
                    startTime: quantizeStart(
                        note.startTime,
                        spec.grid,
                        spec.strength ?? 1,
                        clipLength,
                    ),
                },
            ]
        case "duplicate": {
            const out: NoteDescription[] = [note]
            const count = spec.count ?? 1
            for (let index = 1; index <= count; index++) {
                out.push({ ...note, startTime: note.startTime + spec.offset * index })
            }
            return out
        }
    }
}

/** duplicate の原本ノート（フィルタ合致でも変換されず必ず残る）か。 */
function isUntouchedOriginal(
    spec: TransformSpec,
    produced: NoteDescription,
    source: NoteDescription,
): boolean {
    return spec.type === "duplicate" && produced === source
}

/**
 * クリップ相対座標でノートに決定的変換を適用する。フィルタ外のノートは素通し。
 * startTime が [0, clipLength) または pitch が [0, 127] を外れたノートは、
 * onOutOfRange="error"（既定）で変換全体を例外にし、"drop" で削除する。
 * quantize は末尾を超えないよう範囲内の直前グリッドへ丸めるため、ノートを削除しない。
 */
export function transformNotes(
    notes: readonly NoteDescription[],
    spec: TransformSpec,
    filter: NoteFilter,
    clipLength: number,
    onOutOfRange: "drop" | "error",
): TransformResult {
    const result: NoteDescription[] = []
    let affected = 0
    let dropped_pitch = 0
    let dropped_time = 0
    const out_of_range_times: number[] = []
    const out_of_range_pitches: number[] = []

    for (const note of notes) {
        if (!noteInFilter(note, filter)) {
            result.push(note)
            continue
        }
        affected++
        for (const produced of expandNote(note, spec, clipLength)) {
            if (isUntouchedOriginal(spec, produced, note)) {
                result.push(produced)
                continue
            }
            if (produced.pitch < 0 || produced.pitch > 127) {
                if (onOutOfRange === "error") {
                    out_of_range_pitches.push(produced.pitch)
                    continue
                }
                dropped_pitch++
                continue
            }
            if (produced.startTime < 0 || produced.startTime >= clipLength) {
                if (onOutOfRange === "error") {
                    out_of_range_times.push(produced.startTime)
                    continue
                }
                dropped_time++
                continue
            }
            result.push(produced)
        }
    }

    if (
        onOutOfRange === "error" &&
        (out_of_range_times.length > 0 || out_of_range_pitches.length > 0)
    ) {
        const parts: string[] = []
        if (out_of_range_times.length > 0) {
            parts.push(`startTimes outside [0, ${clipLength}): ${out_of_range_times.join(", ")}`)
        }
        if (out_of_range_pitches.length > 0) {
            parts.push(`pitches outside [0, 127]: ${out_of_range_pitches.join(", ")}`)
        }
        throw new BadRequestError(
            `${out_of_range_times.length + out_of_range_pitches.length} transformed note(s) fall outside the clip time range or MIDI pitch range.`,
            {
                hint: `Adjust the transform or filter so results stay in range, or pass onOutOfRange:"drop" to delete the offending notes. ${parts.join("; ")}.`,
            },
        )
    }

    return {
        notes: result,
        affected,
        droppedPitch: dropped_pitch,
        droppedTime: dropped_time,
        before: notes.length,
        after: result.length,
    }
}

function pitchTimeSummary(notes: readonly NoteDescription[]): {
    noteCount: number
    pitchRange: [number, number] | null
    timeRange: [number, number] | null
} {
    if (notes.length === 0) {
        return { noteCount: 0, pitchRange: null, timeRange: null }
    }
    let minPitch = Number.POSITIVE_INFINITY
    let maxPitch = Number.NEGATIVE_INFINITY
    let minTime = Number.POSITIVE_INFINITY
    let maxTime = Number.NEGATIVE_INFINITY
    for (const note of notes) {
        minPitch = Math.min(minPitch, note.pitch)
        maxPitch = Math.max(maxPitch, note.pitch)
        minTime = Math.min(minTime, note.startTime)
        maxTime = Math.max(maxTime, note.startTime)
    }
    return {
        noteCount: notes.length,
        pitchRange: [minPitch, maxPitch],
        timeRange: [minTime, maxTime],
    }
}

const transformSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("transpose"), semitones: z.number().int() }),
    z.object({ type: z.literal("time_shift"), delta: z.number() }),
    z.object({
        type: z.literal("velocity"),
        scale: z.number().positive().optional(),
        offset: z.number().optional(),
    }),
    z.object({
        type: z.literal("quantize"),
        grid: z.number().positive(),
        strength: z.number().min(0).max(1).optional(),
    }),
    z.object({
        type: z.literal("duplicate"),
        offset: z.number(),
        count: z.number().int().positive().optional(),
    }),
])

const filterSchema = z
    .object({
        timeStart: z.number().min(0).optional(),
        timeEnd: z.number().positive().optional(),
        pitchMin: z.number().int().min(0).max(127).optional(),
        pitchMax: z.number().int().min(0).max(127).optional(),
    })
    .optional()

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

/** `transform_notes` ツール: select で選んだ MidiClip のノートをサーバー側で決定的変換する。 */
export function registerTransformNotesTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "transform_notes",
        {
            title: "MIDI ノート変換",
            description:
                "select で選んだ 1 つの MidiClip のノートを決定的に変換する。transform: transpose（半音）/ time_shift（拍）/ velocity（scale/offset）/ quantize（grid 拍・strength）/ duplicate（offset 拍・count）。filter（時間範囲 timeStart/timeEnd・pitch 範囲 pitchMin/pitchMax）で対象を絞れる。座標はクリップ相対拍。結果が [0, クリップ長) を外れる startTime、または 0..127 を外れる pitch は onOutOfRange で error（既定。write_notes の境界検証と同じく拒否）/ drop（削除を明示的に許可）。quantize は末尾を超えないよう範囲内の直前グリッドへ丸め、ノートを削除しない。全ノートを往復させずに変換する。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'MidiClip を単一ノード変数で RETURN する Cypher。例: MATCH (c:MidiClip {name:"Bass"}) RETURN c',
                    ),
                transform: transformSchema,
                filter: filterSchema,
                onOutOfRange: z
                    .enum(["drop", "error"])
                    .default("error")
                    .describe(
                        "変換結果が範囲外になるノートの扱い。error=変換全体を拒否（既定）/ drop=範囲外ノートを削除",
                    ),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, transform, filter, onOutOfRange, preview }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const nodes = await selectNodes(parseQuery(select), adapter)
                if (nodes.length !== 1) {
                    throw new BadRequestError(
                        `transform_notes requires the selection to match exactly one MidiClip, but matched ${nodes.length}`,
                        {
                            hint: 'Change select so it returns exactly one MidiClip node, e.g. MATCH (c:MidiClip {name:"Bass"}) RETURN c.',
                        },
                    )
                }
                const node = nodes[0]
                if (
                    node === undefined ||
                    node.type !== "object" ||
                    !(node.value instanceof MidiClip)
                ) {
                    throw new BadRequestError("select must return a MidiClip", {
                        hint: "Use a select query that returns a MidiClip node.",
                    })
                }
                const clip = node.value
                const clip_length = clipNoteLength(clip)
                const existing = clip.notes
                const outcome = transformNotes(
                    existing,
                    transform,
                    filter ?? {},
                    clip_length,
                    onOutOfRange,
                )
                const summary = {
                    transform: transform.type,
                    clipLength: clip_length,
                    affected: outcome.affected,
                    droppedPitch: outcome.droppedPitch,
                    droppedTime: outcome.droppedTime,
                    before: pitchTimeSummary(existing),
                    after: pitchTimeSummary(outcome.notes),
                }

                if (preview === true) {
                    return textResult({ status: "preview", ...summary })
                }

                // notes の全置換は restore_snapshot で巻き戻せるよう、適用直前に旧 notes を保存する。
                const snapshotId = await captureNotesSnapshot(deps, {
                    tool: "transform_notes",
                    select,
                    oldNotes: existing,
                    targetIdentity: objectIdentity(clip),
                })

                deps.context.withinTransaction(() => {
                    clip.notes = outcome.notes
                })

                return textResult({ status: "ok", ...summary, snapshotId })
            } catch (error) {
                deps.log.error("transform_notes failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
