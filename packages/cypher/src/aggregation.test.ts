import { describe, expect, it } from "vitest"
import { evaluate } from "./evaluator"
import { parseQuery } from "./parser"
import { FakeGraph, type FakeNode } from "./test-support/fake-graph"

/** 2 つの MidiTrack がそれぞれノートを持つグラフ（グルーピング検証用）。 */
function buildGroupedGraph(): FakeGraph {
    const nodes: FakeNode[] = [
        { id: 0, label: "Song", props: {}, edges: { HAS_TRACK: [1, 2] } },
        {
            id: 1,
            label: "MidiTrack",
            props: { name: "Drums", index: 0 },
            edges: { HAS_NOTE: [3, 4] },
        },
        {
            id: 2,
            label: "MidiTrack",
            props: { name: "Keys", index: 1 },
            edges: { HAS_NOTE: [5, 6, 7] },
        },
        { id: 3, label: "Note", props: { pitch: 60 }, edges: {} },
        { id: 4, label: "Note", props: { pitch: 64 }, edges: {} },
        { id: 5, label: "Note", props: { pitch: 67 }, edges: {} },
        { id: 6, label: "Note", props: { pitch: 72 }, edges: {} },
        { id: 7, label: "Note", props: { pitch: 76 }, edges: {} },
    ]
    return new FakeGraph(nodes, { Track: ["MidiTrack"], MidiTrack: [] })
}

describe("parser: aggregation / ordering", () => {
    it("parses count(*), count(var), and property aggregates with aliases", () => {
        expect(parseQuery("MATCH (n:Note) RETURN count(*)").returns[0]).toEqual({
            kind: "aggregate",
            func: "count",
            arg: { kind: "star" },
            alias: "count(*)",
        })
        expect(
            parseQuery("MATCH (c:MidiClip)-[:HAS_NOTE]->(n:Note) RETURN avg(n.pitch)").returns[0],
        ).toMatchObject({
            func: "avg",
            arg: { kind: "property", variable: "n", property: "pitch" },
            alias: "avg(n.pitch)",
        })
    })

    it("parses DISTINCT, ORDER BY with direction, SKIP and LIMIT", () => {
        const query = parseQuery(
            "MATCH (t:Track) RETURN DISTINCT t.name ORDER BY t.name DESC SKIP 2 LIMIT 3",
        )
        expect(query.distinct).toBe(true)
        expect(query.orderBy).toEqual([
            { key: { kind: "property", variable: "t", property: "name" }, direction: "DESC" },
        ])
        expect(query.skip).toBe(2)
        expect(query.limit).toBe(3)
    })

    it.each([
        ["MATCH (n:Note) RETURN avg(n)", /avg\(\) requires a property argument/],
        ["MATCH (n:Note) RETURN *, count(n)", /cannot be combined with aggregate/],
        ["MATCH (n:Note) RETURN n SKIP -1", /SKIP must be a non-negative integer/],
    ])("rejects invalid aggregate/paging query %s", (query, message) => {
        expect(() => parseQuery(query)).toThrow(message)
    })
})

describe("evaluate: aggregation", () => {
    it("computes count grouped by a non-aggregate key with implicit grouping", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:MidiTrack)-[:HAS_NOTE]->(n:Note) RETURN t.name, count(n)"),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([
            { "t.name": "Drums", "count(n)": 2 },
            { "t.name": "Keys", "count(n)": 3 },
        ])
    })

    it("computes min/max/avg/sum over a property", async () => {
        const rows = await evaluate(
            parseQuery(
                "MATCH (n:Note) RETURN min(n.pitch), max(n.pitch), sum(n.pitch), avg(n.pitch)",
            ),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([
            {
                "min(n.pitch)": 60,
                "max(n.pitch)": 76,
                "sum(n.pitch)": 60 + 64 + 67 + 72 + 76,
                "avg(n.pitch)": (60 + 64 + 67 + 72 + 76) / 5,
            },
        ])
    })

    it("orders grouped rows by an aggregate DESC", async () => {
        const rows = await evaluate(
            parseQuery(
                "MATCH (t:MidiTrack)-[:HAS_NOTE]->(n:Note) RETURN t.name, count(n) ORDER BY count(n) DESC",
            ),
            buildGroupedGraph(),
        )
        expect(rows.map((row) => row["t.name"])).toEqual(["Keys", "Drums"])
    })

    it("returns a single row for a pure aggregate over an empty match", async () => {
        // 「0 件」と「パターン不一致」を区別させない Cypher 標準の挙動。
        const rows = await evaluate(
            parseQuery(
                'MATCH (t:MidiTrack {name:"存在しない"}) RETURN count(t), sum(t.index), min(t.index), max(t.index), avg(t.index)',
            ),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([
            {
                "count(t)": 0,
                "sum(t.index)": 0,
                "min(t.index)": null,
                "max(t.index)": null,
                "avg(t.index)": null,
            },
        ])
    })

    it("keeps zero rows for a grouped aggregate over an empty match", async () => {
        const rows = await evaluate(
            parseQuery('MATCH (t:MidiTrack {name:"存在しない"}) RETURN t.name, count(t)'),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([])
    })

    it("rejects an aggregate over a variable that is not bound in MATCH", async () => {
        await expect(
            evaluate(parseQuery("MATCH (t:MidiTrack) RETURN count(x)"), buildGroupedGraph()),
        ).rejects.toThrow(/Unknown variable "x"/)
        await expect(
            evaluate(parseQuery("MATCH (t:MidiTrack) RETURN min(x.pitch)"), buildGroupedGraph()),
        ).rejects.toThrow(/Unknown variable "x"/)
    })

    it("computes min/max over string properties lexicographically", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:MidiTrack) RETURN min(t.name), max(t.name)"),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([{ "min(t.name)": "Drums", "max(t.name)": "Keys" }])
    })
})

describe("evaluate: ordering / distinct / paging", () => {
    it("orders rows by a property not present in RETURN", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:MidiTrack) RETURN t.name ORDER BY t.index DESC"),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([{ "t.name": "Keys" }, { "t.name": "Drums" }])
    })

    it("deduplicates rows with DISTINCT", async () => {
        const withDuplicates = await evaluate(
            parseQuery("MATCH (t:MidiTrack)-[:HAS_NOTE]->(n:Note) RETURN t.name"),
            buildGroupedGraph(),
        )
        expect(withDuplicates).toHaveLength(5)
        const distinct = await evaluate(
            parseQuery("MATCH (t:MidiTrack)-[:HAS_NOTE]->(n:Note) RETURN DISTINCT t.name"),
            buildGroupedGraph(),
        )
        expect(distinct).toEqual([{ "t.name": "Drums" }, { "t.name": "Keys" }])
    })

    it("applies SKIP and LIMIT after ordering", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (n:Note) RETURN n.pitch ORDER BY n.pitch SKIP 1 LIMIT 2"),
            buildGroupedGraph(),
        )
        expect(rows).toEqual([{ "n.pitch": 64 }, { "n.pitch": 67 }])
    })
})
