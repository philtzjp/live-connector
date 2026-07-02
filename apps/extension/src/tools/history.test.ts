import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { registerHistoryTool, summarizeInput, summarizeResult, withWriteHistory } from "./history"

let storageDir: string

beforeEach(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "lc-history-"))
})

afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true })
})

function buildDeps(): ServerDeps {
    return {
        context: { environment: { storageDirectory: storageDir } },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
}

describe("summarizeInput / summarizeResult", () => {
    it("summarizes arrays as counts and truncates long strings", () => {
        const summary = summarizeInput({ notes: [1, 2, 3], select: "x".repeat(300), mode: "merge" })
        expect(summary.notes).toEqual({ count: 3 })
        expect(String(summary.select)).toHaveLength(201)
        expect(summary.mode).toBe("merge")
    })

    it("keeps only known result fields", () => {
        expect(summarizeResult({ status: "ok", modified: 2, targets: [1, 2], junk: true })).toEqual(
            {
                status: "ok",
                modified: 2,
            },
        )
    })

    it("keeps snapshot ids so history entries link to restore_snapshot", () => {
        const summary = summarizeResult({
            status: "ok",
            snapshotId: "snap-a-1",
            undoSnapshotId: "snap-a-2",
        })
        expect(summary.snapshotId).toBe("snap-a-1")
        expect(summary.undoSnapshotId).toBe("snap-a-2")
    })

    it("keeps the identifying fields of nested creation objects", () => {
        const summary = summarizeResult({
            status: "ok",
            clip: { index: 2, name: "Beat", length: 4, color: 123456 },
            track: { index: 5, name: "Drums", kind: "midi", devices: [] },
        })
        expect(summary.clip).toEqual({ index: 2, name: "Beat" })
        expect(summary.track).toEqual({ index: 5, name: "Drums", kind: "midi" })
    })

    it("keeps the batch step breakdown as tool names", () => {
        const summary = summarizeResult({
            status: "ok",
            steps: [
                { tool: "set_song", mode: undefined },
                { tool: "write_notes", noteCount: 3 },
            ],
        })
        expect(summary.steps).toEqual({ count: 2, tools: ["set_song", "write_notes"] })
    })
})

describe("write history recording", () => {
    it("records ok writes, skips preview, and reads them back after host restart", async () => {
        const deps = buildDeps()
        const server = new FakeMcpServer()
        const facade = withWriteHistory(server.asMcpServer(), deps)
        facade.registerTool("set_track", {}, async (args: Record<string, unknown>) => ({
            content: [
                {
                    type: "text",
                    text: JSON.stringify(
                        args.preview === true
                            ? { status: "preview" }
                            : { status: "ok", modified: 1 },
                    ),
                },
            ],
        }))
        registerHistoryTool(server.asMcpServer(), deps)

        await server.call("set_track", { select: "MATCH (t) RETURN t", preview: true })
        await server.call("set_track", { select: "MATCH (t) RETURN t", set: { name: "B" } })

        // 別 deps インスタンス（＝ホスト再起動相当）でも同じ storageDirectory から読める。
        const restarted = new FakeMcpServer()
        registerHistoryTool(restarted.asMcpServer(), buildDeps())
        const { json } = (await restarted.call("get_write_history", {})) as {
            json: { total: number; count: number; entries: { tool: string; result: unknown }[] }
        }
        expect(json.total).toBe(1)
        expect(json.entries[0]?.tool).toBe("set_track")
        expect(json.entries[0]?.result).toMatchObject({ status: "ok", modified: 1 })
    })

    it("does not record tools outside the write set", async () => {
        const deps = buildDeps()
        const server = new FakeMcpServer()
        const facade = withWriteHistory(server.asMcpServer(), deps)
        facade.registerTool("query", {}, async () => ({
            content: [{ type: "text", text: JSON.stringify({ status: "ok", count: 0 }) }],
        }))
        registerHistoryTool(server.asMcpServer(), deps)

        await server.call("query", { cypher: "MATCH (t:Track) RETURN t" })
        const { json } = (await server.call("get_write_history", {})) as { json: { total: number } }
        expect(json.total).toBe(0)
    })

    it("returns entries newest-first as the tool description declares", async () => {
        const deps = buildDeps()
        const server = new FakeMcpServer()
        const facade = withWriteHistory(server.asMcpServer(), deps)
        let call_index = 0
        facade.registerTool("set_track", {}, async () => {
            call_index++
            return {
                content: [
                    { type: "text", text: JSON.stringify({ status: "ok", modified: call_index }) },
                ],
            }
        })
        registerHistoryTool(server.asMcpServer(), deps)

        await server.call("set_track", { set: { name: "first" } })
        await server.call("set_track", { set: { name: "second" } })
        await server.call("set_track", { set: { name: "third" } })

        const { json } = (await server.call("get_write_history", {})) as {
            json: { entries: { result: { modified: number } }[] }
        }
        expect(json.entries.map((entry) => entry.result.modified)).toEqual([3, 2, 1])
    })

    it("surfaces storage failures instead of returning an empty ok response", async () => {
        const deps = buildDeps()
        // 履歴ファイルのパスをディレクトリにして EISDIR を誘発する（ENOENT 以外の fs 障害の代表）。
        await mkdir(path.join(storageDir, "history", "write-history.jsonl"), { recursive: true })
        const server = new FakeMcpServer()
        registerHistoryTool(server.asMcpServer(), deps)

        const { isError } = await server.call("get_write_history", {})
        expect(isError).toBe(true)
    })
})
