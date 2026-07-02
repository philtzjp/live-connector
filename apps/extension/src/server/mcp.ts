import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerDeps } from "../deps"
import { registerArrangementTools } from "../tools/arrangement"
import { registerAudioTools } from "../tools/audio"
import { registerBatchTool } from "../tools/batch"
import { registerCatalogTools } from "../tools/catalog"
import { registerCreateTools } from "../tools/create"
import { registerDeviceTools } from "../tools/devices"
import { registerHistoryTool, withWriteHistory } from "../tools/history"
import { registerNotesTool } from "../tools/notes"
import { registerOverviewTool } from "../tools/overview"
import { registerPresetTools } from "../tools/presets"
import { registerQueryTool } from "../tools/query"
import { registerSampleTools } from "../tools/samples"
import { registerSchemaTool } from "../tools/schema"
import { registerSnapshotTools } from "../tools/snapshots"
import { registerStructureTools } from "../tools/structure"
import { registerTransformNotesTool } from "../tools/transform-notes"
import { registerWriteTools } from "../tools/write"
import { SERVICE_VERSION } from "../version"
import { withToolAnnotations } from "./annotations"

/** initialize 応答でクライアントへ配布する運用規約の要約。 */
const SERVER_INSTRUCTIONS = `live-connector controls an Ableton Live Set as a property graph over the Live Object Model (LOM).

Recommended flow: (1) call schema for labels/properties/relationships and the query contract; (2) read with query (Cypher subset: MATCH/WHERE/RETURN with aggregates count/min/max/avg/sum, ORDER BY, DISTINCT, SKIP/LIMIT); (3) for writes, run preview:true first, then apply.

Time coordinates (two systems, do not mix): note startTime and clip markers (startMarker/endMarker/loopStart/loopEnd) are CLIP-RELATIVE beats in [0, clipLength). Clip.startTime/endTime, CuePoint.time and create_arrangement_clip/move_clip startTime are ARRANGEMENT-ABSOLUTE beats. write_notes rejects out-of-range notes unless allowOutOfRange:true.

Guardrails: bulk property writes over 20 targets need confirm:true; query without LIMIT truncates at 500 rows (truncated:true); destructive delete_* tools need confirm:true. set_* and write_notes return a snapshotId; restore_snapshot rolls back. batch groups set_*/write_notes into one undo step.

Mixer: track volume, panning and sends are Parameters reached via (Track)-[:HAS_MIXER]->(Mixer)-[:HAS_VOLUME|HAS_PAN|HAS_SEND]->(Parameter). Read with query and write with set_device_parameter (value), not set_track.

Tool annotations mark read-only, destructive and idempotent operations.`

/** 登録ツール構成のサマリ。/health で稼働ホストのツール構成を外形確認するために使う。 */
export type RegisteredToolsSummary = {
    count: number
    digest: string
    names: string[]
}

/**
 * すべての MCP ツールを登録する（createMcpServer と describeRegisteredTools で共通の登録経路）。
 * テストからも参照し、登録ツールの inputSchema と lom-schema の契約一覧の突合に使う。
 */
export function registerAllTools(server: McpServer, deps: ServerDeps): void {
    registerSchemaTool(server, deps)
    registerOverviewTool(server, deps)
    registerQueryTool(server, deps)
    registerAudioTools(server, deps)
    registerArrangementTools(server, deps)
    registerCreateTools(server, deps)
    registerDeviceTools(server, deps)
    registerPresetTools(server, deps)
    registerWriteTools(server, deps)
    registerNotesTool(server, deps)
    registerTransformNotesTool(server, deps)
    registerStructureTools(server, deps)
    registerSampleTools(server, deps)
    registerHistoryTool(server, deps)
    registerSnapshotTools(server, deps)
    registerBatchTool(server, deps)
    registerCatalogTools(server, deps)
}

/** ソート済みツール名から安定した短いダイジェスト（djb2, 8 桁 hex）を導出する。 */
function toolsDigest(names: string[]): string {
    const joined = names.join(",")
    let hash = 5381
    for (let index = 0; index < joined.length; index++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}

/** ツールを登録した MCP サーバーを生成する（リクエストごとに生成し、共有 deps を閉じ込める）。 */
export function createMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer(
        { name: "live-connector", version: SERVICE_VERSION },
        { instructions: SERVER_INSTRUCTIONS },
    )
    // annotations 注入 → 書き込み履歴ラップ の facade を重ねて登録する。
    registerAllTools(withToolAnnotations(withWriteHistory(server, deps)), deps)
    return server
}

/**
 * 実際の登録経路をたどって登録ツール名を収集する（ハンドラは実行しない）。
 * createMcpServer と同一の register* を通すため、ツール構成と乖離しない。
 */
export function describeRegisteredTools(deps: ServerDeps): RegisteredToolsSummary {
    const names: string[] = []
    const collector = {
        registerTool(name: string) {
            names.push(name)
        },
    } as unknown as McpServer
    registerAllTools(collector, deps)
    names.sort((left, right) => left.localeCompare(right))
    return { count: names.length, digest: toolsDigest(names), names }
}
