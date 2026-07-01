import { evaluate, parseQuery, type Row } from "@live-connector/cypher"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"

/** LIMIT 省略時にサーバー側で適用する既定の行数上限。 */
export const DEFAULT_ROW_LIMIT = 500

export type QueryResult = {
    count: number
    rows: Row[]
    truncated: boolean
    hint?: string
}

/**
 * LIMIT 省略時のみ既定上限で切り詰める。LIMIT 明示時は評価器が適用済みのため素通しする。
 * 切り詰めた場合は truncated と絞り込み手段の hint を付ける。
 */
export function applyRowCap(rows: Row[], hasExplicitLimit: boolean, cap: number): QueryResult {
    if (hasExplicitLimit || rows.length <= cap) {
        return { count: rows.length, rows, truncated: false }
    }
    return {
        count: cap,
        rows: rows.slice(0, cap),
        truncated: true,
        hint: `Result was truncated to the default cap of ${cap} rows. Add LIMIT/SKIP for paging, or narrow the pattern/WHERE. Aggregates (count/min/max/avg/sum) summarize large sets in one row.`,
    }
}

/**
 * `query` ツール: Cypher サブセットで Live Set を読む。
 * LIMIT 省略時はサーバー側の既定上限で切り詰め、truncated を応答に含める。
 */
export function registerQueryTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "query",
        {
            title: "Cypher 読み取りクエリ",
            description: `Cypher サブセット（MATCH <pattern> [WHERE ...] RETURN [DISTINCT] ... [ORDER BY expr [ASC|DESC]] [SKIP n] [LIMIT n]）で LOM を読む。集計関数 count/min/max/avg/sum に対応（非集計項目で暗黙グルーピング）。ラベル・プロパティ・リレーションは schema ツールを参照。書き込みは不可。LIMIT 省略時は既定 ${DEFAULT_ROW_LIMIT} 行で切り詰め、応答に truncated:true を返す。`,
            inputSchema: {
                cypher: z.string().min(1).describe("実行する Cypher 読み取りクエリ"),
            },
        },
        async ({ cypher }) => {
            try {
                const ast = parseQuery(cypher)
                const adapter = new LomGraphAdapter(deps.context)
                const rows = await evaluate(ast, adapter)
                const result = applyRowCap(rows, ast.limit !== null, DEFAULT_ROW_LIMIT)
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
