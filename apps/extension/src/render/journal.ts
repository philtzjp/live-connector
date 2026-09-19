/**
 * Main 録音ジョブの永続 journal。クラッシュ後に未完了ジョブの復旧情報を提示する。
 * 破壊的な段階へ進む前に、復旧に必要な記録を確定する。
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { HybridError } from "@live-connector/error"
import type { ServerDeps } from "../deps"
import type { CaptureJournal } from "../types/hybrid"

const RENDERS_DIRECTORY_NAME = "renders"
const JOURNAL_FILE_NAME = "recovery.json"

function rendersDirectory(deps: ServerDeps): string {
    const storage = deps.context.environment.storageDirectory
    if (storage === undefined || storage.length === 0) {
        throw new HybridError(
            "ARTIFACT_STORAGE_UNAVAILABLE",
            "Ableton Extensions SDK did not provide environment.storageDirectory",
        )
    }
    return path.join(storage, RENDERS_DIRECTORY_NAME)
}

function journalDirectory(deps: ServerDeps, job_id: string): string {
    return path.join(rendersDirectory(deps), job_id)
}

function journalFilePath(deps: ServerDeps, job_id: string): string {
    return path.join(journalDirectory(deps, job_id), JOURNAL_FILE_NAME)
}

/** journal を原子的に更新する。 */
export async function writeJournal(deps: ServerDeps, journal: CaptureJournal): Promise<void> {
    const directory = journalDirectory(deps, journal.jobId)
    await mkdir(directory, { recursive: true })
    const updated: CaptureJournal = { ...journal, updatedAt: new Date().toISOString() }
    const temp_path = `${journalFilePath(deps, journal.jobId)}.tmp`
    await writeFile(temp_path, `${JSON.stringify(updated, null, 2)}\n`, "utf8")
    await rename(temp_path, journalFilePath(deps, journal.jobId))
}

export async function readJournal(
    deps: ServerDeps,
    job_id: string,
): Promise<CaptureJournal | null> {
    try {
        const raw = await readFile(journalFilePath(deps, job_id), "utf8")
        return JSON.parse(raw) as CaptureJournal
    } catch (error) {
        if (isMissing(error)) {
            return null
        }
        throw error
    }
}

/** 未完了の journal を列挙する（クラッシュ後の提示用）。 */
export async function listJournals(deps: ServerDeps): Promise<CaptureJournal[]> {
    let entries: string[]
    try {
        entries = await readdir(rendersDirectory(deps))
    } catch (error) {
        if (isMissing(error)) {
            return []
        }
        throw error
    }
    const journals: CaptureJournal[] = []
    for (const entry of entries) {
        const journal = await readJournal(deps, entry)
        if (journal !== null) {
            journals.push(journal)
        }
    }
    return journals
}

export async function deleteJournal(deps: ServerDeps, job_id: string): Promise<void> {
    await rm(journalFilePath(deps, job_id), { force: true })
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
    )
}
