/**
 * テスト用の AbletonOSC シミュレータ。node:dgram を使わず、OSC メッセージを
 * デコードしてスクリプト化された状態から応答を返す。
 * Transport の現在位置は再生中に読み取りごと `beatStepPerRead` だけ進む。
 */

import type { Logger } from "@live-connector/log"
import type { OscDatagramTransport } from "../osc/client"
import { decodeOscMessage, encodeOscMessage } from "../osc/codec"
import { MONITOR_STATE_OFF, OSC_SONG_ENDPOINTS, OSC_TRACK_ENDPOINTS } from "../osc/protocol"
import type { OscMessage, OscSettings } from "../types/hybrid"

/** シミュレータの状態。テストから直接書き換えて応答を変える。 */
export type FakeOscState = {
    isPlaying: boolean
    currentSongTime: number
    tempo: number
    recordMode: boolean
    loop: boolean
    loopStart: number
    loopLength: number
    punchIn: boolean
    punchOut: boolean
    backToArranger: boolean
    trackNames: string[]
    arm: Map<number, boolean>
    monitoring: Map<number, number>
    playingSlot: Map<number, number>
    inputRouting: Map<number, string>
    outputRouting: Map<number, string>
    availableInputRouting: string[]
    availableOutputRouting: string[]
    sends: Map<string, number>
    /** 再生中に current_song_time を読むたびに進める拍数。 */
    beatStepPerRead: number
    /** bind 時に投げるエラー（ポート競合テスト用）。 */
    bindError: Error | null
    /** 応答を返さない address（タイムアウトテスト用）。 */
    dropAddresses: Set<string>
    /** stop_playing 受信時に呼ぶフック（SDK 側へ録音 clip を反映するテスト用）。 */
    onStop: (() => void) | null
    /** 設定時は trackNames の代わりにこの関数で名前一覧を供給する。 */
    trackNamesSource: (() => string[]) | null
}

export function makeFakeOscState(partial: Partial<FakeOscState> = {}): FakeOscState {
    return {
        isPlaying: false,
        currentSongTime: 0,
        tempo: 120,
        recordMode: false,
        loop: false,
        loopStart: 0,
        loopLength: 4,
        punchIn: false,
        punchOut: false,
        backToArranger: true,
        trackNames: [],
        arm: new Map(),
        monitoring: new Map(),
        playingSlot: new Map(),
        inputRouting: new Map(),
        outputRouting: new Map(),
        availableInputRouting: ["Resampling", "Ext. In"],
        availableOutputRouting: ["Sends Only", "Master", "Ext. Out"],
        sends: new Map(),
        beatStepPerRead: 8,
        bindError: null,
        dropAddresses: new Set(),
        onStop: null,
        trackNamesSource: null,
        ...partial,
    }
}

function bool(value: boolean | undefined): number {
    return value === true ? 1 : 0
}

export function buildFakeOscTransport(
    _settings: OscSettings,
    _log: Logger,
    state: FakeOscState,
): OscDatagramTransport {
    let listener: ((payload: Buffer) => void) | null = null

    const trackNames = (): string[] => state.trackNamesSource?.() ?? state.trackNames

    const reply = (message: OscMessage): void => {
        if (state.dropAddresses.has(message.address)) {
            return
        }
        queueMicrotask(() => listener?.(encodeOscMessage(message)))
    }

    const onSend = (payload: Buffer): void => {
        let message: OscMessage
        try {
            message = decodeOscMessage(payload)
        } catch {
            return
        }
        const index = typeof message.args[0] === "number" ? message.args[0] : -1

        switch (message.address) {
            case OSC_SONG_ENDPOINTS.startPlaying:
                state.isPlaying = true
                return
            case OSC_SONG_ENDPOINTS.stopPlaying:
                state.isPlaying = false
                state.onStop?.()
                return
            case OSC_SONG_ENDPOINTS.getIsPlaying:
                reply({ address: message.address, args: [bool(state.isPlaying)] })
                return
            case OSC_SONG_ENDPOINTS.getCurrentSongTime:
                if (state.isPlaying) {
                    state.currentSongTime += state.beatStepPerRead
                }
                reply({ address: message.address, args: [state.currentSongTime] })
                return
            case OSC_SONG_ENDPOINTS.setCurrentSongTime:
                state.currentSongTime = Number(message.args[0] ?? 0)
                return
            case OSC_SONG_ENDPOINTS.getTempo:
                reply({ address: message.address, args: [state.tempo] })
                return
            case OSC_SONG_ENDPOINTS.getRecordMode:
                reply({ address: message.address, args: [bool(state.recordMode)] })
                return
            case OSC_SONG_ENDPOINTS.setRecordMode:
                state.recordMode = Number(message.args[0] ?? 0) !== 0
                return
            case OSC_SONG_ENDPOINTS.getLoop:
                reply({ address: message.address, args: [bool(state.loop)] })
                return
            case OSC_SONG_ENDPOINTS.setLoop:
                state.loop = Number(message.args[0] ?? 0) !== 0
                return
            case OSC_SONG_ENDPOINTS.getLoopStart:
                reply({ address: message.address, args: [state.loopStart] })
                return
            case OSC_SONG_ENDPOINTS.setLoopStart:
                state.loopStart = Number(message.args[0] ?? 0)
                return
            case OSC_SONG_ENDPOINTS.getLoopLength:
                reply({ address: message.address, args: [state.loopLength] })
                return
            case OSC_SONG_ENDPOINTS.setLoopLength:
                state.loopLength = Number(message.args[0] ?? 0)
                return
            case OSC_SONG_ENDPOINTS.getPunchIn:
                reply({ address: message.address, args: [bool(state.punchIn)] })
                return
            case OSC_SONG_ENDPOINTS.setPunchIn:
                state.punchIn = Number(message.args[0] ?? 0) !== 0
                return
            case OSC_SONG_ENDPOINTS.getPunchOut:
                reply({ address: message.address, args: [bool(state.punchOut)] })
                return
            case OSC_SONG_ENDPOINTS.setPunchOut:
                state.punchOut = Number(message.args[0] ?? 0) !== 0
                return
            case OSC_SONG_ENDPOINTS.getBackToArranger:
                reply({ address: message.address, args: [bool(state.backToArranger)] })
                return
            case OSC_SONG_ENDPOINTS.getTrackNames:
                reply({ address: message.address, args: [...trackNames()] })
                return
            case OSC_SONG_ENDPOINTS.getNumTracks:
                reply({ address: message.address, args: [trackNames().length] })
                return
            case OSC_TRACK_ENDPOINTS.getName:
                reply({ address: message.address, args: [index, trackNames()[index] ?? ""] })
                return
            case OSC_TRACK_ENDPOINTS.getArm:
                reply({ address: message.address, args: [index, bool(state.arm.get(index))] })
                return
            case OSC_TRACK_ENDPOINTS.getPlayingSlotIndex:
                reply({
                    address: message.address,
                    args: [index, state.playingSlot.get(index) ?? -1],
                })
                return
            case OSC_TRACK_ENDPOINTS.setArm:
                state.arm.set(index, Number(message.args[1] ?? 0) !== 0)
                return
            case OSC_TRACK_ENDPOINTS.getMonitoringState:
                reply({
                    address: message.address,
                    args: [index, state.monitoring.get(index) ?? MONITOR_STATE_OFF],
                })
                return
            case OSC_TRACK_ENDPOINTS.setMonitoringState:
                state.monitoring.set(index, Number(message.args[1] ?? 0))
                return
            case OSC_TRACK_ENDPOINTS.getAvailableInputRoutingTypes:
                reply({ address: message.address, args: [index, ...state.availableInputRouting] })
                return
            case OSC_TRACK_ENDPOINTS.getInputRoutingType:
                reply({
                    address: message.address,
                    args: [index, state.inputRouting.get(index) ?? ""],
                })
                return
            case OSC_TRACK_ENDPOINTS.setInputRoutingType: {
                const name = String(message.args[1] ?? "")
                if (state.availableInputRouting.includes(name)) {
                    state.inputRouting.set(index, name)
                }
                return
            }
            case OSC_TRACK_ENDPOINTS.getAvailableOutputRoutingTypes:
                reply({ address: message.address, args: [index, ...state.availableOutputRouting] })
                return
            case OSC_TRACK_ENDPOINTS.getOutputRoutingType:
                reply({
                    address: message.address,
                    args: [index, state.outputRouting.get(index) ?? ""],
                })
                return
            case OSC_TRACK_ENDPOINTS.setOutputRoutingType: {
                const name = String(message.args[1] ?? "")
                if (state.availableOutputRouting.includes(name)) {
                    state.outputRouting.set(index, name)
                }
                return
            }
            case OSC_TRACK_ENDPOINTS.getSend: {
                const send_id = Number(message.args[1] ?? 0)
                reply({
                    address: message.address,
                    args: [index, send_id, state.sends.get(`${index}:${send_id}`) ?? 0],
                })
                return
            }
            case OSC_TRACK_ENDPOINTS.setSend: {
                const send_id = Number(message.args[1] ?? 0)
                state.sends.set(`${index}:${send_id}`, Number(message.args[2] ?? 0))
                return
            }
            default:
                return
        }
    }

    return {
        bind() {
            if (state.bindError !== null) {
                return Promise.reject(state.bindError)
            }
            return Promise.resolve()
        },
        send(payload) {
            onSend(payload)
        },
        onMessage(next) {
            listener = next
        },
        close() {
            listener = null
            return Promise.resolve()
        },
    }
}
