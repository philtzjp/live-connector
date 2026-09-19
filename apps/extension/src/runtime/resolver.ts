/**
 * OSC index と SDK トラックの対応解決。
 * SDK handle と OSC index を同一視せず、一意名とトラック順序の照合で対応付ける。
 * 一致しない場合は OSC への変更操作を一切送らずに失敗させる。
 */

import { HybridError } from "@live-connector/error"
import type { OscRoutingAdapter } from "../osc/routing"

/** 一時録音トラックの OSC index を解決する。 */
export class CaptureResolver {
    private readonly routing: OscRoutingAdapter

    constructor(routing: OscRoutingAdapter) {
        this.routing = routing
    }

    /**
     * 一意名が OSC 側にちょうど 1 件あり、SDK 側の同名トラックと同 index であることを確認する。
     * どちらかが崩れている場合は SET_IDENTITY_MISMATCH を投げ、呼び出し側は OSC 変更を送らない。
     */
    async resolveOscIndex(unique_name: string, sdk_track_names: string[]): Promise<number> {
        const osc_names = await this.routing.listTrackNames()
        const matches: number[] = []
        for (const [index, name] of osc_names.entries()) {
            if (name === unique_name) {
                matches.push(index)
            }
        }
        if (matches.length !== 1) {
            throw new HybridError(
                "SET_IDENTITY_MISMATCH",
                `Expected exactly one OSC track named "${unique_name}", found ${matches.length}`,
            )
        }
        const index = matches[0]
        if (index === undefined || sdk_track_names[index] !== unique_name) {
            throw new HybridError(
                "SET_IDENTITY_MISMATCH",
                `SDK and OSC track order disagree at index ${index ?? "?"}; refusing to send OSC changes`,
            )
        }
        return index
    }
}
