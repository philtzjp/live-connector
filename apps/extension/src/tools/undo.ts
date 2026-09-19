import { Clip, ClipSlot, Device, Scene, Track } from "@ableton-extensions/sdk"
import { NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { createAdapterFromDeps } from "../lom/create-adapter"
import { findNodeByIdentity } from "../undo/locate"
import { listUndoEntries, markEntryUndone } from "../undo/log"
import { applyRecreate } from "../undo/recreate"
import { applyNotesInverse, applySetPropertiesInverse } from "../undo/restore"
import type { InverseDeleteCreated, UndoLogEntry } from "../undo/types"
import { textResult } from "./common"
import { deviceParent } from "./do/structure"

type V = TargetApiVersion

async function applyDeleteCreated(
    deps: ServerDeps,
    inverse: InverseDeleteCreated,
): Promise<{ deleted: { label: string; identity: string }[] }> {
    const adapter = createAdapterFromDeps(deps)
    const deleted: { label: string; identity: string }[] = []

    for (const item of inverse.items) {
        const node = await findNodeByIdentity(deps, item.identity, item.label, adapter)
        if (node === null || node.type !== "object") {
            continue
        }
        const value = node.value
        let removed = false

        if (value instanceof Track) {
            await deps.context.withinTransaction(() =>
                deps.context.application.song.deleteTrack(value),
            )
            removed = true
        } else if (value instanceof Scene) {
            await deps.context.withinTransaction(() =>
                deps.context.application.song.deleteScene(value as Scene<V>),
            )
            removed = true
        } else if (value instanceof Device) {
            await deps.context.withinTransaction(() => deviceParent(value).deleteDevice(value))
            removed = true
        } else if (value instanceof Clip) {
            const parent = value.parent
            if (parent instanceof ClipSlot) {
                await deps.context.withinTransaction(() => parent.deleteClip())
                removed = true
            } else if (parent instanceof Track) {
                await deps.context.withinTransaction(() => parent.deleteClip(value))
                removed = true
            }
        }

        if (removed) {
            deleted.push({ label: item.label, identity: item.identity })
        }
    }

    return { deleted }
}

function countRestored(reverted: Record<string, unknown>[]): number {
    let restored = 0
    for (const item of reverted) {
        if (item.kind === "set_properties") {
            const entries = item.reverted
            if (Array.isArray(entries)) {
                restored += entries.length
            }
        } else if (item.kind === "notes_replace" && item.restored === true) {
            restored += 1
        } else if (item.kind === "delete_created") {
            const entries = item.deleted
            if (Array.isArray(entries)) {
                restored += entries.length
            }
        } else if (item.kind === "recreate") {
            const entries = item.recreated
            if (Array.isArray(entries)) {
                restored += entries.length
            }
        }
    }
    return restored
}

async function undoEntry(deps: ServerDeps, entry: UndoLogEntry): Promise<Record<string, unknown>> {
    if (entry.undoable === "none") {
        await markEntryUndone(deps, entry.writeId)
        return {
            writeId: entry.writeId,
            kind: entry.kind,
            restored: 0,
            reverted: [],
            note: "This write could not be restored (undoable: none).",
        }
    }

    const adapter = createAdapterFromDeps(deps)
    const reverted: Record<string, unknown>[] = []

    for (const inverse of entry.inverse) {
        if (inverse.kind === "set_properties") {
            reverted.push({
                kind: "set_properties",
                ...(await applySetPropertiesInverse(deps, adapter, inverse)),
            })
        } else if (inverse.kind === "notes_replace") {
            const restored = await applyNotesInverse(deps, inverse)
            reverted.push({ kind: "notes_replace", restored })
        } else if (inverse.kind === "delete_created") {
            reverted.push({ kind: "delete_created", ...(await applyDeleteCreated(deps, inverse)) })
        } else if (inverse.kind === "recreate") {
            reverted.push({ kind: "recreate", ...(await applyRecreate(deps, inverse)) })
        }
    }

    const restored = countRestored(reverted)
    await markEntryUndone(deps, entry.writeId)

    return {
        writeId: entry.writeId,
        kind: entry.kind,
        restored,
        reverted,
        ...(entry.undoable === "partial"
            ? { note: "Partial undo: some attributes may not have been fully restored." }
            : {}),
        ...(restored === 0 && entry.inverse.length === 0
            ? { note: "No inverse operations were recorded for this write." }
            : {}),
    }
}

export async function runUndo(
    deps: ServerDeps,
    params: { steps?: number; writeId?: string },
): Promise<Record<string, unknown>> {
    deps.runtime.locks.assertWritable()
    const entries = await listUndoEntries(deps)
    const applied = entries.filter((entry) => entry.status === "applied")
    if (applied.length === 0) {
        return {
            status: "no_match",
            hint: "No applied write entries in undo log. Use do read MATCH (e:WriteEvent) RETURN e.",
        }
    }

    const undone: Record<string, unknown>[] = []
    if (params.writeId !== undefined) {
        const entry = applied.find((candidate) => candidate.writeId === params.writeId)
        if (entry === undefined) {
            throw new NotFoundError(`writeId "${params.writeId}" not found or already undone`)
        }
        undone.push(await undoEntry(deps, entry))
    } else {
        const steps = params.steps ?? 1
        const targets = applied.slice(-steps).reverse()
        for (const entry of targets) {
            undone.push(await undoEntry(deps, entry))
        }
    }
    return { status: "ok", undone }
}

export async function undoLogEntry(
    deps: ServerDeps,
    entry: UndoLogEntry,
): Promise<Record<string, unknown>> {
    return undoEntry(deps, entry)
}

export function registerUndoTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "undo",
        {
            title: "書き込みの取り消し",
            description:
                "do 書き込みの逆操作を LIFO で適用する。steps（既定 1）または writeId を指定。undo 自体は新しい undo エントリを作らない。",
            inputSchema: {
                steps: z.number().int().positive().optional().describe("戻す件数（既定 1）"),
                writeId: z.string().min(1).optional().describe("特定の writeId のみ戻す"),
            },
        },
        async ({ steps, writeId }) => {
            try {
                return textResult(
                    await runUndo(deps, {
                        ...(steps !== undefined ? { steps } : {}),
                        ...(writeId !== undefined ? { writeId } : {}),
                    }),
                )
            } catch (error) {
                deps.log.error("undo failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
