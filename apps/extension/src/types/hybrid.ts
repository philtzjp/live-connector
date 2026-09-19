/**
 * Hybrid Runtime（OSC Transport・実時間 Main 録音）の共有型。
 * 実装ファイルへ型を散在させないため、このファイルに集約する。
 */

/** Main 録音経路の検証状態。未検証環境では experimental として扱う。 */
export type CaptureValidationLevel = "unverified" | "integration-tested"

/** OSC（AbletonOSC）接続設定。 */
export type OscSettings = {
    enabled: boolean
    host: string
    sendPort: number
    replyPort: number
    timeoutMs: number
}

/** render の取得元。旧 Pre-FX 経路と Main 実時間録音。 */
export type RenderSource = "audio-track-pre-fx" | "main"

/** render の処理方式。 */
export type RenderMethod = "sdk-pre-fx" | "realtime-resampling"

/** Main 録音ジョブの詳細フェーズ。`status` は互換のため running のまま保つ。 */
export type RenderPhase =
    | "preflight"
    | "preparing"
    | "armed"
    | "preroll"
    | "recording"
    | "finalizing"
    | "exporting"
    | "restoring"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled"

/** 音声 artifact の確定状態。 */
export type AudioStatus = "pending" | "ready" | "failed"

/** Set の復旧状態。音声生成の成否とは独立に管理する。 */
export type CleanupStatus = "pending" | "complete" | "needs_attention"

/** render ジョブの進行状況。 */
export type RenderProgress = {
    currentBeat: number
    endBeat: number
    fraction: number
}

/** 確定済み artifact の測定メタデータ。 */
export type AudioArtifact = {
    sampleRate: number
    channels: number
    frames: number
    sha256: string
    durationSeconds: number
    sampleFormat: string
}

/** RenderJob 仮想ラベルが返すレコード。 */
export type RenderJobRecord = {
    id: string
    status: "running" | "done" | "error" | "cancelled"
    at: string
    source: RenderSource
    method: RenderMethod
    phase: RenderPhase
    startTime: number
    endTime: number
    duration: number
    durationSeconds?: number
    audioStatus: AudioStatus
    cleanupStatus: CleanupStatus
    track?: { index: number; name: string; kind: "audio" }
    progress?: RenderProgress
    filePath?: string
    audio?: AudioArtifact
    requestId?: string
    planId?: string
    setId?: string
    captureTrackRetained?: boolean
    error?: string
    warnings?: string[]
    unrecovered?: string[]
}

/** Main 録音の実引数（requestId / planId を除く、冪等性判定の対象）。 */
export type MainRenderArgs = {
    startTime: number
    endTime: number
    preRollBeats: number
    keepCaptureTrack: boolean
}

/** preview が返す実行計画。planId は永続的な権限ではなく短命なトークン。 */
export type RenderPlan = {
    planId: string
    setId: string
    source: "main"
    method: "realtime-resampling"
    timeUnit: "quarter-note-beats"
    range: { startTime: number; endTime: number }
    preRollBeats: number
    keepCaptureTrack: boolean
    argHash: string
    effects: string[]
    warnings: string[]
    requiresConfirmation: true
    createdAt: string
    expiresAt: string
}

/** ジョブが実際に変更した設定項目と、その設定値。復旧時の競合判定に使う。 */
export type AppliedSetting = {
    key: string
    value: number | boolean
}

/** ジョブが変更した項目の before 値・設定値と所有対象を記録する復旧情報。 */
export type CaptureJournal = {
    jobId: string
    setId: string
    requestId: string
    argHash: string
    phase: RenderPhase
    createdAt: string
    updatedAt: string
    before: CaptureBeforeState
    applied: AppliedSetting[]
    captureTrack?: CaptureTrackIdentity
    audioStatus: AudioStatus
    cleanupStatus: CleanupStatus
    artifactPath?: string
    unrecovered?: string[]
}

/** 録音ジョブが変更し得る項目の before スナップショット。 */
export type CaptureBeforeState = {
    currentSongTime: number | null
    isPlaying: boolean | null
    loop: boolean | null
    loopStart: number | null
    loopLength: number | null
    punchIn: boolean | null
    punchOut: boolean | null
    recordMode: boolean | null
    backToArranger: boolean | null
}

/** 一時録音トラックの同一性（SDK handle・一意名・OSC index）。 */
export type CaptureTrackIdentity = {
    uniqueName: string
    sdkHandle: string
    oscIndex: number
}

/** OSC メッセージの引数。 */
export type OscArg = string | number | boolean

/** OSC 応答メッセージ。 */
export type OscMessage = {
    address: string
    args: OscArg[]
}
