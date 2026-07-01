import { stat } from "node:fs/promises"
import path from "node:path"
import { Simpler } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type V = TargetApiVersion
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const AUDIO_EXTENSIONS = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a", ".aac"])

/** 対応オーディオ拡張子か（純粋判定）。 */
export function isSupportedAudioPath(filePath: string): boolean {
    return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/** 絶対パス・対応形式を検証する（fs アクセスは行わない）。不正なら BadRequestError。 */
export function assertSamplePath(filePath: string): void {
    if (!path.isAbsolute(filePath)) {
        throw new BadRequestError("audioFilePath must be an absolute path", {
            hint: "Pass an absolute path, e.g. /Users/name/Samples/kick.wav.",
        })
    }
    if (!isSupportedAudioPath(filePath)) {
        throw new BadRequestError(
            `unsupported audio format "${path.extname(filePath)}" for audioFilePath`,
            { hint: `Supported extensions: ${[...AUDIO_EXTENSIONS].join(", ")}.` },
        )
    }
}

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function resolveSimpler(nodes: LomNode[]): Simpler<V> {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `load_sample requires the selection to match exactly one Simpler, but matched ${nodes.length}`,
            { hint: "Change select so it returns exactly one Simpler device node." },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof Simpler)) {
        throw new BadRequestError("select must return a Simpler", {
            hint: 'Insert a Simpler with insert_device first, or select a Simpler inside a Drum Rack pad. Example: MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(s:Simpler) RETURN s.',
        })
    }
    return node.value
}

type LoadSampleParams = {
    select: string
    audioFilePath: string
    preview: boolean | undefined
}

async function runLoadSample(deps: ServerDeps, params: LoadSampleParams): Promise<ToolResult> {
    try {
        assertSamplePath(params.audioFilePath)
        const adapter = new LomGraphAdapter(deps.context)
        const simpler = resolveSimpler(await selectNodes(parseQuery(params.select), adapter))

        try {
            const file_stat = await stat(params.audioFilePath)
            if (!file_stat.isFile()) {
                throw new BadRequestError("audioFilePath is not a file")
            }
        } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error) {
                throw new NotFoundError(`audio file was not found: ${params.audioFilePath}`, {
                    hint: "Check the absolute path exists and is readable.",
                })
            }
            throw error
        }

        const summary = {
            device: { name: simpler.name },
            audioFilePath: params.audioFilePath,
        }
        if (params.preview === true) {
            return textResult({ status: "preview", ...summary })
        }

        // importIntoProject はファイルコピー（非トランザクション）。replaceSample はデバイス変更。
        const imported = await deps.context.resources.importIntoProject(params.audioFilePath)
        await deps.context.withinTransaction(() => simpler.replaceSample(imported))

        return textResult({ status: "ok", ...summary, importedPath: imported })
    } catch (error) {
        deps.log.error("load_sample failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** `load_sample` ツール: select で選んだ Simpler に任意オーディオファイルを読み込む。 */
export function registerSampleTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "load_sample",
        {
            title: "サンプル読み込み",
            description:
                "select で選んだ 1 つの Simpler に、audioFilePath のオーディオを読み込む（importIntoProject でプロジェクトへ取り込み、replaceSample で適用）。Drum Rack のパッド内 Simpler も対象。Simpler 未挿入のトラックには先に insert_device で Simpler を挿入する。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'Simpler を単一ノード変数で RETURN する Cypher。例: MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(s:Simpler) RETURN s',
                    ),
                audioFilePath: z.string().min(1).describe("読み込むオーディオファイルの絶対パス"),
                preview: z.boolean().optional().describe("適用せず対象と入力を返すドライラン"),
            },
        },
        async ({ select, audioFilePath, preview }) =>
            runLoadSample(deps, { select, audioFilePath, preview }),
    )
}
