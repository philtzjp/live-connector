import { AudioTrack, type Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type RenderAudioParams = {
    select: string
    startTime: number
    endTime: number
    background: boolean | undefined
}

type RenderJob = {
    jobId: string
    status: "running" | "done" | "error"
    at: string
    track: { index: number; name: string; kind: "audio" }
    startTime: number
    endTime: number
    duration: number
    filePath?: string
    error?: string
}

const MAX_RENDER_JOBS = 50

/** レンダリングジョブの状態を跨リクエストで保持する（module singleton）。 */
const renderJobs = new Map<string, RenderJob>()
let renderJobCounter = 0

function nextRenderJobId(): string {
    renderJobCounter = (renderJobCounter + 1) % 1_000_000
    return `render-${Date.now().toString(36)}-${renderJobCounter.toString(36)}`
}

function pruneRenderJobs(): void {
    while (renderJobs.size > MAX_RENDER_JOBS) {
        const oldest = renderJobs.keys().next().value
        if (oldest === undefined) {
            break
        }
        renderJobs.delete(oldest)
    }
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
        const track_info = { index: track_index, name: track.name, kind: "audio" as const }
        const duration = params.endTime - params.startTime

        if (params.background === true) {
            const jobId = nextRenderJobId()
            const job: RenderJob = {
                jobId,
                status: "running",
                at: new Date().toISOString(),
                track: track_info,
                startTime: params.startTime,
                endTime: params.endTime,
                duration,
            }
            renderJobs.set(jobId, job)
            pruneRenderJobs()
            // レンダリングは待たずに開始し、完了時にジョブへ反映する（クライアントのタイムアウトを避ける）。
            deps.context.resources
                .renderPreFxAudio(track, params.startTime, params.endTime)
                .then((file_path) => {
                    job.status = "done"
                    job.filePath = file_path
                })
                .catch((error: unknown) => {
                    job.status = "error"
                    job.error = String(error)
                    deps.log.error("render job failed", { jobId, error: String(error) })
                })
            return textResult({
                status: "started",
                jobId,
                track: track_info,
                startTime: params.startTime,
                endTime: params.endTime,
                duration,
                hint: "Poll get_render_job with this jobId until status is done or error.",
            })
        }

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
            duration,
            track: track_info,
        })
    } catch (error) {
        deps.log.error("render_audio failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** render_audio（同期／ジョブ）と get_render_job を登録する。 */
export function registerAudioTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "render_audio",
        {
            title: "AudioTrack 音声レンダリング",
            description:
                "select で選んだ 1 つの AudioTrack のアレンジメント上の pre-FX 音声を、startTime/endTime（beats）範囲で WAV にレンダリングする。既定は同期で filePath を返す。長尺で MCP クライアントのタイムアウトが懸念される場合は background:true で jobId を即時返し、get_render_job で状態照会する（完了・明示エラー・照会可能ジョブのいずれかに確定する）。MidiTrack、send、return、post-FX 音声は対象外。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                startTime: z.number().min(0).describe("レンダリング開始位置（beats）"),
                endTime: z.number().positive().describe("レンダリング終了位置（beats）"),
                background: z
                    .boolean()
                    .optional()
                    .describe("true で jobId を即時返し、get_render_job で照会する"),
            },
        },
        async ({ select, startTime, endTime, background }) =>
            runRenderAudioTool(deps, { select, startTime, endTime, background }),
    )

    server.registerTool(
        "get_render_job",
        {
            title: "レンダリングジョブ照会",
            description:
                "background:true で開始した render_audio ジョブの状態（running / done / error）を jobId で照会する。done で filePath、error で error を含む。",
            inputSchema: {
                jobId: z.string().min(1).describe("render_audio が返した jobId"),
            },
        },
        async ({ jobId }) => {
            const job = renderJobs.get(jobId)
            if (job === undefined) {
                return textResult(
                    toMcpError(
                        new NotFoundError(`render job "${jobId}" was not found`, {
                            hint: "Job ids expire after the most recent 50 renders, or the host may have restarted.",
                        }),
                    ),
                    true,
                )
            }
            return textResult(job)
        },
    )
}
