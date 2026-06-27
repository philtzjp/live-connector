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

export type QueryContract = {
    grammar: string
    start_labels: string[]
    read: {
        tool: string
        return_contract: string
        allowed_returns: string[]
    }
    select: {
        tools: string[]
        return_contract: string
        valid_examples: string[]
        invalid_examples: string[]
        hint: string
    }
}

export type LomSchema = {
    version: string
    nodes: NodeLabelDef[]
    relationships: RelationshipDef[]
}
