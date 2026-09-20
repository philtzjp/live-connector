import {
    AudioTrack,
    Chain,
    ClipSlot,
    type Device,
    MidiClip,
    MidiTrack,
    Track,
} from "@ableton-extensions/sdk"
import type { CreateStatement, ScalarValue, WriteValue } from "@live-connector/cypher"
import { resolveWriteTargets } from "@live-connector/cypher"
import { BadRequestError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../../deps"
import type { LomNode } from "../../lom/adapter"
import { createAdapterFromDeps } from "../../lom/create-adapter"
import { objectIdentity } from "../../undo/identity"
import type { InverseDeleteCreated } from "../../undo/types"
import { CATALOG_DEVICE_NAMES } from "./devices"
import { mergeNotes, toNoteDescription } from "./notes"
import { assertSampleFile } from "./samples"
import { beginWrite, finalizeWrite, noMatchResponse } from "./write-support"

type V = TargetApiVersion

function readCreateProperty(
    props: Record<string, WriteValue>,
    name: string,
): ScalarValue | undefined {
    const value = props[name]
    if (
        value === undefined ||
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value
    }
    return undefined
}

function readCreateString(props: Record<string, WriteValue>, name: string): string | undefined {
    const value = readCreateProperty(props, name)
    return typeof value === "string" ? value : undefined
}

function readCreateNumber(props: Record<string, WriteValue>, name: string): number | undefined {
    const value = readCreateProperty(props, name)
    return typeof value === "number" ? value : undefined
}

const SUPPORTED_CREATE_HINT =
    "CREATE (t:MidiTrack|AudioTrack {name?}); CREATE (s:Scene {index?, name?}); CREATE (c:CuePoint {time, name?}); MATCH (t:Track) CREATE (t)-[:HAS_DEVICE]->(d:Device {name, index?}); MATCH (:Device)-[:HAS_CHAIN]->(ch:Chain) CREATE (ch)-[:HAS_DEVICE]->(d:Device {name, index?}); MATCH (s:ClipSlot) CREATE (s)-[:HAS_CLIP]->(c:MidiClip {length}) | (c:AudioClip {filePath}); MATCH (t:Track) CREATE (t)-[:HAS_ARRANGEMENT_CLIP]->(c:MidiClip|AudioClip {...}); MATCH (c:MidiClip) CREATE (c)-[:HAS_NOTE]->(n:Note {pitch, startTime, duration, velocity?})"

export async function executeCreate(
    deps: ServerDeps,
    statement: string,
    ast: CreateStatement,
    preview: boolean | undefined,
    confirm: boolean | undefined,
): Promise<Record<string, unknown>> {
    const adapter = createAdapterFromDeps(deps)
    const label = ast.node.label
    if (label === null) {
        throw new BadRequestError("CREATE requires a node label", { hint: SUPPORTED_CREATE_HINT })
    }

    if (ast.match === null) {
        return executeStandaloneCreate(deps, statement, ast, preview, confirm)
    }

    if (ast.anchorVariable === null || ast.relationshipType === null) {
        throw new BadRequestError("Anchored CREATE requires (anchor)-[:REL]->(node) pattern", {
            hint: SUPPORTED_CREATE_HINT,
        })
    }

    const anchors = await resolveWriteTargets(ast.match, ast.anchorVariable, adapter)
    if (anchors.length === 0) {
        return noMatchResponse("No anchor nodes matched. Adjust MATCH or use do read.")
    }

    const created: Record<string, unknown>[] = []
    const inverse_items: InverseDeleteCreated["items"] = []

    if (preview === true) {
        const base = {
            status: "preview",
            matched: anchors.length,
            label,
            relationship: ast.relationshipType,
            properties: ast.node.createProperties,
        }
        if (ast.relationshipType === "HAS_DEVICE" && label === "Device") {
            return { ...base, targets: previewDeviceInserts(anchors, ast.node.createProperties) }
        }
        return base
    }

    const write_context = beginWrite(statement, "create", `create ${label}`, "full")

    for (const anchor of anchors) {
        const item = await createAnchored(deps, anchor, ast)
        created.push(item.summary)
        if (item.identity !== null) {
            inverse_items.push({ identity: item.identity, label: item.label })
        }
    }

    write_context.inverse.push({ kind: "delete_created", items: inverse_items })
    const meta = await finalizeWrite(deps, write_context)
    return { status: "ok", created, ...meta }
}

async function executeStandaloneCreate(
    deps: ServerDeps,
    statement: string,
    ast: CreateStatement,
    preview: boolean | undefined,
    _confirm: boolean | undefined,
): Promise<Record<string, unknown>> {
    const label = ast.node.label
    const props = ast.node.createProperties
    if (label === "MidiTrack" || label === "AudioTrack") {
        const name = readCreateString(props, "name")
        if (preview === true) {
            return { status: "preview", label, name: name ?? null }
        }
        const write_context = beginWrite(statement, "create", `create ${label}`, "full")
        const song = deps.context.application.song
        const track = await deps.context.withinTransaction(async () => {
            const created =
                label === "MidiTrack" ? await song.createMidiTrack() : await song.createAudioTrack()
            if (name !== undefined) {
                created.name = name
            }
            return created
        })
        const index = song.tracks.findIndex((candidate) => candidate.handle === track.handle)
        const identity = objectIdentity(track)
        if (identity !== null) {
            write_context.inverse.push({
                kind: "delete_created",
                items: [{ identity, label }],
            })
        }
        const meta = await finalizeWrite(deps, write_context)
        return {
            status: "ok",
            created: [{ label, index, name: track.name }],
            ...meta,
        }
    }
    if (label === "Track") {
        throw new BadRequestError("CREATE :Track is ambiguous; use MidiTrack or AudioTrack", {
            hint: SUPPORTED_CREATE_HINT,
        })
    }
    if (label === "Scene") {
        const song = deps.context.application.song
        const index = readCreateNumber(props, "index") ?? song.scenes.length
        const name = readCreateString(props, "name")
        if (preview === true) {
            return { status: "preview", label, index, name: name ?? null }
        }
        const write_context = beginWrite(statement, "create", "create Scene", "full")
        const scene = await deps.context.withinTransaction(async () => {
            const created = await song.createScene(index)
            if (name !== undefined) {
                created.name = name
            }
            return created
        })
        const created_index = song.scenes.findIndex((c) => c.handle === scene.handle)
        const identity = objectIdentity(scene)
        if (identity !== null) {
            write_context.inverse.push({
                kind: "delete_created",
                items: [{ identity, label: "Scene" }],
            })
        }
        const meta = await finalizeWrite(deps, write_context)
        return {
            status: "ok",
            created: [{ label: "Scene", index: created_index, name: scene.name }],
            ...meta,
        }
    }
    if (label === "CuePoint") {
        const time = readCreateNumber(props, "time")
        if (time === undefined) {
            throw new BadRequestError("CREATE CuePoint requires {time: number}")
        }
        const name = readCreateString(props, "name")
        if (preview === true) {
            return { status: "preview", label, time, name: name ?? null }
        }
        const write_context = beginWrite(statement, "create", "create CuePoint", "full")
        const song = deps.context.application.song
        const cue = await deps.context.withinTransaction(async () => {
            const created = await song.createCuePoint(time)
            if (name !== undefined) {
                created.name = name
            }
            return created
        })
        const identity = objectIdentity(cue)
        if (identity !== null) {
            write_context.inverse.push({
                kind: "delete_created",
                items: [{ identity, label: "CuePoint" }],
            })
        }
        const meta = await finalizeWrite(deps, write_context)
        return {
            status: "ok",
            created: [{ label: "CuePoint", time: cue.time, name: cue.name }],
            ...meta,
        }
    }
    throw new BadRequestError(`Unsupported standalone CREATE label ${label}`, {
        hint: SUPPORTED_CREATE_HINT,
    })
}

type DeviceHost = { label: "Track" | "Chain"; value: Track<V> | Chain<V>; deviceCount: number }

/** HAS_DEVICE の CREATE が受け付けるアンカー（Track または Rack の Chain）を取り出す。 */
function deviceHost(anchor: LomNode): DeviceHost {
    if (anchor.type === "object" && anchor.value instanceof Track) {
        return { label: "Track", value: anchor.value, deviceCount: anchor.value.devices.length }
    }
    if (anchor.type === "object" && anchor.value instanceof Chain) {
        return { label: "Chain", value: anchor.value, deviceCount: anchor.value.devices.length }
    }
    throw new BadRequestError("HAS_DEVICE CREATE requires a Track or Chain anchor", {
        hint: "Anchor on a Track, or on a rack Chain reached with MATCH (:Device)-[:HAS_CHAIN]->(ch:Chain).",
    })
}

/**
 * 挿入位置を決める。省略時はデバイスチェーンの末尾。
 * 範囲外はエラーにする（暗黙に丸めると意図しない位置へ挿入されるため）。
 */
function resolveDeviceInsertIndex(props: Record<string, WriteValue>, host: DeviceHost): number {
    const index = readCreateNumber(props, "index")
    if (index === undefined) {
        return host.deviceCount
    }
    if (!Number.isInteger(index) || index < 0 || index > host.deviceCount) {
        throw new BadRequestError(
            `Device index ${index} is out of range for this ${host.label} (valid: 0 to ${host.deviceCount})`,
            {
                hint: "Omit index to append at the end of the device chain.",
            },
        )
    }
    return index
}

/**
 * 挿入失敗の理由を、内蔵デバイス名カタログとの照合結果を添えて返す。
 * カタログは手動管理でありエディション差で漏れうるため、照合は説明の材料としてのみ使う。
 */
function deviceInsertError(
    device_name: string,
    host_label: string,
    error: unknown,
): BadRequestError {
    const in_catalog = CATALOG_DEVICE_NAMES.includes(device_name)
    const cause = error instanceof Error ? error.message : String(error)
    if (in_catalog) {
        return new BadRequestError(
            `Live rejected inserting "${device_name}" into this ${host_label} (${cause})`,
            {
                hint: "The name is a known built-in device. It may be unavailable in this Live edition, or not valid for this device chain (for example an instrument on an audio track).",
                validDeviceNames: CATALOG_DEVICE_NAMES,
            },
        )
    }
    return new BadRequestError(
        `Live rejected inserting "${device_name}" into this ${host_label} (${cause})`,
        {
            hint: "Only devices native to Live can be inserted; third-party plug-ins cannot be loaded this way. Check the spelling against validDeviceNames.",
            validDeviceNames: CATALOG_DEVICE_NAMES,
        },
    )
}

/** preview で返す、アンカーごとの挿入予定（デバイス名と解決後の位置）。 */
function previewDeviceInserts(
    anchors: LomNode[],
    props: Record<string, WriteValue>,
): Record<string, unknown>[] {
    const device_name = readCreateString(props, "name")
    if (device_name === undefined) {
        throw new BadRequestError("CREATE Device requires {name: string}")
    }
    return anchors.map((anchor) => {
        const host = deviceHost(anchor)
        return {
            insertInto: host.label,
            name: device_name,
            index: resolveDeviceInsertIndex(props, host),
            existingDeviceCount: host.deviceCount,
            inCatalog: CATALOG_DEVICE_NAMES.includes(device_name),
        }
    })
}

async function createAnchored(
    deps: ServerDeps,
    anchor: LomNode,
    statement: CreateStatement,
): Promise<{ summary: Record<string, unknown>; identity: string | null; label: string }> {
    const rel = statement.relationshipType
    const label = statement.node.label ?? "Node"
    const props = statement.node.createProperties
    const _song = deps.context.application.song

    if (rel === "HAS_DEVICE" && label === "Device") {
        const host = deviceHost(anchor)
        const device_name = readCreateString(props, "name")
        if (device_name === undefined) {
            throw new BadRequestError("CREATE Device requires {name: string}")
        }
        const insert_index = resolveDeviceInsertIndex(props, host)
        let device: Device<V>
        try {
            device = await deps.context.withinTransaction(() =>
                host.value.insertDevice(device_name, insert_index),
            )
        } catch (error) {
            throw deviceInsertError(device_name, host.label, error)
        }
        return {
            summary: {
                label: "Device",
                name: device.name,
                index: insert_index,
                insertedInto: host.label,
            },
            identity: objectIdentity(device),
            label: "Device",
        }
    }

    if (rel === "HAS_CLIP" && anchor.type === "object" && anchor.value instanceof ClipSlot) {
        const slot = anchor.value
        const parent = slot.parent
        if (!(parent instanceof MidiTrack) && !(parent instanceof AudioTrack)) {
            throw new BadRequestError(
                "HAS_CLIP CREATE requires ClipSlot on MidiTrack or AudioTrack",
            )
        }
        if (slot.clip !== null) {
            throw new BadRequestError("ClipSlot already has a clip")
        }
        if (label === "MidiClip") {
            const length = readCreateNumber(props, "length")
            if (length === undefined) {
                throw new BadRequestError("CREATE MidiClip in slot requires {length: number}")
            }
            const clip = await deps.context.withinTransaction(() => slot.createMidiClip(length))
            return {
                summary: { label: "MidiClip", name: clip.name, duration: clip.duration },
                identity: objectIdentity(clip),
                label: "MidiClip",
            }
        }
        if (label === "AudioClip") {
            const file_path = readCreateString(props, "filePath")
            if (file_path === undefined) {
                throw new BadRequestError("CREATE AudioClip requires {filePath: string}")
            }
            await assertSampleFile(file_path)
            const clip = await deps.context.withinTransaction(() =>
                slot.createAudioClip({ filePath: file_path }),
            )
            return {
                summary: { label: "AudioClip", name: clip.name, filePath: file_path },
                identity: objectIdentity(clip),
                label: "AudioClip",
            }
        }
    }

    if (rel === "HAS_ARRANGEMENT_CLIP" && anchor.type === "object") {
        const track = anchor.value
        if (!(track instanceof MidiTrack) && !(track instanceof AudioTrack)) {
            throw new BadRequestError(
                "HAS_ARRANGEMENT_CLIP requires MidiTrack or AudioTrack anchor",
            )
        }
        const start_time = readCreateNumber(props, "startTime")
        const duration = readCreateNumber(props, "duration")
        if (start_time === undefined || duration === undefined) {
            throw new BadRequestError("CREATE arrangement clip requires startTime and duration")
        }
        const name = readCreateString(props, "name")
        if (label === "MidiClip" && track instanceof MidiTrack) {
            const clip = await deps.context.withinTransaction(async () => {
                const created = await track.createMidiClip(start_time, duration)
                if (name !== undefined) {
                    created.name = name
                }
                return created
            })
            return {
                summary: { label: "MidiClip", startTime: start_time, duration, name: clip.name },
                identity: objectIdentity(clip),
                label: "MidiClip",
            }
        }
        if (label === "AudioClip" && track instanceof AudioTrack) {
            const file_path = readCreateString(props, "filePath")
            if (file_path === undefined) {
                throw new BadRequestError("CREATE AudioClip arrangement requires filePath")
            }
            await assertSampleFile(file_path)
            const is_warped = readCreateProperty(props, "isWarped")
            const clip = await deps.context.withinTransaction(async () => {
                const created = await track.createAudioClip({
                    filePath: file_path,
                    startTime: start_time,
                    duration,
                    ...(typeof is_warped === "boolean" ? { isWarped: is_warped } : {}),
                })
                if (name !== undefined) {
                    created.name = name
                }
                return created
            })
            return {
                summary: {
                    label: "AudioClip",
                    startTime: start_time,
                    duration,
                    filePath: file_path,
                },
                identity: objectIdentity(clip),
                label: "AudioClip",
            }
        }
    }

    if (rel === "HAS_NOTE" && label === "Note") {
        if (anchor.type !== "object" || !(anchor.value instanceof MidiClip)) {
            throw new BadRequestError("HAS_NOTE CREATE requires MidiClip anchor")
        }
        const clip = anchor.value
        const pitch = readCreateNumber(props, "pitch")
        const start_time = readCreateNumber(props, "startTime")
        const duration = readCreateNumber(props, "duration")
        if (pitch === undefined || start_time === undefined || duration === undefined) {
            throw new BadRequestError("CREATE Note requires pitch, startTime, duration")
        }
        const velocity = readCreateNumber(props, "velocity") ?? 100
        const incoming = toNoteDescription({ pitch, startTime: start_time, duration, velocity })
        await deps.context.withinTransaction(() => {
            clip.notes = mergeNotes(clip.notes, [incoming])
        })
        return {
            summary: { label: "Note", pitch, startTime: start_time, duration },
            identity: null,
            label: "Note",
        }
    }

    throw new BadRequestError(`Unsupported CREATE pattern (${rel})->(:${label})`, {
        hint: SUPPORTED_CREATE_HINT,
    })
}
