/** Cypher サブセットの抽象構文木（AST）。SDK には依存しない純粋な構造。 */

export type ScalarValue = string | number | boolean | null

export type NodePattern = {
    variable: string | null
    label: string | null
    properties: Record<string, ScalarValue>
}

export type RelationshipPattern = {
    /** `|` 区切りで複数指定可能なリレーションタイプ。 */
    types: string[]
    /** 最小ホップ数（既定 1）。 */
    minHops: number
    /** 最大ホップ数（既定 1。可変長時に拡張）。 */
    maxHops: number
}

export type PatternPart = {
    start: NodePattern
    chain: { relationship: RelationshipPattern; node: NodePattern }[]
}

export type ComparisonOperator =
    | "="
    | "<>"
    | "<"
    | ">"
    | "<="
    | ">="
    | "CONTAINS"
    | "STARTS_WITH"
    | "IN"

export type PropertyRef = {
    variable: string
    property: string
}

export type ComparisonExpr = {
    kind: "comparison"
    left: PropertyRef
    operator: ComparisonOperator
    right: ScalarValue | ScalarValue[]
}

export type LogicalExpr = {
    kind: "logical"
    operator: "AND" | "OR"
    left: WhereExpr
    right: WhereExpr
}

export type NotExpr = {
    kind: "not"
    expr: WhereExpr
}

export type WhereExpr = ComparisonExpr | LogicalExpr | NotExpr

export type AggregateFunc = "count" | "min" | "max" | "avg" | "sum"

export type AggregateArg =
    | { kind: "star" }
    | { kind: "variable"; variable: string }
    | { kind: "property"; variable: string; property: string }

export type AggregateItem = {
    kind: "aggregate"
    func: AggregateFunc
    arg: AggregateArg
    /** RETURN 行のキー・ORDER BY 参照に使う正規化した表記（例: "count(n)", "avg(n.pitch)", "count(*)"）。 */
    alias: string
}

export type ReturnItem =
    | { kind: "all" }
    | { kind: "variable"; variable: string }
    | { kind: "property"; variable: string; property: string }
    | AggregateItem

export type OrderKey =
    | { kind: "variable"; variable: string }
    | { kind: "property"; variable: string; property: string }
    | AggregateItem

export type OrderItem = {
    key: OrderKey
    direction: "ASC" | "DESC"
}

export type Query = {
    pattern: PatternPart
    where: WhereExpr | null
    distinct: boolean
    returns: ReturnItem[]
    orderBy: OrderItem[]
    skip: number | null
    limit: number | null
}
