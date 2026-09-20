/** MCP ツール応答の共通型とヘルパ。 */

import { stringifyJson } from "@live-connector/json"

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

export type UndoableLevel = "full" | "partial" | "none"

export function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: stringifyJson(payload, 2) }], isError }
}

export function nextWriteId(counter: { value: number }): string {
    counter.value = (counter.value + 1) % 1_000_000
    return `write-${Date.now().toString(36)}-${counter.value.toString(36)}`
}

/** partial / none の書き込みは confirm:true が無ければ実行しない。 */
export function confirmGate(
    undoable: UndoableLevel,
    undoable_reason: string | undefined,
    confirm: boolean | undefined,
    plan: Record<string, unknown>,
): Record<string, unknown> | null {
    if (undoable === "full" || confirm === true) {
        return null
    }
    return {
        status: "confirm_required",
        undoable,
        ...(undoable_reason !== undefined ? { undoableReason: undoable_reason } : {}),
        plan,
    }
}
