import { parseQuery, type ScalarValue, selectNodes } from "@live-connector/cypher"
import { BadRequestError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"
import { capturePropertiesSnapshot, objectIdentity } from "./snapshots"

/** これを超える件数の変更は confirm:true を要求する。 */
const CONFIRM_THRESHOLD = 20

const SONG_SELECT = "MATCH (s:Song) RETURN s"

/**
 * set_* ツールの per-property zod スキーマの正本。
 * batch のステップ検証も同じスキーマを使い、単体ツールとの検証等価性を保つ。
 */
export const SET_TOOL_SET_SCHEMAS = {
    set_song: z.object({ tempo: z.number().positive().optional() }),
    set_track: z.object({
        name: z.string().optional(),
        arm: z.boolean().optional(),
        mute: z.boolean().optional(),
        solo: z.boolean().optional(),
    }),
    set_clip: z.object({
        name: z.string().optional(),
        color: z.number().optional(),
        muted: z.boolean().optional(),
        looping: z.boolean().optional(),
        warping: z.boolean().optional(),
        warpMode: z
            .enum(["Beats", "Tones", "Texture", "Repitch", "Complex", "ComplexPro"])
            .optional(),
    }),
    set_scene: z.object({ name: z.string().optional() }),
    set_cue_point: z.object({ name: z.string().optional() }),
    set_device_parameter: z.object({ value: z.number() }),
} as const

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type SetParams = {
    select: string
    set: Record<string, ScalarValue | undefined>
    preview: boolean | undefined
    confirm: boolean | undefined
    /** 対象が無い / 型不一致のときに、新規作成ツール等を案内する追加ヒント。 */
    createHint?: string
}

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function selectDescription(label: string, example: string): string {
    return `${label} を単一ノード変数で RETURN する Cypher。query のようなプロパティ射影（RETURN t.name）や複数変数（RETURN t, c）は不可。例: ${example}`
}

/** select でノードを解決し、ラベル検証・ガードレールを経てプロパティを適用する共通処理。 */
async function runSetTool(
    deps: ServerDeps,
    requiredLabel: string,
    toolName: string,
    params: SetParams,
): Promise<ToolResult> {
    try {
        const entries = Object.entries(params.set).filter(
            (entry): entry is [string, ScalarValue] => entry[1] !== undefined,
        )
        if (entries.length === 0) {
            throw new BadRequestError("`set` must contain at least one property to write")
        }

        const create_suffix = params.createHint !== undefined ? ` ${params.createHint}` : ""
        const adapter = new LomGraphAdapter(deps.context)
        const nodes = await selectNodes(parseQuery(params.select), adapter)
        for (const node of nodes) {
            if (!adapter.matchesLabel(node, requiredLabel)) {
                throw new BadRequestError(
                    `${toolName} edits existing ${requiredLabel} nodes, but the select matched a ${adapter.labelOf(node)} node`,
                    {
                        hint: `Change the select query so it returns ${requiredLabel} nodes only.${create_suffix}`,
                    },
                )
            }
        }

        if (nodes.length === 0) {
            throw new NotFoundError(`select matched no ${requiredLabel} to edit`, {
                hint: `Adjust the select query, or run query/schema to inspect available ${requiredLabel} nodes.${create_suffix}`,
            })
        }
        if (params.preview === true) {
            const targets = await Promise.all(nodes.map((node) => adapter.serialize(node)))
            return textResult({
                status: "preview",
                matched: nodes.length,
                set: Object.fromEntries(entries),
                targets,
            })
        }
        if (nodes.length > CONFIRM_THRESHOLD && params.confirm !== true) {
            return textResult({
                status: "confirm_required",
                matched: nodes.length,
                hint: `This will modify ${nodes.length} nodes. Pass confirm:true to proceed.`,
            })
        }

        const old_targets = await Promise.all(nodes.map((node) => adapter.serialize(node)))
        const snapshot_id = await capturePropertiesSnapshot(deps, {
            tool: toolName,
            select: params.select,
            requiredLabel,
            properties: entries.map(([property]) => property),
            oldTargets: old_targets,
            targetIdentities: nodes.map((node) => objectIdentity(node.value)),
        })

        await deps.context.withinTransaction(() => {
            const ops: Promise<void>[] = []
            for (const node of nodes) {
                for (const [property, value] of entries) {
                    ops.push(adapter.setProperty(node, property, value))
                }
            }
            return Promise.all(ops)
        })

        return textResult({
            status: "ok",
            modified: nodes.length,
            set: Object.fromEntries(entries),
            snapshotId: snapshot_id,
        })
    } catch (error) {
        deps.log.error("set tool failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

const previewShape = {
    preview: z.boolean().optional().describe("適用せず対象と変更内容を返すドライラン"),
    confirm: z.boolean().optional().describe("大量変更を許可する"),
}

/** set_* / write 系ツールを登録する。 */
export function registerWriteTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "set_song",
        {
            title: "Song プロパティ書き込み",
            description: "Song のプロパティ（tempo）を書き込む。",
            inputSchema: {
                set: SET_TOOL_SET_SCHEMAS.set_song,
                ...previewShape,
            },
        },
        async ({ set, preview, confirm }) =>
            runSetTool(deps, "Song", "set_song", { select: SONG_SELECT, set, preview, confirm }),
    )

    server.registerTool(
        "set_track",
        {
            title: "Track プロパティ書き込み",
            description:
                "select で選んだ既存 Track に name/arm/mute/solo を書き込む。新規作成は create_track を使う。ミキサーの volume/panning/send は HAS_MIXER 経由の Parameter を set_device_parameter で書く。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        selectDescription("Track", 'MATCH (t:Track {name:"Drums"}) RETURN t'),
                    ),
                set: SET_TOOL_SET_SCHEMAS.set_track,
                ...previewShape,
            },
        },
        async ({ select, set, preview, confirm }) =>
            runSetTool(deps, "Track", "set_track", {
                select,
                set,
                preview,
                confirm,
                createHint: "To create a new track, use create_track.",
            }),
    )

    server.registerTool(
        "set_clip",
        {
            title: "Clip プロパティ書き込み",
            description:
                "select で選んだ Clip に name/color/muted/looping（AudioClip は warping/warpMode）を書き込む。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(selectDescription("Clip", 'MATCH (c:Clip {name:"Loop"}) RETURN c')),
                set: SET_TOOL_SET_SCHEMAS.set_clip,
                ...previewShape,
            },
        },
        async ({ select, set, preview, confirm }) =>
            runSetTool(deps, "Clip", "set_clip", { select, set, preview, confirm }),
    )

    server.registerTool(
        "set_scene",
        {
            title: "Scene プロパティ書き込み",
            description:
                "select で選んだ既存 Scene の name を編集する。新規作成は create_scene を使う。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(selectDescription("Scene", "MATCH (s:Scene {index:0}) RETURN s")),
                set: SET_TOOL_SET_SCHEMAS.set_scene,
                ...previewShape,
            },
        },
        async ({ select, set, preview, confirm }) =>
            runSetTool(deps, "Scene", "set_scene", {
                select,
                set,
                preview,
                confirm,
                createHint: "To create a new scene, use create_scene.",
            }),
    )

    server.registerTool(
        "set_cue_point",
        {
            title: "CuePoint プロパティ書き込み",
            description:
                "select で選んだ既存 CuePoint の name を編集する（編集専用）。新規作成は create_cue_point を使う。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        selectDescription("CuePoint", 'MATCH (c:CuePoint {name:"Verse"}) RETURN c'),
                    ),
                set: SET_TOOL_SET_SCHEMAS.set_cue_point,
                ...previewShape,
            },
        },
        async ({ select, set, preview, confirm }) =>
            runSetTool(deps, "CuePoint", "set_cue_point", {
                select,
                set,
                preview,
                confirm,
                createHint: "To create a new CuePoint, use create_cue_point.",
            }),
    )

    server.registerTool(
        "set_device_parameter",
        {
            title: "DeviceParameter 値書き込み",
            description: "select で選んだ Parameter の value を書き込む。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        selectDescription(
                            "Parameter",
                            'MATCH (:Track {name:"Lead"})-[:HAS_DEVICE]->(:Device)-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"}) RETURN p',
                        ),
                    ),
                set: SET_TOOL_SET_SCHEMAS.set_device_parameter,
                ...previewShape,
            },
        },
        async ({ select, set, preview, confirm }) =>
            runSetTool(deps, "Parameter", "set_device_parameter", {
                select,
                set,
                preview,
                confirm,
            }),
    )
}
