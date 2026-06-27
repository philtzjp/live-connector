import {
    AudioClip,
    AudioTrack,
    Chain,
    Clip,
    ClipSlot,
    CuePoint,
    type DataModelObject,
    Device,
    DeviceParameter,
    DrumRack,
    type ExtensionContext,
    GridQuantization,
    MidiClip,
    MidiTrack,
    type NoteDescription,
    RackDevice,
    Scene,
    Simpler,
    Song,
    TakeLane,
    Track,
    TrackMixer,
    WarpMode,
} from "@ableton-extensions/sdk"
import type { GraphAdapter, ScalarValue } from "@live-connector/cypher"
import { BadRequestError } from "@live-connector/error"
import {
    isSubtypeOf,
    LOM_SCHEMA,
    propertiesForLabel,
    startable_labels,
} from "@live-connector/lom-schema"
import type { TargetApiVersion } from "../deps"

type V = TargetApiVersion

type ObjectNode = { type: "object"; label: string; value: DataModelObject<V>; index: number | null }
type NoteNode = { type: "note"; label: "Note"; value: NoteDescription; index: number }

export type LomNode = ObjectNode | NoteNode

const VALID_RELATIONSHIP_TYPES = new Set(
    LOM_SCHEMA.relationships.map((relationship) => relationship.type),
)

const startable_label_hint = startable_labels.join(", ")
const unusable_start_label_hint =
    "Start from one of the valid start labels, then expand with relationships to reach Note, Parameter, ClipSlot, Mixer, Chain or TakeLane."
const relationship_type_hint = LOM_SCHEMA.relationships
    .map((relationship) => relationship.type)
    .join(", ")
const valid_relationship_types = LOM_SCHEMA.relationships.map((relationship) => relationship.type)

const WARP_MODE_NAMES = ["Beats", "Tones", "Texture", "Repitch", "Complex", "ComplexPro"]

const TRACK_KIND_BY_LABEL: Record<string, string> = {
    MidiTrack: "midi",
    AudioTrack: "audio",
    ReturnTrack: "return",
    MainTrack: "main",
    Track: "other",
}

function trackLabel(track: Track<V>): string {
    if (track instanceof MidiTrack) {
        return "MidiTrack"
    }
    if (track instanceof AudioTrack) {
        return "AudioTrack"
    }
    return "Track"
}

function clipLabel(clip: Clip<V>): string {
    if (clip instanceof MidiClip) {
        return "MidiClip"
    }
    if (clip instanceof AudioClip) {
        return "AudioClip"
    }
    return "Clip"
}

function deviceLabel(device: Device<V>): string {
    if (device instanceof DrumRack) {
        return "DrumRack"
    }
    if (device instanceof RackDevice) {
        return "RackDevice"
    }
    if (device instanceof Simpler) {
        return "Simpler"
    }
    return "Device"
}

function enumName(enumObject: Record<number, string>, value: number | string): string {
    return typeof value === "string" ? value : (enumObject[value] ?? String(value))
}

function objectNode(value: DataModelObject<V>, label: string, index: number | null): ObjectNode {
    return { type: "object", label, value, index }
}

/** Cypher 評価器の GraphAdapter を LOM（Ableton SDK）に束ねる実装。 */
export class LomGraphAdapter implements GraphAdapter<LomNode> {
    private readonly context: ExtensionContext<V>

    constructor(context: ExtensionContext<V>) {
        this.context = context
    }

    private get song(): Song<V> {
        return this.context.application.song
    }

    async seeds(label: string | null): Promise<LomNode[]> {
        if (label === null) {
            throw new BadRequestError(
                `Starting node pattern must specify a label. Usable start labels: ${startable_label_hint}. Example: MATCH (t:Track) RETURN t`,
                {
                    hint: "Add a label to the first node pattern, e.g. MATCH (t:Track) RETURN t.",
                    validStartLabels: startable_labels,
                },
            )
        }
        const song = this.song

        if (label === "Song") {
            return [objectNode(song, "Song", null)]
        }
        if (isSubtypeOf(label, "Track")) {
            const seeds: LomNode[] = []
            for (const [index, track] of song.tracks.entries()) {
                seeds.push(objectNode(track, trackLabel(track), index))
            }
            for (const [index, track] of song.returnTracks.entries()) {
                seeds.push(objectNode(track, "ReturnTrack", index))
            }
            seeds.push(objectNode(song.mainTrack, "MainTrack", null))
            return seeds
        }
        if (isSubtypeOf(label, "Clip")) {
            const seeds: LomNode[] = []
            for (const track of song.tracks) {
                for (const [index, slot] of track.clipSlots.entries()) {
                    const clip = slot.clip
                    if (clip !== null) {
                        seeds.push(objectNode(clip, clipLabel(clip), index))
                    }
                }
                for (const [index, clip] of track.arrangementClips.entries()) {
                    seeds.push(objectNode(clip, clipLabel(clip), index))
                }
            }
            return seeds
        }
        if (isSubtypeOf(label, "Device")) {
            const seeds: LomNode[] = []
            for (const track of song.tracks) {
                for (const [index, device] of track.devices.entries()) {
                    seeds.push(objectNode(device, deviceLabel(device), index))
                }
            }
            return seeds
        }
        if (label === "Scene") {
            return song.scenes.map((scene, index) => objectNode(scene, "Scene", index))
        }
        if (label === "CuePoint") {
            return song.cuePoints.map((cue, index) => objectNode(cue, "CuePoint", index))
        }
        throw new BadRequestError(
            `Label "${label}" cannot start a pattern. Usable start labels: ${startable_label_hint}. For labels such as Note, Parameter, ClipSlot, Mixer, Chain or TakeLane, start from a usable label and expand with relationships.`,
            { hint: unusable_start_label_hint, validStartLabels: startable_labels },
        )
    }

    async expand(node: LomNode, relationshipTypes: string[]): Promise<LomNode[]> {
        const out: LomNode[] = []
        for (const relationshipType of relationshipTypes) {
            out.push(...this.expandOne(node, relationshipType))
        }
        return out
    }

    private expandOne(node: LomNode, relationshipType: string): LomNode[] {
        if (!VALID_RELATIONSHIP_TYPES.has(relationshipType)) {
            throw new BadRequestError(
                `Unknown relationship type "${relationshipType}". Valid relationships: ${relationship_type_hint}`,
                {
                    hint: "Use one of the valid relationship types from the schema tool.",
                    validRelationships: valid_relationship_types,
                },
            )
        }
        if (node.type === "note") {
            return []
        }
        const value = node.value

        switch (relationshipType) {
            case "HAS_TRACK":
                return value instanceof Song
                    ? value.tracks.map((track, index) =>
                          objectNode(track, trackLabel(track), index),
                      )
                    : []
            case "HAS_RETURN":
                return value instanceof Song
                    ? value.returnTracks.map((track, index) =>
                          objectNode(track, "ReturnTrack", index),
                      )
                    : []
            case "HAS_MAIN":
                return value instanceof Song ? [objectNode(value.mainTrack, "MainTrack", null)] : []
            case "HAS_SCENE":
                return value instanceof Song
                    ? value.scenes.map((scene, index) => objectNode(scene, "Scene", index))
                    : []
            case "HAS_CUE":
                return value instanceof Song
                    ? value.cuePoints.map((cue, index) => objectNode(cue, "CuePoint", index))
                    : []
            case "HAS_MIXER":
                return value instanceof Track ? [objectNode(value.mixer, "Mixer", null)] : []
            case "HAS_VOLUME":
                return value instanceof TrackMixer
                    ? [objectNode(value.volume, "Parameter", null)]
                    : []
            case "HAS_PAN":
                return value instanceof TrackMixer
                    ? [objectNode(value.panning, "Parameter", null)]
                    : []
            case "HAS_SEND":
                return value instanceof TrackMixer
                    ? value.sends.map((send, index) => objectNode(send, "Parameter", index))
                    : []
            case "HAS_DEVICE":
                if (value instanceof Track) {
                    return value.devices.map((device, index) =>
                        objectNode(device, deviceLabel(device), index),
                    )
                }
                if (value instanceof Chain) {
                    return value.devices.map((device, index) =>
                        objectNode(device, deviceLabel(device), index),
                    )
                }
                return []
            case "HAS_CLIPSLOT":
                return value instanceof Track
                    ? value.clipSlots.map((slot, index) => objectNode(slot, "ClipSlot", index))
                    : []
            case "HAS_CLIP": {
                if (!(value instanceof ClipSlot)) {
                    return []
                }
                const clip = value.clip
                return clip === null ? [] : [objectNode(clip, clipLabel(clip), null)]
            }
            case "HAS_ARRANGEMENT_CLIP":
                return value instanceof Track
                    ? value.arrangementClips.map((clip, index) =>
                          objectNode(clip, clipLabel(clip), index),
                      )
                    : []
            case "HAS_TAKELANE":
                return value instanceof Track
                    ? value.takeLanes.map((lane, index) => objectNode(lane, "TakeLane", index))
                    : []
            case "HAS_PARAM":
                return value instanceof Device
                    ? value.parameters.map((parameter, index) =>
                          objectNode(parameter, "Parameter", index),
                      )
                    : []
            case "HAS_CHAIN":
                return value instanceof RackDevice
                    ? value.chains.map((chain, index) => objectNode(chain, "Chain", index))
                    : []
            case "HAS_NOTE":
                return value instanceof MidiClip
                    ? value.notes.map((note, index) => ({
                          type: "note",
                          label: "Note",
                          value: note,
                          index,
                      }))
                    : []
            default:
                return []
        }
    }

    labelOf(node: LomNode): string {
        return node.label
    }

    matchesLabel(node: LomNode, label: string): boolean {
        return isSubtypeOf(node.label, label)
    }

    async getProperty(node: LomNode, property: string): Promise<ScalarValue> {
        const raw = await this.readRaw(node, property)
        if (
            raw === null ||
            typeof raw === "string" ||
            typeof raw === "number" ||
            typeof raw === "boolean"
        ) {
            return raw
        }
        return null
    }

    async serialize(node: LomNode): Promise<Record<string, unknown>> {
        const out: Record<string, unknown> = { _label: node.label }
        for (const property of propertiesForLabel(node.label)) {
            out[property.name] = await this.readRaw(node, property.name)
        }
        return out
    }

    identity(node: LomNode): unknown {
        return node.value
    }

    async setProperty(node: LomNode, property: string, value: ScalarValue): Promise<void> {
        if (node.type === "note") {
            throw new BadRequestError("Note properties are written via write_notes, not set_*")
        }
        const definition = propertiesForLabel(node.label).find(
            (candidate) => candidate.name === property,
        )
        if (definition === undefined) {
            throw this.unknownProperty(node.label, property)
        }
        if (definition.access !== "rw") {
            throw new BadRequestError(`Property "${property}" on ${node.label} is read-only`)
        }
        const target = node.value
        if (target instanceof Track) {
            this.writeTrack(target, property, value)
            return
        }
        if (target instanceof AudioClip) {
            this.writeAudioClip(target, property, value)
            return
        }
        if (target instanceof Clip) {
            this.writeClip(target, property, value)
            return
        }
        if (target instanceof Scene) {
            this.writeScene(target, property, value)
            return
        }
        if (target instanceof CuePoint) {
            this.writeCuePoint(target, property, value)
            return
        }
        if (target instanceof Song) {
            this.writeSong(target, property, value)
            return
        }
        if (target instanceof DeviceParameter) {
            await this.writeParameter(target, property, value)
            return
        }
        throw new BadRequestError(`Cannot write property "${property}" on ${node.label}`)
    }

    private writeTrack(track: Track<V>, property: string, value: ScalarValue): void {
        switch (property) {
            case "name":
                track.name = this.expectString(track, property, value)
                return
            case "mute":
                track.mute = this.expectBoolean(track, property, value)
                return
            case "solo":
                track.solo = this.expectBoolean(track, property, value)
                return
            case "arm":
                track.arm = this.expectBoolean(track, property, value)
                return
            default:
                throw this.unknownProperty("Track", property)
        }
    }

    private writeClip(clip: Clip<V>, property: string, value: ScalarValue): void {
        switch (property) {
            case "name":
                clip.name = this.expectString(clip, property, value)
                return
            case "color":
                clip.color = this.expectNumber(clip, property, value)
                return
            case "muted":
                clip.muted = this.expectBoolean(clip, property, value)
                return
            case "looping":
                clip.looping = this.expectBoolean(clip, property, value)
                return
            default:
                throw this.unknownProperty("Clip", property)
        }
    }

    private writeAudioClip(clip: AudioClip<V>, property: string, value: ScalarValue): void {
        if (property === "warping") {
            clip.warping = this.expectBoolean(clip, property, value)
            return
        }
        if (property === "warpMode") {
            const name = this.expectString(clip, property, value)
            const mode = (WarpMode as unknown as Record<string, WarpMode>)[name]
            if (mode === undefined) {
                throw new BadRequestError(
                    `Invalid warpMode "${name}". Valid: ${WARP_MODE_NAMES.join(", ")}`,
                )
            }
            clip.warpMode = mode
            return
        }
        this.writeClip(clip, property, value)
    }

    private writeScene(scene: Scene<V>, property: string, value: ScalarValue): void {
        if (property === "name") {
            scene.name = this.expectString(scene, property, value)
            return
        }
        throw this.unknownProperty("Scene", property)
    }

    private writeCuePoint(cue: CuePoint<V>, property: string, value: ScalarValue): void {
        if (property === "name") {
            cue.name = this.expectString(cue, property, value)
            return
        }
        throw this.unknownProperty("CuePoint", property)
    }

    private writeSong(song: Song<V>, property: string, value: ScalarValue): void {
        if (property === "tempo") {
            song.tempo = this.expectNumber(song, property, value)
            return
        }
        throw this.unknownProperty("Song", property)
    }

    private async writeParameter(
        parameter: DeviceParameter<V>,
        property: string,
        value: ScalarValue,
    ): Promise<void> {
        if (property === "value") {
            await parameter.setValue(this.expectNumber(parameter, property, value))
            return
        }
        throw this.unknownProperty("Parameter", property)
    }

    private expectString(
        _target: DataModelObject<V>,
        property: string,
        value: ScalarValue,
    ): string {
        if (typeof value !== "string") {
            throw new BadRequestError(`Property "${property}" expects a string value`)
        }
        return value
    }

    private expectNumber(
        _target: DataModelObject<V>,
        property: string,
        value: ScalarValue,
    ): number {
        if (typeof value !== "number") {
            throw new BadRequestError(`Property "${property}" expects a number value`)
        }
        return value
    }

    private expectBoolean(
        _target: DataModelObject<V>,
        property: string,
        value: ScalarValue,
    ): boolean {
        if (typeof value !== "boolean") {
            throw new BadRequestError(`Property "${property}" expects a boolean value`)
        }
        return value
    }

    private async readRaw(node: LomNode, property: string): Promise<unknown> {
        if (node.type === "note") {
            return this.readNote(node, property)
        }
        if (property === "index") {
            return node.index
        }
        const value = node.value
        if (property === "kind") {
            if (value instanceof Track) {
                return TRACK_KIND_BY_LABEL[node.label] ?? "other"
            }
            throw this.unknownProperty(node.label, property)
        }
        if (value instanceof Track) {
            return this.readTrack(value, node.label, property)
        }
        if (value instanceof AudioClip) {
            return this.readAudioClip(value, node.label, property)
        }
        if (value instanceof Clip) {
            return this.readClip(value, node.label, property)
        }
        if (value instanceof DeviceParameter) {
            return this.readParameter(value, node.label, property)
        }
        if (value instanceof Device) {
            return this.readDevice(value, node.label, property)
        }
        if (value instanceof Scene) {
            return this.readScene(value, node.label, property)
        }
        if (value instanceof ClipSlot) {
            return this.readClipSlot(value, node.label, property)
        }
        if (value instanceof CuePoint) {
            return this.readCuePoint(value, node.label, property)
        }
        if (value instanceof TakeLane) {
            return this.readTakeLane(value, node.label, property)
        }
        if (value instanceof Song) {
            return this.readSong(value, node.label, property)
        }
        throw this.unknownProperty(node.label, property)
    }

    private readTrack(track: Track<V>, label: string, property: string): ScalarValue {
        switch (property) {
            case "name":
                return track.name
            case "arm":
                return track.arm
            case "mute":
                return track.mute
            case "solo":
                return track.solo
            case "mutedViaSolo":
                return track.mutedViaSolo
            default:
                throw this.unknownProperty(label, property)
        }
    }

    private readClip(clip: Clip<V>, label: string, property: string): ScalarValue {
        switch (property) {
            case "name":
                return clip.name
            case "color":
                return clip.color
            case "muted":
                return clip.muted
            case "looping":
                return clip.looping
            case "loopStart":
                return clip.loopStart
            case "loopEnd":
                return clip.loopEnd
            case "startMarker":
                return clip.startMarker
            case "endMarker":
                return clip.endMarker
            case "startTime":
                return clip.startTime
            case "endTime":
                return clip.endTime
            case "duration":
                return clip.duration
            default:
                throw this.unknownProperty(label, property)
        }
    }

    private readAudioClip(clip: AudioClip<V>, label: string, property: string): ScalarValue {
        switch (property) {
            case "filePath":
                return clip.filePath
            case "warping":
                return clip.warping
            case "warpMode":
                return enumName(
                    WarpMode as unknown as Record<number, string>,
                    clip.warpMode as unknown as number,
                )
            default:
                return this.readClip(clip, label, property)
        }
    }

    private async readParameter(
        parameter: DeviceParameter<V>,
        label: string,
        property: string,
    ): Promise<unknown> {
        switch (property) {
            case "name":
                return parameter.name
            case "min":
                return parameter.min
            case "max":
                return parameter.max
            case "defaultValue":
                return parameter.defaultValue
            case "isQuantized":
                return parameter.isQuantized
            case "value":
                return parameter.getValue()
            case "valueItems":
                return parameter.valueItems.map((item) => item.name)
            default:
                throw this.unknownProperty(label, property)
        }
    }

    private readDevice(device: Device<V>, label: string, property: string): ScalarValue {
        if (property === "name") {
            return device.name
        }
        throw this.unknownProperty(label, property)
    }

    private readScene(scene: Scene<V>, label: string, property: string): ScalarValue {
        switch (property) {
            case "name":
                return scene.name
            case "tempo":
                return scene.tempo
            case "signatureNumerator":
                return scene.signatureNumerator
            case "signatureDenominator":
                return scene.signatureDenominator
            default:
                throw this.unknownProperty(label, property)
        }
    }

    private readClipSlot(slot: ClipSlot<V>, label: string, property: string): ScalarValue {
        if (property === "hasClip") {
            return slot.clip !== null
        }
        throw this.unknownProperty(label, property)
    }

    private readCuePoint(cue: CuePoint<V>, label: string, property: string): ScalarValue {
        switch (property) {
            case "name":
                return cue.name
            case "time":
                return cue.time
            default:
                throw this.unknownProperty(label, property)
        }
    }

    private readTakeLane(lane: TakeLane<V>, label: string, property: string): ScalarValue {
        if (property === "name") {
            return lane.name
        }
        throw this.unknownProperty(label, property)
    }

    private readSong(song: Song<V>, label: string, property: string): unknown {
        switch (property) {
            case "tempo":
                return song.tempo
            case "scaleMode":
                return song.scaleMode
            case "scaleName":
                return song.scaleName
            case "rootNote":
                return song.rootNote
            case "scaleIntervals":
                return song.scaleIntervals
            case "gridQuantization":
                return enumName(
                    GridQuantization as unknown as Record<number, string>,
                    song.gridQuantization as unknown as number,
                )
            case "gridIsTriplet":
                return song.gridIsTriplet
            default:
                throw this.unknownProperty(label, property)
        }
    }

    private readNote(node: NoteNode, property: string): ScalarValue {
        const allowed = new Set(propertiesForLabel("Note").map((definition) => definition.name))
        if (!allowed.has(property)) {
            throw this.unknownProperty("Note", property)
        }
        const fields = node.value as unknown as Record<string, ScalarValue>
        return fields[property] ?? null
    }

    private unknownProperty(label: string, property: string): BadRequestError {
        const valid_properties = propertiesForLabel(label).map((definition) => definition.name)
        const valid = valid_properties.join(", ")
        return new BadRequestError(
            `Unknown property "${property}" on ${label}. Valid properties: ${valid}`,
            {
                hint: `Use one of the properties defined for ${label} in the schema tool.`,
                validProperties: valid_properties,
            },
        )
    }
}
