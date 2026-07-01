import { evaluate, parseQuery } from "@live-connector/cypher"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"

/**
 * `query` ツール: Cypher サブセット（MATCH … WHERE … RETURN）で Live Set を読む。
 * 構文は `schema` ツールのスキーマと例クエリに従う。
 */
export function registerQueryTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "query",
        {
            title: "Cypher 読み取りクエリ",
            description:
                "Cypher サブセット（MATCH <pattern> [WHERE ...] RETURN [DISTINCT] ... [ORDER BY expr [ASC|DESC]] [SKIP n] [LIMIT n]）で LOM を読む。集計関数 count/min/max/avg/sum に対応（非集計項目で暗黙グルーピング）。ラベル・プロパティ・リレーションは schema ツールを参照。書き込みは不可。",
            inputSchema: {
                cypher: z.string().min(1).describe("実行する Cypher 読み取りクエリ"),
            },
        },
        async ({ cypher }) => {
            try {
                const ast = parseQuery(cypher)
                const adapter = new LomGraphAdapter(deps.context)
                const rows = await evaluate(ast, adapter)
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ count: rows.length, rows }, null, 2),
                        },
                    ],
                }
            } catch (error) {
                deps.log.error("query failed", { error: String(error) })
                return {
                    content: [{ type: "text", text: JSON.stringify(toMcpError(error), null, 2) }],
                    isError: true,
                }
            }
        },
    )
}
