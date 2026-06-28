import { type Device, DrumRack, RackDevice, Simpler, Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type InsertDeviceParams = {
    select: string
    deviceName: string
    index: number | undefined
    preview: boolean | undefined
}

/**
 * 内蔵 Live デバイス名の参考カタログ。
 * SDK にデバイス列挙 API が無いため、Browser ツリー探索／列挙の代替として提示する。
 * `Track.insertDevice` は表示名と一致する内蔵デバイスのみ受け付ける（サードパーティ
 * プラグインや .adv/.adg などのプリセットファイルは挿入できない）。網羅的ではなく、
 * 正確な名称は Live のブラウザ表示に合わせること。
 */
const BUILT_IN_DEVICE_CATALOG = {
    instruments: [
        "Operator",
        "Wavetable",
        "Analog",
        "Collision",
        "Electric",
        "Tension",
        "Drift",
        "Meld",
        "Sampler",
        "Simpler",
        "Drum Rack",
        "Impulse",
        "Bass",
        "Poli",
    ],
    audioEffects: [
        "Reverb",
        "Hybrid Reverb",
        "Delay",
        "Echo",
        "EQ Eight",
        "EQ Three",
        "Compressor",
        "Glue Compressor",
        "Limiter",
        "Gate",
        "Auto Filter",
        "Saturator",
        "Overdrive",
        "Utility",
        "Auto Pan",
        "Chorus-Ensemble",
        "Phaser-Flanger",
        "Redux",
        "Drum Buss",
        "Pedal",
        "Amp",
        "Cabinet",
        "Corpus",
        "Resonators",
    ],
    midiEffects: ["Arpeggiator", "Chord", "Scale", "Note Length", "Pitch", "Random", "Velocity"],
} as const

const CATALOG_DEVICE_NAMES: string[] = [
    ...BUILT_IN_DEVICE_CATALOG.instruments,
    ...BUILT_IN_DEVICE_CATALOG.audioEffects,
    ...BUILT_IN_DEVICE_CATALOG.midiEffects,
]

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function selectDescription(): string {
    return 'Track を単一ノード変数で RETURN する Cypher。プロパティ射影（RETURN t.name）や複数変数（RETURN t, d）は不可。例: MATCH (t:MidiTrack {name:"Lead"}) RETURN t'
}

function deviceNameDescription(): string {
    return `挿入する内蔵 Live デバイスの表示名（例: "Operator", "Reverb", "Auto Filter"）。サードパーティプラグインや .adv/.adg などのプリセットファイルは挿入できない。よく使う名称: ${CATALOG_DEVICE_NAMES.join(", ")}`
}

function deviceLabel(device: Device<TargetApiVersion>): string {
    if (device instanceof DrumRack) {
        return "DrumRack"
    }
    if (device instanceof RackDevice) {
        return "RackDevice"
    }
    if (device instanceof Simpler) {
        return "Simpler"
    }
    return "Device"
}

function resolveSingleTrack(nodes: LomNode[]): {
    node: LomNode
    track: Track<TargetApiVersion>
} {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `insert_device requires the selection to match exactly one Track, but matched ${nodes.length}`,
            {
                hint: 'select が Track ノードを 1 つだけ返すようにする。例: MATCH (t:MidiTrack {name:"Lead"}) RETURN t.',
            },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof Track)) {
        throw new BadRequestError("select must return a Track", {
            hint: "MidiTrack / AudioTrack / Track のいずれかを RETURN する select を使う。",
        })
    }
    return { node, track: node.value as Track<TargetApiVersion> }
}

function resolveInsertIndex(track: Track<TargetApiVersion>, index: number | undefined): number {
    const device_count = track.devices.length
    if (index === undefined) {
        return device_count
    }
    if (!Number.isInteger(index) || index < 0 || index > device_count) {
        throw new BadRequestError(
            `insert index must be an integer in [0, ${device_count}], but received ${index}`,
            { hint: "index を省略するとデバイスチェーンの末尾に追加する。" },
        )
    }
    return index
}

function deviceSummary(
    track: Track<TargetApiVersion>,
    device: Device<TargetApiVersion>,
): Record<string, unknown> {
    const index = track.devices.findIndex((candidate) => candidate.handle === device.handle)
    return {
        _label: deviceLabel(device),
        name: device.name,
        index,
        parameterCount: device.parameters.length,
    }
}

async function runInsertDeviceTool(
    deps: ServerDeps,
    params: InsertDeviceParams,
): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const { node, track } = resolveSingleTrack(
            await selectNodes(parseQuery(params.select), adapter),
        )
        const insert_index = resolveInsertIndex(track, params.index)
        const summary = {
            track: await adapter.serialize(node),
            deviceName: params.deviceName,
            index: insert_index,
        }

        if (params.preview === true) {
            return textResult({ status: "preview", ...summary })
        }

        let device: Device<TargetApiVersion>
        try {
            device = await deps.context.withinTransaction(() =>
                track.insertDevice(params.deviceName, insert_index),
            )
        } catch (_cause) {
            throw new NotFoundError(`failed to insert device "${params.deviceName}"`, {
                hint: "deviceName は Live 内蔵デバイスの表示名と一致させる。サードパーティプラグインや .adv/.adg などのプリセットファイルは挿入できない。",
                validDeviceNames: CATALOG_DEVICE_NAMES,
            })
        }

        return textResult({
            status: "ok",
            ...summary,
            device: deviceSummary(track, device),
        })
    } catch (error) {
        deps.log.error("insert_device failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** `insert_device` ツール: select で選んだ 1 つの Track に内蔵 Live デバイスを挿入する。 */
export function registerDeviceTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "insert_device",
        {
            title: "内蔵デバイス挿入",
            description:
                "select で選んだ 1 つの Track のデバイスチェーンに、内蔵 Live デバイスを挿入する。index 省略時は末尾に追加する。MidiTrack にインストゥルメントを挿入するとノートが発音可能になる。内蔵デバイスのデフォルトプリセットのみ挿入でき、サードパーティプラグインやプリセットファイルは扱えない。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                deviceName: z.string().min(1).describe(deviceNameDescription()),
                index: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("挿入位置（0 始まり, [0, デバイス数]）。省略時は末尾に追加する"),
                preview: z.boolean().optional().describe("挿入せず対象と挿入内容を返すドライラン"),
            },
        },
        async ({ select, deviceName, index, preview }) =>
            runInsertDeviceTool(deps, { select, deviceName, index, preview }),
    )
}
