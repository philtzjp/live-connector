import { BadRequestError } from "@live-connector/error"
import type {
    ComparisonExpr,
    NodePattern,
    Query,
    RelationshipPattern,
    ScalarValue,
    WhereExpr,
} from "./ast"

export type Row = Record<string, unknown>

/**
 * グラフ走査の抽象インタフェース。Cypher 評価器はこの実装越しに実行され、SDK には依存しない。
 * 型引数 `N` は実装側のノード表現。
 */
export interface GraphAdapter<N> {
    /** 先頭ノードパターンの開始候補（指定ラベルの族）を返す。 */
    seeds(label: string | null): Promise<N[]>
    /** いずれかのリレーションタイプで隣接するノードを返す。 */
    expand(node: N, relationshipTypes: string[]): Promise<N[]>
    /** ノードの具象ラベル。 */
    labelOf(node: N): string
    /** ノードの具象ラベルが（抽象を含む）パターンラベルにマッチするか。 */
    matchesLabel(node: N, label: string): boolean
    /** プロパティ値を読む（SDK の非同期読み取りを許容するため Promise）。 */
    getProperty(node: N, property: string): Promise<ScalarValue>
    /** ノードを `_label` 付きのプロパティマップに直列化する（配列プロパティを含みうる）。 */
    serialize(node: N): Promise<Record<string, unknown>>
}

type Binding<N> = {
    vars: Map<string, N>
    current: N
}

function valuesEqual(left: ScalarValue, right: ScalarValue): boolean {
    return left === right
}

async function nodeMatches<N>(
    adapter: GraphAdapter<N>,
    node: N,
    pattern: NodePattern,
): Promise<boolean> {
    if (pattern.label !== null && !adapter.matchesLabel(node, pattern.label)) {
        return false
    }
    for (const [key, expected] of Object.entries(pattern.properties)) {
        const actual = await adapter.getProperty(node, key)
        if (!valuesEqual(actual, expected)) {
            return false
        }
    }
    return true
}

async function expandHops<N>(
    adapter: GraphAdapter<N>,
    from: N,
    relationship: RelationshipPattern,
): Promise<N[]> {
    const collected: N[] = []
    let frontier: N[] = [from]
    for (let hop = 1; hop <= relationship.maxHops; hop++) {
        const nextFrontier: N[] = []
        for (const node of frontier) {
            nextFrontier.push(...(await adapter.expand(node, relationship.types)))
        }
        if (hop >= relationship.minHops) {
            collected.push(...nextFrontier)
        }
        if (nextFrontier.length === 0) {
            break
        }
        frontier = nextFrontier
    }
    return collected
}

function compareScalar(
    left: ScalarValue,
    operator: ComparisonExpr["operator"],
    right: ScalarValue | ScalarValue[],
): boolean {
    if (operator === "IN") {
        const list = Array.isArray(right) ? right : [right]
        return list.some((item) => valuesEqual(left, item))
    }
    if (Array.isArray(right)) {
        throw new BadRequestError(`Operator "${operator}" does not accept a list`)
    }
    if (operator === "=") {
        return valuesEqual(left, right)
    }
    if (operator === "<>") {
        return !valuesEqual(left, right)
    }
    if (operator === "CONTAINS") {
        return typeof left === "string" && typeof right === "string" && left.includes(right)
    }
    if (operator === "STARTS_WITH") {
        return typeof left === "string" && typeof right === "string" && left.startsWith(right)
    }
    if (left === null || right === null) {
        return false
    }
    if (typeof left === "number" && typeof right === "number") {
        return compareOrdered(left, right, operator)
    }
    if (typeof left === "string" && typeof right === "string") {
        return compareOrdered(left, right, operator)
    }
    return false
}

function compareOrdered<T extends number | string>(
    left: T,
    right: T,
    operator: "<" | ">" | "<=" | ">=" | "=" | "<>" | "CONTAINS" | "STARTS_WITH" | "IN",
): boolean {
    switch (operator) {
        case "<":
            return left < right
        case ">":
            return left > right
        case "<=":
            return left <= right
        case ">=":
            return left >= right
        default:
            return false
    }
}

async function evalWhere<N>(
    adapter: GraphAdapter<N>,
    expr: WhereExpr,
    binding: Binding<N>,
): Promise<boolean> {
    if (expr.kind === "logical") {
        const left = await evalWhere(adapter, expr.left, binding)
        if (expr.operator === "AND") {
            return left && (await evalWhere(adapter, expr.right, binding))
        }
        return left || (await evalWhere(adapter, expr.right, binding))
    }
    if (expr.kind === "not") {
        return !(await evalWhere(adapter, expr.expr, binding))
    }
    const node = binding.vars.get(expr.left.variable)
    if (node === undefined) {
        throw new BadRequestError(`Unknown variable "${expr.left.variable}" in WHERE`)
    }
    const actual = await adapter.getProperty(node, expr.left.property)
    return compareScalar(actual, expr.operator, expr.right)
}

/** AST を GraphAdapter 越しに評価し、結果行を返す。 */
export async function evaluate<N>(query: Query, adapter: GraphAdapter<N>): Promise<Row[]> {
    const start = query.pattern.start
    let bindings: Binding<N>[] = []

    for (const node of await adapter.seeds(start.label)) {
        if (await nodeMatches(adapter, node, start)) {
            const vars = new Map<string, N>()
            if (start.variable !== null) {
                vars.set(start.variable, node)
            }
            bindings.push({ vars, current: node })
        }
    }

    for (const step of query.pattern.chain) {
        const next: Binding<N>[] = []
        for (const binding of bindings) {
            for (const node of await expandHops(adapter, binding.current, step.relationship)) {
                if (await nodeMatches(adapter, node, step.node)) {
                    const vars = new Map(binding.vars)
                    if (step.node.variable !== null) {
                        vars.set(step.node.variable, node)
                    }
                    next.push({ vars, current: node })
                }
            }
        }
        bindings = next
    }

    if (query.where !== null) {
        const filtered: Binding<N>[] = []
        for (const binding of bindings) {
            if (await evalWhere(adapter, query.where, binding)) {
                filtered.push(binding)
            }
        }
        bindings = filtered
    }

    if (query.limit !== null) {
        bindings = bindings.slice(0, query.limit)
    }

    const rows: Row[] = []
    for (const binding of bindings) {
        const row: Row = {}
        for (const item of query.returns) {
            if (item.kind === "all") {
                for (const [name, node] of binding.vars) {
                    row[name] = await adapter.serialize(node)
                }
                continue
            }
            const node = binding.vars.get(item.variable)
            if (node === undefined) {
                throw new BadRequestError(`Unknown variable "${item.variable}" in RETURN`)
            }
            if (item.kind === "variable") {
                row[item.variable] = await adapter.serialize(node)
            } else {
                row[`${item.variable}.${item.property}`] = await adapter.getProperty(
                    node,
                    item.property,
                )
            }
        }
        rows.push(row)
    }
    return rows
}
