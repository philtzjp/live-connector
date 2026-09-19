import type { ExtensionContext } from "@ableton-extensions/sdk"
import type { ScalarValue } from "@live-connector/cypher"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { listRenderJobs } from "../render/jobs"
import { listWriteEventsForQuery } from "../undo/log"
import { LomGraphAdapter } from "./adapter"

export type RenderJobSummary = {
    id: string
    status: string
    source: string
    method: string
    phase: string
    audioStatus: string
    cleanupStatus: string
    startTime: number
    endTime: number
    duration: number
    durationSeconds?: number
    filePath?: string
    error?: string
    progressCurrentBeat?: number
    progressEndBeat?: number
    progressFraction?: number
    captureTrackRetained?: boolean
}

export type TransportSummary = Record<string, ScalarValue>

export type VirtualLabelSources = {
    listWriteEvents: () => Promise<
        {
            id: string
            time: string
            kind: string
            statement: string
            undoable: string
            status: string
        }[]
    >
    listRenderJobs: () => Promise<RenderJobSummary[]>
    /** OSC 未接続・状態取得失敗時は null（古い値を現在値として返さない）。 */
    readTransport: () => Promise<TransportSummary | null>
}

export function defaultVirtualLabelSources(deps: ServerDeps): VirtualLabelSources {
    return {
        async listWriteEvents() {
            const entries = await listWriteEventsForQuery(deps)
            return entries.map((entry) => ({
                id: entry.writeId,
                time: entry.time,
                kind: entry.kind,
                statement: entry.statement,
                undoable: entry.undoable,
                status: entry.status,
            }))
        },
        listRenderJobs() {
            return Promise.resolve(
                listRenderJobs().map((job) => ({
                    id: job.id,
                    status: job.status,
                    source: job.source,
                    method: job.method,
                    phase: job.phase,
                    audioStatus: job.audioStatus,
                    cleanupStatus: job.cleanupStatus,
                    startTime: job.startTime,
                    endTime: job.endTime,
                    duration: job.duration,
                    ...(job.durationSeconds !== undefined
                        ? { durationSeconds: job.durationSeconds }
                        : {}),
                    ...(job.filePath !== undefined ? { filePath: job.filePath } : {}),
                    ...(job.error !== undefined ? { error: job.error } : {}),
                    ...(job.progress !== undefined
                        ? {
                              progressCurrentBeat: job.progress.currentBeat,
                              progressEndBeat: job.progress.endBeat,
                              progressFraction: job.progress.fraction,
                          }
                        : {}),
                    ...(job.captureTrackRetained !== undefined
                        ? { captureTrackRetained: job.captureTrackRetained }
                        : {}),
                })),
            )
        },
        async readTransport() {
            if (!deps.runtime.oscConnected()) {
                return null
            }
            try {
                const state = await deps.runtime.requireTransport().readState()
                return {
                    isPlaying: state.isPlaying,
                    currentSongTime: state.currentSongTime,
                    tempo: state.tempo,
                    recordMode: state.recordMode,
                    loop: state.loop,
                    loopStart: state.loopStart,
                    loopLength: state.loopLength,
                    punchIn: state.punchIn,
                    punchOut: state.punchOut,
                    backToArranger: state.backToArranger,
                    observedAt: state.observedAt,
                }
            } catch (error) {
                deps.log.warn("Transport read failed", { error: String(error) })
                return null
            }
        },
    }
}

export function createLomGraphAdapter(
    context: ExtensionContext<TargetApiVersion>,
    sources: VirtualLabelSources = {
        listWriteEvents: async () => [],
        listRenderJobs: async () => [],
        readTransport: async () => null,
    },
): LomGraphAdapter {
    return new LomGraphAdapter(context, sources)
}

export function createAdapterFromDeps(deps: ServerDeps): LomGraphAdapter {
    return createLomGraphAdapter(deps.context, defaultVirtualLabelSources(deps))
}

export type VirtualNode = {
    type: "virtual"
    label: "WriteEvent" | "RenderJob" | "Transport"
    id: string
    properties: Record<string, ScalarValue>
}

export function isVirtualLabel(label: string): boolean {
    return label === "WriteEvent" || label === "RenderJob" || label === "Transport"
}
