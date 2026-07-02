import { query_contract } from "@live-connector/lom-schema"
import { describe, expect, it, vi } from "vitest"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"

// SDK 実体をロードせずに register* を通す。version.ts の注入はグローバルで代替する。
vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

async function collectSelectTools(): Promise<string[]> {
    vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
    const { registerAllTools } = await import("./mcp")
    const server = new FakeMcpServer()
    registerAllTools(server.asMcpServer(), {} as unknown as ServerDeps)
    const names: string[] = []
    for (const [name, tool] of server.tools) {
        const input_schema = tool.config.inputSchema as Record<string, unknown> | undefined
        if (input_schema !== undefined && "select" in input_schema) {
            names.push(name)
        }
    }
    return names.sort((left, right) => left.localeCompare(right))
}

describe("query_contract.select.tools", () => {
    it("matches the registered tools that accept a top-level select input", async () => {
        // batch はステップ内に select を持つがトップレベル入力ではないため対象外。
        const registered = await collectSelectTools()
        const contract = [...query_contract.select.tools].sort((left, right) =>
            left.localeCompare(right),
        )
        expect(contract).toEqual(registered)
    })
})
