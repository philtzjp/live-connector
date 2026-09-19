import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import type { ServerDeps } from "../deps"
import { createFakeLive, makeClip, makeHybridTrack } from "../test-support/fake-live"
import { type FakeOscState, makeFakeOscState } from "../test-support/fake-osc"
import { createFakeOscRuntime } from "../test-support/fake-runtime"
import { runDoStatement } from "../tools/do"
import { runRender } from "../tools/render"
import { runUndo } from "../tools/undo"
import type { RenderJobRecord } from "../types/hybrid"
import { clearRenderJobsForTest, getRenderJob } from "./jobs"
import { clearRenderPlansForTest } from "./plan"

const log = { debug() {}, info() {}, warn() {}, error() {} }

async function buildDeps(
    state: FakeOscState,
    tracks = [makeHybridTrack("Drums")],
): Promise<{ deps: ServerDeps; live: ReturnType<typeof createFakeLive> }> {
    const storage = await mkdtemp(path.join(tmpdir(), "lc-capture-"))
    const live = createFakeLive({ storageDirectory: storage, tracks })
    live.song.tracks = tracks
    const runtime = createFakeOscRuntime(state)
    await runtime.start()
    const deps = { context: live.context, log, runtime } as unknown as ServerDeps
    return { deps, live }
}

function baseParams(): Record<string, unknown> {
    return { source: "main", startTime: 0, endTime: 8 }
}

async function waitForJob(
    job_id: string,
    predicate: (job: RenderJobRecord) => boolean,
    timeout_ms = 8000,
): Promise<RenderJobRecord> {
    const deadline = Date.now() + timeout_ms
    for (;;) {
        const job = getRenderJob(job_id)
        if (job !== undefined && predicate(job)) {
            return job
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for job: ${JSON.stringify(job)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

beforeEach(() => {
    clearRenderJobsForTest()
    clearRenderPlansForTest()
})

afterEach(() => {
    clearRenderJobsForTest()
    clearRenderPlansForTest()
})

describe("Main capture", () => {
    it("preview plans without side effects", async () => {
        const state = makeFakeOscState({ trackNamesSource: null })
        const { deps, live } = await buildDeps(state, [makeHybridTrack("Drums")])
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)

        const result = await runRender(deps, {
            ...baseParams(),
            preview: true,
        } as never)

        expect(result.status).toBe("preview")
        expect(typeof result.planId).toBe("string")
        expect(live.song.tracks).toHaveLength(1)
        expect(state.isPlaying).toBe(false)
        expect(state.recordMode).toBe(false)
        expect(state.loopLength).toBe(4)
    })

    it("requires confirm before starting", async () => {
        const state = makeFakeOscState()
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)
        const preview = await runRender(deps, { ...baseParams(), preview: true } as never)

        const result = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "capture-1",
        } as never)

        expect(result.status).toBe("confirm_required")
        expect(live.song.tracks).toHaveLength(1)
    })

    it("rejects a capture while a Session clip is playing", async () => {
        const state = makeFakeOscState()
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)
        state.playingSlot.set(0, 2)

        await expect(
            runRender(deps, { ...baseParams(), preview: true } as never),
        ).rejects.toMatchObject({ code: "ARRANGEMENT_NOT_ACTIVE" })
    })

    it("records, exports, restores and deletes the capture track", async () => {
        const state = makeFakeOscState()
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)
        state.onStop = () => {
            const capture = live.song.tracks[live.song.tracks.length - 1]
            capture?.arrangementClips.push(makeClip(0, 8))
        }

        const preview = await runRender(deps, { ...baseParams(), preview: true } as never)
        const started = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "capture-ok",
            confirm: true,
        } as never)

        const job = await waitForJob(
            String(started.jobId),
            (candidate) => candidate.status === "done",
        )
        expect(job.audioStatus).toBe("ready")
        expect(job.cleanupStatus).toBe("complete")
        expect(job.audio?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(job.filePath).toBeDefined()
        // 一時トラックは削除され、Transport 設定は復旧する。
        expect(live.song.tracks).toHaveLength(1)
        expect(state.loop).toBe(false)
        expect(state.loopLength).toBe(4)
        expect(state.punchIn).toBe(false)
        expect(state.punchOut).toBe(false)
        expect(state.recordMode).toBe(false)
        expect(state.currentSongTime).toBe(0)
    })

    it("returns the same job for a repeated requestId", async () => {
        const state = makeFakeOscState()
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)
        state.onStop = () => {
            const capture = live.song.tracks[live.song.tracks.length - 1]
            capture?.arrangementClips.push(makeClip(0, 8))
        }
        const preview = await runRender(deps, { ...baseParams(), preview: true } as never)

        const first = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "same-request",
            confirm: true,
        } as never)
        const second = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "same-request",
            confirm: true,
        } as never)

        expect(second.jobId).toBe(first.jobId)
    })

    it("cancels a running capture and still restores the Set", async () => {
        const state = makeFakeOscState({ beatStepPerRead: 0 })
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)

        const preview = await runRender(deps, { ...baseParams(), preview: true } as never)
        const started = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "capture-cancel",
            confirm: true,
        } as never)
        const job_id = String(started.jobId)
        await waitForJob(job_id, (candidate) => candidate.phase === "recording")

        const cancelled = await runDoStatement(deps, {
            statement: `CALL render.cancel("${job_id}")`,
            confirm: true,
        })
        expect(cancelled.status).toBe("ok")

        const job = await waitForJob(job_id, (candidate) => candidate.status === "cancelled")
        expect(job.cleanupStatus).toBe("complete")
        expect(live.song.tracks).toHaveLength(1)
        expect(state.recordMode).toBe(false)
    })

    it("rejects writes and undo while recording", async () => {
        const state = makeFakeOscState({ beatStepPerRead: 0 })
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)

        const preview = await runRender(deps, { ...baseParams(), preview: true } as never)
        const started = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "capture-lock",
            confirm: true,
        } as never)
        const job_id = String(started.jobId)
        await waitForJob(job_id, (candidate) => candidate.phase === "recording")

        await expect(
            runDoStatement(deps, {
                statement: 'MATCH (t:AudioTrack {name:"Drums"}) SET t.mute = true',
            }),
        ).rejects.toMatchObject({ code: "RENDER_BUSY" })
        await expect(runUndo(deps, {})).rejects.toMatchObject({ code: "RENDER_BUSY" })

        await runDoStatement(deps, {
            statement: `CALL render.cancel("${job_id}")`,
            confirm: true,
        })
        await waitForJob(job_id, (candidate) => candidate.status === "cancelled")
    })

    it("reports OSC unavailable when AbletonOSC is disabled", async () => {
        const storage = await mkdtemp(path.join(tmpdir(), "lc-capture-"))
        const live = createFakeLive({ storageDirectory: storage })
        const { HybridRuntime } = await import("../runtime/runtime")
        const { loadEnv } = await import("@live-connector/env")
        const runtime = new HybridRuntime(loadEnv({}), { ...log } as never)
        const deps = { context: live.context, log, runtime } as unknown as ServerDeps

        await expect(
            runRender(deps, { ...baseParams(), preview: true } as never),
        ).rejects.toMatchObject({ code: "OSC_UNAVAILABLE" })
    })

    it("conflicts when the same requestId is reused with different arguments", async () => {
        const state = makeFakeOscState()
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)
        state.beatStepPerRead = 100
        state.onStop = () => {
            const capture = live.song.tracks[live.song.tracks.length - 1]
            capture?.arrangementClips.push(makeClip(0, 8))
        }
        const preview = await runRender(deps, { ...baseParams(), preview: true } as never)
        const started = await runRender(deps, {
            ...baseParams(),
            planId: preview.planId,
            requestId: "conflict-request",
            confirm: true,
        } as never)
        await waitForJob(String(started.jobId), (job) => job.status === "done")

        await expect(
            runRender(deps, {
                source: "main",
                startTime: 0,
                endTime: 16,
                planId: preview.planId,
                requestId: "conflict-request",
                confirm: true,
            } as never),
        ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
    })

    it("retains the capture track when keepCaptureTrack is true", async () => {
        const state = makeFakeOscState()
        const { deps, live } = await buildDeps(state)
        state.trackNamesSource = () => live.song.tracks.map((track) => track.name)
        state.onStop = () => {
            const capture = live.song.tracks[live.song.tracks.length - 1]
            capture?.arrangementClips.push(makeClip(0, 8))
        }
        const preview = await runRender(deps, {
            ...baseParams(),
            keepCaptureTrack: true,
            preview: true,
        } as never)
        const started = await runRender(deps, {
            ...baseParams(),
            keepCaptureTrack: true,
            planId: preview.planId,
            requestId: "keep-track",
            confirm: true,
        } as never)
        const job = await waitForJob(
            String(started.jobId),
            (candidate) => candidate.status === "done",
        )

        expect(job.captureTrackRetained).toBe(true)
        expect(live.song.tracks).toHaveLength(2)
        const capture = live.song.tracks[1]
        expect(capture?.mute).toBe(true)
        expect(capture?.arm).toBe(false)
    })

    it("reports OSC unavailable when the reply port is in use", async () => {
        const state = makeFakeOscState()
        state.bindError = Object.assign(new Error("address in use"), { code: "EADDRINUSE" })
        const { deps } = await buildDeps(state)

        expect(deps.runtime.oscConnected()).toBe(false)
        const capabilities = deps.runtime.capabilities()
        expect(capabilities.render.mainOutput.available).toBe(false)
        expect(capabilities.render.mainOutput.reason).toBeDefined()
        await expect(
            runRender(deps, { ...baseParams(), preview: true } as never),
        ).rejects.toMatchObject({ code: "OSC_UNAVAILABLE" })
    })

    it("reports OSC unavailable when the socket binds but AbletonOSC does not answer", async () => {
        const state = makeFakeOscState()
        // ソケットは bind できるが get/tempo に応答しない（AbletonOSC 未起動の再現）。
        state.dropAddresses = new Set(["/live/song/get/tempo"])
        const { deps } = await buildDeps(state)

        expect(deps.runtime.oscConnected()).toBe(false)
        expect(deps.runtime.capabilities().render.mainOutput.available).toBe(false)
        await expect(
            runRender(deps, { ...baseParams(), preview: true } as never),
        ).rejects.toMatchObject({ code: "OSC_UNAVAILABLE" })
    })
})
