import { describe, expect, it } from "vitest"
import { tokenize } from "./tokenizer"

describe("tokenize", () => {
    it("splits a full query into typed tokens", () => {
        const tokens = tokenize('MATCH (t:Track {name:"Drums"}) RETURN t.name LIMIT 5')
        expect(tokens.map((token) => token.type)).toEqual([
            "keyword", // MATCH
            "punct", // (
            "identifier", // t
            "punct", // :
            "identifier", // Track
            "punct", // {
            "identifier", // name
            "punct", // :
            "string", // "Drums"
            "punct", // }
            "punct", // )
            "keyword", // RETURN
            "identifier", // t
            "punct", // .
            "identifier", // name
            "keyword", // LIMIT
            "number", // 5
        ])
    })

    it("recognizes keywords case-insensitively but keeps identifier casing", () => {
        const tokens = tokenize("match (t) return t")
        expect(tokens[0]).toMatchObject({ type: "keyword", value: "MATCH" })
        expect(tokens[2]).toMatchObject({ type: "identifier", value: "t" })
        expect(tokens[4]).toMatchObject({ type: "keyword", value: "RETURN" })
    })

    it("tokenizes booleans and null as dedicated types", () => {
        expect(tokenize("TRUE")[0]).toMatchObject({ type: "boolean", value: "true" })
        expect(tokenize("false")[0]).toMatchObject({ type: "boolean", value: "false" })
        expect(tokenize("NULL")[0]).toMatchObject({ type: "null", value: "null" })
    })

    it("parses integer, decimal, and negative numbers", () => {
        expect(tokenize("42")[0]).toMatchObject({ type: "number", value: "42" })
        expect(tokenize("3.14")[0]).toMatchObject({ type: "number", value: "3.14" })
        expect(tokenize("-7")[0]).toMatchObject({ type: "number", value: "-7" })
    })

    it("handles string escapes and both quote styles", () => {
        expect(tokenize('"a\\"b"')[0]).toMatchObject({ type: "string", value: 'a"b' })
        expect(tokenize("'plain'")[0]).toMatchObject({ type: "string", value: "plain" })
    })

    it("recognizes two-character punctuation", () => {
        expect(tokenize("->")[0]).toMatchObject({ type: "punct", value: "->" })
        expect(tokenize("..")[0]).toMatchObject({ type: "punct", value: ".." })
        expect(tokenize(">=")[0]).toMatchObject({ type: "punct", value: ">=" })
        expect(tokenize("<>")[0]).toMatchObject({ type: "punct", value: "<>" })
    })

    it("throws on an unterminated string literal", () => {
        expect(() => tokenize('"open')).toThrow(/Unterminated string/)
    })

    it("throws on an unexpected character", () => {
        expect(() => tokenize("@")).toThrow(/Unexpected character/)
    })
})
