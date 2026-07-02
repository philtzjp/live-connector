import { Chain, ClipSlot, Device, Scene, Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type V = TargetApiVersion
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function resolveSingleObject(nodes: LomNode[], label: string): LomNode {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `this operation requires the selection to match exactly one ${label}, but matched ${nodes.length}`,
            { hint: `Change select so it returns exactly one ${label} node.` },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object") {
        throw new BadRequestError(`select must return a ${label} object node`)
    }
    return node
}

/** preview / confirm ガード。preview は対象を返し、confirm 無しの破壊操作は confirm_required を返す。 */
export function guardDestructive(
    summary: Record<string, unknown>,
    preview: boolean | undefined,
    confirm: boolean | undefined,
): ToolResult | null {
    if (preview === true) {
        return textResult({ status: "preview", ...summary })
    }
    if (confirm !== true) {
        return textResult({
            status: "confirm_required",
            ...summary,
            hint: "This is a destructive operation that cannot be undone from MCP (Live's Edit > Undo can still revert it). Pass confirm:true to proceed.",
        })
    }
    return null
}

function trackSummary(track: Track<V>, song: { tracks: Track<V>[] }): Record<string, unknown> {
    const index = song.tracks.findIndex((candidate) => candidate.handle === track.handle)
    return { name: track.name, index: index < 0 ? null : index }
}

function requireRegularTrack(node: LomNode, song: { tracks: Track<V>[] }): Track<V> {
    if (!(node.value instanceof Track)) {
        throw new BadRequestError("select must return a Track")
    }
    const track = node.value
    const is_regular = song.tracks.some((candidate) => candidate.handle === track.handle)
    if (!is_regular) {
        throw new BadRequestError(
            "only regular MidiTrack / AudioTrack in song.tracks can be deleted or duplicated",
            { hint: "Return / main tracks cannot be deleted or duplicated." },
        )
    }
    return track
}

function deviceParent(device: Device<V>): Track<V> | Chain<V> {
    const parent = device.parent
    if (parent instanceof Track || parent instanceof Chain) {
        return parent
    }
    throw new BadRequestError("the selected Device has no Track or Chain parent to delete from", {
        hint: "Select a device reached via HAS_DEVICE from a Track or a rack Chain.",
    })
}

async function runCreateScene(
    deps: ServerDeps,
    params: { index: number | undefined; name: string | undefined; preview: boolean | undefined },
): Promise<ToolResult> {
    const song = deps.context.application.song
    const scene_count = song.scenes.length
    const index = params.index ?? scene_count
    if (!Number.isInteger(index) || index < 0 || index > scene_count) {
        throw new BadRequestError(
            `scene index must be an integer in [0, ${scene_count}], but received ${index}`,
            { hint: "Omit index to append at the end." },
        )
    }
    const summary = { index, name: params.name ?? null }
    if (params.preview === true) {
        return textResult({ status: "preview", ...summary })
    }
    const scene = await deps.context.withinTransaction(() =>
        song.createScene(index).then((created) => {
            if (params.name !== undefined) {
                created.name = params.name
            }
            return created
        }),
    )
    const created_index = song.scenes.findIndex((candidate) => candidate.handle === scene.handle)
    return textResult({
        status: "ok",
        scene: { index: created_index < 0 ? index : created_index, name: scene.name },
    })
}

async function runCreateTrack(
    deps: ServerDeps,
    params: { kind: "midi" | "audio"; name: string | undefined; preview: boolean | undefined },
): Promise<ToolResult> {
    const song = deps.context.application.song
    if (params.preview === true) {
        return textResult({ status: "preview", kind: params.kind, name: params.name ?? null })
    }
    const track = await deps.context.withinTransaction(() => {
        const created = params.kind === "midi" ? song.createMidiTrack() : song.createAudioTrack()
        return created.then((value) => {
            if (params.name !== undefined) {
                value.name = params.name
            }
            return value
        })
    })
    const index = song.tracks.findIndex((candidate) => candidate.handle === track.handle)
    return textResult({
        status: "ok",
        track: { index: index < 0 ? null : index, name: track.name, kind: params.kind },
    })
}

/** SDK が提供する構造操作（シーン / トラック / デバイス / セッションクリップ）をツール化する。 */
export function registerStructureTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "create_track",
        {
            title: "Track 生成",
            description:
                "MIDI または Audio トラックを生成し、任意で name を設定する。SDK は挿入位置（index）を指定できず、最後に選択されたトラックの直後（未選択なら末尾）に生成される。生成トラックの ClipSlot 数は既存シーン数に一致する。生成直後の MidiTrack は音源が無いため発音しない（insert_device と併用する）。",
            inputSchema: {
                kind: z.enum(["midi", "audio"]).describe("生成するトラック種別"),
                name: z.string().min(1).optional().describe("生成後に設定するトラック名"),
                preview: z.boolean().optional().describe("生成せず内容を返すドライラン"),
            },
        },
        async ({ kind, name, preview }) => {
            try {
                return await runCreateTrack(deps, { kind, name, preview })
            } catch (error) {
                deps.log.error("create_track failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "create_scene",
        {
            title: "Scene 作成",
            description:
                "index（省略時は末尾）に空の Scene を作成し、任意で name を設定する。既存トラックの ClipSlot はシーン数に追随する。",
            inputSchema: {
                index: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("挿入位置（0 始まり）。省略で末尾"),
                name: z.string().min(1).optional(),
                preview: z.boolean().optional(),
            },
        },
        async ({ index, name, preview }) => {
            try {
                return await runCreateScene(deps, { index, name, preview })
            } catch (error) {
                deps.log.error("create_scene failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "delete_scene",
        {
            title: "Scene 削除",
            description:
                "select で選んだ 1 つの Scene を削除する。破壊的操作のため confirm:true が必要（preview で対象確認可）。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        "Scene を単一ノード変数で RETURN する Cypher。例: MATCH (s:Scene {index:0}) RETURN s",
                    ),
                preview: z.boolean().optional(),
                confirm: z.boolean().optional(),
            },
        },
        async ({ select, preview, confirm }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "Scene",
                )
                if (!(node.value instanceof Scene)) {
                    throw new BadRequestError("select must return a Scene")
                }
                const scene = node.value
                const summary = { scene: { index: node.index, name: scene.name } }
                const guarded = guardDestructive(summary, preview, confirm)
                if (guarded !== null) {
                    return guarded
                }
                await deps.context.withinTransaction(() =>
                    deps.context.application.song.deleteScene(scene),
                )
                return textResult({ status: "ok", ...summary })
            } catch (error) {
                deps.log.error("delete_scene failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "duplicate_scene",
        {
            title: "Scene 複製",
            description: "select で選んだ 1 つの Scene を複製する。複製は元の直後に挿入される。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        "Scene を単一ノード変数で RETURN する Cypher。例: MATCH (s:Scene {index:0}) RETURN s",
                    ),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, preview }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "Scene",
                )
                if (!(node.value instanceof Scene)) {
                    throw new BadRequestError("select must return a Scene")
                }
                const scene = node.value
                if (preview === true) {
                    return textResult({
                        status: "preview",
                        scene: { index: node.index, name: scene.name },
                    })
                }
                const song = deps.context.application.song
                const created = await deps.context.withinTransaction(() =>
                    song.duplicateScene(scene),
                )
                const created_index = song.scenes.findIndex(
                    (candidate) => candidate.handle === created.handle,
                )
                return textResult({
                    status: "ok",
                    scene: { index: created_index < 0 ? null : created_index, name: created.name },
                })
            } catch (error) {
                deps.log.error("duplicate_scene failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "delete_track",
        {
            title: "Track 削除",
            description:
                "select で選んだ 1 つの regular Track（MidiTrack / AudioTrack）を削除する。return / main は不可。破壊的操作のため confirm:true が必要。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'Track を単一ノード変数で RETURN する Cypher。例: MATCH (t:Track {name:"Old"}) RETURN t',
                    ),
                preview: z.boolean().optional(),
                confirm: z.boolean().optional(),
            },
        },
        async ({ select, preview, confirm }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "Track",
                )
                const song = deps.context.application.song
                const track = requireRegularTrack(node, song)
                const summary = { track: trackSummary(track, song) }
                const guarded = guardDestructive(summary, preview, confirm)
                if (guarded !== null) {
                    return guarded
                }
                await deps.context.withinTransaction(() => song.deleteTrack(track))
                return textResult({ status: "ok", ...summary })
            } catch (error) {
                deps.log.error("delete_track failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "duplicate_track",
        {
            title: "Track 複製",
            description:
                "select で選んだ 1 つの regular Track を複製する。複製は元の直後に挿入される。return / main は不可。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'Track を単一ノード変数で RETURN する Cypher。例: MATCH (t:Track {name:"Drums"}) RETURN t',
                    ),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, preview }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "Track",
                )
                const song = deps.context.application.song
                const track = requireRegularTrack(node, song)
                if (preview === true) {
                    return textResult({ status: "preview", track: trackSummary(track, song) })
                }
                const created = await deps.context.withinTransaction(() =>
                    song.duplicateTrack(track),
                )
                const created_index = song.tracks.findIndex(
                    (candidate) => candidate.handle === created.handle,
                )
                return textResult({
                    status: "ok",
                    track: { index: created_index < 0 ? null : created_index, name: created.name },
                })
            } catch (error) {
                deps.log.error("duplicate_track failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "delete_device",
        {
            title: "Device 削除",
            description:
                "select で選んだ 1 つの Device を、その親 Track / Chain のデバイスチェーンから削除する。破壊的操作のため confirm:true が必要。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'Device を単一ノード変数で RETURN する Cypher。例: MATCH (:Track {name:"Lead"})-[:HAS_DEVICE]->(d:Device {name:"Reverb"}) RETURN d',
                    ),
                preview: z.boolean().optional(),
                confirm: z.boolean().optional(),
            },
        },
        async ({ select, preview, confirm }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "Device",
                )
                if (!(node.value instanceof Device)) {
                    throw new BadRequestError("select must return a Device")
                }
                const device = node.value
                const parent = deviceParent(device)
                const summary = { device: { name: device.name, index: node.index } }
                const guarded = guardDestructive(summary, preview, confirm)
                if (guarded !== null) {
                    return guarded
                }
                await deps.context.withinTransaction(() => parent.deleteDevice(device))
                return textResult({ status: "ok", ...summary })
            } catch (error) {
                deps.log.error("delete_device failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "duplicate_device",
        {
            title: "Device 複製",
            description: "select で選んだ 1 つの Device を複製する。複製は元の直後に挿入される。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'Device を単一ノード変数で RETURN する Cypher。例: MATCH (:Track {name:"Lead"})-[:HAS_DEVICE]->(d:Device {name:"Operator"}) RETURN d',
                    ),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, preview }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "Device",
                )
                if (!(node.value instanceof Device)) {
                    throw new BadRequestError("select must return a Device")
                }
                const device = node.value
                const parent = deviceParent(device)
                if (preview === true) {
                    return textResult({
                        status: "preview",
                        device: { name: device.name, index: node.index },
                    })
                }
                const created = await deps.context.withinTransaction(() =>
                    parent.duplicateDevice(device),
                )
                // 同名デバイスが並んだ直後でも index で一意に select できるよう、複製後の実 index を返す。
                const created_index = parent.devices.findIndex(
                    (candidate) => candidate.handle === created.handle,
                )
                return textResult({
                    status: "ok",
                    device: { name: created.name, index: created_index < 0 ? null : created_index },
                })
            } catch (error) {
                deps.log.error("duplicate_device failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )

    server.registerTool(
        "delete_session_clip",
        {
            title: "Session Clip 削除",
            description:
                "select で選んだ 1 つの ClipSlot（クリップを持つもの）のセッションクリップを削除する。アレンジメントクリップは delete_arrangement_clip を使う。破壊的操作のため confirm:true が必要。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'クリップを持つ ClipSlot を単一ノード変数で RETURN する Cypher。例: MATCH (:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s',
                    ),
                preview: z.boolean().optional(),
                confirm: z.boolean().optional(),
            },
        },
        async ({ select, preview, confirm }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const node = resolveSingleObject(
                    await selectNodes(parseQuery(select), adapter),
                    "ClipSlot",
                )
                if (!(node.value instanceof ClipSlot)) {
                    throw new BadRequestError("select must return a ClipSlot")
                }
                const slot = node.value
                const clip = slot.clip
                if (clip === null) {
                    throw new BadRequestError("selected ClipSlot has no clip to delete", {
                        hint: "Select a ClipSlot where hasClip is true.",
                    })
                }
                const summary = { clipSlot: { index: node.index }, clip: { name: clip.name } }
                const guarded = guardDestructive(summary, preview, confirm)
                if (guarded !== null) {
                    return guarded
                }
                await deps.context.withinTransaction(() => slot.deleteClip())
                return textResult({ status: "ok", ...summary })
            } catch (error) {
                deps.log.error("delete_session_clip failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}
