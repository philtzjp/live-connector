import {
    AudioClip,
    AudioTrack,
    Clip,
    type ClipLoopSettings,
    CuePoint,
    MidiClip,
    MidiTrack,
    type NoteDescription,
    Track,
    type WarpMode,
} from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type CreateArrangementClipParams = {
    select: string
    startTime: number
    duration: number
    name: string | undefined
    audioFilePath: string | undefined
    isWarped: boolean | undefined
    loopSettings: ClipLoopSettings | undefined
    preview: boolean | undefined
}

type DeleteArrangementClipParams = {
    select: string
    preview: boolean | undefined
}

type CreateCuePointParams = {
    time: number
    name: string | undefined
    preview: boolean | undefined
}

type DeleteCuePointParams = {
    select: string
    preview: boolean | undefined
}

type CreateAudioArrangementClipArgs = {
    filePath: string
    startTime: number
    duration?: number
    isWarped?: boolean
    loopSettings?: ClipLoopSettings
}

const loop_settings_schema = z
    .object({
        looping: z.boolean(),
        startMarker: z.number().min(0),
        endMarker: z.number().positive(),
        loopStart: z.number().min(0),
        loopEnd: z.number().positive(),
    })
    .optional()

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function trackSelectDescription(): string {
    return 'MidiTrack または AudioTrack を単一ノード変数で RETURN する Cypher。プロパティ射影（RETURN t.name）や複数変数（RETURN t, c）は不可。例: MATCH (t:MidiTrack {name:"Lead"}) RETURN t'
}

function clipSelectDescription(): string {
    return 'アレンジメント Clip を単一ノード変数で RETURN する Cypher。session clip は不可。例: MATCH (:Track {name:"Print"})-[:HAS_ARRANGEMENT_CLIP]->(c:Clip {index:0}) RETURN c'
}

function cuePointSelectDescription(): string {
    return 'CuePoint を単一ノード変数で RETURN する Cypher。プロパティ射影（RETURN c.time）や複数変数は不可。例: MATCH (c:CuePoint {name:"Verse"}) RETURN c'
}

function resolveSingleObject(nodes: LomNode[], label: string): LomNode {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `${label} operation requires the selection to match exactly one node, but matched ${nodes.length}`,
            {
                hint: `Change select so it returns exactly one ${label} node.`,
            },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object") {
        throw new BadRequestError(`select must return a ${label} object node`)
    }
    return node
}

function resolveArrangementTrack(
    nodes: LomNode[],
): MidiTrack<TargetApiVersion> | AudioTrack<TargetApiVersion> {
    const node = resolveSingleObject(nodes, "Track")
    if (node.value instanceof MidiTrack || node.value instanceof AudioTrack) {
        return node.value
    }
    throw new BadRequestError("select must return a MidiTrack or AudioTrack", {
        hint: "Arrangement clip creation supports regular MidiTrack and AudioTrack targets only.",
    })
}

function resolveArrangementClip(nodes: LomNode[]): {
    clip: Clip<TargetApiVersion>
    track: Track<TargetApiVersion>
} {
    const node = resolveSingleObject(nodes, "Clip")
    if (!(node.value instanceof Clip)) {
        throw new BadRequestError("select must return a Clip", {
            hint: "Use HAS_ARRANGEMENT_CLIP from a Track and return the Clip node.",
        })
    }
    const parent = node.value.parent
    if (!(parent instanceof Track)) {
        throw new BadRequestError("select must return an arrangement Clip", {
            hint: "Session clips are deleted with ClipSlot.deleteClip. Select a Clip reached through HAS_ARRANGEMENT_CLIP.",
        })
    }
    return { clip: node.value, track: parent }
}

function resolveCuePoint(nodes: LomNode[]): CuePoint<TargetApiVersion> {
    const node = resolveSingleObject(nodes, "CuePoint")
    if (!(node.value instanceof CuePoint)) {
        throw new BadRequestError("select must return a CuePoint", {
            hint: 'Use a select query such as MATCH (c:CuePoint {name:"Verse"}) RETURN c.',
        })
    }
    return node.value
}

function trackIndex(tracks: Track<TargetApiVersion>[], track: Track<TargetApiVersion>): number {
    const index = tracks.findIndex((candidate) => candidate.handle === track.handle)
    if (index < 0) {
        throw new BadRequestError("selected Track is not in Song.tracks")
    }
    return index
}

function clipSummary(clip: Clip<TargetApiVersion>, index: number | null): Record<string, unknown> {
    return {
        _label:
            clip instanceof MidiClip
                ? "MidiClip"
                : clip instanceof AudioClip
                  ? "AudioClip"
                  : "Clip",
        index,
        name: clip.name,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
    }
}

function cuePointSummary(
    cue: CuePoint<TargetApiVersion>,
    index: number | null,
): Record<string, unknown> {
    return {
        _label: "CuePoint",
        index,
        name: cue.name,
        time: cue.time,
    }
}

async function runCreateArrangementClipTool(
    deps: ServerDeps,
    params: CreateArrangementClipParams,
): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const track = resolveArrangementTrack(await selectNodes(parseQuery(params.select), adapter))
        const track_index = trackIndex(deps.context.application.song.tracks, track)
        const target = {
            index: track_index,
            name: track.name,
            kind: track instanceof MidiTrack ? "midi" : "audio",
        }
        if (params.preview === true) {
            return textResult({
                status: "preview",
                track: target,
                startTime: params.startTime,
                duration: params.duration,
                audioFilePath: params.audioFilePath,
            })
        }

        const clip = await deps.context.withinTransaction(() => {
            if (track instanceof MidiTrack) {
                return track.createMidiClip(params.startTime, params.duration).then((created) => {
                    if (params.name !== undefined) {
                        created.name = params.name
                    }
                    return created
                })
            }
            if (params.audioFilePath === undefined) {
                throw new BadRequestError(
                    "audioFilePath is required when selected track is AudioTrack",
                )
            }
            const args: CreateAudioArrangementClipArgs = {
                filePath: params.audioFilePath,
                startTime: params.startTime,
                duration: params.duration,
            }
            if (params.isWarped !== undefined) {
                args.isWarped = params.isWarped
            }
            if (params.loopSettings !== undefined) {
                args.loopSettings = params.loopSettings
            }
            return track.createAudioClip(args).then((created) => {
                if (params.name !== undefined) {
                    created.name = params.name
                }
                return created
            })
        })
        const index = track.arrangementClips.findIndex(
            (candidate) => candidate.handle === clip.handle,
        )

        return textResult({
            status: "ok",
            track: target,
            clip: clipSummary(clip, index < 0 ? null : index),
        })
    } catch (error) {
        deps.log.error("create_arrangement_clip failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

async function runDeleteArrangementClipTool(
    deps: ServerDeps,
    params: DeleteArrangementClipParams,
): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const { clip, track } = resolveArrangementClip(
            await selectNodes(parseQuery(params.select), adapter),
        )
        const index = track.arrangementClips.findIndex(
            (candidate) => candidate.handle === clip.handle,
        )
        const summary = {
            track: {
                index: trackIndex(deps.context.application.song.tracks, track),
                name: track.name,
            },
            clip: clipSummary(clip, index < 0 ? null : index),
        }
        if (params.preview === true) {
            return textResult({ status: "preview", ...summary })
        }
        await deps.context.withinTransaction(() => track.deleteClip(clip))
        return textResult({ status: "ok", ...summary })
    } catch (error) {
        deps.log.error("delete_arrangement_clip failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

async function runCreateCuePointTool(
    deps: ServerDeps,
    params: CreateCuePointParams,
): Promise<ToolResult> {
    try {
        if (params.preview === true) {
            return textResult({ status: "preview", time: params.time, name: params.name })
        }
        const song = deps.context.application.song
        const cue = await deps.context.withinTransaction(() =>
            song.createCuePoint(params.time).then((created) => {
                if (params.name !== undefined) {
                    created.name = params.name
                }
                return created
            }),
        )
        const index = song.cuePoints.findIndex((candidate) => candidate.handle === cue.handle)
        return textResult({
            status: "ok",
            cuePoint: cuePointSummary(cue, index < 0 ? null : index),
        })
    } catch (error) {
        deps.log.error("create_cue_point failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

async function runDeleteCuePointTool(
    deps: ServerDeps,
    params: DeleteCuePointParams,
): Promise<ToolResult> {
    try {
        const cue = resolveCuePoint(
            await selectNodes(parseQuery(params.select), new LomGraphAdapter(deps.context)),
        )
        const song = deps.context.application.song
        const index = song.cuePoints.findIndex((candidate) => candidate.handle === cue.handle)
        const summary = cuePointSummary(cue, index < 0 ? null : index)
        if (params.preview === true) {
            return textResult({ status: "preview", cuePoint: summary })
        }
        await deps.context.withinTransaction(() => song.deleteCuePoint(cue))
        return textResult({ status: "ok", cuePoint: summary })
    } catch (error) {
        deps.log.error("delete_cue_point failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

type MoveClipParams = {
    select: string
    startTime: number
    overwrite: boolean | undefined
    confirm: boolean | undefined
    preview: boolean | undefined
}

type TrimClipParams = {
    select: string
    duration: number | undefined
    startMarker: number | undefined
    endMarker: number | undefined
    overwrite: boolean | undefined
    confirm: boolean | undefined
    preview: boolean | undefined
}

const FLOAT_EPS = 1e-6

/**
 * 削除前にキャプチャするクリップの再現可能状態。
 * MidiClip は MidiTrack、AudioClip は AudioTrack でのみ対応する。
 */
type CapturedClipBase = {
    name: string
    color: number
    muted: boolean
    looping: boolean
    startTime: number
    duration: number
    startMarker: number
    endMarker: number
    loopStart: number
    loopEnd: number
}
type CapturedMidiClip = CapturedClipBase & {
    kind: "midi"
    track: MidiTrack<TargetApiVersion>
    notes: NoteDescription[]
}
type CapturedAudioClip = CapturedClipBase & {
    kind: "audio"
    track: AudioTrack<TargetApiVersion>
    filePath: string
    warping: boolean
    warpMode: WarpMode
    warpMarkerCount: number
}
type CapturedClip = CapturedMidiClip | CapturedAudioClip

/** 再作成時に上書きする属性。未指定の項目はキャプチャ値を引き継ぐ。 */
type RecreateOverrides = {
    startTime?: number
    duration?: number
    startMarker?: number
    endMarker?: number
    loopStart?: number
    loopEnd?: number
    notes?: NoteDescription[]
}

/** クリップの再現可能状態を削除前にキャプチャする。 */
function captureClip(clip: Clip<TargetApiVersion>, track: Track<TargetApiVersion>): CapturedClip {
    const base: CapturedClipBase = {
        name: clip.name,
        color: clip.color,
        muted: clip.muted,
        looping: clip.looping,
        startTime: clip.startTime,
        duration: clip.duration,
        startMarker: clip.startMarker,
        endMarker: clip.endMarker,
        loopStart: clip.loopStart,
        loopEnd: clip.loopEnd,
    }
    if (clip instanceof MidiClip && track instanceof MidiTrack) {
        return { ...base, kind: "midi", track, notes: clip.notes }
    }
    if (clip instanceof AudioClip && track instanceof AudioTrack) {
        return {
            ...base,
            kind: "audio",
            track,
            filePath: clip.filePath,
            warping: clip.warping,
            warpMode: clip.warpMode,
            warpMarkerCount: clip.warpMarkers.length,
        }
    }
    throw new BadRequestError(
        "this edit supports MidiClip on MidiTrack and AudioClip on AudioTrack only",
        { hint: "Select an arrangement MidiClip or AudioClip via HAS_ARRANGEMENT_CLIP." },
    )
}

/** キャプチャ状態から、任意の上書きを適用して同等クリップを再作成する。 */
async function recreateClip(
    captured: CapturedClip,
    overrides: RecreateOverrides,
): Promise<Clip<TargetApiVersion>> {
    const start = overrides.startTime ?? captured.startTime
    const duration = overrides.duration ?? captured.duration
    if (captured.kind === "midi") {
        const created = await captured.track.createMidiClip(start, duration)
        created.notes = overrides.notes ?? captured.notes
        created.name = captured.name
        created.color = captured.color
        created.muted = captured.muted
        created.looping = captured.looping
        return created
    }
    const loop_settings: ClipLoopSettings = {
        looping: captured.looping,
        startMarker: overrides.startMarker ?? captured.startMarker,
        endMarker: overrides.endMarker ?? captured.endMarker,
        loopStart: overrides.loopStart ?? captured.loopStart,
        loopEnd: overrides.loopEnd ?? captured.loopEnd,
    }
    const created = await captured.track.createAudioClip({
        filePath: captured.filePath,
        startTime: start,
        duration,
        isWarped: captured.warping,
        loopSettings: loop_settings,
    })
    created.warpMode = captured.warpMode
    created.name = captured.name
    created.color = captured.color
    created.muted = captured.muted
    return created
}

/** 再作成で失われる属性（再現不能属性）を列挙する。 */
function lossyAttributes(captured: CapturedClip): string[] {
    const lossy: string[] = []
    if (captured.kind === "midi") {
        const custom_markers =
            Math.abs(captured.startMarker) > FLOAT_EPS ||
            Math.abs(captured.endMarker - captured.duration) > FLOAT_EPS ||
            Math.abs(captured.loopStart) > FLOAT_EPS ||
            Math.abs(captured.loopEnd - captured.duration) > FLOAT_EPS
        if (custom_markers) {
            lossy.push(
                "MIDI clip start/end markers and loop bounds (createMidiClip accepts only startTime and duration)",
            )
        }
    } else if (captured.warping && captured.warpMarkerCount > 2) {
        lossy.push("custom warp markers (the warp grid)")
    }
    return lossy
}

async function runMoveClipTool(deps: ServerDeps, params: MoveClipParams): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const { clip, track } = resolveArrangementClip(
            await selectNodes(parseQuery(params.select), adapter),
        )

        const old_start = clip.startTime
        const duration = clip.duration
        const new_start = params.startTime
        const target_end = new_start + duration

        const before_index = track.arrangementClips.findIndex((c) => c.handle === clip.handle)
        const clip_before = clipSummary(clip, before_index < 0 ? null : before_index)

        if (Math.abs(new_start - old_start) < FLOAT_EPS) {
            return textResult({ status: "noop", reason: "startTime unchanged", clip: clip_before })
        }

        // 退避状態をキャプチャ（削除前に実行）
        const captured = captureClip(clip, track)
        const lossy = lossyAttributes(captured)
        const others = track.arrangementClips.filter(
            (c) =>
                c.handle !== clip.handle &&
                c.startTime < target_end - FLOAT_EPS &&
                c.endTime > new_start + FLOAT_EPS,
        )

        if (others.length > 0 && params.overwrite !== true) {
            throw new BadRequestError(
                `target range [${new_start}, ${target_end}) overlaps ${others.length} other clip(s)`,
                {
                    hint: "Pass overwrite:true to clear the target range, or choose a free startTime.",
                },
            )
        }

        const plan = {
            clip: clip_before,
            target: { startTime: new_start, endTime: target_end },
            wouldDropAttributes: lossy,
            wouldClearClips: others.length,
        }

        if (params.preview === true) {
            return textResult({ status: "preview", ...plan })
        }
        if ((lossy.length > 0 || others.length > 0) && params.confirm !== true) {
            return textResult({
                status: "confirm_required",
                ...plan,
                hint: "Destructive or lossy move. Pass confirm:true to proceed.",
            })
        }

        const self_overlap = Math.abs(new_start - old_start) < duration - FLOAT_EPS

        let created: Clip<TargetApiVersion>
        if (!self_overlap) {
            // create-first: 失敗しても元クリップは無傷
            if (others.length > 0) {
                await track.clearClipsInRange(new_start, target_end)
            }
            created = await recreateClip(captured, { startTime: new_start })
            await track.deleteClip(clip)
        } else {
            // 自己重なり: 旧削除 → 新作成。失敗時は元位置へ復元（補償）
            await track.deleteClip(clip)
            if (others.length > 0) {
                await track.clearClipsInRange(new_start, target_end)
            }
            try {
                created = await recreateClip(captured, { startTime: new_start })
            } catch (createError) {
                await recreateClip(captured, { startTime: old_start })
                throw new BadRequestError(
                    `move failed during recreate; original clip restored at startTime ${old_start}`,
                    { hint: String(createError) },
                )
            }
        }

        const after_index = track.arrangementClips.findIndex((c) => c.handle === created.handle)
        return textResult({
            status: "ok",
            movedTo: { startTime: new_start, endTime: target_end },
            droppedAttributes: lossy,
            clearedClips: others.length,
            clip: clipSummary(created, after_index < 0 ? null : after_index),
        })
    } catch (error) {
        deps.log.error("move_clip failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** トリム後の長さ・内容窓・MIDI ノートを計算する。 */
function computeTrimPlan(
    captured: CapturedClip,
    params: TrimClipParams,
): {
    new_duration: number
    window_start: number
    window_end: number
    adjusted_notes: NoteDescription[] | undefined
    dropped_notes: number
    lossy: string[]
} {
    const window_start = params.startMarker ?? captured.startMarker
    const window_end =
        params.endMarker ??
        (params.duration !== undefined ? window_start + params.duration : captured.endMarker)
    const new_duration = params.duration ?? window_end - window_start

    if (new_duration <= FLOAT_EPS) {
        throw new BadRequestError(`resulting duration must be positive but was ${new_duration}`, {
            hint: "Provide a positive duration, or startMarker/endMarker that span a positive range.",
        })
    }

    const lossy = lossyAttributes(captured)
    let adjusted_notes: NoteDescription[] | undefined
    let dropped_notes = 0

    if (captured.kind === "midi") {
        // MIDI は marker を設定できないため、ノートを新しい窓へフィルタ／シフトして近似する。
        const window_changed =
            Math.abs(window_start - captured.startMarker) > FLOAT_EPS ||
            Math.abs(window_end - captured.endMarker) > FLOAT_EPS
        adjusted_notes = captured.notes
            .filter(
                (note) =>
                    note.startTime >= window_start - FLOAT_EPS &&
                    note.startTime < window_end - FLOAT_EPS,
            )
            .map((note) => {
                const start = note.startTime - window_start
                const max_duration = new_duration - start
                return {
                    ...note,
                    startTime: start,
                    duration: Math.min(note.duration, max_duration),
                }
            })
        dropped_notes = captured.notes.length - adjusted_notes.length
        if (
            window_changed &&
            (params.startMarker !== undefined || params.endMarker !== undefined)
        ) {
            lossy.push(
                "MIDI markers cannot be set; trim is approximated by shifting/filtering notes into the new window",
            )
        }
        if (dropped_notes > 0) {
            lossy.push(`${dropped_notes} note(s) outside the new window are dropped`)
        }
    }

    return { new_duration, window_start, window_end, adjusted_notes, dropped_notes, lossy }
}

async function runTrimClipTool(deps: ServerDeps, params: TrimClipParams): Promise<ToolResult> {
    try {
        if (
            params.duration === undefined &&
            params.startMarker === undefined &&
            params.endMarker === undefined
        ) {
            throw new BadRequestError(
                "trim_clip requires at least one of duration, startMarker, or endMarker",
                {
                    hint: "Pass the new duration, or the audio content window (startMarker/endMarker).",
                },
            )
        }

        const adapter = new LomGraphAdapter(deps.context)
        const { clip, track } = resolveArrangementClip(
            await selectNodes(parseQuery(params.select), adapter),
        )

        const old_start = clip.startTime
        const old_duration = clip.duration
        const before_index = track.arrangementClips.findIndex((c) => c.handle === clip.handle)
        const clip_before = clipSummary(clip, before_index < 0 ? null : before_index)

        // 退避状態をキャプチャ（削除前に実行）
        const captured = captureClip(clip, track)
        const plan = computeTrimPlan(captured, params)
        const new_end = old_start + plan.new_duration

        if (Math.abs(plan.new_duration - old_duration) < FLOAT_EPS && plan.dropped_notes === 0) {
            return textResult({ status: "noop", reason: "duration unchanged", clip: clip_before })
        }

        // トリムは startTime を維持するため、新旧クリップは必ず先頭で重なる（自己重なり）。
        const others = track.arrangementClips.filter(
            (c) =>
                c.handle !== clip.handle &&
                c.startTime < new_end - FLOAT_EPS &&
                c.endTime > old_start + FLOAT_EPS,
        )

        if (others.length > 0 && params.overwrite !== true) {
            throw new BadRequestError(
                `new range [${old_start}, ${new_end}) overlaps ${others.length} other clip(s)`,
                {
                    hint: "Pass overwrite:true to clear the overlapping range, or trim to a shorter duration.",
                },
            )
        }

        const preview_plan = {
            clip: clip_before,
            target: {
                startTime: old_start,
                endTime: new_end,
                duration: plan.new_duration,
                startMarker: captured.kind === "audio" ? plan.window_start : undefined,
                endMarker: captured.kind === "audio" ? plan.window_end : undefined,
            },
            droppedNotes: plan.dropped_notes,
            wouldDropAttributes: plan.lossy,
            wouldClearClips: others.length,
        }

        if (params.preview === true) {
            return textResult({ status: "preview", ...preview_plan })
        }
        if ((plan.lossy.length > 0 || others.length > 0) && params.confirm !== true) {
            return textResult({
                status: "confirm_required",
                ...preview_plan,
                hint: "Destructive or lossy trim. Pass confirm:true to proceed.",
            })
        }

        const overrides: RecreateOverrides = { startTime: old_start, duration: plan.new_duration }
        if (captured.kind === "audio") {
            overrides.startMarker = plan.window_start
            overrides.endMarker = plan.window_end
        } else if (plan.adjusted_notes !== undefined) {
            overrides.notes = plan.adjusted_notes
        }

        // 自己重なりのため delete-first。失敗時は退避状態から元クリップを復元（補償）。
        await track.deleteClip(clip)
        if (others.length > 0) {
            await track.clearClipsInRange(old_start, new_end)
        }
        let created: Clip<TargetApiVersion>
        try {
            created = await recreateClip(captured, overrides)
        } catch (createError) {
            await recreateClip(captured, { startTime: old_start })
            throw new BadRequestError(
                `trim failed during recreate; original clip restored at startTime ${old_start}`,
                { hint: String(createError) },
            )
        }

        const after_index = track.arrangementClips.findIndex((c) => c.handle === created.handle)
        return textResult({
            status: "ok",
            trimmedTo: {
                startTime: old_start,
                endTime: new_end,
                duration: plan.new_duration,
                startMarker: captured.kind === "audio" ? plan.window_start : undefined,
                endMarker: captured.kind === "audio" ? plan.window_end : undefined,
            },
            droppedNotes: plan.dropped_notes,
            droppedAttributes: plan.lossy,
            clearedClips: others.length,
            clip: clipSummary(created, after_index < 0 ? null : after_index),
        })
    } catch (error) {
        deps.log.error("trim_clip failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** アレンジメントクリップ作成/削除/移動/トリムとロケーター作成/削除ツールを登録する。 */
export function registerArrangementTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "create_arrangement_clip",
        {
            title: "アレンジメント Clip 作成",
            description:
                "select で選んだ 1 つの MidiTrack または AudioTrack にアレンジメント Clip を作成する。必須: select・startTime・duration（AudioTrack はさらに audioFilePath）。長さは length ではなく duration（beats）。例: {select:'MATCH (t:MidiTrack {name:\"Lead\"}) RETURN t', startTime:0, duration:4}。移動・トリムは SDK 非対応のため、削除＋再作成で扱う。",
            inputSchema: {
                select: z.string().min(1).describe(trackSelectDescription()),
                startTime: z.number().min(0).describe("配置位置。アレンジメント絶対拍（beats）"),
                duration: z
                    .number()
                    .positive()
                    .describe("クリップ長（beats）。length ではなく duration を使う"),
                name: z.string().min(1).optional().describe("作成後に設定するクリップ名"),
                audioFilePath: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("AudioTrack を選択した場合は必須のオーディオファイル絶対パス"),
                isWarped: z.boolean().optional().describe("AudioClip の warp を有効化する"),
                loopSettings: loop_settings_schema,
                preview: z.boolean().optional(),
            },
        },
        async ({
            select,
            startTime,
            duration,
            name,
            audioFilePath,
            isWarped,
            loopSettings,
            preview,
        }) =>
            runCreateArrangementClipTool(deps, {
                select,
                startTime,
                duration,
                name,
                audioFilePath,
                isWarped,
                loopSettings,
                preview,
            }),
    )

    server.registerTool(
        "delete_arrangement_clip",
        {
            title: "アレンジメント Clip 削除",
            description:
                "select で選んだ 1 つのアレンジメント Clip を削除する。Session Clip は対象外。移動・トリムは SDK 非対応のため、削除＋再作成で扱う。",
            inputSchema: {
                select: z.string().min(1).describe(clipSelectDescription()),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, preview }) => runDeleteArrangementClipTool(deps, { select, preview }),
    )

    server.registerTool(
        "move_clip",
        {
            title: "アレンジメント Clip 移動",
            description:
                "select で選んだ 1 つのアレンジメント Clip を startTime（beats）へ移動する。SDK に移動 API が無いため、状態退避→削除→再作成→再適用で実現する（失敗時は元位置へ復元）。再現不能属性（Audio のカスタム warp グリッド、MIDI のカスタム marker/loop）を持つ場合や移動先に他クリップがある場合は confirm 必須。他クリップと重なる場合は overwrite:true で範囲を空ける。Session Clip は対象外。",
            inputSchema: {
                select: z.string().min(1).describe(clipSelectDescription()),
                startTime: z.number().min(0),
                overwrite: z.boolean().optional(),
                confirm: z.boolean().optional(),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, startTime, overwrite, confirm, preview }) =>
            runMoveClipTool(deps, { select, startTime, overwrite, confirm, preview }),
    )

    server.registerTool(
        "trim_clip",
        {
            title: "アレンジメント Clip トリム",
            description:
                "select で選んだ 1 つのアレンジメント Clip の長さ／内容窓を変更する。SDK にトリム API が無いため、状態退避→削除→再作成→再適用で実現する（失敗時は元状態へ復元）。duration（拍）で長さを変更し、Audio は startMarker/endMarker（拍）で内容窓も変更できる。MIDI は marker を設定できないため、ノートを新窓へフィルタ／シフトして近似する（窓外のノートは削除）。startTime は維持する。再現不能属性（Audio のカスタム warp グリッド、MIDI のカスタム marker/loop・窓外ノート）を伴う場合や他クリップと重なる場合は confirm 必須。重なる場合は overwrite:true で範囲を空ける。Session Clip は対象外。duration / startMarker / endMarker のいずれか 1 つ以上が必須。",
            inputSchema: {
                select: z.string().min(1).describe(clipSelectDescription()),
                duration: z.number().positive().optional(),
                startMarker: z.number().min(0).optional(),
                endMarker: z.number().positive().optional(),
                overwrite: z.boolean().optional(),
                confirm: z.boolean().optional(),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, duration, startMarker, endMarker, overwrite, confirm, preview }) =>
            runTrimClipTool(deps, {
                select,
                duration,
                startMarker,
                endMarker,
                overwrite,
                confirm,
                preview,
            }),
    )

    server.registerTool(
        "create_cue_point",
        {
            title: "CuePoint 作成",
            description:
                "time（beats）指定でロケーター（CuePoint）を作成し、任意で name を設定する。",
            inputSchema: {
                time: z.number().min(0),
                name: z.string().min(1).optional(),
                preview: z.boolean().optional(),
            },
        },
        async ({ time, name, preview }) => runCreateCuePointTool(deps, { time, name, preview }),
    )

    server.registerTool(
        "delete_cue_point",
        {
            title: "CuePoint 削除",
            description: "select で選んだ 1 つの CuePoint を削除する。",
            inputSchema: {
                select: z.string().min(1).describe(cuePointSelectDescription()),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, preview }) => runDeleteCuePointTool(deps, { select, preview }),
    )
}
