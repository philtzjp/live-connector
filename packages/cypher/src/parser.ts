import { BadRequestError } from "@live-connector/error"
import type {
    AggregateArg,
    AggregateFunc,
    AggregateItem,
    CallStatement,
    ComparisonOperator,
    CopyStatement,
    CreateNodePattern,
    CreateStatement,
    DeleteStatement,
    MatchClause,
    NodePattern,
    OrderItem,
    OrderKey,
    PatternPart,
    ProcedureArgument,
    Query,
    RelationshipPattern,
    ReturnItem,
    ScalarValue,
    SetAssignment,
    SetStatement,
    Statement,
    WhereExpr,
    WriteValue,
} from "./ast"
import { type Token, tokenize } from "./tokenizer"

/** 可変長リレーション `*` で上限省略時に適用するホップ数の上限。 */
const DEFAULT_MAX_HOPS = 8

/** パースエラーに添える対応済み文法の案内。AS / WITH / count(DISTINCT ...) 等の非対応構文を明示する。 */
const SUPPORTED_GRAMMAR_HINT =
    "Supported grammar: MATCH (n:Label {prop: value})[-[:REL|REL2*1..2]->(m:Label)] [WHERE ...] RETURN [DISTINCT] n | n.prop | count(*) | ... [ORDER BY ...] [SKIP <int>] [LIMIT <int>]; MATCH ... SET n.prop = <value> [, n.prop2 = <value>]*; CREATE (n:Label {prop: value}); MATCH ... CREATE (a)-[:REL]->(n:Label {prop: value}); MATCH ... [DETACH] DELETE n; MATCH ... COPY n; CALL transport.play() | transport.stop() | transport.seek(<beats>) | render.cancel(<jobId>). Write values: scalar, [scalars], [{key: scalar, ...}]. Not supported: AS aliases, WITH, count(DISTINCT ...), RETURN after write clauses, dynamic procedure names, multiple statements."

const AGGREGATE_FUNCS = new Set<AggregateFunc>(["count", "min", "max", "avg", "sum"])

/** MATCH パターンで束縛される変数名の集合を返す。 */
function collectBoundVariables(pattern: PatternPart): Set<string> {
    const variables = new Set<string>()
    if (pattern.start.variable !== null) {
        variables.add(pattern.start.variable)
    }
    for (const step of pattern.chain) {
        if (step.node.variable !== null) {
            variables.add(step.node.variable)
        }
    }
    return variables
}

/** 集計項目の正規化表記（RETURN 行キー・ORDER BY 参照に使う）。 */
function aggregateAlias(func: AggregateFunc, arg: AggregateArg): string {
    if (arg.kind === "star") {
        return `${func}(*)`
    }
    if (arg.kind === "variable") {
        return `${func}(${arg.variable})`
    }
    return `${func}(${arg.variable}.${arg.property})`
}

class Parser {
    private readonly tokens: Token[]
    private pos = 0

    constructor(tokens: Token[]) {
        this.tokens = tokens
    }

    parse(): Query {
        const match = this.parseMatchClause()
        return this.parseReadTail(match)
    }

    parseStatement(): Statement {
        const first = this.peek()
        if (first?.type === "keyword" && first.value === "CREATE") {
            return this.parseStandaloneCreate()
        }
        if (first?.type === "keyword" && first.value === "CALL") {
            return this.parseCallStatement()
        }
        if (first?.type !== "keyword" || first.value !== "MATCH") {
            throw this.error(`Expected keyword "MATCH", "CREATE", or "CALL"`)
        }
        const match = this.parseMatchClause()
        if (this.peekKeyword("RETURN")) {
            return { kind: "read", query: this.parseReadTail(match) }
        }
        if (this.peekKeyword("SET")) {
            return this.parseSetStatement(match)
        }
        if (this.peekKeyword("CREATE")) {
            return this.parseAnchoredCreateStatement(match)
        }
        if (this.peekKeyword("DELETE") || this.peekKeyword("DETACH")) {
            return this.parseDeleteStatement(match)
        }
        if (this.peekKeyword("COPY")) {
            return this.parseCopyStatement(match)
        }
        throw this.error("Expected RETURN, SET, CREATE, DELETE, or COPY after MATCH clause")
    }

    private parseMatchClause(): MatchClause {
        this.expectKeyword("MATCH")
        const pattern = this.parsePattern()
        let where: WhereExpr | null = null
        if (this.peekKeyword("WHERE")) {
            this.next()
            where = this.parseOr()
        }
        return { pattern, where }
    }

    private parseReadTail(match: MatchClause): Query {
        const { pattern, where } = match
        this.expectKeyword("RETURN")
        const distinct = this.consumeKeyword("DISTINCT")
        const returns = this.parseReturnItems()

        const hasAggregate = returns.some((item) => item.kind === "aggregate")
        if (hasAggregate && returns.some((item) => item.kind === "all")) {
            throw this.error("RETURN * cannot be combined with aggregate functions")
        }

        const orderBy = this.peekKeyword("ORDER") ? this.parseOrderBy() : []

        let skip: number | null = null
        if (this.consumeKeyword("SKIP")) {
            skip = this.expectNonNegativeInteger("SKIP")
        }

        let limit: number | null = null
        if (this.consumeKeyword("LIMIT")) {
            limit = this.expectNonNegativeInteger("LIMIT")
        }

        if (this.pos < this.tokens.length) {
            throw this.error(`Unexpected token after RETURN clause`)
        }
        return { pattern, where, distinct, returns, orderBy, skip, limit }
    }

    private parseStandaloneCreate(): CreateStatement {
        this.expectKeyword("CREATE")
        if (!this.peekPunct("(")) {
            throw this.error(
                "Standalone CREATE requires a node pattern such as CREATE (n:Label {prop: value})",
            )
        }
        const saved_pos = this.pos
        this.next()
        if (this.peekType("identifier")) {
            this.next()
            if (this.consumePunct(")") && this.peekPunct("-")) {
                throw this.error(
                    "Standalone CREATE cannot use an anchored relationship pattern",
                    "Use MATCH ... CREATE (a)-[:REL]->(n:Label) for anchored CREATE.",
                )
            }
        }
        this.pos = saved_pos
        const node = this.parseCreateNodePattern()
        if (this.pos < this.tokens.length) {
            throw this.error(`Unexpected token after CREATE clause`)
        }
        return {
            kind: "create",
            match: null,
            anchorVariable: null,
            relationshipType: null,
            node,
        }
    }

    /**
     * 限定 CALL 文をパースする。`CALL transport.seek(32)` のように、許可手続き名と
     * リテラル引数のみを受理する。動的関数名・変数参照・複数文は受理しない。
     */
    private parseCallStatement(): CallStatement {
        this.expectKeyword("CALL")
        const segments = [this.expectType("identifier").value]
        while (this.consumePunct(".")) {
            segments.push(this.expectType("identifier").value)
        }
        this.expectPunct("(")
        const args: ProcedureArgument[] = []
        if (!this.peekPunct(")")) {
            do {
                args.push(this.parseScalar())
            } while (this.consumePunct(","))
        }
        this.expectPunct(")")
        if (this.pos < this.tokens.length) {
            throw this.error(
                "Unexpected token after CALL statement; a single CALL with literal arguments is required",
            )
        }
        return { kind: "call", procedure: segments.join("."), args }
    }

    private parseAnchoredCreateStatement(match: MatchClause): CreateStatement {
        this.expectKeyword("CREATE")
        const { anchorVariable, relationshipType, node } = this.parseAnchoredCreatePattern()
        this.requireBoundVariable(match.pattern, anchorVariable, "anchored CREATE")
        this.assertNoReturnAfterWrite()
        return {
            kind: "create",
            match,
            anchorVariable,
            relationshipType,
            node,
        }
    }

    private parseAnchoredCreatePattern(): {
        anchorVariable: string
        relationshipType: string
        node: CreateNodePattern
    } {
        this.expectPunct("(")
        const anchorVariable = this.expectType("identifier").value
        if (this.peekPunct(":") || this.peekPunct("{")) {
            throw this.error("Anchored CREATE anchor must be a bare variable such as (t)")
        }
        this.expectPunct(")")
        const relationshipType = this.parseAnchoredRelationship()
        const node = this.parseCreateNodePattern()
        return { anchorVariable, relationshipType, node }
    }

    private parseAnchoredRelationship(): string {
        this.expectPunct("-")
        this.expectPunct("[")
        this.expectPunct(":")
        const relationshipType = this.expectType("identifier").value
        if (this.consumePunct("|")) {
            throw this.error(
                "Anchored CREATE supports only a single relationship type",
                "Use one relationship type, e.g. [:HAS_DEVICE].",
            )
        }
        if (this.consumePunct("*")) {
            throw this.error("Variable-length relationships are not supported in anchored CREATE")
        }
        this.expectPunct("]")
        this.expectPunct("->")
        return relationshipType
    }

    private parseSetStatement(match: MatchClause): SetStatement {
        this.expectKeyword("SET")
        const assignments = this.parseSetAssignments()
        this.assertNoReturnAfterWrite()
        return { kind: "set", match, assignments }
    }

    private parseSetAssignments(): SetAssignment[] {
        const assignments: SetAssignment[] = []
        do {
            const variable = this.expectType("identifier").value
            this.expectPunct(".")
            const property = this.expectType("identifier").value
            this.expectPunct("=")
            const value = this.parseWriteValue()
            assignments.push({ variable, property, value })
        } while (this.consumePunct(","))
        const targetVariables = new Set(assignments.map((assignment) => assignment.variable))
        if (targetVariables.size > 1) {
            throw this.error(
                "SET assignments must target a single variable",
                "Split assignments across multiple do calls when updating different variables.",
            )
        }
        return assignments
    }

    private parseDeleteStatement(match: MatchClause): DeleteStatement {
        if (this.consumeKeyword("DETACH")) {
            // Cypher 慣習との互換のため DETACH を読み飛ばす（挙動は DELETE と同一）。
        }
        this.expectKeyword("DELETE")
        const variable = this.expectType("identifier").value
        this.requireBoundVariable(match.pattern, variable, "DELETE")
        this.assertNoReturnAfterWrite()
        return { kind: "delete", match, variable }
    }

    private parseCopyStatement(match: MatchClause): CopyStatement {
        this.expectKeyword("COPY")
        const variable = this.expectType("identifier").value
        this.requireBoundVariable(match.pattern, variable, "COPY")
        this.assertNoReturnAfterWrite()
        return { kind: "copy", match, variable }
    }

    private parseCreateNodePattern(): CreateNodePattern {
        this.expectPunct("(")
        let variable: string | null = null
        let label: string | null = null
        if (this.peekType("identifier")) {
            variable = this.next().value
        }
        if (this.peekPunct(":")) {
            this.next()
            label = this.expectType("identifier").value
        }
        if (label === null) {
            throw this.error("CREATE requires a node label such as (n:Note)")
        }
        const createProperties = this.peekPunct("{") ? this.parseCreateProperties() : {}
        this.expectPunct(")")
        return { variable, label, properties: {}, createProperties }
    }

    private parseCreateProperties(): Record<string, WriteValue> {
        this.expectPunct("{")
        const properties: Record<string, WriteValue> = {}
        if (!this.peekPunct("}")) {
            do {
                const key = this.expectType("identifier").value
                this.expectPunct(":")
                properties[key] = this.parseWriteValue()
            } while (this.consumePunct(","))
        }
        this.expectPunct("}")
        return properties
    }

    private parseWriteValue(): WriteValue {
        if (this.peekPunct("[")) {
            this.next()
            if (this.peekPunct("{")) {
                const maps: Record<string, ScalarValue>[] = []
                if (!this.peekPunct("]")) {
                    do {
                        maps.push(this.parseMapLiteral())
                    } while (this.consumePunct(","))
                }
                this.expectPunct("]")
                return maps
            }
            const values: ScalarValue[] = []
            if (!this.peekPunct("]")) {
                do {
                    values.push(this.parseScalar())
                } while (this.consumePunct(","))
            }
            this.expectPunct("]")
            return values
        }
        return this.parseScalar()
    }

    private parseMapLiteral(): Record<string, ScalarValue> {
        this.expectPunct("{")
        const map: Record<string, ScalarValue> = {}
        if (!this.peekPunct("}")) {
            do {
                const key = this.expectType("identifier").value
                this.expectPunct(":")
                map[key] = this.parseScalar()
            } while (this.consumePunct(","))
        }
        this.expectPunct("}")
        return map
    }

    private requireBoundVariable(pattern: PatternPart, variable: string, clause: string): void {
        if (!collectBoundVariables(pattern).has(variable)) {
            throw this.error(
                `Variable "${variable}" in ${clause} is not bound in the MATCH pattern`,
                "Use a variable that appears in the MATCH pattern.",
            )
        }
    }

    private assertNoReturnAfterWrite(): void {
        if (this.peekKeyword("RETURN")) {
            throw this.error(
                "Write statements must not include RETURN; the response includes the diff automatically",
                "Remove RETURN from the write statement, or use a read-only MATCH ... RETURN query.",
            )
        }
        if (this.pos < this.tokens.length) {
            throw this.error(`Unexpected token after write clause`)
        }
    }

    private parsePattern(): PatternPart {
        const start = this.parseNodePattern()
        const chain: PatternPart["chain"] = []
        while (this.peekPunct("-")) {
            const relationship = this.parseRelationship()
            const node = this.parseNodePattern()
            chain.push({ relationship, node })
        }
        return { start, chain }
    }

    private parseNodePattern(): NodePattern {
        this.expectPunct("(")
        let variable: string | null = null
        let label: string | null = null

        if (this.peekType("identifier")) {
            variable = this.next().value
        }
        if (this.peekPunct(":")) {
            this.next()
            label = this.expectType("identifier").value
        }
        const properties = this.peekPunct("{") ? this.parseProperties() : {}
        this.expectPunct(")")
        return { variable, label, properties }
    }

    private parseProperties(): Record<string, ScalarValue> {
        this.expectPunct("{")
        const properties: Record<string, ScalarValue> = {}
        if (!this.peekPunct("}")) {
            do {
                const key = this.expectType("identifier").value
                this.expectPunct(":")
                properties[key] = this.parseScalar()
            } while (this.consumePunct(","))
        }
        this.expectPunct("}")
        return properties
    }

    private parseRelationship(): RelationshipPattern {
        this.expectPunct("-")
        this.expectPunct("[")
        this.expectPunct(":")
        const types = [this.expectType("identifier").value]
        while (this.consumePunct("|")) {
            types.push(this.expectType("identifier").value)
        }

        let minHops = 1
        let maxHops = 1
        if (this.consumePunct("*")) {
            minHops = 1
            maxHops = DEFAULT_MAX_HOPS
            const hasMin = this.peekType("number")
            if (hasMin) {
                minHops = this.expectIntegerLiteral()
                maxHops = minHops
            }
            if (this.consumePunct("..")) {
                maxHops = this.peekType("number") ? this.expectIntegerLiteral() : DEFAULT_MAX_HOPS
                if (!hasMin) {
                    minHops = 1
                }
            }
            if (maxHops < minHops) {
                throw this.error(
                    `Variable-length range max (${maxHops}) is less than min (${minHops})`,
                )
            }
        }

        this.expectPunct("]")
        this.expectPunct("->")
        return { types, minHops, maxHops }
    }

    private parseReturnItems(): ReturnItem[] {
        const items: ReturnItem[] = []
        do {
            if (this.consumePunct("*")) {
                items.push({ kind: "all" })
                continue
            }
            const aggregate = this.tryParseAggregate()
            if (aggregate !== null) {
                items.push(aggregate)
                continue
            }
            const variable = this.expectType("identifier").value
            if (this.consumePunct(".")) {
                const property = this.expectType("identifier").value
                items.push({ kind: "property", variable, property })
            } else {
                items.push({ kind: "variable", variable })
            }
        } while (this.consumePunct(","))
        return items
    }

    /** 集計関数 `func(...)` を試行的にパースする。集計でなければ位置を進めず null を返す。 */
    private tryParseAggregate(): AggregateItem | null {
        const token = this.peek()
        if (token === undefined || token.type !== "identifier") {
            return null
        }
        const lowered = token.value.toLowerCase()
        if (!AGGREGATE_FUNCS.has(lowered as AggregateFunc)) {
            return null
        }
        const next = this.tokens[this.pos + 1]
        if (next === undefined || next.type !== "punct" || next.value !== "(") {
            return null
        }
        this.next()
        this.expectPunct("(")
        let arg: AggregateArg
        if (this.consumePunct("*")) {
            arg = { kind: "star" }
        } else {
            const variable = this.expectType("identifier").value
            if (this.consumePunct(".")) {
                const property = this.expectType("identifier").value
                arg = { kind: "property", variable, property }
            } else {
                arg = { kind: "variable", variable }
            }
        }
        this.expectPunct(")")
        const func = lowered as AggregateFunc
        if (func !== "count" && arg.kind !== "property") {
            throw this.error(
                `${func}() requires a property argument such as ${func}(n.pitch); only count() accepts count(*) or count(var)`,
            )
        }
        return { kind: "aggregate", func, arg, alias: aggregateAlias(func, arg) }
    }

    private parseOrderBy(): OrderItem[] {
        this.expectKeyword("ORDER")
        this.expectKeyword("BY")
        const items: OrderItem[] = []
        do {
            const key = this.parseOrderKey()
            let direction: "ASC" | "DESC" = "ASC"
            if (this.consumeKeyword("ASC")) {
                direction = "ASC"
            } else if (this.consumeKeyword("DESC")) {
                direction = "DESC"
            }
            items.push({ key, direction })
        } while (this.consumePunct(","))
        return items
    }

    private parseOrderKey(): OrderKey {
        const aggregate = this.tryParseAggregate()
        if (aggregate !== null) {
            return aggregate
        }
        const variable = this.expectType("identifier").value
        if (this.consumePunct(".")) {
            const property = this.expectType("identifier").value
            return { kind: "property", variable, property }
        }
        return { kind: "variable", variable }
    }

    private parseOr(): WhereExpr {
        let left = this.parseAnd()
        while (this.peekKeyword("OR")) {
            this.next()
            const right = this.parseAnd()
            left = { kind: "logical", operator: "OR", left, right }
        }
        return left
    }

    private parseAnd(): WhereExpr {
        let left = this.parseNot()
        while (this.peekKeyword("AND")) {
            this.next()
            const right = this.parseNot()
            left = { kind: "logical", operator: "AND", left, right }
        }
        return left
    }

    private parseNot(): WhereExpr {
        if (this.peekKeyword("NOT")) {
            this.next()
            return { kind: "not", expr: this.parseNot() }
        }
        return this.parsePrimary()
    }

    private parsePrimary(): WhereExpr {
        if (this.consumePunct("(")) {
            const expr = this.parseOr()
            this.expectPunct(")")
            return expr
        }
        return this.parseComparison()
    }

    private parseComparison(): WhereExpr {
        const variable = this.expectType("identifier").value
        this.expectPunct(".")
        const property = this.expectType("identifier").value
        const { operator, isList } = this.parseOperator()
        const right = isList ? this.parseList() : this.parseScalar()
        return { kind: "comparison", left: { variable, property }, operator, right }
    }

    private parseOperator(): { operator: ComparisonOperator; isList: boolean } {
        if (this.peekKeyword("CONTAINS")) {
            this.next()
            return { operator: "CONTAINS", isList: false }
        }
        if (this.peekKeyword("STARTS")) {
            this.next()
            this.expectKeyword("WITH")
            return { operator: "STARTS_WITH", isList: false }
        }
        if (this.peekKeyword("IN")) {
            this.next()
            return { operator: "IN", isList: true }
        }
        const token = this.next()
        if (token.type !== "punct" || !["=", "<>", "<", ">", "<=", ">="].includes(token.value)) {
            throw this.error(`Expected a comparison operator but found "${token.value}"`)
        }
        return { operator: token.value as ComparisonOperator, isList: false }
    }

    private parseList(): ScalarValue[] {
        this.expectPunct("[")
        const values: ScalarValue[] = []
        if (!this.peekPunct("]")) {
            do {
                values.push(this.parseScalar())
            } while (this.consumePunct(","))
        }
        this.expectPunct("]")
        return values
    }

    private parseScalar(): ScalarValue {
        const token = this.next()
        if (token.type === "string") {
            return token.value
        }
        if (token.type === "number") {
            return Number(token.value)
        }
        if (token.type === "boolean") {
            return token.value === "true"
        }
        if (token.type === "null") {
            return null
        }
        throw this.error(`Expected a scalar value but found "${token.value}"`)
    }

    private expectIntegerLiteral(): number {
        const token = this.expectType("number")
        const value = Number(token.value)
        if (!Number.isInteger(value)) {
            throw this.error(`Expected an integer but found "${token.value}"`)
        }
        return value
    }

    private expectNonNegativeInteger(clause: string): number {
        const value = this.expectIntegerLiteral()
        if (value < 0) {
            throw this.error(`${clause} must be a non-negative integer`)
        }
        return value
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos]
    }

    private next(): Token {
        const token = this.tokens[this.pos]
        if (token === undefined) {
            throw new BadRequestError("Unexpected end of query")
        }
        this.pos++
        return token
    }

    private peekType(type: Token["type"]): boolean {
        return this.peek()?.type === type
    }

    private peekPunct(value: string): boolean {
        const token = this.peek()
        return token?.type === "punct" && token.value === value
    }

    private peekKeyword(value: string): boolean {
        const token = this.peek()
        return token?.type === "keyword" && token.value === value
    }

    private consumePunct(value: string): boolean {
        if (this.peekPunct(value)) {
            this.pos++
            return true
        }
        return false
    }

    private consumeKeyword(value: string): boolean {
        if (this.peekKeyword(value)) {
            this.pos++
            return true
        }
        return false
    }

    private expectPunct(value: string): Token {
        if (!this.peekPunct(value)) {
            throw this.error(`Expected "${value}"`)
        }
        return this.next()
    }

    private expectKeyword(value: string): Token {
        if (!this.peekKeyword(value)) {
            throw this.error(`Expected keyword "${value}"`)
        }
        return this.next()
    }

    private expectType(type: Token["type"]): Token {
        if (!this.peekType(type)) {
            throw this.error(`Expected ${type}`)
        }
        return this.next()
    }

    private error(message: string, hint?: string): BadRequestError {
        const token = this.peek()
        const where =
            token === undefined ? "end of query" : `"${token.value}" (position ${token.start})`
        return new BadRequestError(`Cypher parse error: ${message}, but found ${where}`, {
            hint: hint ?? SUPPORTED_GRAMMAR_HINT,
        })
    }
}

/** Cypher サブセット文字列を AST にパースする。 */
export function parseQuery(input: string): Query {
    return new Parser(tokenize(input)).parse()
}

/** 読み取り・書き込みを含む Cypher 文を AST にパースする。 */
export function parseStatement(input: string): Statement {
    return new Parser(tokenize(input)).parseStatement()
}
