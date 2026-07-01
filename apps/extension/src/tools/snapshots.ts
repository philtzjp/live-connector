import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, type ScalarValue, selectNodes } from "@live-connector/cypher"
import { BadRequestError, ConfigError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"

const SNAPSHOT_DIRECTORY_NAME = "snapshots"
const SNAPSHOT_SCHEMA_VERSION = "1.0"
const MAX_SNAPSHOTS = 100
const DEFAULT_LIST_LIMIT = 50

export type PropertiesSnapshot = {
    schemaVersion: "1.0"
    id: string
    at: string
    tool: string
    kind: "properties"
    select: string
    requiredLabel: string
    properties: string[]
    oldTargets: Record<string, unknown>[]
}

export type NotesSnapshot = {
    schemaVersion: "1.0"
    id: string
    at: string
    tool: string
    kind: "notes"
    select: string
    oldNotes: NoteDescription[]
}

export type SnapshotFile = PropertiesSnapshot | NotesSnapshot

let snapshotCounter = 0

function nextSnapshotId(): string {
    snapshotCounter = (snapshotCounter + 1) % 1_000_000
    return `snap-${Date.now().toString(36)}-${snapshotCounter.toString(36)}`
}

function snapshotDirectory(deps: ServerDeps): string {
    const storage = deps.context.environment.storageDirectory
    if (storage === undefined || storage.length === 0) {
        throw new ConfigError("Ableton Extensions SDK did not provide environment.storageDirectory")
    }
    return path.join(storage, SNAPSHOT_DIRECTORY_NAME)
}

function snapshotPath(directory: string, id: string): string {
    return path.join(directory, `${encodeURIComponent(id)}.json`)
}

/** 保持数を超えた古いスナップショットを削除する。 */
async function pruneSnapshots(directory: string): Promise<void> {
    let files: string[]
    try {
        files = (await readdir(directory)).filter((name) => name.endsWith(".json"))
    } catch {
        return
    }
    if (files.length <= MAX_SNAPSHOTS) {
        return
    }
    // ファイル名は snap-<base36 time>-<counter> で辞書順 ≈ 時系列。古い方を削除する。
    const sorted = files.sort()
    for (const name of sorted.slice(0, files.length - MAX_SNAPSHOTS)) {
        await unlink(path.join(directory, name)).catch(() => {})
    }
}

async function writeSnapshot(deps: ServerDeps, snapshot: SnapshotFile): Promise<void> {
    const directory = snapshotDirectory(deps)
    await mkdir(directory, { recursive: true })
    await writeFile(
        snapshotPath(directory, snapshot.id),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        "utf8",
    )
    await pruneSnapshots(directory)
}

/** set_* の適用直前に旧プロパティ値をスナップショットする。snapshotId を返す。 */
export async function capturePropertiesSnapshot(
    deps: ServerDeps,
    params: {
        tool: string
        select: string
        requiredLabel: string
        properties: string[]
        oldTargets: Record<string, unknown>[]
    },
): Promise<string> {
    const id = nextSnapshotId()
    await writeSnapshot(deps, {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        id,
        at: new Date().toISOString(),
        tool: params.tool,
        kind: "properties",
        select: params.select,
        requiredLabel: params.requiredLabel,
        properties: params.properties,
        oldTargets: params.oldTargets,
    })
    return id
}

/** write_notes の適用直前に旧 notes をスナップショットする。snapshotId を返す。 */
export async function captureNotesSnapshot(
    deps: ServerDeps,
    params: { tool: string; select: string; oldNotes: NoteDescription[] },
): Promise<string> {
    const id = nextSnapshotId()
    await writeSnapshot(deps, {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        id,
        at: new Date().toISOString(),
        tool: params.tool,
        kind: "notes",
        select: params.select,
        oldNotes: params.oldNotes,
    })
    return id
}

function isScalar(value: unknown): value is ScalarValue {
    return (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    )
}

async function readSnapshot(deps: ServerDeps, id: string): Promise<SnapshotFile> {
    const file = snapshotPath(snapshotDirectory(deps), id)
    let raw: string
    try {
        raw = await readFile(file, "utf8")
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
            throw new NotFoundError(`snapshot "${id}" was not found`, {
                hint: "Use list_snapshots to see available snapshot ids.",
            })
        }
        throw error
    }
    return JSON.parse(raw) as SnapshotFile
}

/** スナップショット識別子を指定して旧値を書き戻す。 */
export async function restoreSnapshot(
    deps: ServerDeps,
    id: string,
): Promise<Record<string, unknown>> {
    const snapshot = await readSnapshot(deps, id)
    const adapter = new LomGraphAdapter(deps.context)
    const nodes = await selectNodes(parseQuery(snapshot.select), adapter)

    if (snapshot.kind === "notes") {
        const node = nodes[0]
        if (
            nodes.length !== 1 ||
            node === undefined ||
            node.type !== "object" ||
            !(node.value instanceof MidiClip)
        ) {
            throw new BadRequestError(
                `snapshot ${id} target MidiClip no longer resolves to exactly one clip (matched ${nodes.length})`,
                { hint: "The clip may have been deleted or moved. Restore is best-effort." },
            )
        }
        const clip = node.value
        await deps.context.withinTransaction(() => {
            clip.notes = snapshot.oldNotes
        })
        return { restored: "notes", id, tool: snapshot.tool, noteCount: snapshot.oldNotes.length }
    }

    let restored = 0
    await deps.context.withinTransaction(() => {
        const ops: Promise<void>[] = []
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index]
            const old = snapshot.oldTargets[index]
            if (node === undefined || old === undefined) {
                continue
            }
            for (const property of snapshot.properties) {
                const value = old[property]
                if (isScalar(value)) {
                    ops.push(adapter.setProperty(node, property, value))
                }
            }
            restored++
        }
        return Promise.all(ops)
    })
    const note =
        nodes.length === snapshot.oldTargets.length
            ? undefined
            : `select now matches ${nodes.length} node(s) but the snapshot captured ${snapshot.oldTargets.length}; restore matched by order and may be partial.`
    return {
        restored,
        id,
        tool: snapshot.tool,
        properties: snapshot.properties,
        matchedNow: nodes.length,
        snapshotTargets: snapshot.oldTargets.length,
        ...(note !== undefined ? { note } : {}),
    }
}

async function listSnapshots(
    deps: ServerDeps,
    limit: number,
): Promise<{
    count: number
    total: number
    truncated: boolean
    snapshots: Record<string, unknown>[]
}> {
    const directory = snapshotDirectory(deps)
    let files: string[]
    try {
        files = (await readdir(directory)).filter((name) => name.endsWith(".json"))
    } catch {
        return { count: 0, total: 0, truncated: false, snapshots: [] }
    }
    const recent = files.sort().slice(-limit).reverse()
    const summaries: Record<string, unknown>[] = []
    for (const name of recent) {
        try {
            const raw = await readFile(path.join(directory, name), "utf8")
            const snapshot = JSON.parse(raw) as SnapshotFile
            summaries.push({
                id: snapshot.id,
                at: snapshot.at,
                tool: snapshot.tool,
                kind: snapshot.kind,
                select: snapshot.select,
            })
        } catch {
            // 壊れたファイルは無視する。
        }
    }
    return {
        count: summaries.length,
        total: files.length,
        truncated: files.length > summaries.length,
        snapshots: summaries,
    }
}

function textResult(
    payload: unknown,
    isError = false,
): {
    content: { type: "text"; text: string }[]
    isError?: boolean
} {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

/** スナップショット復元・一覧ツールを登録する。 */
export function registerSnapshotTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "restore_snapshot",
        {
            title: "スナップショット復元",
            description:
                "snapshotId を指定して、set_* / write_notes の変更前の値へ書き戻す。set_* の properties スナップショット、write_notes の notes スナップショットに対応。select を再解決して適用するため、対象が削除・移動されている場合は復元できない（best-effort）。構造操作（create/delete/duplicate）はこの機構の対象外。",
            inputSchema: {
                snapshotId: z.string().min(1).describe("復元するスナップショット識別子"),
            },
        },
        async ({ snapshotId }) => {
            try {
                const result = await restoreSnapshot(deps, snapshotId)
                return textResult({ status: "ok", ...result })
            } catch (error) {
                deps.log.error("restore_snapshot failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "list_snapshots",
        {
            title: "スナップショット一覧",
            description:
                "保存済みの書き込みスナップショット（id / 時刻 / ツール / 種別 / select）を新しい順に取得する。",
            inputSchema: {
                limit: z
                    .number()
                    .int()
                    .positive()
                    .max(MAX_SNAPSHOTS)
                    .optional()
                    .describe(`取得する最大件数（既定 ${DEFAULT_LIST_LIMIT}）`),
            },
        },
        async ({ limit }) => {
            try {
                return textResult(await listSnapshots(deps, limit ?? DEFAULT_LIST_LIMIT))
            } catch (error) {
                deps.log.error("list_snapshots failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
