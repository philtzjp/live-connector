import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigError } from "@live-connector/error"
import { stringifyJson } from "@live-connector/json"
import type { ServerDeps } from "../deps"
import type { UndoLogEntry } from "./types"

const UNDO_DIRECTORY_NAME = "undo"
const UNDO_FILE_NAME = "undo-log.jsonl"
const MAX_UNDO_ENTRIES = 200

function undoDirectory(deps: ServerDeps): string {
    const storage = deps.context.environment.storageDirectory
    if (storage === undefined || storage.length === 0) {
        throw new ConfigError("Ableton Extensions SDK did not provide environment.storageDirectory")
    }
    return path.join(storage, UNDO_DIRECTORY_NAME)
}

function undoFilePath(deps: ServerDeps): string {
    return path.join(undoDirectory(deps), UNDO_FILE_NAME)
}

function isFileMissingError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
    )
}

async function readAllEntries(deps: ServerDeps): Promise<UndoLogEntry[]> {
    const file_path = undoFilePath(deps)
    let raw: string
    try {
        raw = await readFile(file_path, "utf8")
    } catch (error) {
        if (isFileMissingError(error)) {
            return []
        }
        throw error
    }
    const entries: UndoLogEntry[] = []
    for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) {
            continue
        }
        entries.push(JSON.parse(trimmed) as UndoLogEntry)
    }
    return entries
}

async function writeAllEntries(deps: ServerDeps, entries: UndoLogEntry[]): Promise<void> {
    const directory = undoDirectory(deps)
    await mkdir(directory, { recursive: true })
    const body =
        entries.length === 0 ? "" : `${entries.map((entry) => stringifyJson(entry)).join("\n")}\n`
    await writeFile(undoFilePath(deps), body, "utf8")
}

async function pruneEntries(entries: UndoLogEntry[]): Promise<UndoLogEntry[]> {
    if (entries.length <= MAX_UNDO_ENTRIES) {
        return entries
    }
    return entries.slice(entries.length - MAX_UNDO_ENTRIES)
}

export async function appendUndoEntry(deps: ServerDeps, entry: UndoLogEntry): Promise<void> {
    const directory = undoDirectory(deps)
    await mkdir(directory, { recursive: true })
    await appendFile(undoFilePath(deps), `${stringifyJson(entry)}\n`, "utf8")
    const all = await readAllEntries(deps)
    const pruned = await pruneEntries(all)
    if (pruned.length < all.length) {
        await writeAllEntries(deps, pruned)
    }
}

export async function listUndoEntries(deps: ServerDeps): Promise<UndoLogEntry[]> {
    return readAllEntries(deps)
}

export async function markEntryUndone(deps: ServerDeps, write_id: string): Promise<boolean> {
    const entries = await readAllEntries(deps)
    let updated = false
    for (const entry of entries) {
        if (entry.writeId === write_id && entry.status === "applied") {
            entry.status = "undone"
            updated = true
        }
    }
    if (updated) {
        await writeAllEntries(deps, entries)
    }
    return updated
}

/** WriteEvent 仮想ラベル照会用。 */
export async function listWriteEventsForQuery(deps: ServerDeps): Promise<UndoLogEntry[]> {
    return readAllEntries(deps)
}
