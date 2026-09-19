import { parseStatement } from "@live-connector/cypher"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { textResult } from "./common"
import { executeCall } from "./do/call"
import { executeCopy } from "./do/copy"
import { executeCreate } from "./do/create"
import { executeDelete } from "./do/delete"
import { executeRead } from "./do/read"
import { executeSet } from "./do/set"

export async function runDoStatement(
    deps: ServerDeps,
    params: { statement: string; preview?: boolean; confirm?: boolean },
): Promise<Record<string, unknown>> {
    const ast = parseStatement(params.statement)
    switch (ast.kind) {
        case "read":
            return executeRead(deps, params.statement)
        case "call":
            return executeCall(deps, ast, params.preview, params.confirm)
        case "set":
            deps.runtime.locks.assertWritable()
            return executeSet(deps, params.statement, ast, params.preview, params.confirm)
        case "create":
            deps.runtime.locks.assertWritable()
            return executeCreate(deps, params.statement, ast, params.preview, params.confirm)
        case "delete":
            deps.runtime.locks.assertWritable()
            return executeDelete(deps, params.statement, ast, params.preview, params.confirm)
        case "copy":
            deps.runtime.locks.assertWritable()
            return executeCopy(deps, params.statement, ast, params.preview, params.confirm)
    }
}

export function registerDoTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "do",
        {
            title: "読み書き統合（Cypher 文）",
            description:
                "Cypher サブセットで Live Set を読み書きする。read: MATCH ... RETURN（LIMIT 省略時 500 行 truncate）。write: MATCH ... SET / CREATE / DELETE / COPY。preview:true でドライラン。undoable が partial/none の書き込みは confirm:true 必須。",
            inputSchema: {
                statement: z
                    .string()
                    .min(1)
                    .describe("実行する Cypher 文（読み取りまたは書き込み）"),
                preview: z.boolean().optional().describe("書き込みのドライラン"),
                confirm: z.boolean().optional().describe("戻せない／部分的な書き込みの確定"),
            },
        },
        async ({ statement, preview, confirm }) => {
            try {
                const result = await runDoStatement(deps, {
                    statement,
                    ...(preview !== undefined ? { preview } : {}),
                    ...(confirm !== undefined ? { confirm } : {}),
                })
                return textResult(result, result.status === "error")
            } catch (error) {
                deps.log.error("do failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
