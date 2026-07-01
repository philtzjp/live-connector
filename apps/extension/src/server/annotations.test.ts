import { describe, expect, it } from "vitest"
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
})
