import { type ActivationContext, initialize } from "@ableton-extensions/sdk"
import { loadEnv } from "@live-connector/env"
import { createLogger } from "@live-connector/log"
import { API_VERSION } from "./deps"
import { startMcpHttpServer } from "./server/http"

const log = createLogger("extension")

/**
 * Extension Host から呼ばれるエントリポイント。
 * SDK を初期化し、コマンドコールバック外で常駐する MCP サーバーを起動する。
 */
export function activate(activation: ActivationContext): void {
    const context = initialize(activation, API_VERSION)
    const env = loadEnv()

    startMcpHttpServer({ deps: { context, log }, env, log })
        .then((info) => log.info("live-connector ready", info))
        .catch((error) => log.error("Failed to start MCP server", { error: String(error) }))
}
