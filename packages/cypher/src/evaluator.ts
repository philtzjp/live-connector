import { BadRequestError } from "@live-connector/error"
import type {
    AggregateItem,
    ComparisonExpr,
    NodePattern,
    OrderItem,
    Query,
    RelationshipPattern,
    ReturnItem,
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
    /** ノードの同一性判定に使う安定した識別子（重複排除用）。 */
    identity(node: N): unknown
}

type Binding<N> = {
    vars: Map<string, N>
    current: N
}

const select_return_hint =
    'Selection query must RETURN exactly one bound node variable. For write-tool select, use e.g. MATCH (t:Track {name:"Drums"}) RETURN t. Do not return properties such as RETURN t.name or multiple variables such as RETURN t, c; those forms are only for the read-only query tool.'
const select_return_metadata = {
    hint: "For write-tool select, RETURN one bound node variable only. Use the read-only query tool for property projections or multiple RETURN items.",
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
        throw new BadRequestError(`Unknown variable "${expr.left.variable}" in WHERE`, {
            hint: "Use a variable that is bound in the MATCH pattern before referencing it in WHERE.",
        })
    }
    const actual = await adapter.getProperty(node, expr.left.property)
    return compareScalar(actual, expr.operator, expr.right)
}

/** パターンマッチ・WHERE・LIMIT を適用して束縛集合を返す（read/select 共通）。 */
async function matchBindings<N>(query: Query, adapter: GraphAdapter<N>): Promise<Binding<N>[]> {
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

    // DISTINCT / ORDER BY / SKIP / LIMIT は行射影後に適用するため、ここでは行わない。
    return bindings
}

/** SKIP / LIMIT を配列へ適用する（skip 未指定=0、limit 未指定=末尾まで）。 */
function sliceRange<T>(items: T[], skip: number | null, limit: number | null): T[] {
    const start = skip ?? 0
    const end = limit === null ? items.length : start + limit
    return items.slice(start, end)
}

/**
 * 書き込み対象の選択用に、単一変数を RETURN するクエリの束縛ノード集合を返す。
 * identity による重複排除の後、SKIP / LIMIT を適用する。
 */
export async function selectNodes<N>(query: Query, adapter: GraphAdapter<N>): Promise<N[]> {
    const returns = query.returns
    const target = returns[0]
    if (returns.length !== 1 || target === undefined || target.kind !== "variable") {
        throw new BadRequestError(select_return_hint, select_return_metadata)
    }
    const bindings = await matchBindings(query, adapter)
    const seen = new Set<unknown>()
    const nodes: N[] = []
    for (const binding of bindings) {
        const node = binding.vars.get(target.variable)
        if (node === undefined) {
            throw new BadRequestError(
                `Unknown variable "${target.variable}" in RETURN. Return one variable bound in MATCH, e.g. MATCH (t:Track) RETURN t`,
                { hint: "Use a variable that is bound in the MATCH pattern." },
            )
        }
        const id = adapter.identity(node)
        if (!seen.has(id)) {
            seen.add(id)
            nodes.push(node)
        }
    }
    return sliceRange(nodes, query.skip, query.limit)
}

function requireNode<N>(binding: Binding<N>, variable: string, clause: string): N {
    const node = binding.vars.get(variable)
    if (node === undefined) {
        throw new BadRequestError(`Unknown variable "${variable}" in ${clause}`, {
            hint: "Use a variable that is bound in the MATCH pattern.",
        })
    }
    return node
}

/** 非集計クエリの 1 束縛を 1 行へ射影する。 */
async function projectRow<N>(
    returns: ReturnItem[],
    adapter: GraphAdapter<N>,
    binding: Binding<N>,
): Promise<Row> {
    const row: Row = {}
    for (const item of returns) {
        if (item.kind === "all") {
            for (const [name, node] of binding.vars) {
                row[name] = await adapter.serialize(node)
            }
        } else if (item.kind === "variable") {
            row[item.variable] = await adapter.serialize(
                requireNode(binding, item.variable, "RETURN"),
            )
        } else if (item.kind === "property") {
            row[`${item.variable}.${item.property}`] = await adapter.getProperty(
                requireNode(binding, item.variable, "RETURN"),
                item.property,
            )
        }
    }
    return row
}

function coerceScalar(value: unknown): ScalarValue {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value
    }
    return null
}

/** null 最後、数値は数値比較、真偽は false<true、それ以外は文字列比較。 */
function compareValues(left: ScalarValue, right: ScalarValue): number {
    if (left === right) {
        return 0
    }
    if (left === null) {
        return 1
    }
    if (right === null) {
        return -1
    }
    if (typeof left === "number" && typeof right === "number") {
        return left - right
    }
    if (typeof left === "boolean" && typeof right === "boolean") {
        return (left ? 1 : 0) - (right ? 1 : 0)
    }
    return String(left).localeCompare(String(right))
}

function compareTuples(left: ScalarValue[], right: ScalarValue[], orderBy: OrderItem[]): number {
    for (let index = 0; index < orderBy.length; index++) {
        let comparison = compareValues(left[index] ?? null, right[index] ?? null)
        if (orderBy[index]?.direction === "DESC") {
            comparison = -comparison
        }
        if (comparison !== 0) {
            return comparison
        }
    }
    return 0
}

function distinctRows(rows: Row[]): Row[] {
    const seen = new Set<string>()
    const out: Row[] = []
    for (const row of rows) {
        const key = JSON.stringify(row)
        if (!seen.has(key)) {
            seen.add(key)
            out.push(row)
        }
    }
    return out
}

/** 非集計クエリの ORDER BY 値を束縛から求める（未射影のプロパティも参照可）。 */
async function orderValuesFromBinding<N>(
    orderBy: OrderItem[],
    adapter: GraphAdapter<N>,
    binding: Binding<N>,
): Promise<ScalarValue[]> {
    const values: ScalarValue[] = []
    for (const item of orderBy) {
        const key = item.key
        if (key.kind === "property") {
            values.push(
                await adapter.getProperty(
                    requireNode(binding, key.variable, "ORDER BY"),
                    key.property,
                ),
            )
        } else if (key.kind === "aggregate") {
            throw new BadRequestError(
                "ORDER BY with an aggregate requires aggregate functions in RETURN",
                { hint: "Add the aggregate to RETURN, e.g. RETURN t, count(n) ORDER BY count(n)." },
            )
        } else {
            throw new BadRequestError(
                `ORDER BY requires a property such as ORDER BY ${key.variable}.startTime, not a bare node variable`,
                { hint: "Order by a property of a bound variable." },
            )
        }
    }
    return values
}

async function evaluateSimple<N>(
    query: Query,
    adapter: GraphAdapter<N>,
    bindings: Binding<N>[],
): Promise<Row[]> {
    const entries: { row: Row; sortKeys: ScalarValue[] }[] = []
    for (const binding of bindings) {
        entries.push({
            row: await projectRow(query.returns, adapter, binding),
            sortKeys:
                query.orderBy.length > 0
                    ? await orderValuesFromBinding(query.orderBy, adapter, binding)
                    : [],
        })
    }
    if (query.orderBy.length > 0) {
        entries.sort((left, right) => compareTuples(left.sortKeys, right.sortKeys, query.orderBy))
    }
    let rows = entries.map((entry) => entry.row)
    if (query.distinct) {
        rows = distinctRows(rows)
    }
    return rows
}

function identityToken(identity: unknown, ids: Map<unknown, number>): number {
    const existing = ids.get(identity)
    if (existing !== undefined) {
        return existing
    }
    const id = ids.size
    ids.set(identity, id)
    return id
}

async function computeAggregate<N>(
    item: AggregateItem,
    adapter: GraphAdapter<N>,
    members: Binding<N>[],
): Promise<ScalarValue> {
    const { func, arg } = item
    if (func === "count") {
        if (arg.kind === "star") {
            return members.length
        }
        if (arg.kind === "variable") {
            return members.filter((member) => member.vars.get(arg.variable) !== undefined).length
        }
        let count = 0
        for (const member of members) {
            const node = member.vars.get(arg.variable)
            if (node !== undefined && (await adapter.getProperty(node, arg.property)) !== null) {
                count++
            }
        }
        return count
    }
    if (arg.kind !== "property") {
        throw new BadRequestError(`${func}() requires a property argument`)
    }
    const values: number[] = []
    for (const member of members) {
        const node = member.vars.get(arg.variable)
        if (node === undefined) {
            continue
        }
        const value = await adapter.getProperty(node, arg.property)
        if (typeof value === "number") {
            values.push(value)
        }
    }
    if (func === "sum") {
        return values.reduce((total, value) => total + value, 0)
    }
    if (values.length === 0) {
        return null
    }
    if (func === "min") {
        return Math.min(...values)
    }
    if (func === "max") {
        return Math.max(...values)
    }
    return values.reduce((total, value) => total + value, 0) / values.length
}

function orderValuesFromRow(orderBy: OrderItem[], row: Row): ScalarValue[] {
    const values: ScalarValue[] = []
    for (const item of orderBy) {
        const key = item.key
        let rowKey: string
        if (key.kind === "aggregate") {
            rowKey = key.alias
        } else if (key.kind === "property") {
            rowKey = `${key.variable}.${key.property}`
        } else {
            throw new BadRequestError(
                "ORDER BY in an aggregating query must reference a grouping key or aggregate",
                { hint: "Order by a returned property or aggregate, e.g. ORDER BY count(n) DESC." },
            )
        }
        if (!(rowKey in row)) {
            throw new BadRequestError(
                `ORDER BY "${rowKey}" must appear in RETURN for an aggregating query`,
                { hint: "Add the expression to RETURN, or order by a returned item." },
            )
        }
        values.push(coerceScalar(row[rowKey]))
    }
    return values
}

async function evaluateAggregate<N>(
    query: Query,
    adapter: GraphAdapter<N>,
    bindings: Binding<N>[],
): Promise<Row[]> {
    const groupingItems = query.returns.filter(
        (item): item is Exclude<ReturnItem, AggregateItem> => item.kind !== "aggregate",
    )
    const aggregateItems = query.returns.filter(
        (item): item is AggregateItem => item.kind === "aggregate",
    )
    const identityIds = new Map<unknown, number>()
    const groups = new Map<string, { first: Binding<N>; members: Binding<N>[] }>()
    const order: string[] = []

    for (const binding of bindings) {
        const parts: string[] = []
        for (const item of groupingItems) {
            if (item.kind === "variable") {
                const node = requireNode(binding, item.variable, "RETURN")
                parts.push(`o:${identityToken(adapter.identity(node), identityIds)}`)
            } else if (item.kind === "property") {
                const node = requireNode(binding, item.variable, "RETURN")
                parts.push(`s:${JSON.stringify(await adapter.getProperty(node, item.property))}`)
            }
        }
        const key = parts.join("|")
        const existing = groups.get(key)
        if (existing === undefined) {
            groups.set(key, { first: binding, members: [binding] })
            order.push(key)
        } else {
            existing.members.push(binding)
        }
    }

    const rows: Row[] = []
    for (const key of order) {
        const group = groups.get(key)
        if (group === undefined) {
            continue
        }
        const row: Row = {}
        for (const item of groupingItems) {
            if (item.kind === "variable") {
                row[item.variable] = await adapter.serialize(
                    requireNode(group.first, item.variable, "RETURN"),
                )
            } else if (item.kind === "property") {
                row[`${item.variable}.${item.property}`] = await adapter.getProperty(
                    requireNode(group.first, item.variable, "RETURN"),
                    item.property,
                )
            }
        }
        for (const item of aggregateItems) {
            row[item.alias] = await computeAggregate(item, adapter, group.members)
        }
        rows.push(row)
    }
    return rows
}

/** AST を GraphAdapter 越しに評価し、結果行を返す（集計・DISTINCT・ORDER BY・SKIP・LIMIT を適用）。 */
export async function evaluate<N>(query: Query, adapter: GraphAdapter<N>): Promise<Row[]> {
    const bindings = await matchBindings(query, adapter)
    const hasAggregate = query.returns.some((item) => item.kind === "aggregate")

    let rows: Row[]
    if (hasAggregate) {
        rows = await evaluateAggregate(query, adapter, bindings)
        if (query.orderBy.length > 0) {
            const entries = rows.map((row) => ({
                row,
                sortKeys: orderValuesFromRow(query.orderBy, row),
            }))
            entries.sort((left, right) =>
                compareTuples(left.sortKeys, right.sortKeys, query.orderBy),
            )
            rows = entries.map((entry) => entry.row)
        }
        if (query.distinct) {
            rows = distinctRows(rows)
        }
    } else {
        rows = await evaluateSimple(query, adapter, bindings)
    }

    return sliceRange(rows, query.skip, query.limit)
}
