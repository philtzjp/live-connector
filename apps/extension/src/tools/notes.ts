import { type Clip, MidiClip, type NoteDescription } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
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

type NoteStartTime = { startTime: number }

/** クリップ相対のノート配置に使うクリップ長。ループ・内容窓を含む上限を採用し誤検出を避ける。 */
export function clipNoteLength(clip: Clip<TargetApiVersion>): number {
    return Math.max(clip.duration, clip.loopEnd, clip.endMarker)
}

/**
 * クリップ相対座標 [0, clipLength) を外れるノートの index / startTime を返す。
 * ノートの startTime はクリップ相対拍。アレンジメント絶対拍を混入させると境界外になる。
 */
export function findOutOfRangeNotes(
    notes: readonly NoteStartTime[],
    clipLength: number,
): { index: number; startTime: number }[] {
    const offending: { index: number; startTime: number }[] = []
    notes.forEach((note, index) => {
        if (note.startTime < 0 || note.startTime >= clipLength) {
            offending.push({ index, startTime: note.startTime })
        }
    })
    return offending
}

function selectDescription(): string {
    return 'MidiClip を単一ノード変数で RETURN する Cypher。query のようなプロパティ射影（RETURN c.name）や複数変数（RETURN t, c）は不可。例: MATCH (c:MidiClip {name:"Bass"}) RETURN c'
}

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
                "select で選んだ 1 つの MidiClip の notes を置換する（mode: replace）。各ノートの startTime/duration はクリップ相対拍（[0, クリップ長)）。アレンジメント絶対拍（Clip.startTime や create_arrangement_clip の startTime）とは座標系が異なる。クリップ長を超える startTime のノートは既定で拒否する（allowOutOfRange:true で許容）。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                notes: z.array(noteSchema),
                mode: z.enum(["replace"]).default("replace"),
                allowOutOfRange: z
                    .boolean()
                    .optional()
                    .describe("クリップ長を超える startTime のノートを許容する（既定 false）"),
                preview: z.boolean().optional(),
            },
        },
        async ({ select, notes, allowOutOfRange, preview }) => {
            try {
                const adapter = new LomGraphAdapter(deps.context)
                const nodes = await selectNodes(parseQuery(select), adapter)
                if (nodes.length !== 1) {
                    throw new BadRequestError(
                        `write_notes requires the selection to match exactly one MidiClip, but matched ${nodes.length}`,
                        {
                            hint: 'Change select so it returns exactly one MidiClip node, e.g. MATCH (c:MidiClip {name:"Bass"}) RETURN c.',
                        },
                    )
                }
                const node = nodes[0]
                if (
                    node === undefined ||
                    node.type !== "object" ||
                    !(node.value instanceof MidiClip)
                ) {
                    throw new BadRequestError("select must return a MidiClip", {
                        hint: "Use a select query that returns a MidiClip node.",
                    })
                }
                const clip = node.value
                const clip_length = clipNoteLength(clip)
                const out_of_range = findOutOfRangeNotes(notes, clip_length)
                if (out_of_range.length > 0 && allowOutOfRange !== true) {
                    throw new BadRequestError(
                        `${out_of_range.length} note(s) fall outside the clip's relative range [0, ${clip_length}). Note startTime is clip-relative beats, not arrangement-absolute beats.`,
                        {
                            hint: `LOM has two time coordinate systems: note startTime / clip markers are CLIP-RELATIVE beats in [0, clipLength); Clip.startTime/endTime and create_arrangement_clip startTime are ARRANGEMENT-ABSOLUTE beats. Recompute the offending notes relative to the clip start, or pass allowOutOfRange:true. Offending indices: ${out_of_range.map((entry) => `${entry.index}@${entry.startTime}`).join(", ")}.`,
                        },
                    )
                }
                const descriptions = notes.map(toNoteDescription)

                if (preview === true) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "preview",
                                        noteCount: descriptions.length,
                                        clipLength: clip_length,
                                        outOfRange: out_of_range.length,
                                    },
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
                                {
                                    status: "ok",
                                    noteCount: descriptions.length,
                                    clipLength: clip_length,
                                    outOfRange: out_of_range.length,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                }
            } catch (error) {
                deps.log.error("write_notes failed", { error: String(error) })
                return {
                    content: [{ type: "text", text: JSON.stringify(toMcpError(error), null, 2) }],
                    isError: true,
                }
            }
        },
    )
}
