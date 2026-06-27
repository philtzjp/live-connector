import { MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toProblemDetails } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps } from "../deps"
import { LomGraphAdapter } from "../lom/adapter"

const noteSchema = z.object({
    pitch: z.number().int().min(0).max(127),
    startTime: z.number().min(0),
    duration: z.number().positive(),
    velocity: z.number().min(0).max(127).optional(),
    muted: z.boolean().optional(),
    probability: z.number().min(0).max(1).optional(),
    releaseVelocity: z.number().min(0).max(127).optional(),
    velocityDeviation: z.number().optional(),
})

type NoteInput = z.infer<typeof noteSchema>

function toNoteDescription(input: NoteInput): NoteDescription {
    const note: NoteDescription = {
        pitch: input.pitch,
        startTime: input.startTime,
        duration: input.duration,
    }
    if (input.velocity !== undefined) {
        note.velocity = input.velocity
    }
    if (input.muted !== undefined) {
        note.muted = input.muted
    }
    if (input.probability !== undefined) {
        note.probability = input.probability
    }
    if (input.releaseVelocity !== undefined) {
        note.releaseVelocity = input.releaseVelocity
    }
    if (input.velocityDeviation !== undefined) {
        note.velocityDeviation = input.velocityDeviation
    }
    return note
}

/** `write_notes` ツール: select で選んだ単一 MidiClip の notes を置換する。 */
export function registerNotesTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "write_notes",
        {
            title: "MIDI ノート書き込み",
            description:
                "select で選んだ 1 つの MidiClip の notes を置換する（mode: replace）。各ノートは pitch/startTime/duration/velocity 等。",
            inputSchema: {
                select: z.string().min(1).describe("MidiClip を 1 変数で RETURN する Cypher"),
                notes: z.array(noteSchema),
                mode: z.enum(["replace"]).default("replace"),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, notes, preview }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const nodes = await selectNodes(parseQuery(select), adapter)
                if (nodes.length !== 1) {
                    throw new BadRequestError(
                        `write_notes requires the selection to match exactly one MidiClip, but matched ${nodes.length}`,
                    )
                }
                const node = nodes[0]
                if (
                    node === undefined ||
                    node.type !== "object" ||
                    !(node.value instanceof MidiClip)
                ) {
                    throw new BadRequestError("select must return a MidiClip")
                }
                const clip = node.value
                const descriptions = notes.map(toNoteDescription)

                if (preview === true) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    { status: "preview", noteCount: descriptions.length },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    }
                }

                deps.context.withinTransaction(() => {
                    clip.notes = descriptions
                })

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                { status: "ok", noteCount: descriptions.length },
                                null,
                                2,
                            ),
                        },
                    ],
                }
            } catch (error) {
                deps.log.error("write_notes failed", { error: String(error) })
                return {
                    content: [{ type: "text", text: JSON.stringify(toProblemDetails(error)) }],
                    isError: true,
                }
            }
        },
    )
}
