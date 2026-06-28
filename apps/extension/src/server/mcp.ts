import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerDeps } from "../deps"
import { registerArrangementTools } from "../tools/arrangement"
import { registerAudioTools } from "../tools/audio"
import { registerCreateTools } from "../tools/create"
import { registerDeviceTools } from "../tools/devices"
import { registerNotesTool } from "../tools/notes"
import { registerOverviewTool } from "../tools/overview"
import { registerPresetTools } from "../tools/presets"
import { registerQueryTool } from "../tools/query"
import { registerSchemaTool } from "../tools/schema"
import { registerWriteTools } from "../tools/write"

/** ツールを登録した MCP サーバーを生成する（リクエストごとに生成し、共有 deps を閉じ込める）。 */
export function createMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer({ name: "live-connector", version: "2.1.0" })
    registerSchemaTool(server, deps)
    registerOverviewTool(server, deps)
    registerQueryTool(server, deps)
    registerAudioTools(server, deps)
    registerArrangementTools(server, deps)
    registerCreateTools(server, deps)
    registerDeviceTools(server, deps)
    registerPresetTools(server, deps)
    registerWriteTools(server, deps)
    registerNotesTool(server, deps)
    return server
}
