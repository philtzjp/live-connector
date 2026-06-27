import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerDeps } from "../deps"
import { registerOverviewTool } from "../tools/overview"
import { registerQueryTool } from "../tools/query"
import { registerSchemaTool } from "../tools/schema"

/** ツールを登録した MCP サーバーを生成する（リクエストごとに生成し、共有 deps を閉じ込める）。 */
export function createMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer({ name: "live-connector", version: "0.0.0" })
    registerSchemaTool(server, deps)
    registerOverviewTool(server, deps)
    registerQueryTool(server, deps)
    return server
}
