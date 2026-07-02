import { evaluate, parseQuery, type Row } from "@live-connector/cypher"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"

/** LIMIT 省略時にサーバー側で適用する既定の行数上限。 */
export const DEFAULT_ROW_LIMIT = 500

/**
 * 明示 LIMIT にも適用する絶対上限。行数上限の目的（MCP クライアントのコンテキスト保護）を
 * クライアント自身の LIMIT 指定で迂回できないようにする（#98 の決定。根拠は llm/models.yaml）。
 */
export const MAX_ROW_LIMIT = 2000

export type QueryResult = {
    count: number
    rows: Row[]
    truncated: boolean
    hint?: string
}

/**
 * 行数上限を適用する。LIMIT 省略時は既定上限（DEFAULT_ROW_LIMIT）、
 * LIMIT 明示時も絶対上限（MAX_ROW_LIMIT）で切り詰める。
 * 切り詰めた場合は truncated と絞り込み手段の hint を付ける。
 */
export function applyRowCap(
    rows: Row[],
    hasExplicitLimit: boolean,
    cap: number,
    absoluteCap: number = MAX_ROW_LIMIT,
): QueryResult {
    const effective_cap = hasExplicitLimit ? absoluteCap : cap
    if (rows.length <= effective_cap) {
        return { count: rows.length, rows, truncated: false }
    }
    const hint = hasExplicitLimit
        ? `Result was clamped to the absolute cap of ${absoluteCap} rows even though LIMIT was explicit (the cap protects the MCP client context). Use SKIP for paging, narrow the pattern/WHERE, or summarize with aggregates (count/min/max/avg/sum).`
        : `Result was truncated to the default cap of ${cap} rows. Add LIMIT/SKIP for paging, or narrow the pattern/WHERE. Aggregates (count/min/max/avg/sum) summarize large sets in one row.`
    return {
        count: effective_cap,
        rows: rows.slice(0, effective_cap),
        truncated: true,
        hint,
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
            description: `Cypher サブセット（MATCH <pattern> [WHERE ...] RETURN [DISTINCT] ... [ORDER BY expr [ASC|DESC]] [SKIP n] [LIMIT n]）で LOM を読む。集計関数 count/min/max/avg/sum に対応（非集計項目で暗黙グルーピング）。ラベル・プロパティ・リレーションは schema ツールを参照。書き込みは不可。LIMIT 省略時は既定 ${DEFAULT_ROW_LIMIT} 行、LIMIT 明示時も絶対上限 ${MAX_ROW_LIMIT} 行で切り詰め、切り詰め時は応答に truncated:true と hint を返す。`,
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
