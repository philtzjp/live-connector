import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

/** MCP tool annotations（実態と一致したヒント）。SDK の ToolAnnotations サブセット。 */
export type ToolAnnotations = {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true }
const SIDE_EFFECT_FILE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false }
const IDEMPOTENT_WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
}
const CREATE_WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
}
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true }
const NEUTRAL_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false }

/** ツール名 → annotations の正本。read 系 / 破壊系 / 冪等書き込みなどを宣言的に区別する。 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
    // read
    schema: READ_ONLY,
    get_overview: READ_ONLY,
    query: READ_ONLY,
    search_presets: READ_ONLY,
    get_write_history: READ_ONLY,
    list_snapshots: READ_ONLY,
    // file side effects, no Set mutation
    render_audio: SIDE_EFFECT_FILE,
    save_device_state: SIDE_EFFECT_FILE,
    // idempotent Set writes（同じ値の再適用は同結果）
    set_song: IDEMPOTENT_WRITE,
    set_track: IDEMPOTENT_WRITE,
    set_clip: IDEMPOTENT_WRITE,
    set_scene: IDEMPOTENT_WRITE,
    set_cue_point: IDEMPOTENT_WRITE,
    set_device_parameter: IDEMPOTENT_WRITE,
    apply_device_state: IDEMPOTENT_WRITE,
    restore_snapshot: IDEMPOTENT_WRITE,
    // creating writes（毎回新規生成）
    create_clip: CREATE_WRITE,
    create_track: CREATE_WRITE,
    create_scene: CREATE_WRITE,
    create_arrangement_clip: CREATE_WRITE,
    create_cue_point: CREATE_WRITE,
    insert_device: CREATE_WRITE,
    duplicate_scene: CREATE_WRITE,
    duplicate_track: CREATE_WRITE,
    duplicate_device: CREATE_WRITE,
    load_sample: CREATE_WRITE,
    // destructive deletes
    delete_scene: DESTRUCTIVE,
    delete_track: DESTRUCTIVE,
    delete_device: DESTRUCTIVE,
    delete_session_clip: DESTRUCTIVE,
    delete_arrangement_clip: DESTRUCTIVE,
    delete_cue_point: DESTRUCTIVE,
    // other Set writes
    write_notes: NEUTRAL_WRITE,
    transform_notes: NEUTRAL_WRITE,
    move_clip: NEUTRAL_WRITE,
    trim_clip: NEUTRAL_WRITE,
    batch: NEUTRAL_WRITE,
    // 一時トラックで試行し即削除する検証ツール（Set に残留せず、再実行で同結果）
    verify_device_catalog: IDEMPOTENT_WRITE,
}

type RegisterConfig = Record<string, unknown>
type RegisterHandler = (...args: unknown[]) => unknown

/**
 * register* が使う registerTool を横取りし、TOOL_ANNOTATIONS に基づき annotations を config に注入する facade。
 * ツール名・ハンドラは変えない。
 */
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
