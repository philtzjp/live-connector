/**
 * OSC 設定の読み戻し収束ヘルパー。
 * AbletonOSC の setter は LOM 更新が非同期なため、送信直後の 1 回読みでは
 * 反映前の値を観測することがある。目標値へ収束するまで短時間ポーリングする。
 */

import { HybridError } from "@live-connector/error"

const DEFAULT_TIMEOUT_MS = 1_500
const POLL_INTERVAL_MS = 100

/** `read()` が `matches` を満たすまでポーリングし、満たさなければ OSC_WRITE_UNCERTAIN。 */
export async function converge<T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean,
    label: string,
    timeout_ms: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
    const deadline = Date.now() + timeout_ms
    let last: T | undefined
    for (;;) {
        last = await read()
        if (matches(last)) {
            return last
        }
        if (Date.now() >= deadline) {
            break
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    throw new HybridError(
        "OSC_WRITE_UNCERTAIN",
        `${label} was not confirmed (observed ${String(last)})`,
    )
}

/** 数値の許容誤差つき収束。 */
export async function convergeNumber(
    read: () => Promise<number>,
    expected: number,
    label: string,
    tolerance = 0.05,
): Promise<number> {
    return converge(read, (value) => Math.abs(value - expected) <= tolerance, label)
}
