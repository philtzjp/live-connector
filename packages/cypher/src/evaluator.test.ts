import { describe, expect, it } from "vitest"
import { evaluate, selectNodes } from "./evaluator"
import { parseQuery } from "./parser"
import { FakeGraph, type FakeNode } from "./test-support/fake-graph"

function buildGraph(): FakeGraph {
    const nodes: FakeNode[] = [
        { id: 0, label: "Song", props: { tempo: 120 }, edges: { HAS_TRACK: [1, 2] } },
        {
            id: 1,
            label: "MidiTrack",
            props: { name: "Drums", index: 0, mute: false },
            edges: { HAS_NOTE: [3, 4] },
        },
        {
            id: 2,
            label: "AudioTrack",
            props: { name: "Bass", index: 1, mute: true },
            edges: {},
        },
        { id: 3, label: "Note", props: { pitch: 60, velocity: 100 }, edges: {} },
        { id: 4, label: "Note", props: { pitch: 72, velocity: 40 }, edges: {} },
    ]
    return new FakeGraph(nodes, { Track: ["MidiTrack", "AudioTrack"] })
}

describe("evaluate", () => {
    it("returns matched abstract-label nodes with property projections", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:Track) RETURN t.name, t.index"),
            buildGraph(),
        )
        expect(rows).toEqual([
            { "t.name": "Drums", "t.index": 0 },
            { "t.name": "Bass", "t.index": 1 },
        ])
    })

    it("filters rows via WHERE", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:Track) WHERE t.mute = true RETURN t.name"),
            buildGraph(),
        )
        expect(rows).toEqual([{ "t.name": "Bass" }])
    })

    it("serializes whole nodes for RETURN *", async () => {
        const rows = await evaluate(
            parseQuery('MATCH (t:Track {name:"Drums"}) RETURN *'),
            buildGraph(),
        )
        expect(rows).toEqual([{ t: { _label: "MidiTrack", name: "Drums", index: 0, mute: false } }])
    })

    it("expands relationships and applies a numeric WHERE", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:Track)-[:HAS_NOTE]->(n:Note) WHERE n.pitch >= 70 RETURN n.pitch"),
            buildGraph(),
        )
        expect(rows).toEqual([{ "n.pitch": 72 }])
    })

    it("honors LIMIT", async () => {
        const rows = await evaluate(
            parseQuery("MATCH (t:Track) RETURN t.name LIMIT 1"),
            buildGraph(),
        )
        expect(rows).toHaveLength(1)
    })
})

describe("selectNodes", () => {
    it("returns the bound nodes for a single-variable RETURN", async () => {
        const nodes = await selectNodes(
            parseQuery('MATCH (t:Track {name:"Bass"}) RETURN t'),
            buildGraph(),
        )
        expect(nodes.map((node) => node.id)).toEqual([2])
    })

    it("deduplicates nodes reached by multiple paths", async () => {
        const graph = new FakeGraph([
            { id: 0, label: "Song", props: {}, edges: { HAS_TRACK: [1], HAS_MAIN: [1] } },
            { id: 1, label: "MidiTrack", props: { name: "Drums" }, edges: {} },
        ])
        const nodes = await selectNodes(
            parseQuery("MATCH (s:Song)-[:HAS_TRACK|HAS_MAIN]->(t:MidiTrack) RETURN t"),
            graph,
        )
        expect(nodes).toHaveLength(1)
    })

    it("rejects RETURN of a property projection", async () => {
        await expect(
            selectNodes(parseQuery("MATCH (t:Track) RETURN t.name"), buildGraph()),
        ).rejects.toThrow(/exactly one bound node variable/)
    })

    it("rejects RETURN of multiple variables", async () => {
        await expect(
            selectNodes(
                parseQuery("MATCH (t:Track)-[:HAS_NOTE]->(n:Note) RETURN t, n"),
                buildGraph(),
            ),
        ).rejects.toThrow(/exactly one bound node variable/)
    })
})
