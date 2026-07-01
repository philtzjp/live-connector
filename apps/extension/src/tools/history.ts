import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"

const HISTORY_DIRECTORY_NAME = "history"
const HISTORY_FILE_NAME = "write-history.jsonl"
const MAX_HISTORY_ENTRIES = 1000
const MAX_HISTORY_BYTES = 512 * 1024
const DEFAULT_READ_LIMIT = 50
const MAX_READ_LIMIT = 500
const MAX_INPUT_STRING = 200

/** Set を変更する（履歴に記録する）書き込みツール名。read / fs 系は含めない。 */
export const WRITE_HISTORY_TOOLS = new Set<string>([
    "set_song",
    "set_track",
    "set_clip",
    "set_scene",
    "set_cue_point",
    "set_device_parameter",
    "write_notes",
    "transform_notes",
    "create_clip",
    "create_scene",
    "delete_scene",
    "duplicate_scene",
    "delete_track",
    "duplicate_track",
    "delete_device",
    "duplicate_device",
    "delete_session_clip",
    "create_arrangement_clip",
    "delete_arrangement_clip",
    "move_clip",
    "trim_clip",
    "create_cue_point",
    "delete_cue_point",
    "insert_device",
    "load_sample",
    "apply_device_state",
])

export type HistoryEntry = {
    at: string
    tool: string
    input: Record<string, unknown>
    result: Record<string, unknown>
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

function historyDirectory(deps: ServerDeps): string {
    const storage = deps.context.environment.storageDirectory
    if (storage === undefined || storage.length === 0) {
        throw new ConfigError("Ableton Extensions SDK did not provide environment.storageDirectory")
    }
    return path.join(storage, HISTORY_DIRECTORY_NAME)
}

function historyFile(deps: ServerDeps): string {
    return path.join(historyDirectory(deps), HISTORY_FILE_NAME)
}

/** 入力を履歴向けに要約する（配列は件数、長い文字列は切り詰め）。 */
export function summarizeInput(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
        if (Array.isArray(value)) {
            out[key] = { count: value.length }
        } else if (typeof value === "string" && value.length > MAX_INPUT_STRING) {
            out[key] = `${value.slice(0, MAX_INPUT_STRING)}…`
        } else {
            out[key] = value
        }
    }
    return out
}

/** 結果 JSON から履歴向けの主要フィールドを抽出する。 */
export function summarizeResult(parsed: Record<string, unknown>): Record<string, unknown> {
    const keys = [
        "status",
        "modified",
        "matched",
        "noteCount",
        "removed",
        "added",
        "affected",
        "applied",
        "clipLength",
        "index",
        "name",
    ]
    const out: Record<string, unknown> = {}
    for (const key of keys) {
        if (key in parsed) {
            out[key] = parsed[key]
        }
    }
    return out
}

async function rotateIfLarge(file: string): Promise<void> {
    let size: number
    try {
        size = (await stat(file)).size
    } catch {
        return
    }
    if (size <= MAX_HISTORY_BYTES) {
        return
    }
    const raw = await readFile(file, "utf8")
    const lines = raw.split("\n").filter((line) => line.length > 0)
    const kept = lines.slice(-MAX_HISTORY_ENTRIES)
    await writeFile(file, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8")
}

async function appendHistory(deps: ServerDeps, entry: HistoryEntry): Promise<void> {
    const directory = historyDirectory(deps)
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, HISTORY_FILE_NAME)
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8")
    await rotateIfLarge(file)
}

/** result が status:"ok" の実書き込みのみ履歴へ記録する（preview / confirm_required / error は記録しない）。 */
async function recordWrite(
    deps: ServerDeps,
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
): Promise<void> {
    if (result.isError) {
        return
    }
    const text = result.content.map((part) => part.text).join("")
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { status?: unknown }).status !== "ok"
    ) {
        return
    }
    await appendHistory(deps, {
        at: new Date().toISOString(),
        tool,
        input: summarizeInput(args),
        result: summarizeResult(parsed as Record<string, unknown>),
    })
}

type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>

/**
 * register* が使う registerTool を横取りし、書き込みツールのハンドラを履歴記録でラップする facade。
 * ツール名は変えないため、tools/list や describeRegisteredTools には影響しない。
 */
export function withWriteHistory(server: McpServer, deps: ServerDeps): McpServer {
    return {
        registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler) {
            if (!WRITE_HISTORY_TOOLS.has(name)) {
                return server.registerTool(name, config as never, handler as never)
            }
            const wrapped: ToolHandler = async (args) => {
                const result = await handler(args)
                try {
                    await recordWrite(deps, name, args, result)
                } catch (error) {
                    deps.log.error("write history append failed", { error: String(error) })
                }
                return result
            }
            return server.registerTool(name, config as never, wrapped as never)
        },
    } as unknown as McpServer
}

async function readHistory(
    deps: ServerDeps,
    params: { limit: number; since: string | undefined; until: string | undefined },
): Promise<{ count: number; total: number; truncated: boolean; entries: HistoryEntry[] }> {
    const file = historyFile(deps)
    let raw: string
    try {
        raw = await readFile(file, "utf8")
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
            return { count: 0, total: 0, truncated: false, entries: [] }
        }
        throw error
    }
    const entries: HistoryEntry[] = []
    for (const line of raw.split("\n")) {
        if (line.length === 0) {
            continue
        }
        try {
            entries.push(JSON.parse(line) as HistoryEntry)
        } catch {
            // 壊れた行は無視する。
        }
    }
    const filtered = entries.filter((entry) => {
        if (params.since !== undefined && entry.at < params.since) {
            return false
        }
        if (params.until !== undefined && entry.at > params.until) {
            return false
        }
        return true
    })
    const limited = filtered.slice(-params.limit)
    return {
        count: limited.length,
        total: filtered.length,
        truncated: filtered.length > limited.length,
        entries: limited,
    }
}

/** `get_write_history` ツール: 書き込み履歴を件数・時刻範囲で取得する。 */
export function registerHistoryTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "get_write_history",
        {
            title: "書き込み履歴取得",
            description:
                "書き込みツールの実行履歴（時刻・ツール名・入力要約・結果）を新しい順に取得する。ホスト再起動後も参照できる。件数上限を超えた場合は truncated:true を返す。",
            inputSchema: {
                limit: z
                    .number()
                    .int()
                    .positive()
                    .max(MAX_READ_LIMIT)
                    .optional()
                    .describe(
                        `取得する最大件数（既定 ${DEFAULT_READ_LIMIT}、最大 ${MAX_READ_LIMIT}）`,
                    ),
                since: z.string().min(1).optional().describe("この ISO 時刻以降（含む）に絞る"),
                until: z.string().min(1).optional().describe("この ISO 時刻以前（含む）に絞る"),
            },
        },
        async ({ limit, since, until }) => {
            try {
                const result = await readHistory(deps, {
                    limit: limit ?? DEFAULT_READ_LIMIT,
                    since,
                    until,
                })
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
            } catch (error) {
                deps.log.error("get_write_history failed", { error: String(error) })
                return {
                    content: [{ type: "text", text: JSON.stringify(toMcpError(error), null, 2) }],
                    isError: true,
                }
            }
        },
    )
}
