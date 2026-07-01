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
import { registerStructureTools } from "../tools/structure"
import { registerTransformNotesTool } from "../tools/transform-notes"
import { registerWriteTools } from "../tools/write"
import { SERVICE_VERSION } from "../version"

/** 登録ツール構成のサマリ。/health で稼働ホストのツール構成を外形確認するために使う。 */
export type RegisteredToolsSummary = {
    count: number
    digest: string
    names: string[]
}

/** すべての MCP ツールを登録する（createMcpServer と describeRegisteredTools で共通の登録経路）。 */
function registerAllTools(server: McpServer, deps: ServerDeps): void {
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
    registerTransformNotesTool(server, deps)
    registerStructureTools(server, deps)
}

/** ソート済みツール名から安定した短いダイジェスト（djb2, 8 桁 hex）を導出する。 */
function toolsDigest(names: string[]): string {
    const joined = names.join(",")
    let hash = 5381
    for (let index = 0; index < joined.length; index++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}

/** ツールを登録した MCP サーバーを生成する（リクエストごとに生成し、共有 deps を閉じ込める）。 */
export function createMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer({ name: "live-connector", version: SERVICE_VERSION })
    registerAllTools(server, deps)
    return server
}

/**
 * 実際の登録経路をたどって登録ツール名を収集する（ハンドラは実行しない）。
 * createMcpServer と同一の register* を通すため、ツール構成と乖離しない。
 */
export function describeRegisteredTools(deps: ServerDeps): RegisteredToolsSummary {
    const names: string[] = []
    const collector = {
        registerTool(name: string) {
            names.push(name)
        },
    } as unknown as McpServer
    registerAllTools(collector, deps)
    names.sort((left, right) => left.localeCompare(right))
    return { count: names.length, digest: toolsDigest(names), names }
}
