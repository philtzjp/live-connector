import { MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, type ScalarValue, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"
import {
    clearNotesInRange,
    clipNoteLength,
    findOutOfRangeNotes,
    mergeNotes,
    noteSchema,
    toNoteDescription,
} from "./notes"

const CONFIRM_THRESHOLD = 20
const SONG_SELECT = "MATCH (s:Song) RETURN s"

const SET_LABEL: Record<string, string> = {
    set_song: "Song",
    set_track: "Track",
    set_clip: "Clip",
    set_scene: "Scene",
    set_cue_point: "CuePoint",
    set_device_parameter: "Parameter",
}

const setValueSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

const stepSchema = z.discriminatedUnion("tool", [
    z.object({ tool: z.literal("set_song"), set: setValueSchema }),
    z.object({ tool: z.literal("set_track"), select: z.string().min(1), set: setValueSchema }),
    z.object({ tool: z.literal("set_clip"), select: z.string().min(1), set: setValueSchema }),
    z.object({ tool: z.literal("set_scene"), select: z.string().min(1), set: setValueSchema }),
    z.object({ tool: z.literal("set_cue_point"), select: z.string().min(1), set: setValueSchema }),
    z.object({
        tool: z.literal("set_device_parameter"),
        select: z.string().min(1),
        set: setValueSchema,
    }),
    z.object({
        tool: z.literal("write_notes"),
        select: z.string().min(1),
        notes: z.array(noteSchema).default([]),
        mode: z.enum(["replace", "merge", "clear_range"]).default("replace"),
        range: z.object({ start: z.number().min(0), end: z.number().positive() }).optional(),
        allowOutOfRange: z.boolean().optional(),
    }),
])

type Step = z.infer<typeof stepSchema>

type ResolvedStep = {
    index: number
    tool: string
    targets: number
    summary: Record<string, unknown>
    apply: () => Promise<unknown> | void
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function resolveMidiClip(nodes: LomNode[]): MidiClip<TargetApiVersion> {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `write_notes step requires the selection to match exactly one MidiClip, but matched ${nodes.length}`,
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof MidiClip)) {
        throw new BadRequestError("write_notes step select must return a MidiClip")
    }
    return node.value
}

async function resolveStep(
    deps: ServerDeps,
    adapter: LomGraphAdapter,
    step: Step,
    index: number,
): Promise<ResolvedStep> {
    if (step.tool === "write_notes") {
        const clip = resolveMidiClip(await selectNodes(parseQuery(step.select), adapter))
        const clip_length = clipNoteLength(clip)
        const incoming = step.notes.map(toNoteDescription)
        if (step.mode !== "clear_range") {
            const out_of_range = findOutOfRangeNotes(step.notes, clip_length)
            if (out_of_range.length > 0 && step.allowOutOfRange !== true) {
                throw new BadRequestError(
                    `write_notes step has ${out_of_range.length} note(s) outside clip range [0, ${clip_length}); pass allowOutOfRange or fix coordinates`,
                )
            }
        }
        let next_notes: NoteDescription[]
        if (step.mode === "replace") {
            next_notes = incoming
        } else if (step.mode === "merge") {
            next_notes = mergeNotes(clip.notes, incoming)
        } else {
            if (step.range === undefined) {
                throw new BadRequestError(
                    "write_notes step clear_range requires a range {start,end}",
                )
            }
            next_notes = clearNotesInRange(clip.notes, step.range.start, step.range.end).kept
        }
        return {
            index,
            tool: step.tool,
            targets: 1,
            summary: { tool: step.tool, mode: step.mode, noteCount: next_notes.length },
            apply: () => {
                clip.notes = next_notes
            },
        }
    }

    const requiredLabel = SET_LABEL[step.tool] ?? "Node"
    const select = step.tool === "set_song" ? SONG_SELECT : step.select
    const nodes = await selectNodes(parseQuery(select), adapter)
    for (const node of nodes) {
        if (!adapter.matchesLabel(node, requiredLabel)) {
            throw new BadRequestError(
                `${step.tool} step must select ${requiredLabel} nodes, but matched ${adapter.labelOf(node)}`,
            )
        }
    }
    if (nodes.length === 0) {
        throw new BadRequestError(`${step.tool} step matched 0 nodes`)
    }
    const entries = Object.entries(step.set) as [string, ScalarValue][]
    if (entries.length === 0) {
        throw new BadRequestError(`${step.tool} step set must contain at least one property`)
    }
    return {
        index,
        tool: step.tool,
        targets: nodes.length,
        summary: { tool: step.tool, matched: nodes.length, set: step.set },
        apply: () => {
            const ops: Promise<void>[] = []
            for (const node of nodes) {
                for (const [property, value] of entries) {
                    ops.push(adapter.setProperty(node, property, value))
                }
            }
            return Promise.all(ops)
        },
    }
}

async function runBatch(
    deps: ServerDeps,
    params: { steps: Step[]; preview: boolean | undefined; confirm: boolean | undefined },
): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const resolved: ResolvedStep[] = []
        for (let index = 0; index < params.steps.length; index++) {
            const step = params.steps[index]
            if (step === undefined) {
                continue
            }
            try {
                resolved.push(await resolveStep(deps, adapter, step, index))
            } catch (error) {
                // 検証はすべて適用前に行うため、失敗時は何も適用しない（all-or-nothing）。
                return textResult({
                    status: "failed",
                    failedStep: index,
                    tool: step.tool,
                    reason: error instanceof Error ? error.message : String(error),
                    resolvedSteps: resolved.map((entry) => entry.index),
                    appliedSteps: [],
                    hint: "No step was applied. Fix the failing step and retry. Batch resolves all steps before applying, so later steps cannot reference objects created by earlier steps in the same batch.",
                })
            }
        }

        const totalTargets = resolved.reduce((sum, entry) => sum + entry.targets, 0)
        const plan = {
            stepCount: resolved.length,
            totalTargets,
            steps: resolved.map((e) => e.summary),
        }

        if (params.preview === true) {
            return textResult({ status: "preview", ...plan })
        }
        if (totalTargets > CONFIRM_THRESHOLD && params.confirm !== true) {
            return textResult({
                status: "confirm_required",
                ...plan,
                hint: `This batch modifies ${totalTargets} targets. Pass confirm:true to proceed.`,
            })
        }

        // 全ステップのミューテーションを 1 つの同期トランザクションで初期化し、単一 undo ステップにする。
        await deps.context.withinTransaction(() =>
            Promise.all(resolved.map((entry) => entry.apply())),
        )

        return textResult({
            status: "ok",
            appliedSteps: resolved.length,
            totalTargets,
            steps: resolved.map((entry) => entry.summary),
        })
    } catch (error) {
        deps.log.error("batch failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** `batch` ツール: 複数の書き込みを 1 つの undo ステップで実行する。 */
export function registerBatchTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "batch",
        {
            title: "一括書き込み",
            description:
                "複数の書き込みステップ（set_song / set_track / set_clip / set_scene / set_cue_point / set_device_parameter / write_notes）を 1 回の呼び出しで実行し、Live の undo 履歴上 1 ステップにまとめる。全ステップを適用前に解決・検証し（all-or-nothing）、いずれか失敗時は何も適用せず失敗ステップを返す。SDK のトランザクションコールバックは同期必須のため、後続ステップは同一 batch 内で先行ステップが作成したオブジェクトを参照できない（構造操作 create/delete は本ツールの対象外）。",
            inputSchema: {
                steps: z.array(stepSchema).min(1).describe("順に実行する書き込みステップ列"),
                preview: z.boolean().optional().describe("適用せず解決済みプランを返す"),
                confirm: z.boolean().optional().describe("大量ターゲットの変更を許可する"),
            },
        },
        async ({ steps, preview, confirm }) => runBatch(deps, { steps, preview, confirm }),
    )
}
