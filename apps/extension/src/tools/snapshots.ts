import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, type ScalarValue, selectNodes } from "@live-connector/cypher"
import { BadRequestError, ConfigError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { isFileMissingError } from "./history"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

const SNAPSHOT_DIRECTORY_NAME = "snapshots"
// 1.1: targetIdentities / targetIdentity（handle.id の文字列）を追加し、identity ベース照合に対応。
const SNAPSHOT_SCHEMA_VERSION = "1.1"
const MAX_SNAPSHOTS = 100
const DEFAULT_LIST_LIMIT = 50

export type PropertiesSnapshot = {
    schemaVersion: "1.1"
    id: string
    at: string
    tool: string
    kind: "properties"
    select: string
    requiredLabel: string
    properties: string[]
    oldTargets: Record<string, unknown>[]
    /** oldTargets と同順の対象識別子（SDK Handle.id の文字列。取得できない対象は null）。 */
    targetIdentities: (string | null)[]
}

export type NotesSnapshot = {
    schemaVersion: "1.1"
    id: string
    at: string
    tool: string
    kind: "notes"
    select: string
    oldNotes: NoteDescription[]
    /** 対象 MidiClip の識別子（SDK Handle.id の文字列。取得できない場合は null）。 */
    targetIdentity: string | null
}

export type SnapshotFile = PropertiesSnapshot | NotesSnapshot

/**
 * LOM オブジェクトの直列化可能な識別子（Handle.id の文字列）を返す。
 * フェイクや handle 未公開のオブジェクトは null（照合は件数一致時の index フォールバック）。
 */
export function objectIdentity(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
        return null
    }
    const handle = (value as { handle?: unknown }).handle
    if (typeof handle !== "object" || handle === null || !("id" in handle)) {
        return null
    }
    const id = (handle as { id: unknown }).id
    if (typeof id === "bigint" || typeof id === "number" || typeof id === "string") {
        return String(id)
    }
    return null
}

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
        targetIdentities?: (string | null)[]
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
        targetIdentities: params.targetIdentities ?? params.oldTargets.map(() => null),
    })
    return id
}

/** write_notes の適用直前に旧 notes をスナップショットする。snapshotId を返す。 */
export async function captureNotesSnapshot(
    deps: ServerDeps,
    params: {
        tool: string
        select: string
        oldNotes: NoteDescription[]
        targetIdentity?: string | null
    },
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
        targetIdentity: params.targetIdentity ?? null,
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
        // ENOENT のみ not_found。EACCES / EIO 等の storage 障害は隠さずエラーにする。
        if (isFileMissingError(error)) {
            throw new NotFoundError(`snapshot "${id}" was not found`, {
                hint: "Use list_snapshots to see available snapshot ids.",
            })
        }
        throw error
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new BadRequestError(`snapshot "${id}" file is corrupted (not valid JSON)`, {
            hint: "The snapshot cannot be restored. Use list_snapshots to pick another snapshot, or revert via Live undo.",
        })
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new BadRequestError(`snapshot "${id}" file is corrupted (not a JSON object)`, {
            hint: "The snapshot cannot be restored. Use list_snapshots to pick another snapshot, or revert via Live undo.",
        })
    }
    const snapshot = parsed as SnapshotFile
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        throw new BadRequestError(
            `snapshot "${id}" has schemaVersion "${String(snapshot.schemaVersion)}" but this build expects "${SNAPSHOT_SCHEMA_VERSION}"`,
            {
                hint: "The snapshot was captured by a different live-connector version and cannot be restored safely. Revert via Live undo instead.",
            },
        )
    }
    return snapshot
}

/** notes スナップショットを復元し、復元前 notes の巻き戻し用スナップショット id を返す。 */
async function restoreNotesSnapshot(
    deps: ServerDeps,
    snapshot: NotesSnapshot,
    nodes: LomNode[],
): Promise<Record<string, unknown>> {
    const node = nodes[0]
    if (
        nodes.length !== 1 ||
        node === undefined ||
        node.type !== "object" ||
        !(node.value instanceof MidiClip)
    ) {
        throw new BadRequestError(
            `snapshot ${snapshot.id} target MidiClip no longer resolves to exactly one clip (matched ${nodes.length})`,
            { hint: "The clip may have been deleted or moved. Restore is best-effort." },
        )
    }
    const clip = node.value
    const current_identity = objectIdentity(clip)
    if (
        snapshot.targetIdentity !== null &&
        current_identity !== null &&
        snapshot.targetIdentity !== current_identity
    ) {
        throw new BadRequestError(
            `snapshot ${snapshot.id} was captured for clip identity ${snapshot.targetIdentity}, but the select now resolves a different clip (${current_identity})`,
            {
                hint: "The original clip was deleted or replaced. Adjust the Set or revert via Live undo.",
            },
        )
    }
    // restore 自身を巻き戻せるよう、復元前の現在値をスナップショットする。
    const undo_snapshot_id = await captureNotesSnapshot(deps, {
        tool: "restore_snapshot",
        select: snapshot.select,
        oldNotes: clip.notes,
        targetIdentity: current_identity,
    })
    await deps.context.withinTransaction(() => {
        clip.notes = snapshot.oldNotes
    })
    return {
        restored: "notes",
        id: snapshot.id,
        tool: snapshot.tool,
        noteCount: snapshot.oldNotes.length,
        undoSnapshotId: undo_snapshot_id,
    }
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
        return restoreNotesSnapshot(deps, snapshot, nodes)
    }

    // 保存済み requiredLabel を復元時にも検証する（select の再解決が別種ノードを返す場合を拒否）。
    for (const node of nodes) {
        if (!adapter.matchesLabel(node, snapshot.requiredLabel)) {
            throw new BadRequestError(
                `snapshot ${id} expects ${snapshot.requiredLabel} nodes, but the select now matches a ${adapter.labelOf(node)} node`,
                { hint: "The Set structure changed since the snapshot. Revert via Live undo." },
            )
        }
    }

    // identity（Handle.id）で対象を照合する。identity が取得できない環境（フェイク等）は、
    // 件数が一致する場合のみ index 照合へフォールバックし、順ズレ適用を防ぐ。
    const node_identities = nodes.map((node) => objectIdentity(node.value))
    const has_identities =
        snapshot.targetIdentities.every((identity) => identity !== null) &&
        node_identities.every((identity) => identity !== null)

    type MatchedTarget = { node: (typeof nodes)[number]; old: Record<string, unknown> }
    const matched: MatchedTarget[] = []
    let missing_from_set = 0
    let unmatched_now = 0
    if (has_identities) {
        const now_by_identity = new Map<string, (typeof nodes)[number]>()
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index]
            const identity = node_identities[index]
            if (node !== undefined && typeof identity === "string") {
                now_by_identity.set(identity, node)
            }
        }
        const matched_identities = new Set<string>()
        for (let index = 0; index < snapshot.oldTargets.length; index++) {
            const identity = snapshot.targetIdentities[index]
            const old = snapshot.oldTargets[index]
            if (typeof identity !== "string" || old === undefined) {
                continue
            }
            const node = now_by_identity.get(identity)
            if (node === undefined) {
                missing_from_set++
                continue
            }
            matched_identities.add(identity)
            matched.push({ node, old })
        }
        unmatched_now = node_identities.filter(
            (identity) => typeof identity === "string" && !matched_identities.has(identity),
        ).length
    } else {
        if (nodes.length !== snapshot.oldTargets.length) {
            throw new BadRequestError(
                `snapshot ${id} captured ${snapshot.oldTargets.length} target(s) but the select now matches ${nodes.length}, and target identities are unavailable for safe matching`,
                {
                    hint: "Restoring by position would write old values onto the wrong nodes. Revert via Live undo, or restore after returning the Set to the captured structure.",
                },
            )
        }
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index]
            const old = snapshot.oldTargets[index]
            if (node !== undefined && old !== undefined) {
                matched.push({ node, old })
            }
        }
    }

    if (matched.length === 0) {
        throw new NotFoundError(
            `snapshot ${id} matched none of its captured targets (captured ${snapshot.oldTargets.length}, select now matches ${nodes.length})`,
            { hint: "The captured targets were deleted or replaced. Revert via Live undo." },
        )
    }

    // restore 自身を巻き戻せるよう、照合済み対象の現在値をスナップショットする。
    const current_targets = await Promise.all(matched.map((entry) => adapter.serialize(entry.node)))
    const undo_snapshot_id = await capturePropertiesSnapshot(deps, {
        tool: "restore_snapshot",
        select: snapshot.select,
        requiredLabel: snapshot.requiredLabel,
        properties: snapshot.properties,
        oldTargets: current_targets,
        targetIdentities: matched.map((entry) => objectIdentity(entry.node.value)),
    })

    let restored = 0
    await deps.context.withinTransaction(() => {
        const ops: Promise<void>[] = []
        for (const entry of matched) {
            for (const property of snapshot.properties) {
                const value = entry.old[property]
                if (isScalar(value)) {
                    ops.push(adapter.setProperty(entry.node, property, value))
                }
            }
            restored++
        }
        return Promise.all(ops)
    })
    const partial = missing_from_set > 0 || unmatched_now > 0
    return {
        restored,
        id,
        tool: snapshot.tool,
        properties: snapshot.properties,
        matchedNow: nodes.length,
        snapshotTargets: snapshot.oldTargets.length,
        missingFromSet: missing_from_set,
        unmatchedNow: unmatched_now,
        undoSnapshotId: undo_snapshot_id,
        ...(partial
            ? {
                  note: `partial restore: ${missing_from_set} captured target(s) no longer resolve and ${unmatched_now} currently matching node(s) were not in the snapshot.`,
              }
            : {}),
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
    } catch (error) {
        // ENOENT（スナップショット未作成）のみ「空」扱い。storage 障害はエラーにする。
        if (isFileMissingError(error)) {
            return { count: 0, total: 0, truncated: false, snapshots: [] }
        }
        throw error
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
                "snapshotId を指定して、set_* / write_notes / transform_notes / batch ステップの変更前の値へ書き戻す。select を再解決し、対象を identity（SDK Handle）で照合する。スナップショット後に構成が変わった場合は一致した対象のみ部分復元し（missingFromSet / unmatchedNow で申告）、identity が使えない環境で件数が合わない場合や対象が全て消えた場合は拒否する。復元前の現在値を自動スナップショットし undoSnapshotId で返す（誤 restore の巻き戻し用）。構造操作（create/delete/duplicate）はこの機構の対象外。",
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
