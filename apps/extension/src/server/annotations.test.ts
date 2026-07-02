import { describe, expect, it, vi } from "vitest"

// registerAllTools（登録ツールとの網羅一致テスト）が SDK 実体を読むため、フェイクへ差し替える。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { TOOL_ANNOTATIONS, withToolAnnotations } from "./annotations"

describe("withToolAnnotations", () => {
    it("injects read-only, destructive and idempotent hints by tool name", () => {
        const server = new FakeMcpServer()
        const facade = withToolAnnotations(server.asMcpServer()) as unknown as {
            registerTool: (
                name: string,
                config: Record<string, unknown>,
                handler: unknown,
            ) => unknown
        }
        const handler = async () => ({ content: [{ type: "text", text: "{}" }] })
        facade.registerTool("query", { title: "Q" }, handler)
        facade.registerTool("delete_track", { title: "D" }, handler)
        facade.registerTool("set_track", { title: "S" }, handler)
        facade.registerTool("unknown_tool", { title: "U" }, handler)

        expect(server.tools.get("query")?.config.annotations).toEqual({ readOnlyHint: true })
        expect(server.tools.get("delete_track")?.config.annotations).toMatchObject({
            destructiveHint: true,
        })
        expect(server.tools.get("set_track")?.config.annotations).toMatchObject({
            idempotentHint: true,
        })
        expect(server.tools.get("unknown_tool")?.config.annotations).toBeUndefined()
    })

    it("marks read tools read-only and delete tools destructive in the map", () => {
        for (const name of ["schema", "get_overview", "query", "list_snapshots"]) {
            expect(TOOL_ANNOTATIONS[name]?.readOnlyHint).toBe(true)
        }
        for (const name of ["delete_scene", "delete_device", "delete_session_clip"]) {
            expect(TOOL_ANNOTATIONS[name]?.destructiveHint).toBe(true)
        }
    })

    it("marks replacing writes destructive per the MCP additive-only semantics", () => {
        // destructiveHint:false は「additive な更新のみ」を意味するため、置換・削除を行うツールは true。
        for (const name of ["write_notes", "transform_notes", "batch", "restore_snapshot"]) {
            expect(TOOL_ANNOTATIONS[name]?.destructiveHint).toBe(true)
        }
        expect(TOOL_ANNOTATIONS.load_sample?.destructiveHint).toBe(true)
        for (const name of ["move_clip", "trim_clip", "restore_snapshot", "load_sample"]) {
            expect(TOOL_ANNOTATIONS[name]?.idempotentHint).toBe(true)
        }
    })

    it("covers every registered tool with an annotation and lists no stale names", async () => {
        vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
        const { registerAllTools } = await import("./mcp")
        const server = new FakeMcpServer()
        registerAllTools(server.asMcpServer(), {} as unknown as ServerDeps)
        const registered = [...server.tools.keys()].sort((left, right) => left.localeCompare(right))
        const annotated = Object.keys(TOOL_ANNOTATIONS).sort((left, right) =>
            left.localeCompare(right),
        )
        expect(annotated).toEqual(registered)
    })
})
