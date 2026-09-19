/**
 * AbletonOSC の型付き endpoint 定義と応答の解釈。
 * 一次ソース: AbletonOSC `abletonosc/song.py` / `abletonosc/track.py`。
 *
 * 注意: track 系 getter の応答は先頭に track_index が付く（例: [index, value]）。
 * song 系 getter は値のみを返す。track index は `song.tracks`（通常トラック、返りトラックを除く）
 * の 0 始まり index に対応する。
 */

import { BadRequestError } from "@live-connector/error"
import type { OscArg, OscMessage } from "../types/hybrid"

/** 録音先入力として選択する Resampling 候補名（英語表示）。 */
export const RESAMPLING_INPUT_NAME = "Resampling"

/**
 * LOM `current_monitoring_state` の Off 値。
 * 列挙値は Python API 側の表現であり、実機確認のうえ adapter 内に閉じ込める。
 */
export const MONITOR_STATE_OFF = 2

/** Song レベルの OSC endpoint。 */
export const OSC_SONG_ENDPOINTS = {
    startPlaying: "/live/song/start_playing",
    stopPlaying: "/live/song/stop_playing",
    getIsPlaying: "/live/song/get/is_playing",
    getCurrentSongTime: "/live/song/get/current_song_time",
    setCurrentSongTime: "/live/song/set/current_song_time",
    getTempo: "/live/song/get/tempo",
    getRecordMode: "/live/song/get/record_mode",
    setRecordMode: "/live/song/set/record_mode",
    getLoop: "/live/song/get/loop",
    setLoop: "/live/song/set/loop",
    getLoopStart: "/live/song/get/loop_start",
    setLoopStart: "/live/song/set/loop_start",
    getLoopLength: "/live/song/get/loop_length",
    setLoopLength: "/live/song/set/loop_length",
    getPunchIn: "/live/song/get/punch_in",
    setPunchIn: "/live/song/set/punch_in",
    getPunchOut: "/live/song/get/punch_out",
    setPunchOut: "/live/song/set/punch_out",
    getTrackNames: "/live/song/get/track_names",
    getNumTracks: "/live/song/get/num_tracks",
    getBackToArranger: "/live/song/get/back_to_arranger",
    setBackToArranger: "/live/song/set/back_to_arranger",
} as const

/** トラック単位の OSC endpoint。先頭引数にトラック index を取る。 */
export const OSC_TRACK_ENDPOINTS = {
    getName: "/live/track/get/name",
    getArm: "/live/track/get/arm",
    setArm: "/live/track/set/arm",
    getPlayingSlotIndex: "/live/track/get/playing_slot_index",
    getMonitoringState: "/live/track/get/current_monitoring_state",
    setMonitoringState: "/live/track/set/current_monitoring_state",
    getAvailableInputRoutingTypes: "/live/track/get/available_input_routing_types",
    getInputRoutingType: "/live/track/get/input_routing_type",
    setInputRoutingType: "/live/track/set/input_routing_type",
    getAvailableOutputRoutingTypes: "/live/track/get/available_output_routing_types",
    getOutputRoutingType: "/live/track/get/output_routing_type",
    setOutputRoutingType: "/live/track/set/output_routing_type",
    getSend: "/live/track/get/send",
    setSend: "/live/track/set/send",
} as const

function describe(message: OscMessage): string {
    return `OSC reply "${message.address}"`
}

function toNumber(value: OscArg | undefined, message: OscMessage): number {
    if (typeof value === "number") {
        return value
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0
    }
    throw new BadRequestError(`${describe(message)} did not contain a numeric value`)
}

function toBoolean(value: OscArg | undefined, message: OscMessage): boolean {
    if (typeof value === "boolean") {
        return value
    }
    if (typeof value === "number") {
        return value !== 0
    }
    throw new BadRequestError(`${describe(message)} did not contain a boolean value`)
}

function toStringArgs(values: OscArg[]): string[] {
    return values.map((value) => (typeof value === "string" ? value : String(value)))
}

/** Song レベルの応答先頭値を数値として取り出す。 */
export function expectSongNumber(message: OscMessage): number {
    return toNumber(message.args[0], message)
}

/** Song レベルの応答先頭値を真偽値として取り出す。 */
export function expectSongBoolean(message: OscMessage): boolean {
    return toBoolean(message.args[0], message)
}

/** トラック応答（[index, value]）から値だけを数値として取り出す。 */
export function expectTrackNumber(message: OscMessage): number {
    return toNumber(message.args[1], message)
}

/** トラック応答（[index, value]）から値だけを真偽値として取り出す。 */
export function expectTrackBoolean(message: OscMessage): boolean {
    return toBoolean(message.args[1], message)
}

/** トラック応答（[index, value]）から値だけを文字列として取り出す。 */
export function expectTrackString(message: OscMessage): string {
    const value = message.args[1]
    if (typeof value !== "string") {
        throw new BadRequestError(`${describe(message)} did not contain a string value`)
    }
    return value
}

/** トラック応答から index を除いた文字列引数リストを取り出す（routing 候補など）。 */
export function expectTrackStringList(message: OscMessage): string[] {
    return toStringArgs(message.args.slice(1))
}

/** `/live/song/get/track_names` の応答（名前のみ）を取り出す。 */
export function expectSongStringList(message: OscMessage): string[] {
    return toStringArgs(message.args)
}

/** `/live/track/get/send` の応答（[index, sendId, value]）から値を取り出す。 */
export function expectSendNumber(message: OscMessage): number {
    return toNumber(message.args[2], message)
}

/** 候補名一覧から Resampling を解決する。見つからない場合は null。 */
export function findResamplingCandidate(candidates: string[]): string | null {
    for (const candidate of candidates) {
        if (
            candidate === RESAMPLING_INPUT_NAME ||
            candidate.endsWith(` ${RESAMPLING_INPUT_NAME}`)
        ) {
            return candidate
        }
    }
    return null
}
