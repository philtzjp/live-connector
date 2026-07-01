import {
    AudioTrack,
    type ExtensionContext,
    MidiTrack,
    type Song,
    type Track,
} from "@ableton-extensions/sdk"
import type { TargetApiVersion } from "../deps"

type V = TargetApiVersion

export type TrackFeature = {
    name: string
    kind: string
    arrangementClipCount: number
    sessionClipCount: number
    deviceCount: number
}

/**
 * 構造フィンガープリントの素。トラック構成・クリップ数・デバイス数・シーン/キュー数から成る。
 * tempo など可変プロパティは含めない（構造変更の検知に絞る）。
 */
export type SetFeatures = {
    trackCount: number
    sceneCount: number
    cuePointCount: number
    tracks: TrackFeature[]
}

export type SetIdentity = {
    storageDirectory: string | null
    songHandle: unknown
    sdkNote: string
}

const SDK_IDENTITY_NOTE =
    "Ableton Extensions SDK v1.0.0-beta.0 does not expose the Live Set name or file path. songHandle changes when the extension host reconnects to a different Set; structureDigest changes when the track/clip/device structure changes."

function trackKind(track: Track<V>): string {
    if (track instanceof MidiTrack) {
        return "midi"
    }
    if (track instanceof AudioTrack) {
        return "audio"
    }
    return "other"
}

/** SDK の Song から構造フィンガープリントの素を収集する。 */
export function collectSetFeatures(song: Song<V>): SetFeatures {
    const tracks = song.tracks.map((track) => ({
        name: track.name,
        kind: trackKind(track),
        arrangementClipCount: track.arrangementClips.length,
        sessionClipCount: track.clipSlots.filter((slot) => slot.clip !== null).length,
        deviceCount: track.devices.length,
    }))
    return {
        trackCount: song.tracks.length,
        sceneCount: song.scenes.length,
        cuePointCount: song.cuePoints.length,
        tracks,
    }
}

/** 構造特徴から安定した短いダイジェスト（djb2, 8 桁 hex）を導出する。 */
export function structureDigest(features: SetFeatures): string {
    const parts = [
        `t:${features.trackCount}`,
        `s:${features.sceneCount}`,
        `c:${features.cuePointCount}`,
        ...features.tracks.map(
            (track, index) =>
                `${index}=${track.kind}:${track.name}:a${track.arrangementClipCount}:s${track.sessionClipCount}:d${track.deviceCount}`,
        ),
    ]
    const joined = parts.join("|")
    let hash = 5381
    for (let index = 0; index < joined.length; index++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}

/** SDK から取得可能な接続先 Set の識別情報。 */
export function setIdentity(context: ExtensionContext<V>): SetIdentity {
    const storage = context.environment.storageDirectory
    return {
        storageDirectory: storage === undefined || storage.length === 0 ? null : storage,
        songHandle: context.application.song.handle,
        sdkNote: SDK_IDENTITY_NOTE,
    }
}
