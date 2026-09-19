import { AudioTrack, type Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, HybridError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import type { LomNode } from "../lom/adapter"
import { createAdapterFromDeps } from "../lom/create-adapter"
import { serializeSongHandle } from "../lom/fingerprint"
import {
    countRunningRenderJobs,
    findRenderJobByRequest,
    nextRenderJobId,
    RENDER_JOB_STORE_MAX,
    type RenderJobRecord,
    setRenderJob,
    updateRenderJob,
} from "../render/jobs"
import { consumeRenderPlan, createRenderPlan, verifyRenderPlan } from "../render/plan"
import { preflightMainCapture, startMainCapture } from "../render/resampling"
import type { MainRenderArgs } from "../types/hybrid"
import { textResult } from "./common"

type RenderAudioParams = {
    select: string | undefined
    source: "main" | "master" | undefined
    startTime: number
    endTime: number
    background: boolean | undefined
    preview: boolean | undefined
    confirm: boolean | undefined
    planId: string | undefined
    requestId: string | undefined
    keepCaptureTrack: boolean | undefined
    preRollBeats: number | undefined
}

function validateBeatRange(start_time: number, end_time: number): void {
    if (!Number.isFinite(start_time) || !Number.isFinite(end_time)) {
        throw new BadRequestError("startTime and endTime must be finite numbers")
    }
    if (start_time < 0) {
        throw new BadRequestError("startTime must be greater than or equal to 0")
    }
    if (end_time <= start_time) {
        throw new BadRequestError("endTime must be greater than startTime", {
            hint: "Pass a positive beat range, e.g. startTime:0 and endTime:16.",
        })
    }
}

function resolveSingleAudioTrack(nodes: LomNode[]): LomNode {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `render requires exactly one AudioTrack, but matched ${nodes.length}`,
            { hint: 'MATCH (t:AudioTrack {name:"Print"}) RETURN t' },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof AudioTrack)) {
        throw new BadRequestError("select must return an AudioTrack")
    }
    return node
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

function currentSetId(deps: ServerDeps): string {
    return serializeSongHandle(deps.context.application.song.handle)
}

function mainRenderArgs(params: RenderAudioParams): MainRenderArgs {
    return {
        startTime: params.startTime,
        endTime: params.endTime,
        preRollBeats: params.preRollBeats ?? 0,
        keepCaptureTrack: params.keepCaptureTrack ?? false,
    }
}

export async function runRender(
    deps: ServerDeps,
    params: RenderAudioParams,
): Promise<Record<string, unknown>> {
    validateBeatRange(params.startTime, params.endTime)
    if (params.select !== undefined && params.source !== undefined) {
        throw new BadRequestError("select and source are mutually exclusive", {
            hint: 'Use either select:"MATCH (t:AudioTrack ...) RETURN t" or source:"main".',
        })
    }
    if (params.source !== undefined) {
        return runMainRender(deps, params)
    }
    if (params.select === undefined) {
        throw new BadRequestError("render requires select or source", {
            hint: 'Pass select:"MATCH (t:AudioTrack {name:\\"Print\\"}) RETURN t" or source:"main".',
        })
    }
    return runPreFxRender(deps, params, params.select)
}

async function runPreFxRender(
    deps: ServerDeps,
    params: RenderAudioParams,
    select: string,
): Promise<Record<string, unknown>> {
    const adapter = createAdapterFromDeps(deps)
    const node = resolveSingleAudioTrack(await selectNodes(parseQuery(select), adapter))
    if (node.type !== "object") {
        throw new BadRequestError("select must return an AudioTrack object node")
    }
    const track = node.value as AudioTrack<TargetApiVersion>
    const track_index = trackIndex(deps.context.application.song.tracks, track)
    const track_info = { index: track_index, name: track.name, kind: "audio" as const }
    const duration = params.endTime - params.startTime
    const job_query_hint = 'Poll status with do: MATCH (j:RenderJob {id:"<jobId>"}) RETURN j'

    if (params.background === true) {
        const running_count = countRunningRenderJobs()
        if (running_count >= RENDER_JOB_STORE_MAX) {
            throw new BadRequestError(
                `${running_count} render job(s) are already running (max ${RENDER_JOB_STORE_MAX})`,
                {
                    hint: "Wait for jobs to finish or render synchronously without background:true.",
                },
            )
        }
        const job_id = nextRenderJobId()
        const job: RenderJobRecord = {
            id: job_id,
            status: "running",
            at: new Date().toISOString(),
            source: "audio-track-pre-fx",
            method: "sdk-pre-fx",
            phase: "exporting",
            track: track_info,
            startTime: params.startTime,
            endTime: params.endTime,
            duration,
            audioStatus: "pending",
            cleanupStatus: "complete",
        }
        setRenderJob(job)
        deps.context.resources
            .renderPreFxAudio(track, params.startTime, params.endTime)
            .then((file_path) => {
                updateRenderJob(job_id, {
                    status: "done",
                    phase: "completed",
                    filePath: file_path,
                    audioStatus: "ready",
                })
            })
            .catch((error: unknown) => {
                updateRenderJob(job_id, {
                    status: "error",
                    phase: "failed",
                    error: String(error),
                    audioStatus: "failed",
                })
                deps.log.error("render job failed", { jobId: job_id, error: String(error) })
            })
        return {
            status: "started",
            jobId: job_id,
            source: "audio-track-pre-fx",
            method: "sdk-pre-fx",
            track: track_info,
            startTime: params.startTime,
            endTime: params.endTime,
            duration,
            hint: job_query_hint,
        }
    }

    const file_path = await deps.context.resources.renderPreFxAudio(
        track,
        params.startTime,
        params.endTime,
    )
    return {
        status: "ok",
        filePath: file_path,
        source: "audio-track-pre-fx",
        method: "sdk-pre-fx",
        startTime: params.startTime,
        endTime: params.endTime,
        duration,
        track: track_info,
        hint: job_query_hint,
    }
}

async function runMainRender(
    deps: ServerDeps,
    params: RenderAudioParams,
): Promise<Record<string, unknown>> {
    const args = mainRenderArgs(params)
    const set_id = currentSetId(deps)

    if (params.preview === true) {
        const preflight = await preflightMainCapture(deps, args, set_id)
        const plan = createRenderPlan({ setId: set_id, args, ttlMs: deps.runtime.planTtlMs() })
        return {
            status: "preview",
            planId: plan.planId,
            source: "main",
            method: "realtime-resampling",
            timeUnit: "quarter-note-beats",
            range: { startTime: args.startTime, endTime: args.endTime },
            preRollBeats: args.preRollBeats,
            keepCaptureTrack: args.keepCaptureTrack,
            effects: plan.effects,
            requiresConfirmation: true,
            limits: {
                maxCaptureBeats: deps.runtime.maxCaptureBeats(),
                maxArtifactBytes: deps.runtime.maxArtifactBytes(),
            },
            warnings: preflight.warnings,
        }
    }

    if (params.background === false) {
        throw new HybridError(
            "REALTIME_REQUIRES_BACKGROUND",
            "Main capture is real-time and always runs as a background job",
        )
    }
    if (params.planId === undefined) {
        throw new BadRequestError("Main capture requires planId from a preview call")
    }
    if (params.requestId === undefined) {
        throw new BadRequestError("Main capture requires requestId for idempotency")
    }
    if (params.confirm !== true) {
        return {
            status: "confirm_required",
            source: "main",
            method: "realtime-resampling",
            planId: params.planId,
            requestId: params.requestId,
            requiresConfirmation: true,
            hint: "Re-run with confirm:true to start the real-time capture.",
        }
    }

    // 冪等性を計画検証より先に判定する。同じ requestId の再送は同じ job を返す。
    const existing = findRenderJobByRequest(params.requestId, set_id)
    if (existing !== undefined) {
        if (existing.startTime !== args.startTime || existing.endTime !== args.endTime) {
            throw new HybridError(
                "REQUEST_ID_CONFLICT",
                `requestId "${params.requestId}" was already used with different arguments`,
            )
        }
        return startedMainResponse(existing)
    }

    verifyRenderPlan({ planId: params.planId, setId: set_id, args })
    consumeRenderPlan(params.planId)
    const { job } = startMainCapture(
        deps,
        { ...args, planId: params.planId, requestId: params.requestId },
        set_id,
    )
    return startedMainResponse(job)
}

function startedMainResponse(job: RenderJobRecord): Record<string, unknown> {
    return {
        status: "started",
        jobId: job.id,
        source: "main",
        method: "realtime-resampling",
        startTime: job.startTime,
        endTime: job.endTime,
        duration: job.duration,
        hint: 'Poll status with do: MATCH (j:RenderJob {id:"<jobId>"}) RETURN j',
    }
}

export function registerRenderTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "render",
        {
            title: "オーディオレンダリング",
            description:
                'AudioTrack の指定範囲を Pre-FX レンダリングする（select、既定同期・background:true で非同期）。source:"main" では Main 出力を Resampling で実時間録音する（preview で実行計画を取得し、planId・requestId・confirm:true で開始。常に background ジョブ）。RenderJob 仮想ラベルで照会。',
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        'AudioTrack を RETURN する MATCH。例: MATCH (t:AudioTrack {name:"Print"}) RETURN t',
                    ),
                source: z
                    .enum(["main", "master"])
                    .optional()
                    .describe('Main 出力を実時間録音する。"master" は "main" の別名'),
                startTime: z.number().min(0).describe("0 始まりの四分音符拍"),
                endTime: z.number().min(0).describe("0 始まりの四分音符拍。endTime > startTime"),
                background: z.boolean().optional().describe("非同期ジョブとして開始"),
                preview: z
                    .boolean()
                    .optional()
                    .describe("Main 解析: 実行計画と事前検査のみで副作用なし"),
                confirm: z.boolean().optional().describe("Main 実行の確定"),
                planId: z.string().min(1).optional().describe("preview が返した planId"),
                requestId: z.string().min(1).optional().describe("冪等性のための呼び出し識別子"),
                keepCaptureTrack: z
                    .boolean()
                    .optional()
                    .describe("true なら録音トラックを消音・Disarm して保持する"),
                preRollBeats: z.number().min(0).optional().describe("開始前に再生する拍数。既定 0"),
            },
        },
        async (params) => {
            try {
                return textResult(await runRender(deps, normalizeParams(params)))
            } catch (error) {
                deps.log.error("render failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}

function normalizeParams(params: Record<string, unknown>): RenderAudioParams {
    return {
        select: typeof params.select === "string" ? params.select : undefined,
        source: params.source === "main" || params.source === "master" ? params.source : undefined,
        startTime: Number(params.startTime),
        endTime: Number(params.endTime),
        background: typeof params.background === "boolean" ? params.background : undefined,
        preview: typeof params.preview === "boolean" ? params.preview : undefined,
        confirm: typeof params.confirm === "boolean" ? params.confirm : undefined,
        planId: typeof params.planId === "string" ? params.planId : undefined,
        requestId: typeof params.requestId === "string" ? params.requestId : undefined,
        keepCaptureTrack:
            typeof params.keepCaptureTrack === "boolean" ? params.keepCaptureTrack : undefined,
        preRollBeats: typeof params.preRollBeats === "number" ? params.preRollBeats : undefined,
    }
}

export { clearRenderJobsForTest } from "../render/jobs"
