import type { MidiTrack } from "@ableton-extensions/sdk"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { CATALOG_DEVICE_NAMES } from "./devices"

type V = TargetApiVersion
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

export type CatalogProbe = { name: string; insertable: boolean; error?: string }

export type CatalogSummary = {
    total: number
    insertable: number
    failed: number
    failedNames: string[]
    results: CatalogProbe[]
}

/** 挿入試行結果を集計する（純粋）。 */
export function summarizeCatalogResults(results: CatalogProbe[]): CatalogSummary {
    const failedNames = results.filter((probe) => !probe.insertable).map((probe) => probe.name)
    return {
        total: results.length,
        insertable: results.length - failedNames.length,
        failed: failedNames.length,
        failedNames,
        results,
    }
}

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

async function probeCatalog(track: MidiTrack<V>, deps: ServerDeps): Promise<CatalogProbe[]> {
    const results: CatalogProbe[] = []
    for (const name of CATALOG_DEVICE_NAMES) {
        try {
            const device = await deps.context.withinTransaction(() =>
                track.insertDevice(name, track.devices.length),
            )
            // 各デバイスは即時削除して次の試行から隔離する。
            await deps.context.withinTransaction(() => track.deleteDevice(device))
            results.push({ name, insertable: true })
        } catch (error) {
            results.push({ name, insertable: false, error: String(error) })
        }
    }
    return results
}

type VerifyCatalogParams = {
    preview: boolean | undefined
    confirm: boolean | undefined
}

/** 実行内容の事前提示（preview / confirm_required で返す計画）。 */
function catalogPlan(): Record<string, unknown> {
    return {
        devices: CATALOG_DEVICE_NAMES.length,
        note: `Creates 1 temporary MidiTrack, inserts and immediately deletes ${CATALOG_DEVICE_NAMES.length} devices on it, then deletes the track. Adds roughly ${CATALOG_DEVICE_NAMES.length * 2 + 2} entries to Live's undo history (the SDK cannot batch them into one step because each delete depends on the awaited insert result).`,
    }
}

async function runVerifyDeviceCatalog(
    deps: ServerDeps,
    params: VerifyCatalogParams,
): Promise<ToolResult> {
    if (params.preview === true) {
        return textResult({ status: "preview", ...catalogPlan() })
    }
    if (params.confirm !== true) {
        return textResult({
            status: "confirm_required",
            ...catalogPlan(),
            hint: "This probe temporarily mutates the Set and floods Live's undo history. Pass confirm:true to proceed.",
        })
    }
    const song = deps.context.application.song
    let track: MidiTrack<V> | undefined
    try {
        track = await deps.context.withinTransaction(() => song.createMidiTrack())
        const results = await probeCatalog(track, deps)
        // 掃除（一時トラック削除）の成否を応答に反映する。失敗時は Set に残留するため警告を返す。
        const temp_track = track
        track = undefined
        let cleanup: "ok" | "failed" = "ok"
        let cleanup_error: string | undefined
        try {
            await deps.context.withinTransaction(() => song.deleteTrack(temp_track))
        } catch (error) {
            cleanup = "failed"
            cleanup_error = String(error)
            deps.log.error("verify_device_catalog cleanup failed", { error: cleanup_error })
        }
        const payload: Record<string, unknown> = {
            status: "ok",
            ...summarizeCatalogResults(results),
            cleanup,
        }
        if (cleanup_error !== undefined) {
            payload.cleanupError = cleanup_error
            payload.warning =
                "The temporary MidiTrack could not be deleted and remains in the Set. Remove it with delete_track or Live undo."
        }
        return textResult(payload)
    } catch (error) {
        deps.log.error("verify_device_catalog failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    } finally {
        if (track !== undefined) {
            const leftover_track = track
            await deps.context
                .withinTransaction(() => song.deleteTrack(leftover_track))
                .catch((error: unknown) => {
                    deps.log.error("verify_device_catalog cleanup failed", {
                        error: String(error),
                    })
                })
        }
    }
}

/** `verify_device_catalog` ツール: 内蔵デバイスカタログ全項目の実機挿入可否を一括検証する。 */
export function registerCatalogTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "verify_device_catalog",
        {
            title: "内蔵デバイスカタログ検証",
            description:
                "内蔵デバイスカタログ全項目を一時 MidiTrack へ挿入試行し、挿入可否の一覧を返す（confirm:true 必須。無しは実行せず confirm_required と実行計画を返す）。各デバイスは即時削除し、一時トラックも最後に削除するため Set に残留しない（Live の undo 履歴にはデバイス数の約 2 倍の試行記録が残る。挿入結果に依存する削除を同期開始できないため SDK 制約で 1 undo ステップに束ねられない）。掃除に失敗した場合は応答の cleanup:failed と warning で申告する。失敗項目はカタログから除外するか実ロード名を調査する。",
            inputSchema: {
                preview: z.boolean().optional().describe("実行せず実行計画を返す"),
                confirm: z
                    .boolean()
                    .optional()
                    .describe("Set の一時変更と undo 履歴への大量記録を許可する"),
            },
        },
        async ({ preview, confirm }) => runVerifyDeviceCatalog(deps, { preview, confirm }),
    )
}
