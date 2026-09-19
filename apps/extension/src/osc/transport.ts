/**
 * Transport（再生・停止・シーク・録音モード・loop/punch）の型付き操作。
 * 設定系は送信後に読み戻して確認し、不一致は OSC_WRITE_UNCERTAIN とする。
 */

import { HybridError } from "@live-connector/error"
import type { OscClient } from "./client"
import { expectSongBoolean, expectSongNumber, OSC_SONG_ENDPOINTS } from "./protocol"
import { converge, convergeNumber } from "./verify"

/** Transport のスナップショット。observedAt で鮮度を示す。 */
export type TransportState = {
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
    observedAt: string
}

/** OSC 経由の Transport 操作。プレビューでは一切呼び出さない。 */
export class OscTransportAdapter {
    private readonly client: OscClient

    constructor(client: OscClient) {
        this.client = client
    }

    async readState(): Promise<TransportState> {
        const is_playing = expectSongBoolean(
            await this.client.request(OSC_SONG_ENDPOINTS.getIsPlaying),
        )
        const current_song_time = expectSongNumber(
            await this.client.request(OSC_SONG_ENDPOINTS.getCurrentSongTime),
        )
        const tempo = expectSongNumber(await this.client.request(OSC_SONG_ENDPOINTS.getTempo))
        const record_mode = expectSongBoolean(
            await this.client.request(OSC_SONG_ENDPOINTS.getRecordMode),
        )
        const loop = expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getLoop))
        const loop_start = expectSongNumber(
            await this.client.request(OSC_SONG_ENDPOINTS.getLoopStart),
        )
        const loop_length = expectSongNumber(
            await this.client.request(OSC_SONG_ENDPOINTS.getLoopLength),
        )
        const punch_in = expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getPunchIn))
        const punch_out = expectSongBoolean(
            await this.client.request(OSC_SONG_ENDPOINTS.getPunchOut),
        )
        const back_to_arranger = expectSongBoolean(
            await this.client.request(OSC_SONG_ENDPOINTS.getBackToArranger),
        )
        return {
            isPlaying: is_playing,
            currentSongTime: current_song_time,
            tempo,
            recordMode: record_mode,
            loop,
            loopStart: loop_start,
            loopLength: loop_length,
            punchIn: punch_in,
            punchOut: punch_out,
            backToArranger: back_to_arranger,
            observedAt: new Date().toISOString(),
        }
    }

    async readCurrentSongTime(): Promise<number> {
        return expectSongNumber(await this.client.request(OSC_SONG_ENDPOINTS.getCurrentSongTime))
    }

    async readTempo(): Promise<number> {
        return expectSongNumber(await this.client.request(OSC_SONG_ENDPOINTS.getTempo))
    }

    /** AbletonOSC が応答するかを 1 回だけ確認する（再送なし）。 */
    async ping(): Promise<number> {
        return expectSongNumber(
            await this.client.request(OSC_SONG_ENDPOINTS.getTempo, [], { retries: 0 }),
        )
    }

    async readIsPlaying(): Promise<boolean> {
        return expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getIsPlaying))
    }

    /** 再生開始。応答がないため送信のみ。呼び出し側が isPlaying を確認する。 */
    play(): void {
        this.client.send(OSC_SONG_ENDPOINTS.startPlaying)
    }

    /** 停止。応答がないため送信のみ。 */
    stop(): void {
        this.client.send(OSC_SONG_ENDPOINTS.stopPlaying)
    }

    /** 再生位置を拍で設定し、読み戻して収束を確認する。 */
    async seek(beats: number): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setCurrentSongTime, [beats])
        await convergeNumber(() => this.readCurrentSongTime(), beats, "current_song_time")
    }

    async setRecordMode(enabled: boolean): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setRecordMode, [enabled ? 1 : 0])
        await converge(
            () => this.readRecordMode(),
            (value) => value === enabled,
            "record_mode",
        )
    }

    async readRecordMode(): Promise<boolean> {
        return expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getRecordMode))
    }

    async setLoop(enabled: boolean): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setLoop, [enabled ? 1 : 0])
        await converge(
            () => this.readLoop(),
            (value) => value === enabled,
            "loop",
        )
    }

    async readLoop(): Promise<boolean> {
        return expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getLoop))
    }

    async setLoopStart(beats: number): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setLoopStart, [beats])
        await convergeNumber(
            async () =>
                expectSongNumber(await this.client.request(OSC_SONG_ENDPOINTS.getLoopStart)),
            beats,
            "loop_start",
        )
    }

    async setLoopLength(beats: number): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setLoopLength, [beats])
        await convergeNumber(
            async () =>
                expectSongNumber(await this.client.request(OSC_SONG_ENDPOINTS.getLoopLength)),
            beats,
            "loop_length",
        )
    }

    async setPunchIn(enabled: boolean): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setPunchIn, [enabled ? 1 : 0])
        await converge(
            async () => expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getPunchIn)),
            (value) => value === enabled,
            "punch_in",
        )
    }

    async setPunchOut(enabled: boolean): Promise<void> {
        this.client.send(OSC_SONG_ENDPOINTS.setPunchOut, [enabled ? 1 : 0])
        await converge(
            async () =>
                expectSongBoolean(await this.client.request(OSC_SONG_ENDPOINTS.getPunchOut)),
            (value) => value === enabled,
            "punch_out",
        )
    }

    /** 再生中になるまでポーリングする。タイムアウト時は OSC_WRITE_UNCERTAIN。 */
    async waitForPlaying(timeout_ms: number): Promise<void> {
        await this.waitFor(() => this.readIsPlaying(), timeout_ms, "playing")
    }

    /** 停止するまでポーリングする。 */
    async waitForStopped(timeout_ms: number): Promise<void> {
        await this.waitFor(async () => !(await this.readIsPlaying()), timeout_ms, "stopped")
    }

    private async waitFor(
        predicate: () => Promise<boolean>,
        timeout_ms: number,
        label: string,
    ): Promise<void> {
        const deadline = Date.now() + timeout_ms
        for (;;) {
            if (await predicate()) {
                return
            }
            if (Date.now() >= deadline) {
                throw new HybridError(
                    "OSC_WRITE_UNCERTAIN",
                    `Transport did not reach ${label} state within ${timeout_ms} ms`,
                )
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
}
