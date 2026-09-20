import { describe, expect, it } from "vitest"
import { bigintToJsonValue, jsonReplacer, stringifyJson } from "./index"

describe("bigintToJsonValue", () => {
    it("安全整数の範囲内は数値を返す", () => {
        expect(bigintToJsonValue(0n)).toBe(0)
        expect(bigintToJsonValue(42n)).toBe(42)
        expect(bigintToJsonValue(-7n)).toBe(-7)
        expect(bigintToJsonValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
        expect(bigintToJsonValue(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER)
    })

    it("安全整数の範囲外は精度を保つため 10 進文字列を返す", () => {
        const above = BigInt(Number.MAX_SAFE_INTEGER) + 1n
        const below = BigInt(Number.MIN_SAFE_INTEGER) - 1n
        expect(bigintToJsonValue(above)).toBe("9007199254740992")
        expect(bigintToJsonValue(below)).toBe("-9007199254740992")
    })
})

describe("jsonReplacer", () => {
    it("bigint 以外の値はそのまま通す", () => {
        expect(jsonReplacer("k", "text")).toBe("text")
        expect(jsonReplacer("k", 1)).toBe(1)
        expect(jsonReplacer("k", null)).toBeNull()
        expect(jsonReplacer("k", true)).toBe(true)
    })
})

describe("stringifyJson", () => {
    it("bigint を含むオブジェクトを例外なく直列化する", () => {
        const payload = { status: "preview", matched: 1n, targets: [{ index: 0n, name: "Scene" }] }
        expect(stringifyJson(payload)).toBe(
            '{"status":"preview","matched":1,"targets":[{"index":0,"name":"Scene"}]}',
        )
    })

    it("bigint を含む配列を直列化する", () => {
        expect(stringifyJson([1n, 2n, 3])).toBe("[1,2,3]")
    })

    it("入れ子の bigint も数値として返す", () => {
        const payload = { a: { b: { c: 12345n } } }
        expect(JSON.parse(stringifyJson(payload))).toEqual({ a: { b: { c: 12345 } } })
    })

    it("space を渡すと整形して返す", () => {
        expect(stringifyJson({ index: 3n }, 2)).toBe('{\n  "index": 3\n}')
    })

    it("bigint を含まない値は JSON.stringify と同じ結果を返す", () => {
        const payload = { status: "ok", count: 2, rows: [{ name: "Track 1" }], truncated: false }
        expect(stringifyJson(payload)).toBe(JSON.stringify(payload))
    })

    it("undefined のプロパティは JSON.stringify と同じく省略する", () => {
        expect(stringifyJson({ a: undefined, b: 1n })).toBe('{"b":1}')
    })
})
