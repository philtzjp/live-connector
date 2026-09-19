/**
 * トラックの routing / monitoring / arm / send を OSC で操作する adapter。
 * 設定系は送信後に読み戻して確認する（AbletonOSC の routing setter は候補が見つからない場合
 * 例外ではなくログのみになるため、送信成功を設定成功と見なさない）。
 */

import { HybridError, NotFoundError } from "@live-connector/error"
import type { OscClient } from "./client"
import {
    expectSendNumber,
    expectTrackBoolean,
    expectTrackNumber,
    expectTrackString,
    expectTrackStringList,
    OSC_SONG_ENDPOINTS,
    OSC_TRACK_ENDPOINTS,
} from "./protocol"
import { converge, convergeNumber } from "./verify"

/** OSC 経由のトラック操作。 */
export class OscRoutingAdapter {
    private readonly client: OscClient

    constructor(client: OscClient) {
        this.client = client
    }

    /** 通常トラックの名前一覧を取得する（返りトラックは含まれない）。 */
    async listTrackNames(): Promise<string[]> {
        const message = await this.client.request(OSC_SONG_ENDPOINTS.getTrackNames)
        return message.args.map((arg) => (typeof arg === "string" ? arg : String(arg)))
    }

    /** 一意名がちょうど 1 件だけ存在する場合にその index を返す。 */
    async findTrackIndexByUniqueName(unique_name: string): Promise<number> {
        const names = await this.listTrackNames()
        const matches: number[] = []
        for (const [index, name] of names.entries()) {
            if (name === unique_name) {
                matches.push(index)
            }
        }
        if (matches.length === 0) {
            throw new NotFoundError(
                `No track named "${unique_name}" exists in the Live Set visible to AbletonOSC`,
            )
        }
        if (matches.length > 1) {
            throw new HybridError(
                "SET_IDENTITY_MISMATCH",
                `Track name "${unique_name}" is not unique (${matches.length} matches)`,
            )
        }
        const index = matches[0]
        if (index === undefined) {
            throw new NotFoundError(`Track "${unique_name}" index could not be resolved`)
        }
        return index
    }

    async getTrackName(index: number): Promise<string> {
        return expectTrackString(await this.client.request(OSC_TRACK_ENDPOINTS.getName, [index]))
    }

    async getAvailableInputRoutingTypes(index: number): Promise<string[]> {
        return expectTrackStringList(
            await this.client.request(OSC_TRACK_ENDPOINTS.getAvailableInputRoutingTypes, [index]),
        )
    }

    async getInputRoutingType(index: number): Promise<string> {
        return expectTrackString(
            await this.client.request(OSC_TRACK_ENDPOINTS.getInputRoutingType, [index]),
        )
    }

    async setInputRoutingType(index: number, display_name: string): Promise<void> {
        this.client.send(OSC_TRACK_ENDPOINTS.setInputRoutingType, [index, display_name])
        await converge(
            () => this.getInputRoutingType(index),
            (value) => value === display_name,
            "input_routing_type",
        )
    }

    async getAvailableOutputRoutingTypes(index: number): Promise<string[]> {
        return expectTrackStringList(
            await this.client.request(OSC_TRACK_ENDPOINTS.getAvailableOutputRoutingTypes, [index]),
        )
    }

    async getOutputRoutingType(index: number): Promise<string> {
        return expectTrackString(
            await this.client.request(OSC_TRACK_ENDPOINTS.getOutputRoutingType, [index]),
        )
    }

    async setOutputRoutingType(index: number, display_name: string): Promise<void> {
        this.client.send(OSC_TRACK_ENDPOINTS.setOutputRoutingType, [index, display_name])
        await converge(
            () => this.getOutputRoutingType(index),
            (value) => value === display_name,
            "output_routing_type",
        )
    }

    async getMonitoringState(index: number): Promise<number> {
        return expectTrackNumber(
            await this.client.request(OSC_TRACK_ENDPOINTS.getMonitoringState, [index]),
        )
    }

    async setMonitoringState(index: number, state: number): Promise<void> {
        this.client.send(OSC_TRACK_ENDPOINTS.setMonitoringState, [index, state])
        await converge(
            () => this.getMonitoringState(index),
            (value) => value === state,
            "current_monitoring_state",
        )
    }

    async getArm(index: number): Promise<boolean> {
        return expectTrackBoolean(await this.client.request(OSC_TRACK_ENDPOINTS.getArm, [index]))
    }

    /** 再生中の Session clip slot index。再生していなければ -1。 */
    async getPlayingSlotIndex(index: number): Promise<number> {
        return expectTrackNumber(
            await this.client.request(OSC_TRACK_ENDPOINTS.getPlayingSlotIndex, [index]),
        )
    }

    async setArm(index: number, value: boolean): Promise<void> {
        this.client.send(OSC_TRACK_ENDPOINTS.setArm, [index, value ? 1 : 0])
        await converge(
            () => this.getArm(index),
            (observed) => observed === value,
            "arm",
        )
    }

    async getSend(index: number, send_id: number): Promise<number> {
        return expectSendNumber(
            await this.client.request(OSC_TRACK_ENDPOINTS.getSend, [index, send_id]),
        )
    }

    async setSend(index: number, send_id: number, value: number): Promise<void> {
        this.client.send(OSC_TRACK_ENDPOINTS.setSend, [index, send_id, value])
        await convergeNumber(() => this.getSend(index, send_id), value, `send ${send_id}`, 0.0001)
    }
}
