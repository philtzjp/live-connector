import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

/**
 * テスト用の MCP サーバー代用実装。register*Tool が呼ぶ `registerTool` を捕捉する。
 * `call()` は zod を経由せずハンドラを直接呼び、`callValidated()` は登録された
 * inputSchema（zod shape）で検証・既定値適用してから呼ぶ（本番 MCP 層と同等の経路）。
 * ツール層のロジック（select 解決・preview / confirm・閾値・エラー hint）と
 * 入力スキーマの検証等価性の両方を、実機／SDK 実体なしで固定する。
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

    /**
     * 登録された inputSchema（zod shape）で args を検証・既定値適用してから呼び出す。
     * スキーマ不一致は ZodError を投げる（本番 MCP 層の検証と同等）。
     */
    async callValidated(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
        const tool = this.tools.get(name)
        if (tool === undefined) {
            throw new Error(`tool "${name}" is not registered`)
        }
        const shape = tool.config.inputSchema as z.ZodRawShape | undefined
        const parsed = shape === undefined ? args : z.object(shape).parse(args)
        const result = await tool.handler(parsed as Record<string, unknown>)
        const text = result.content.map((part) => part.text).join("")
        return { isError: result.isError ?? false, json: JSON.parse(text) }
    }
}
