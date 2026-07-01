import type { MidiTrack } from "@ableton-extensions/sdk"
import { toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
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

async function runVerifyDeviceCatalog(deps: ServerDeps): Promise<ToolResult> {
    const song = deps.context.application.song
    let track: MidiTrack<V> | undefined
    try {
        track = await deps.context.withinTransaction(() => song.createMidiTrack())
        const results = await probeCatalog(track, deps)
        return textResult({ status: "ok", ...summarizeCatalogResults(results) })
    } catch (error) {
        deps.log.error("verify_device_catalog failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    } finally {
        if (track !== undefined) {
            const temp_track = track
            await deps.context
                .withinTransaction(() => song.deleteTrack(temp_track))
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
                "内蔵デバイスカタログ全項目を一時 MidiTrack へ挿入試行し、挿入可否の一覧を返す。各デバイスは即時削除し、一時トラックも最後に削除するため Set に残留しない（Live の undo 履歴には試行の記録が残る）。失敗項目はカタログから除外するか実ロード名を調査する。",
            inputSchema: {},
        },
        async () => runVerifyDeviceCatalog(deps),
    )
}
