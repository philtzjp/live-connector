/** render ツールのジョブ状態（module singleton）。RenderJob 仮想ラベルの供給源。 */

import type { RenderJobRecord } from "../types/hybrid"

const MAX_RENDER_JOBS = 50

const render_jobs = new Map<string, RenderJobRecord>()
let render_job_counter = 0

export function nextRenderJobId(): string {
    render_job_counter = (render_job_counter + 1) % 1_000_000
    return `render-${Date.now().toString(36)}-${render_job_counter.toString(36)}`
}

export function getRenderJob(job_id: string): RenderJobRecord | undefined {
    return render_jobs.get(job_id)
}

export function setRenderJob(job: RenderJobRecord): void {
    render_jobs.set(job.id, job)
    pruneRenderJobs()
}

/** 既存ジョブを部分更新する。存在しない場合は何もしない。 */
export function updateRenderJob(
    job_id: string,
    patch: Partial<RenderJobRecord>,
): RenderJobRecord | undefined {
    const current = render_jobs.get(job_id)
    if (current === undefined) {
        return undefined
    }
    const updated: RenderJobRecord = { ...current, ...patch }
    render_jobs.set(job_id, updated)
    return updated
}

export function listRenderJobs(): RenderJobRecord[] {
    return [...render_jobs.values()]
}

export function countRunningRenderJobs(): number {
    let count = 0
    for (const job of render_jobs.values()) {
        if (job.status === "running") {
            count++
        }
    }
    return count
}

export function clearRenderJobsForTest(): void {
    render_jobs.clear()
}

/** requestId と Set identity に一致する実行中ジョブを探す（冪等性判定用）。 */
export function findRenderJobByRequest(
    request_id: string,
    set_id: string,
): RenderJobRecord | undefined {
    for (const job of render_jobs.values()) {
        if (job.requestId === request_id && job.setId === set_id) {
            return job
        }
    }
    return undefined
}

function pruneRenderJobs(): void {
    if (render_jobs.size <= MAX_RENDER_JOBS) {
        return
    }
    for (const [job_id, job] of render_jobs) {
        if (render_jobs.size <= MAX_RENDER_JOBS) {
            break
        }
        if (job.status !== "running") {
            render_jobs.delete(job_id)
        }
    }
}

export const RENDER_JOB_STORE_MAX = MAX_RENDER_JOBS
export type { RenderJobRecord }
