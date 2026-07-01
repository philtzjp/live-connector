import { BadRequestError } from "@live-connector/error"

export type TokenType =
    | "keyword"
    | "identifier"
    | "number"
    | "string"
    | "boolean"
    | "null"
    | "punct"

export type Token = {
    type: TokenType
    value: string
    start: number
}

const KEYWORDS = new Set([
    "MATCH",
    "WHERE",
    "RETURN",
    "LIMIT",
    "AND",
    "OR",
    "NOT",
    "CONTAINS",
    "STARTS",
    "WITH",
    "IN",
    "DISTINCT",
    "ORDER",
    "BY",
    "SKIP",
    "ASC",
    "DESC",
])

const PUNCT_TWO = new Set(["->", "..", ">=", "<=", "<>"])

const PUNCT_ONE = "()[]{}:,.*=<>|-"

function isIdentStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch)
}

function isIdentPart(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch)
}

function isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9"
}

/** Cypher サブセットの入力をトークン列に分解する。 */
export function tokenize(input: string): Token[] {
    const tokens: Token[] = []
    const length = input.length
    let i = 0

    while (i < length) {
        const ch = input[i] ?? ""

        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            i++
            continue
        }

        const start = i

        if (ch === '"' || ch === "'") {
            const quote = ch
            i++
            let text = ""
            while (i < length && input[i] !== quote) {
                if (input[i] === "\\" && i + 1 < length) {
                    text += input[i + 1]
                    i += 2
                    continue
                }
                text += input[i]
                i++
            }
            if (i >= length) {
                throw new BadRequestError(`Unterminated string literal at position ${start}`)
            }
            i++
            tokens.push({ type: "string", value: text, start })
            continue
        }

        if (isDigit(ch) || (ch === "-" && isDigit(input[i + 1] ?? ""))) {
            let num = ""
            if (ch === "-") {
                num += "-"
                i++
            }
            while (i < length && isDigit(input[i] ?? "")) {
                num += input[i]
                i++
            }
            if (input[i] === "." && isDigit(input[i + 1] ?? "")) {
                num += "."
                i++
                while (i < length && isDigit(input[i] ?? "")) {
                    num += input[i]
                    i++
                }
            }
            tokens.push({ type: "number", value: num, start })
            continue
        }

        if (isIdentStart(ch)) {
            let id = ""
            while (i < length && isIdentPart(input[i] ?? "")) {
                id += input[i]
                i++
            }
            const upper = id.toUpperCase()
            if (upper === "TRUE" || upper === "FALSE") {
                tokens.push({ type: "boolean", value: upper.toLowerCase(), start })
            } else if (upper === "NULL") {
                tokens.push({ type: "null", value: "null", start })
            } else if (KEYWORDS.has(upper)) {
                tokens.push({ type: "keyword", value: upper, start })
            } else {
                tokens.push({ type: "identifier", value: id, start })
            }
            continue
        }

        const two = input.slice(i, i + 2)
        if (PUNCT_TWO.has(two)) {
            tokens.push({ type: "punct", value: two, start })
            i += 2
            continue
        }

        if (PUNCT_ONE.includes(ch)) {
            tokens.push({ type: "punct", value: ch, start })
            i++
            continue
        }

        throw new BadRequestError(`Unexpected character "${ch}" at position ${start}`)
    }

    return tokens
}
