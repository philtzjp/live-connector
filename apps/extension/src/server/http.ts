import { StreamableHTTPTransport } from "@hono/mcp"
import { serve } from "@hono/node-server"
import type { Env } from "@live-connector/env"
import type { Logger } from "@live-connector/log"
import { Hono } from "hono"
import { bearerAuth } from "hono/bearer-auth"
import type { ServerDeps } from "../deps"
import { createMcpServer } from "./mcp"

const MCP_PATH = "/api/v1/mcp"
const HEALTH_PATH = "/health"
const SERVICE_VERSION = "0.0.0"

export type StartArgs = {
    deps: ServerDeps
    env: Env
    log: Logger
}

export type ServerInfo = {
    host: string
    port: number
    mcpPath: string
}

/**
 * Hono + @hono/mcp で MCP サーバーを localhost に起動する。
 *
 * - `/health`: 認証不要のヘルスチェック（draft-inadarei 準拠）。
 * - `/api/v1/mcp`: Bearer 認証付きの MCP エンドポイント。
 */
export function startMcpHttpServer(args: StartArgs): Promise<ServerInfo> {
    const { deps, env, log } = args
    const app = new Hono()

    app.get(HEALTH_PATH, (c) =>
        c.json(
            { status: "pass", version: SERVICE_VERSION, description: "live-connector MCP server" },
            200,
            { "content-type": "application/health+json" },
        ),
    )

    const token = env.LIVE_CONNECTOR_MCP_TOKEN
    if (token !== undefined) {
        app.use(MCP_PATH, bearerAuth({ token }))
    }

    app.all(MCP_PATH, async (c) => {
        const server = createMcpServer(deps)
        const transport = new StreamableHTTPTransport()
        await server.connect(transport)
        return transport.handleRequest(c)
    })

    return new Promise<ServerInfo>((resolve) => {
        serve(
            {
                fetch: app.fetch,
                hostname: env.LIVE_CONNECTOR_MCP_HOST,
                port: env.LIVE_CONNECTOR_MCP_PORT,
            },
            (info) => {
                const server_info: ServerInfo = {
                    host: env.LIVE_CONNECTOR_MCP_HOST,
                    port: info.port,
                    mcpPath: MCP_PATH,
                }
                log.info("MCP HTTP server listening", server_info)
                resolve(server_info)
            },
        )
    })
}
