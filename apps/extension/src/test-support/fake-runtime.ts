/**
 * テスト用の Hybrid Runtime 生成。OSC を有効化する場合は fake transport を注入する。
 */

import { loadEnv } from "@live-connector/env"
import { createLogger } from "@live-connector/log"
import { HybridRuntime, type RuntimeOptions } from "../runtime/runtime"
import { buildFakeOscTransport, type FakeOscState } from "./fake-osc"

/** OSC 無効の runtime（従来 SDK 機能のみ）。 */
export function createSdkOnlyRuntime(source: NodeJS.ProcessEnv = {}): HybridRuntime {
    return new HybridRuntime(loadEnv(source), createLogger("test"))
}

/**
 * fake OSC transport を注入した runtime。`state` を返す関数を受け取り、
 * start() 後にテストから応答内容を操作できる。
 */
export function createFakeOscRuntime(
    state: FakeOscState,
    source: NodeJS.ProcessEnv = { LIVE_CONNECTOR_OSC_ENABLED: "true" },
    extra: RuntimeOptions = {},
): HybridRuntime {
    const options: RuntimeOptions = {
        transportFactory: (settings, log) => buildFakeOscTransport(settings, log, state),
        ...extra,
    }
    return new HybridRuntime(loadEnv(source), createLogger("test"), options)
}
