import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

/**
 * テスト用の MCP サーバー代用実装。register*Tool が呼ぶ `registerTool` を捕捉し、
 * zod 検証を経由せずにハンドラを直接呼び出せるようにする。ツール層のロジック
 * （select 解決・preview / confirm・閾値・エラー hint）を実機／SDK 実体なしで固定する。
 */

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }
type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>

export type CapturedTool = {
    name: string
    config: Record<string, unknown>
    handler: ToolHandler
}

export type ToolCallResult = { isError: boolean; json: unknown }

export class FakeMcpServer {
    readonly tools = new Map<string, CapturedTool>()

    registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): void {
        this.tools.set(name, { name, config, handler })
    }

    /** register*Tool へ渡すための McpServer 型として扱う。 */
    asMcpServer(): McpServer {
        return this as unknown as McpServer
    }

    /** 登録済みツールを呼び出し、text コンテンツを JSON として復元する。 */
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
        const tool = this.tools.get(name)
        if (tool === undefined) {
            throw new Error(`tool "${name}" is not registered`)
        }
        const result = await tool.handler(args)
        const text = result.content.map((part) => part.text).join("")
        return { isError: result.isError ?? false, json: JSON.parse(text) }
    }
}
