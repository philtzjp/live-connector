import { MidiClip } from "@ableton-extensions/sdk"
import { parseQuery, type ScalarValue, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"
import { noteSchema, planNoteWrite } from "./notes"
import { captureNotesSnapshot, capturePropertiesSnapshot, objectIdentity } from "./snapshots"
import { SET_TOOL_SET_SCHEMAS } from "./write"

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

/**
 * ステップの入力スキーマ。set の per-property 検証は単体ツールと同じ
 * SET_TOOL_SET_SCHEMAS を、write_notes の各フィールドは noteSchema を共有する。
 * テスト（検証等価性）からも参照する。
 */
export const batchStepSchema = z.discriminatedUnion("tool", [
    z.object({ tool: z.literal("set_song"), set: SET_TOOL_SET_SCHEMAS.set_song }),
    z.object({
        tool: z.literal("set_track"),
        select: z.string().min(1),
        set: SET_TOOL_SET_SCHEMAS.set_track,
    }),
    z.object({
        tool: z.literal("set_clip"),
        select: z.string().min(1),
        set: SET_TOOL_SET_SCHEMAS.set_clip,
    }),
    z.object({
        tool: z.literal("set_scene"),
        select: z.string().min(1),
        set: SET_TOOL_SET_SCHEMAS.set_scene,
    }),
    z.object({
        tool: z.literal("set_cue_point"),
        select: z.string().min(1),
        set: SET_TOOL_SET_SCHEMAS.set_cue_point,
    }),
    z.object({
        tool: z.literal("set_device_parameter"),
        select: z.string().min(1),
        set: SET_TOOL_SET_SCHEMAS.set_device_parameter,
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

type Step = z.infer<typeof batchStepSchema>

type ResolvedStep = {
    index: number
    tool: string
    targets: number
    summary: Record<string, unknown>
    apply: () => Promise<unknown> | void
    /** 適用直前（confirm 通過後）に旧状態をスナップショットし snapshotId を返す。 */
    captureSnapshot: () => Promise<string>
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
        // 検証・計画は単体 write_notes と同じ planNoteWrite を通す。適用時は
        // computeNextNotes がその時点の clip.notes から再計算するため、同一クリップへの
        // 多段ステップでも先行ステップの結果を消さない（summary の件数は解決時点の推定）。
        const plan = planNoteWrite(clip, {
            tool_name: "write_notes step",
            notes: step.notes,
            mode: step.mode,
            range: step.range,
            allowOutOfRange: step.allowOutOfRange,
        })
        return {
            index,
            tool: step.tool,
            targets: 1,
            summary: { tool: step.tool, ...plan.summary },
            apply: () => {
                clip.notes = plan.computeNextNotes()
            },
            captureSnapshot: () =>
                captureNotesSnapshot(deps, {
                    tool: `batch:${step.tool}`,
                    select: step.select,
                    oldNotes: clip.notes,
                    targetIdentity: objectIdentity(clip),
                }),
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
        captureSnapshot: async () => {
            const old_targets = await Promise.all(nodes.map((node) => adapter.serialize(node)))
            return capturePropertiesSnapshot(deps, {
                tool: `batch:${step.tool}`,
                select,
                requiredLabel,
                properties: entries.map(([property]) => property),
                oldTargets: old_targets as Record<string, unknown>[],
                targetIdentities: nodes.map((node) => objectIdentity(node.value)),
            })
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
                // 解決・検証段階の失敗では何も適用しない。
                return textResult({
                    status: "failed",
                    phase: "resolve",
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

        // 適用直前に各ステップの旧状態をスナップショットし、restore_snapshot で巻き戻せるようにする。
        // 取得はすべて適用前なので、同一対象への多段ステップでは先頭ステップの snapshotId が
        // batch 実行前の状態を表す。
        const snapshots: { index: number; tool: string; snapshotId: string }[] = []
        for (const entry of resolved) {
            snapshots.push({
                index: entry.index,
                tool: entry.tool,
                snapshotId: await entry.captureSnapshot(),
            })
        }

        // 全ステップのミューテーションを 1 つの同期トランザクションで初期化し、単一 undo ステップにする。
        // SDK の withinTransaction は undo グルーピングのみでロールバックしないため、適用段階の
        // 失敗ではステップごとの成否を追跡し、部分適用を応答から識別できるようにする。
        type StepOutcome = { index: number; tool: string; reason?: string }
        const applied_steps: StepOutcome[] = []
        const failed_steps: StepOutcome[] = []
        const unapplied_steps: StepOutcome[] = []
        await deps.context.withinTransaction(() => {
            const pending: Promise<void>[] = []
            let sync_failed = false
            for (const entry of resolved) {
                if (sync_failed) {
                    // 同期的に失敗したステップ以降は開始しない（開始済みの非同期 op は止められない）。
                    unapplied_steps.push({ index: entry.index, tool: entry.tool })
                    continue
                }
                let started: Promise<unknown>
                try {
                    started = Promise.resolve(entry.apply())
                } catch (error) {
                    sync_failed = true
                    failed_steps.push({
                        index: entry.index,
                        tool: entry.tool,
                        reason: error instanceof Error ? error.message : String(error),
                    })
                    continue
                }
                pending.push(
                    started.then(
                        () => {
                            applied_steps.push({ index: entry.index, tool: entry.tool })
                        },
                        (error) => {
                            failed_steps.push({
                                index: entry.index,
                                tool: entry.tool,
                                reason: error instanceof Error ? error.message : String(error),
                            })
                        },
                    ),
                )
            }
            return Promise.all(pending)
        })
        applied_steps.sort((left, right) => left.index - right.index)
        failed_steps.sort((left, right) => left.index - right.index)

        if (failed_steps.length > 0) {
            return textResult(
                {
                    status: "failed",
                    phase: "apply",
                    appliedSteps: applied_steps,
                    failedSteps: failed_steps,
                    unappliedSteps: unapplied_steps,
                    totalTargets,
                    snapshots,
                    steps: resolved.map((entry) => entry.summary),
                    hint: "The SDK transaction groups undo but does not roll back: appliedSteps remain applied. Revert applied steps with restore_snapshot using the per-step snapshotId (or Live undo), then fix the failed steps and retry only those.",
                },
                true,
            )
        }

        return textResult({
            status: "ok",
            appliedSteps: resolved.length,
            totalTargets,
            snapshots,
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
                "複数の書き込みステップ（set_song / set_track / set_clip / set_scene / set_cue_point / set_device_parameter / write_notes）を 1 回の呼び出しで実行し、Live の undo 履歴上 1 ステップにまとめる。入力検証は単体ツールと同一の zod スキーマで行い、全ステップを適用前に解決・検証する。解決・検証段階の失敗では何も適用しない。適用段階の失敗では SDK トランザクションがロールバックしないため適用済みステップは残り、応答（appliedSteps / failedSteps / unappliedSteps）で識別できる。同一クリップへの複数 write_notes ステップは適用時に逐次再解決され、先行ステップの結果を保持する。SDK のトランザクションコールバックは同期必須のため、後続ステップは同一 batch 内で先行ステップが作成したオブジェクトを参照できない（構造操作 create/delete は本ツールの対象外）。",
            inputSchema: {
                steps: z.array(batchStepSchema).min(1).describe("順に実行する書き込みステップ列"),
                preview: z.boolean().optional().describe("適用せず解決済みプランを返す"),
                confirm: z.boolean().optional().describe("大量ターゲットの変更を許可する"),
            },
        },
        async ({ steps, preview, confirm }) => runBatch(deps, { steps, preview, confirm }),
    )
}
