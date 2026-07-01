import { describe, expect, it } from "vitest"
import { parseQuery } from "./parser"

describe("parseQuery", () => {
    it("parses a minimal MATCH ... RETURN", () => {
        const query = parseQuery("MATCH (t:Track) RETURN t")
        expect(query.pattern.start).toMatchObject({ variable: "t", label: "Track", properties: {} })
        expect(query.pattern.chain).toHaveLength(0)
        expect(query.returns).toEqual([{ kind: "variable", variable: "t" }])
        expect(query.where).toBeNull()
        expect(query.limit).toBeNull()
    })

    it("parses inline property maps on node patterns", () => {
        const query = parseQuery('MATCH (t:Track {name:"Drums", mute:true}) RETURN t')
        expect(query.pattern.start.properties).toEqual({ name: "Drums", mute: true })
    })

    it("parses relationship chains with alternation types", () => {
        const query = parseQuery(
            "MATCH (t:Track)-[:HAS_CLIPSLOT|HAS_ARRANGEMENT_CLIP]->(c:Clip) RETURN c",
        )
        const step = query.pattern.chain[0]
        expect(step?.relationship.types).toEqual(["HAS_CLIPSLOT", "HAS_ARRANGEMENT_CLIP"])
        expect(step?.relationship).toMatchObject({ minHops: 1, maxHops: 1 })
    })

    it.each([
        ["*", { minHops: 1, maxHops: 8 }],
        ["*2", { minHops: 2, maxHops: 2 }],
        ["*1..3", { minHops: 1, maxHops: 3 }],
        ["*..3", { minHops: 1, maxHops: 3 }],
    ])("parses variable-length relationship %s", (spec, expected) => {
        const query = parseQuery(`MATCH (a:Song)-[:HAS_TRACK${spec}]->(b:Track) RETURN b`)
        expect(query.pattern.chain[0]?.relationship).toMatchObject(expected)
    })

    it("parses WHERE with AND / OR / NOT precedence", () => {
        const query = parseQuery(
            "MATCH (n:Note) WHERE n.pitch >= 60 AND n.velocity > 100 OR NOT n.muted = true RETURN n",
        )
        expect(query.where?.kind).toBe("logical")
        // OR is the lowest-precedence root operator.
        expect(query.where).toMatchObject({ kind: "logical", operator: "OR" })
    })

    it("parses IN, CONTAINS and STARTS WITH operators", () => {
        expect(parseQuery("MATCH (t:Track) WHERE t.name IN [1, 2] RETURN t").where).toMatchObject({
            kind: "comparison",
            operator: "IN",
            right: [1, 2],
        })
        expect(
            parseQuery('MATCH (t:Track) WHERE t.name CONTAINS "ru" RETURN t').where,
        ).toMatchObject({ operator: "CONTAINS", right: "ru" })
        expect(
            parseQuery('MATCH (t:Track) WHERE t.name STARTS WITH "Dr" RETURN t').where,
        ).toMatchObject({ operator: "STARTS_WITH", right: "Dr" })
    })

    it("parses RETURN with property projection, wildcard and multiple items", () => {
        expect(parseQuery("MATCH (t:Track) RETURN *").returns).toEqual([{ kind: "all" }])
        expect(parseQuery("MATCH (t:Track) RETURN t.name, t.index").returns).toEqual([
            { kind: "property", variable: "t", property: "name" },
            { kind: "property", variable: "t", property: "index" },
        ])
    })

    it("parses a trailing LIMIT", () => {
        expect(parseQuery("MATCH (t:Track) RETURN t LIMIT 10").limit).toBe(10)
    })

    it.each([
        ["RETURN (t:Track) RETURN t", /Expected keyword "MATCH"/],
        ["MATCH (t:Track)", /Expected keyword "RETURN"/],
        ["MATCH (t:Track) RETURN t EXTRA", /Unexpected token after RETURN/],
        ["MATCH (a:Song)-[:HAS_TRACK*3..1]->(b) RETURN b", /max \(1\) is less than min \(3\)/],
    ])("throws for invalid query %s", (query, message) => {
        expect(() => parseQuery(query)).toThrow(message)
    })
})
