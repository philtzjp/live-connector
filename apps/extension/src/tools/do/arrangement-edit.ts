import {
    AudioTrack,
    Clip,
    type ClipLoopSettings,
    type MidiClip,
    MidiTrack,
    type NoteDescription,
    Track,
} from "@ableton-extensions/sdk"
import { BadRequestError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../../deps"
import type { LomNode } from "../../lom/adapter"
import { buildArrangementClipBlueprint, warpModeFromBlueprint } from "../../undo/blueprint"
import type { ArrangementAudioClipBlueprint, ArrangementMidiClipBlueprint } from "../../undo/types"
import type { UndoableLevel } from "../common"

type V = TargetApiVersion
const FLOAT_EPS = 1e-6

type RecreateOverrides = {
    startTime?: number
    duration?: number
    startMarker?: number
    endMarker?: number
    loopStart?: number
    loopEnd?: number
    notes?: NoteDescription[]
}

export type ArrangementClipBlueprint = ArrangementMidiClipBlueprint | ArrangementAudioClipBlueprint

export function captureArrangementClipBlueprint(
    clip: Clip<V>,
    track: Track<V>,
): ArrangementClipBlueprint {
    return buildArrangementClipBlueprint(clip, track)
}

export function lossyAttributes(blueprint: ArrangementClipBlueprint): string[] {
    const lossy: string[] = []
    if (blueprint.kind === "arrangement_midi_clip") {
        const custom_markers =
            Math.abs(blueprint.startMarker) > FLOAT_EPS ||
            Math.abs(blueprint.endMarker - blueprint.duration) > FLOAT_EPS ||
            Math.abs(blueprint.loopStart) > FLOAT_EPS ||
            Math.abs(blueprint.loopEnd - blueprint.duration) > FLOAT_EPS
        if (custom_markers) {
            lossy.push("MIDI clip custom markers/loop bounds")
        }
    } else if (blueprint.warping && blueprint.warpMarkerCount > 2) {
        lossy.push("custom warp markers")
    }
    return lossy
}

async function recreateFromBlueprint(
    deps: ServerDeps,
    blueprint: ArrangementClipBlueprint,
    overrides: RecreateOverrides,
): Promise<Clip<V>> {
    const track = await findTrackForBlueprint(deps, blueprint.trackIdentity)
    const start = overrides.startTime ?? blueprint.startTime
    const duration = overrides.duration ?? blueprint.duration

    if (blueprint.kind === "arrangement_midi_clip") {
        if (!(track instanceof MidiTrack)) {
            throw new BadRequestError("arrangement MidiClip requires MidiTrack")
        }
        // withinTransaction のコールバックは同期でなければならない。生成の完了を待つ時点で
        // トランザクションは閉じているため、属性の書き戻しは別トランザクションへまとめる。
        const created = await deps.context.withinTransaction(() =>
            track.createMidiClip(start, duration),
        )
        deps.context.withinTransaction(() => {
            created.notes = (overrides.notes ?? blueprint.notes) as MidiClip<V>["notes"]
            created.name = blueprint.name
            created.color = blueprint.color
            created.muted = blueprint.muted
            created.looping = blueprint.looping
        })
        return created
    }

    if (!(track instanceof AudioTrack)) {
        throw new BadRequestError("arrangement AudioClip requires AudioTrack")
    }
    const loop_settings: ClipLoopSettings = {
        looping: blueprint.looping,
        startMarker: overrides.startMarker ?? blueprint.startMarker,
        endMarker: overrides.endMarker ?? blueprint.endMarker,
        loopStart: overrides.loopStart ?? blueprint.loopStart,
        loopEnd: overrides.loopEnd ?? blueprint.loopEnd,
    }
    const created = await deps.context.withinTransaction(() =>
        track.createAudioClip({
            filePath: blueprint.filePath,
            startTime: start,
            duration,
            isWarped: blueprint.warping,
            loopSettings: loop_settings,
        }),
    )
    deps.context.withinTransaction(() => {
        created.warpMode = warpModeFromBlueprint(blueprint.warpMode)
        created.name = blueprint.name
        created.color = blueprint.color
        created.muted = blueprint.muted
    })
    return created
}

async function findTrackForBlueprint(deps: ServerDeps, track_identity: string): Promise<Track<V>> {
    const song = deps.context.application.song
    for (const track of song.tracks) {
        if (String(track.handle.id) === track_identity) {
            return track
        }
    }
    throw new BadRequestError(`track identity ${track_identity} not found`)
}

function resolveArrangement(clip_node: LomNode): { clip: Clip<V>; track: Track<V> } {
    if (clip_node.type !== "object" || !(clip_node.value instanceof Clip)) {
        throw new BadRequestError("arrangement property writes require a Clip node")
    }
    const clip = clip_node.value
    const parent = clip.parent
    if (!(parent instanceof Track)) {
        throw new BadRequestError("only arrangement clips support startTime/duration/marker writes")
    }
    if (!parent.arrangementClips.some((candidate) => candidate.handle === clip.handle)) {
        throw new BadRequestError("session clips do not support arrangement placement properties")
    }
    return { clip, track: parent }
}

export function assessArrangementUndoable(clip_node: LomNode): {
    undoable: UndoableLevel
    reason?: string
} {
    const { clip, track } = resolveArrangement(clip_node)
    const blueprint = captureArrangementClipBlueprint(clip, track)
    const lossy = lossyAttributes(blueprint)
    if (lossy.length > 0) {
        return { undoable: "partial", reason: lossy.join("; ") }
    }
    return { undoable: "full" }
}

export async function applyArrangementPropertySet(
    deps: ServerDeps,
    clip_node: LomNode,
    property: string,
    value: number,
): Promise<Clip<V>> {
    const { clip, track } = resolveArrangement(clip_node)
    const blueprint = captureArrangementClipBlueprint(clip, track)
    const old_start = clip.startTime

    if (property === "startTime") {
        const new_start = value
        const duration = clip.duration
        const target_end = new_start + duration
        const others = track.arrangementClips.filter(
            (candidate) =>
                candidate.handle !== clip.handle &&
                candidate.startTime < target_end - FLOAT_EPS &&
                candidate.endTime > new_start + FLOAT_EPS,
        )
        if (others.length > 0) {
            await track.clearClipsInRange(new_start, target_end)
        }
        const self_overlap = Math.abs(new_start - old_start) < duration - FLOAT_EPS
        if (!self_overlap) {
            const created = await recreateFromBlueprint(deps, blueprint, { startTime: new_start })
            await track.deleteClip(clip)
            return created
        }
        await track.deleteClip(clip)
        return recreateFromBlueprint(deps, blueprint, { startTime: new_start })
    }

    const overrides: RecreateOverrides = { startTime: old_start }
    if (property === "duration") {
        overrides.duration = value
    } else if (property === "startMarker") {
        overrides.startMarker = value
        overrides.endMarker = blueprint.endMarker
        overrides.duration = blueprint.endMarker - value
    } else if (property === "endMarker") {
        overrides.endMarker = value
        overrides.duration = value - blueprint.startMarker
    } else {
        throw new BadRequestError(`unsupported arrangement property ${property}`)
    }

    if (blueprint.kind === "arrangement_midi_clip" && overrides.duration !== undefined) {
        const window_start = overrides.startMarker ?? blueprint.startMarker
        const window_end = overrides.endMarker ?? blueprint.endMarker
        overrides.notes = blueprint.notes
            .filter(
                (note) =>
                    note.startTime >= window_start - FLOAT_EPS &&
                    note.startTime < window_end - FLOAT_EPS,
            )
            .map((note) => ({
                ...note,
                startTime: note.startTime - window_start,
                duration: Math.min(
                    note.duration,
                    (overrides.duration ?? blueprint.duration) - (note.startTime - window_start),
                ),
            }))
    }

    const others = track.arrangementClips.filter(
        (candidate) =>
            candidate.handle !== clip.handle &&
            candidate.startTime <
                old_start + (overrides.duration ?? blueprint.duration) - FLOAT_EPS &&
            candidate.endTime > old_start + FLOAT_EPS,
    )
    if (others.length > 0) {
        await track.clearClipsInRange(
            old_start,
            old_start + (overrides.duration ?? blueprint.duration),
        )
    }
    await track.deleteClip(clip)
    return recreateFromBlueprint(deps, blueprint, overrides)
}
