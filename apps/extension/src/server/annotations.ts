import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export type ToolAnnotations = {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true }
const DO_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true }
const UNDO_WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
}
const RENDER: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
}

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
    meta: READ_ONLY,
    do: DO_WRITE,
    undo: UNDO_WRITE,
    render: RENDER,
}

type RegisterConfig = Record<string, unknown>
type RegisterHandler = (...args: unknown[]) => unknown

export function withToolAnnotations(server: McpServer): McpServer {
    return {
        registerTool(name: string, config: RegisterConfig, handler: RegisterHandler) {
            const annotations = TOOL_ANNOTATIONS[name]
            const merged = annotations !== undefined ? { ...config, annotations } : config
            return (
                server.registerTool as unknown as (
                    n: string,
                    c: RegisterConfig,
                    h: RegisterHandler,
                ) => unknown
            )(name, merged, handler)
        },
    } as unknown as McpServer
}
