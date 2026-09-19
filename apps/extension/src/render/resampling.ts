/**
 * Main 出力の実時間録音（Resampling）オーケストレーション。
 *
 * 手順: preflight → preparing → armed → preroll → recording → finalizing → exporting
 * → restoring → completed。どの段階でも異常／中断は stopping → restoring → error / cancelled。
 * 音声生成の成否 (`audioStatus`) と Set 復旧の成否 (`cleanupStatus`) は別フィールドで管理する。
 */

import { randomUUID } from "node:crypto"
import type { AudioTrack, Song } from "@ableton-extensions/sdk"
import { HybridError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { findResamplingCandidate, MONITOR_STATE_OFF } from "../osc/protocol"
import type { OscRoutingAdapter } from "../osc/routing"
import type { OscTransportAdapter, TransportState } from "../osc/transport"
import type {
    AppliedSetting,
    AudioArtifact,
    CaptureBeforeState,
    CaptureJournal,
    MainRenderArgs,
    RenderJobRecord,
    RenderPhase,
} from "../types/hybrid"
import { assertArtifactStorage, finalizeArtifact } from "./artifacts"
import { restoreTransport } from "./capture-state"
import { nextRenderJobId, setRenderJob, updateRenderJob } from "./jobs"
import { writeJournal } from "./journal"
import { mainRenderArgHash } from "./plan"

type V = TargetApiVersion

const POLL_INTERVAL_MS = 50
const PLAY_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 10_000
/** SDK で作成したトラックが OSC のトラック一覧に現れるまでの待ち時間。 */
const PAIRING_TIMEOUT_MS = 8_000
/** SDK が OSC 録音由来の arrangement clip を取得できるまでの待ち時間。 */
const CLIP_SYNC_TIMEOUT_MS = 15_000
const REALTIME_OVERHEAD_MS = 15_000

export type MainCaptureParams = MainRenderArgs & {
    planId: string
    requestId: string
}

export type PreflightResult = {
    warnings: string[]
    transport: TransportState
}

/** 実行前の事前検査（副作用なし）。preview からも呼ぶ。 */
export async function preflightMainCapture(
    deps: ServerDeps,
    args: MainRenderArgs,
    set_id: string,
): Promise<PreflightResult> {
    assertArtifactStorage(deps)
    const transport = deps.runtime.requireTransport()
    const band = args.endTime - args.startTime
    if (band > deps.runtime.maxCaptureBeats()) {
        throw new HybridError(
            "RECORDING_LIMIT_EXCEEDED",
            `Requested ${band} beats exceeds maxCaptureBeats ${deps.runtime.maxCaptureBeats()}`,
        )
    }
    const state = await transport.readState()
    if (state.isPlaying || state.recordMode) {
        throw new HybridError(
            "TRANSPORT_BUSY",
            "Stop playback and recording before starting a Main capture",
        )
    }
    // `back_to_arranger` は停止中 false を返すことがあり Arrangement 可否を判定できない。
    // 代わりに Session clip が再生中でないことを確認する（Session 出力を録らないため）。
    const routing = deps.runtime.requireRouting()
    const track_names = await routing.listTrackNames()
    for (const index of track_names.keys()) {
        const playing_slot = await routing.getPlayingSlotIndex(index)
        if (playing_slot >= 0) {
            throw new HybridError(
                "ARRANGEMENT_NOT_ACTIVE",
                `A Session clip is playing on track ${index}; stop it before a Main capture`,
            )
        }
    }
    const warnings: string[] = []
    if (deps.runtime.validationLevel() === "unverified") {
        warnings.push("This capture path is unverified on this Live build; result is experimental.")
    }
    warnings.push(`Set identity: ${set_id}`)
    return { warnings, transport: state }
}

function sdkTrackNames(song: Song<V>): string[] {
    return song.tracks.map((track) => track.name)
}

export type StartMainCaptureResult = {
    job: RenderJobRecord
    warnings: string[]
}

/** 録音中ジョブの cancel ハンドラ。CALL render.cancel から参照する。 */
const active_captures = new Map<string, MainCaptureJob>()

/** 実行中の Main 録音ジョブを登録する。 */
function registerActiveCapture(job_id: string, capture: MainCaptureJob): void {
    active_captures.set(job_id, capture)
}

/**
 * 実行中の Main 録音ジョブへ中断を要求する。
 * 受理と停止・復旧完了は別であり、この関数は受理だけを行う。
 */
export function requestCaptureCancel(job_id: string): boolean {
    const capture = active_captures.get(job_id)
    if (capture === undefined) {
        return false
    }
    capture.cancel()
    return true
}

/** Main 録音ジョブを生成し、バックグラウンド実行を開始する。 */
export function startMainCapture(
    deps: ServerDeps,
    params: MainCaptureParams,
    setId: string,
): StartMainCaptureResult {
    const job_id = nextRenderJobId()
    deps.runtime.locks.acquireRecording(job_id)
    const duration = params.endTime - params.startTime
    const job: RenderJobRecord = {
        id: job_id,
        status: "running",
        at: new Date().toISOString(),
        source: "main",
        method: "realtime-resampling",
        phase: "preflight",
        startTime: params.startTime,
        endTime: params.endTime,
        duration,
        audioStatus: "pending",
        cleanupStatus: "pending",
        requestId: params.requestId,
        planId: params.planId,
        setId,
    }
    setRenderJob(job)

    const capture = new MainCaptureJob(deps, job_id, params, setId)
    registerActiveCapture(job_id, capture)
    capture.start()
    return { job, warnings: [] }
}

function captureCancelled(): HybridError {
    return new HybridError("CAPTURE_CANCELLED", "Main capture was cancelled")
}

function isCaptureCancelled(error: unknown): boolean {
    return error instanceof HybridError && error.code === "CAPTURE_CANCELLED"
}

/** 1 回の Main 録音ジョブの状態機械。 */
class MainCaptureJob {
    private readonly deps: ServerDeps
    private readonly job_id: string
    private readonly params: MainCaptureParams
    private readonly set_id: string
    private cancelled = false
    private phase: RenderPhase = "preflight"
    private before: CaptureBeforeState | null = null
    private applied: AppliedSetting[] = []
    private capture_track: AudioTrack<V> | null = null
    private unique_name = ""
    private osc_index: number | null = null
    private baseline_clip_counts = new Map<string, number>()
    private warnings: string[] = []
    private unrecovered: string[] = []
    private file_path: string | undefined
    private audio: AudioArtifact | undefined

    constructor(deps: ServerDeps, job_id: string, params: MainCaptureParams, set_id: string) {
        this.deps = deps
        this.job_id = job_id
        this.params = params
        this.set_id = set_id
    }

    /** バックグラウンド実行を開始する（await しない）。 */
    start(): void {
        void this.run().catch((error) => {
            this.deps.log.error("Main capture job crashed", {
                jobId: this.job_id,
                error: String(error),
            })
        })
    }

    /** 中断要求。受理と停止・復旧完了は別であり、run() が完了まで処理する。 */
    cancel(): void {
        this.cancelled = true
    }

    private get transport(): OscTransportAdapter {
        return this.deps.runtime.requireTransport()
    }

    private get routing(): OscRoutingAdapter {
        return this.deps.runtime.requireRouting()
    }

    private journal(): CaptureJournal {
        return {
            jobId: this.job_id,
            setId: this.set_id,
            requestId: this.params.requestId,
            argHash: mainRenderArgHash(this.params),
            phase: this.phase,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            before: this.before ?? {
                currentSongTime: null,
                isPlaying: null,
                loop: null,
                loopStart: null,
                loopLength: null,
                punchIn: null,
                punchOut: null,
                recordMode: null,
                backToArranger: null,
            },
            applied: [...this.applied],
            ...(this.capture_track !== null && this.osc_index !== null
                ? {
                      captureTrack: {
                          uniqueName: this.unique_name,
                          sdkHandle: String(this.capture_track.handle.id),
                          oscIndex: this.osc_index,
                      },
                  }
                : {}),
            audioStatus: this.audio !== undefined ? "ready" : "pending",
            cleanupStatus: "pending",
            ...(this.file_path !== undefined ? { artifactPath: this.file_path } : {}),
            ...(this.unrecovered.length > 0 ? { unrecovered: [...this.unrecovered] } : {}),
        }
    }

    private async transition(phase: RenderPhase): Promise<void> {
        if (this.cancelled && phase !== "stopping" && phase !== "restoring") {
            throw captureCancelled()
        }
        this.phase = phase
        updateRenderJob(this.job_id, { phase })
        await this.persistJournal()
    }

    private async persistJournal(): Promise<void> {
        try {
            await writeJournal(this.deps, this.journal())
        } catch (error) {
            this.deps.log.warn("Failed to persist capture journal", { error: String(error) })
        }
    }

    private recordApplied(key: string, value: number | boolean): void {
        const existing = this.applied.findIndex((entry) => entry.key === key)
        if (existing >= 0) {
            this.applied[existing] = { key, value }
        } else {
            this.applied.push({ key, value })
        }
    }

    private assertNotCancelled(): void {
        if (this.cancelled) {
            throw captureCancelled()
        }
    }

    async run(): Promise<void> {
        let failure: "error" | "cancelled" | null = null
        let error_message: string | undefined
        try {
            await this.transition("preflight")
            await this.preflight()
            await this.transition("preparing")
            await this.prepare()
            await this.transition("armed")
            await this.armRange()
            await this.transition("preroll")
            await this.startRecording()
            await this.transition("recording")
            await this.monitor()
            await this.transition("finalizing")
            await this.stopRecording()
            await this.checkUnexpectedRecording()
            await this.transition("exporting")
            await this.exportArtifact()
        } catch (error) {
            if (isCaptureCancelled(error)) {
                failure = "cancelled"
            } else {
                failure = "error"
                error_message = error instanceof Error ? error.message : String(error)
                this.deps.log.error("Main capture failed", {
                    jobId: this.job_id,
                    error: error_message,
                })
            }
        } finally {
            try {
                await this.cleanup()
            } catch (error) {
                this.unrecovered.push(`cleanup: ${String(error)}`)
            }
            const cleanup_status = this.unrecovered.length > 0 ? "needs_attention" : "complete"
            const audio_status = this.audio !== undefined ? "ready" : "failed"
            const final_status: RenderJobRecord["status"] =
                failure === "cancelled" ? "cancelled" : failure === "error" ? "error" : "done"
            updateRenderJob(this.job_id, {
                status: final_status,
                phase:
                    failure === "cancelled"
                        ? "cancelled"
                        : failure === "error"
                          ? "failed"
                          : "completed",
                audioStatus: audio_status,
                cleanupStatus: cleanup_status,
                ...(this.file_path !== undefined ? { filePath: this.file_path } : {}),
                ...(this.audio !== undefined ? { audio: this.audio } : {}),
                ...(error_message !== undefined ? { error: error_message } : {}),
                warnings: [...this.warnings],
                ...(this.unrecovered.length > 0 ? { unrecovered: [...this.unrecovered] } : {}),
            })
            await this.persistJournal()
            this.deps.runtime.locks.releaseRecording(this.job_id)
            active_captures.delete(this.job_id)
        }
    }

    private async preflight(): Promise<void> {
        const result = await preflightMainCapture(this.deps, this.params, this.set_id)
        this.warnings.push(...result.warnings)
    }

    private async prepare(): Promise<void> {
        const runtime = this.deps.runtime
        const song = this.deps.context.application.song
        runtime.requireResolver()

        this.baseline_clip_counts = new Map(
            song.tracks.map((track) => [String(track.handle.id), track.arrangementClips.length]),
        )

        this.unique_name = `__LC_PRINT_${randomUUID()}`
        const created = await this.deps.context.withinTransaction(() => song.createAudioTrack())
        this.capture_track = created
        created.name = this.unique_name

        // SDK のトラック作成・改名は Live へ非同期に反映される。OSC 側に現れるまで期限付きで待つ。
        const osc_index = await this.waitForPairing()
        this.osc_index = osc_index

        if (created.devices.length > 0) {
            throw new HybridError(
                "CAPTURE_ROUTING_UNAVAILABLE",
                "The temporary capture track unexpectedly contains devices",
            )
        }
        if (
            created.arrangementClips.length > 0 ||
            created.clipSlots.some((slot) => slot.clip !== null)
        ) {
            throw new HybridError(
                "CAPTURE_ROUTING_UNAVAILABLE",
                "The temporary capture track unexpectedly contains clips",
            )
        }

        await this.assertNoArmedTracks(osc_index)

        this.before = await this.readBeforeState()
        await this.persistJournal()

        await this.configureRouting(osc_index, created)
        await this.routing.setArm(osc_index, true)
        this.recordApplied("arm", true)
    }

    /** SDK で作成・改名した一時トラックが OSC 側へ反映されるまで待って index を解決する。 */
    private async waitForPairing(): Promise<number> {
        const deadline = Date.now() + PAIRING_TIMEOUT_MS
        let last_error: unknown
        for (;;) {
            const song = this.deps.context.application.song
            const names = sdkTrackNames(song)
            try {
                return await this.deps.runtime
                    .requireResolver()
                    .resolveOscIndex(this.unique_name, names)
            } catch (error) {
                last_error = error
            }
            if (Date.now() > deadline) {
                throw last_error instanceof Error
                    ? last_error
                    : new HybridError(
                          "SET_IDENTITY_MISMATCH",
                          `Capture track "${this.unique_name}" did not appear to OSC in time`,
                      )
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        }
    }

    private async readBeforeState(): Promise<CaptureBeforeState> {
        const state = await this.transport.readState()
        return {
            currentSongTime: state.currentSongTime,
            isPlaying: state.isPlaying,
            loop: state.loop,
            loopStart: state.loopStart,
            loopLength: state.loopLength,
            punchIn: state.punchIn,
            punchOut: state.punchOut,
            recordMode: state.recordMode,
            backToArranger: state.backToArranger,
        }
    }

    /** 手動 Arm された他トラックがある Set は MVP では拒否する（Auto monitoring 変化を検証できないため）。 */
    private async assertNoArmedTracks(capture_index: number): Promise<void> {
        const names = await this.routing.listTrackNames()
        for (const index of names.keys()) {
            if (index === capture_index) {
                continue
            }
            if (await this.routing.getArm(index)) {
                throw new HybridError(
                    "ARM_CONFLICT",
                    `Track ${index} "${names[index] ?? ""}" is armed; disarm other tracks before a Main capture`,
                )
            }
        }
    }

    private async configureRouting(index: number, track: AudioTrack<V>): Promise<void> {
        const candidates = await this.routing.getAvailableInputRoutingTypes(index)
        const resampling = findResamplingCandidate(candidates)
        if (resampling === null) {
            throw new HybridError(
                "CAPTURE_ROUTING_UNAVAILABLE",
                "No Resampling input candidate is available on the capture track",
                409,
                { hint: `Available input routing types: ${candidates.join(", ")}` },
            )
        }
        await this.routing.setInputRoutingType(index, resampling)
        await this.routing.setMonitoringState(index, MONITOR_STATE_OFF)

        const output_candidates = await this.routing.getAvailableOutputRoutingTypes(index)
        const sends_only = output_candidates.find((name) => name === "Sends Only")
        if (sends_only !== undefined) {
            await this.routing.setOutputRoutingType(index, sends_only)
            const send_count = track.mixer.sends.length
            for (let send_id = 0; send_id < send_count; send_id++) {
                await this.routing.setSend(index, send_id, 0)
            }
        } else {
            this.warnings.push(
                "Sends Only output routing is unavailable; the capture track output was not blocked",
            )
        }
    }

    private async armRange(): Promise<void> {
        const { startTime, endTime, preRollBeats } = this.params
        await this.transport.setLoop(false)
        this.recordApplied("loop", false)
        await this.transport.setLoopStart(startTime)
        this.recordApplied("loopStart", startTime)
        await this.transport.setLoopLength(endTime - startTime)
        this.recordApplied("loopLength", endTime - startTime)
        await this.transport.setPunchIn(true)
        this.recordApplied("punchIn", true)
        await this.transport.setPunchOut(true)
        this.recordApplied("punchOut", true)
        await this.transport.seek(Math.max(0, startTime - preRollBeats))
    }

    private async startRecording(): Promise<void> {
        this.assertNotCancelled()
        await this.transport.setRecordMode(true)
        this.recordApplied("recordMode", true)
        if (!(await this.transport.readIsPlaying())) {
            this.transport.play()
        }
        await this.transport.waitForPlaying(PLAY_TIMEOUT_MS)
    }

    private async monitor(): Promise<void> {
        const state = await this.transport.readState()
        const beats_per_second = state.tempo / 60
        const seconds = (this.params.endTime - this.params.startTime) / beats_per_second
        const deadline = Date.now() + seconds * 1000 + REALTIME_OVERHEAD_MS
        const initial_tempo = state.tempo
        let last_time = state.currentSongTime
        let polls_since_tempo_check = 0

        for (;;) {
            this.assertNotCancelled()
            const current = await this.transport.readCurrentSongTime()
            if (current < last_time - 0.5) {
                throw new HybridError(
                    "OSC_WRITE_UNCERTAIN",
                    `Playback position moved backwards (${last_time} -> ${current})`,
                )
            }
            last_time = current
            const fraction =
                this.params.endTime > this.params.startTime
                    ? Math.min(
                          1,
                          Math.max(
                              0,
                              (current - this.params.startTime) /
                                  (this.params.endTime - this.params.startTime),
                          ),
                      )
                    : 0
            updateRenderJob(this.job_id, {
                progress: {
                    currentBeat: current,
                    endBeat: this.params.endTime,
                    fraction,
                },
            })
            if (current >= this.params.endTime) {
                return
            }
            if (Date.now() > deadline) {
                throw new HybridError(
                    "OSC_WRITE_UNCERTAIN",
                    "Main capture exceeded its real-time budget",
                )
            }
            polls_since_tempo_check += 1
            if (polls_since_tempo_check >= 10) {
                polls_since_tempo_check = 0
                const tempo = await this.transport.readTempo()
                if (Math.abs(tempo - initial_tempo) > 0.01) {
                    throw new HybridError(
                        "OSC_WRITE_UNCERTAIN",
                        `Tempo changed during capture (${initial_tempo} -> ${tempo})`,
                    )
                }
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        }
    }

    private async stopRecording(): Promise<void> {
        this.transport.stop()
        await this.transport.waitForStopped(STOP_TIMEOUT_MS)
        await this.transport.setRecordMode(false)
        this.recordApplied("recordMode", false)
    }

    private async checkUnexpectedRecording(): Promise<void> {
        const song = this.deps.context.application.song
        for (const track of song.tracks) {
            if (this.capture_track !== null && track.handle.id === this.capture_track.handle.id) {
                continue
            }
            const baseline = this.baseline_clip_counts.get(String(track.handle.id))
            if (baseline === undefined) {
                continue
            }
            if (track.arrangementClips.length > baseline) {
                throw new HybridError(
                    "UNEXPECTED_RECORDING",
                    `Track "${track.name}" gained a clip during capture; not deleting it automatically`,
                )
            }
        }
    }

    private async exportArtifact(): Promise<void> {
        if (this.capture_track === null) {
            throw new HybridError("AUDIO_ARTIFACT_INVALID", "Capture track is missing")
        }
        await this.waitForCaptureClip()
        const intermediate = await this.deps.context.resources.renderPreFxAudio(
            this.capture_track,
            this.params.startTime,
            this.params.endTime,
        )
        const result = await finalizeArtifact(
            this.deps,
            this.job_id,
            intermediate,
            this.deps.runtime.maxArtifactBytes(),
        )
        this.file_path = result.filePath
        this.audio = result.audio
        this.warnings.push(...result.warnings)
    }

    /** OSC 録音で生成された arrangement clip が SDK から見えるまで期限付きで待つ。 */
    private async waitForCaptureClip(): Promise<void> {
        const deadline = Date.now() + CLIP_SYNC_TIMEOUT_MS
        for (;;) {
            this.assertNotCancelled()
            const track = this.capture_track
            if (track !== null) {
                const covering = track.arrangementClips.find(
                    (clip) =>
                        clip.startTime <= this.params.startTime + 0.001 &&
                        clip.endTime >= this.params.endTime - 0.001,
                )
                if (covering !== undefined) {
                    return
                }
            }
            if (Date.now() > deadline) {
                throw new HybridError(
                    "AUDIO_ARTIFACT_INVALID",
                    "The recorded clip did not appear to the SDK within the sync deadline",
                )
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        }
    }

    private async cleanup(): Promise<void> {
        await this.phaseSafe("restoring")
        try {
            this.transport.stop()
        } catch (error) {
            this.unrecovered.push(`stop transport: ${String(error)}`)
        }
        try {
            await this.transport.setRecordMode(false)
        } catch (error) {
            this.unrecovered.push(`record_mode: ${String(error)}`)
        }
        if (this.before !== null) {
            try {
                const outcome = await restoreTransport(
                    this.transport,
                    this.before,
                    this.applied,
                    this.deps.log,
                )
                this.unrecovered.push(...outcome.unrecovered)
            } catch (error) {
                this.unrecovered.push(`transport settings: ${String(error)}`)
            }
        }
        await this.releaseCaptureTrack()
        if (this.unrecovered.length > 0) {
            this.deps.log.error("Capture cleanup needs attention", {
                jobId: this.job_id,
                unrecovered: this.unrecovered,
            })
        }
    }

    private async phaseSafe(phase: RenderPhase): Promise<void> {
        this.phase = phase
        updateRenderJob(this.job_id, { phase })
        await this.persistJournal()
    }

    private async releaseCaptureTrack(): Promise<void> {
        const track = this.capture_track
        if (track === null) {
            return
        }
        // keepCaptureTrack が指定された場合、OSC index を解決できていなくても削除しない。
        // 録音結果がこのトラック上にあるため、保持要求を無視して消すと成果物を失う。
        if (this.params.keepCaptureTrack) {
            try {
                if (this.osc_index !== null) {
                    await this.routing.setArm(this.osc_index, false)
                } else {
                    this.unrecovered.push("disarm capture track (OSC index unresolved)")
                }
                track.mute = true
            } catch (error) {
                this.unrecovered.push(`retain capture track: ${String(error)}`)
            }
            updateRenderJob(this.job_id, { captureTrackRetained: true })
            return
        }
        // OSC index を解決できなかった場合でも、SDK handle で自分の一時トラックだけを削除する。
        try {
            const song = this.deps.context.application.song
            await this.deps.context.withinTransaction(() => song.deleteTrack(track))
        } catch (error) {
            this.unrecovered.push(`delete capture track: ${String(error)}`)
        }
    }
}
