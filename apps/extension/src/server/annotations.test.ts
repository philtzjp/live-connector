import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { TOOL_ANNOTATIONS, withToolAnnotations } from "./annotations"

describe("withToolAnnotations", () => {
    it("injects annotations for the four tools", () => {
        const server = new FakeMcpServer()
        const facade = withToolAnnotations(server.asMcpServer()) as unknown as {
            registerTool: (
                name: string,
                config: Record<string, unknown>,
                handler: unknown,
            ) => unknown
        }
        const handler = async () => ({ content: [{ type: "text", text: "{}" }] })
        facade.registerTool("meta", { title: "M" }, handler)
        facade.registerTool("do", { title: "D" }, handler)
        facade.registerTool("undo", { title: "U" }, handler)
        facade.registerTool("render", { title: "R" }, handler)

        expect(server.tools.get("meta")?.config.annotations).toEqual({ readOnlyHint: true })
        expect(
            (server.tools.get("do")?.config.annotations as { destructiveHint?: boolean })
                ?.destructiveHint,
        ).toBe(true)
        expect(
            (server.tools.get("undo")?.config.annotations as { idempotentHint?: boolean })
                ?.idempotentHint,
        ).toBe(false)
        // render は Main 実時間録音で一時トラック・Transport を変更するため保守的に destructive とする。
        expect(server.tools.get("render")?.config.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        })
    })

    it("covers every registered tool with an annotation", async () => {
        vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
        const { registerAllTools } = await import("./mcp")
        const server = new FakeMcpServer()
        registerAllTools(server.asMcpServer(), {} as unknown as ServerDeps)
        const registered = [...server.tools.keys()].sort((left, right) => left.localeCompare(right))
        const annotated = Object.keys(TOOL_ANNOTATIONS).sort((left, right) =>
            left.localeCompare(right),
        )
        expect(annotated).toEqual(registered)
        expect(registered).toEqual(["do", "meta", "render", "undo"])
    })
})
