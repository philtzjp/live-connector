import { type ActivationContext, initialize } from "@ableton-extensions/sdk"
import { loadEnv } from "@live-connector/env"
import { createLogger } from "@live-connector/log"
import { API_VERSION } from "./deps"
import { HybridRuntime } from "./runtime/runtime"
import { startMcpHttpServer } from "./server/http"

const log = createLogger("extension")
const runtime_log = createLogger("runtime")

/**
 * Extension Host から呼ばれるエントリポイント。
 * SDK を初期化し、activation 単位の Hybrid Runtime と常駐 MCP サーバーを起動する。
 */
export function activate(activation: ActivationContext): void {
    const context = initialize(activation, API_VERSION)
    const env = loadEnv()
    const runtime = new HybridRuntime(env, runtime_log)

    // OSC は接続できなくても従来の SDK 機能を止めない。失敗理由は meta の capabilities に載る。
    void runtime.start()

    startMcpHttpServer({ deps: { context, log, runtime }, env, log })
        .then((info) => log.info("live-connector ready", info))
        .catch((error) => log.error("Failed to start MCP server", { error: String(error) }))
}
