/**
 * LOM（Live Object Model）をプロパティグラフとして記述するためのスキーマ型。
 * この定義は `schema` MCP ツールと、将来の Cypher クエリプランナの単一の正本となる。
 */

export type PropertyType = "number" | "string" | "boolean" | "number[]" | "string[]" | "enum"

export type PropertyAccess = "r" | "rw"

export type PropertyDef = {
    name: string
    type: PropertyType
    access: PropertyAccess
    /** type が "enum" の場合の取りうる値。 */
    enumValues?: string[]
    description?: string
}

export type NodeLabelDef = {
    label: string
    /** 継承元ラベル（プロパティを引き継ぐ）。 */
    extends?: string
    /** 抽象ラベル（直接インスタンス化されず、サブタイプ全体にマッチする）。 */
    abstract?: boolean
    properties: PropertyDef[]
    description?: string
}

export type RelationshipDef = {
    type: string
    from: string
    to: string
    /** 親から見て複数の子を持つか（true なら配列）。 */
    array: boolean
    description?: string
}

export type ProcedureDef = {
    /** 手続き名（例: "transport.seek"）。 */
    name: string
    /** 引数の型付きシグネチャ（例: "beats:number"）。 */
    args: string
    /** 実行時の副作用種別。 */
    effect: "runtime" | "write"
    /** undo 可否。"none" は undo ログに載らない。 */
    undoable: "none"
    /** confirm:true が必須か。 */
    requiresConfirm: boolean
}

export type QueryContract = {
    grammar: string
    start_labels: string[]
    time_coordinates: {
        absolute: string
        relative: string
    }
    read: {
        tool: string
        return_contract: string
        allowed_returns: string[]
    }
    write: {
        tool: string
        target_resolution: string
        set_properties: Record<string, string[]>
        create_patterns: string[]
        delete_labels: string[]
        copy_labels: string[]
        undoable_levels: {
            full: string
            partial: string
            none: string
        }
        guards: {
            preview: string
            confirm: string
            no_match: string
        }
    }
    procedure: {
        tool: string
        grammar: string
        allowed: ProcedureDef[]
        guards: {
            literals_only: string
            preview: string
            confirm: string
            lock: string
        }
    }
    virtual_labels: {
        WriteEvent: string
        RenderJob: string
        Transport: string
    }
}

export type LomSchema = {
    version: string
    nodes: NodeLabelDef[]
    relationships: RelationshipDef[]
}
