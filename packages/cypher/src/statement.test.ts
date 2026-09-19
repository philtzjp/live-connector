import { describe, expect, it } from "vitest"
import { parseQuery, parseStatement } from "./parser"

describe("parseStatement", () => {
    describe("read statements", () => {
        it("returns ReadStatement equivalent to parseQuery", () => {
            const text = 'MATCH (t:Track {name:"Drums"}) WHERE t.mute = false RETURN t.name LIMIT 5'
            const statement = parseStatement(text)
            expect(statement).toEqual({ kind: "read", query: parseQuery(text) })
        })
    })

    describe("SET", () => {
        it("parses a single assignment", () => {
            const statement = parseStatement('MATCH (t:Track {name:"Drums"}) SET t.mute = true')
            expect(statement).toEqual({
                kind: "set",
                match: {
                    pattern: {
                        start: {
                            variable: "t",
                            label: "Track",
                            properties: { name: "Drums" },
                        },
                        chain: [],
                    },
                    where: null,
                },
                assignments: [{ variable: "t", property: "mute", value: true }],
            })
        })

        it("parses multiple assignments on the same variable", () => {
            const statement = parseStatement('MATCH (c:Clip) SET c.name = "Intro", c.color = 1')
            expect(statement.kind).toBe("set")
            if (statement.kind !== "set") {
                return
            }
            expect(statement.assignments).toEqual([
                { variable: "c", property: "name", value: "Intro" },
                { variable: "c", property: "color", value: 1 },
            ])
        })

        it("parses notes map array assignment", () => {
            const statement = parseStatement(
                "MATCH (c:Clip) SET c.notes = [{pitch:60, startTime:0, duration:1, velocity:100}, {pitch:64, startTime:1, duration:1, velocity:90}]",
            )
            expect(statement.kind).toBe("set")
            if (statement.kind !== "set") {
                return
            }
            expect(statement.assignments[0]?.value).toEqual([
                { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
                { pitch: 64, startTime: 1, duration: 1, velocity: 90 },
            ])
        })

        it("parses negative numbers and boolean/null values", () => {
            const statement = parseStatement(
                "MATCH (n:Note) SET n.pitch = -0.5, n.muted = false, n.label = null",
            )
            expect(statement.kind).toBe("set")
            if (statement.kind !== "set") {
                return
            }
            expect(statement.assignments).toEqual([
                { variable: "n", property: "pitch", value: -0.5 },
                { variable: "n", property: "muted", value: false },
                { variable: "n", property: "label", value: null },
            ])
        })

        it("parses scalar array assignment", () => {
            const statement = parseStatement("MATCH (t:Track) SET t.indices = [1, 2, 3]")
            expect(statement.kind).toBe("set")
            if (statement.kind !== "set") {
                return
            }
            expect(statement.assignments[0]?.value).toEqual([1, 2, 3])
        })
    })

    describe("CREATE", () => {
        it("parses standalone CREATE", () => {
            const statement = parseStatement("CREATE (n:Note {pitch:60, velocity:100})")
            expect(statement).toEqual({
                kind: "create",
                match: null,
                anchorVariable: null,
                relationshipType: null,
                node: {
                    variable: "n",
                    label: "Note",
                    properties: {},
                    createProperties: { pitch: 60, velocity: 100 },
                },
            })
        })

        it("parses anchored CREATE with HAS_DEVICE", () => {
            const statement = parseStatement(
                'MATCH (t:Track {name:"Drums"}) CREATE (t)-[:HAS_DEVICE]->(d:Device {name:"Compressor"})',
            )
            expect(statement).toMatchObject({
                kind: "create",
                anchorVariable: "t",
                relationshipType: "HAS_DEVICE",
                node: {
                    variable: "d",
                    label: "Device",
                    createProperties: { name: "Compressor" },
                },
            })
        })

        it("parses anchored CREATE with HAS_CLIP", () => {
            const statement = parseStatement(
                'MATCH (s:Scene) CREATE (s)-[:HAS_CLIP]->(c:Clip {name:"A"})',
            )
            expect(statement).toMatchObject({
                kind: "create",
                relationshipType: "HAS_CLIP",
                node: { label: "Clip" },
            })
        })

        it("parses anchored CREATE with HAS_ARRANGEMENT_CLIP", () => {
            const statement = parseStatement(
                "MATCH (t:Track) CREATE (t)-[:HAS_ARRANGEMENT_CLIP]->(c:Clip)",
            )
            expect(statement).toMatchObject({
                kind: "create",
                relationshipType: "HAS_ARRANGEMENT_CLIP",
                node: { label: "Clip", createProperties: {} },
            })
        })
    })

    describe("DELETE and COPY", () => {
        it("parses DELETE", () => {
            const statement = parseStatement("MATCH (n:Note {pitch:60}) DELETE n")
            expect(statement).toEqual({
                kind: "delete",
                match: {
                    pattern: {
                        start: {
                            variable: "n",
                            label: "Note",
                            properties: { pitch: 60 },
                        },
                        chain: [],
                    },
                    where: null,
                },
                variable: "n",
            })
        })

        it("parses DETACH DELETE", () => {
            const statement = parseStatement("MATCH (d:Device) DETACH DELETE d")
            expect(statement).toMatchObject({ kind: "delete", variable: "d" })
        })

        it("parses COPY", () => {
            const statement = parseStatement('MATCH (c:Clip {name:"A"}) COPY c')
            expect(statement).toMatchObject({ kind: "copy", variable: "c" })
        })
    })

    describe("CALL", () => {
        it("parses a zero-argument procedure call", () => {
            expect(parseStatement("CALL transport.play()")).toEqual({
                kind: "call",
                procedure: "transport.play",
                args: [],
            })
        })

        it("parses a numeric argument", () => {
            expect(parseStatement("CALL transport.seek(32)")).toEqual({
                kind: "call",
                procedure: "transport.seek",
                args: [32],
            })
        })

        it("parses a string argument", () => {
            expect(parseStatement('CALL render.cancel("render-abc")')).toEqual({
                kind: "call",
                procedure: "render.cancel",
                args: ["render-abc"],
            })
        })

        it("rejects a bare identifier argument (no variable references)", () => {
            expect(() => parseStatement("CALL render.cancel(job)")).toThrow(
                /Expected a scalar value/,
            )
        })

        it("rejects multiple statements chained after CALL", () => {
            expect(() => parseStatement("CALL transport.stop() CALL transport.play()")).toThrow(
                /single CALL with literal arguments/,
            )
        })

        it("rejects a CALL without parentheses", () => {
            expect(() => parseStatement("CALL transport.stop")).toThrow(/Expected "\("/)
        })
    })

    describe("errors", () => {
        it("rejects SET assignments targeting multiple variables", () => {
            expect(() =>
                parseStatement(
                    'MATCH (t:Track)-[:HAS_CLIP]->(c:Clip) SET t.mute = true, c.name = "X"',
                ),
            ).toThrow(/SET assignments must target a single variable/)
        })

        it("rejects RETURN after SET", () => {
            expect(() => parseStatement("MATCH (t:Track) SET t.mute = true RETURN t")).toThrow(
                /must not include RETURN/,
            )
        })

        it("rejects RETURN after DELETE", () => {
            expect(() => parseStatement("MATCH (n:Note) DELETE n RETURN n")).toThrow(
                /must not include RETURN/,
            )
        })

        it("rejects unbound DELETE variable", () => {
            expect(() => parseStatement("MATCH (t:Track)-[:HAS_NOTE]->(n:Note) DELETE c")).toThrow(
                /not bound in the MATCH pattern/,
            )
        })

        it("rejects unbound COPY variable", () => {
            expect(() => parseStatement("MATCH (t:Track) COPY c")).toThrow(
                /not bound in the MATCH pattern/,
            )
        })

        it("rejects unbound anchored CREATE anchor", () => {
            expect(() =>
                parseStatement("MATCH (t:Track) CREATE (s)-[:HAS_CLIP]->(c:Clip)"),
            ).toThrow(/not bound in the MATCH pattern/)
        })

        it("rejects CREATE without label", () => {
            expect(() => parseStatement("CREATE (n)")).toThrow(/requires a node label/)
        })

        it("rejects variable-length relationship in anchored CREATE", () => {
            expect(() =>
                parseStatement("MATCH (t:Track) CREATE (t)-[:HAS_NOTE*]->(n:Note)"),
            ).toThrow(/Variable-length relationships/)
        })

        it("rejects relationship alternation in anchored CREATE", () => {
            expect(() =>
                parseStatement(
                    "MATCH (t:Track) CREATE (t)-[:HAS_CLIP|HAS_ARRANGEMENT_CLIP]->(c:Clip)",
                ),
            ).toThrow(/single relationship type/)
        })

        it("rejects anchored pattern in standalone CREATE", () => {
            expect(() => parseStatement('CREATE (t)-[:HAS_CLIP]->(c:Clip {name:"A"})')).toThrow(
                /anchored relationship pattern/,
            )
        })
    })
})
