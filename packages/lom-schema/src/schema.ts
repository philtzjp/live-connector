import type { LomSchema, QueryContract } from "./types"

const WARP_MODES = ["Beats", "Tones", "Texture", "Repitch", "Complex", "ComplexPro"]

const GRID_QUANTIZATIONS = [
    "NoGrid",
    "EightBars",
    "FourBars",
    "TwoBars",
    "Bar",
    "Half",
    "Quarter",
    "Eighth",
    "Sixteenth",
    "ThirtySecond",
]

export const startable_labels: string[] = [
    "Song",
    "Track",
    "MidiTrack",
    "AudioTrack",
    "ReturnTrack",
    "MainTrack",
    "Clip",
    "MidiClip",
    "AudioClip",
    "Device",
    "RackDevice",
    "DrumRack",
    "Simpler",
    "Scene",
    "CuePoint",
]

export const query_contract: QueryContract = {
    grammar: "MATCH <pattern> [WHERE <expr>] RETURN <items> [LIMIT <integer>]",
    start_labels: startable_labels,
    read: {
        tool: "query",
        return_contract:
            "RETURN は *, ノード変数、プロパティ射影、カンマ区切りの組み合わせを許可する。",
        allowed_returns: [
            "RETURN *",
            "RETURN node_variable",
            "RETURN node_variable.property",
            "RETURN item1, item2, ...",
        ],
    },
    select: {
        tools: [
            "create_clip",
            "create_arrangement_clip",
            "delete_arrangement_clip",
            "delete_cue_point",
            "render_audio",
            "set_track",
            "set_clip",
            "set_scene",
            "set_cue_point",
            "set_device_parameter",
            "write_notes",
        ],
        return_contract:
            "単一対象ツールの select の RETURN は、プロパティ射影ではなく単一の束縛済みノード変数のみを許可する。",
        valid_examples: [
            'MATCH (t:AudioTrack {name:"Print"}) RETURN t',
            'MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s',
            'MATCH (t:Track {name:"Print"})-[:HAS_ARRANGEMENT_CLIP]->(c:Clip {index:0}) RETURN c',
            'MATCH (t:Track {name:"Drums"}) RETURN t',
            'MATCH (c:MidiClip {name:"Bass"}) RETURN c',
            'MATCH (c:CuePoint {name:"Verse"}) RETURN c',
            'MATCH (:Track {name:"Lead"})-[:HAS_DEVICE]->(:Device)-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"}) RETURN p',
        ],
        invalid_examples: [
            "MATCH (t:Track) RETURN t.name",
            "MATCH (t:Track)-[:HAS_CLIPSLOT]->(s:ClipSlot) RETURN t, s",
            "MATCH (n:Note) RETURN n",
        ],
        hint: "Note / Parameter / ClipSlot など start_labels に無いラベルは、Song / Track / Clip / Device などから relationship で辿る。",
    },
}

/**
 * LOM のグラフスキーマ（ラベル・プロパティ・リレーション）の正本。
 * 抽象ラベル（Track / Clip / Device）は具象サブタイプ全体にマッチする。
 */
export const LOM_SCHEMA: LomSchema = {
    version: "1.0.0",
    nodes: [
        {
            label: "Song",
            description: "Live Set のルート。",
            properties: [
                { name: "tempo", type: "number", access: "rw" },
                { name: "scaleMode", type: "boolean", access: "r" },
                { name: "scaleName", type: "string", access: "r" },
                { name: "rootNote", type: "number", access: "r", description: "0(C)-11(B)" },
                { name: "scaleIntervals", type: "number[]", access: "r" },
                {
                    name: "gridQuantization",
                    type: "enum",
                    access: "r",
                    enumValues: GRID_QUANTIZATIONS,
                },
                { name: "gridIsTriplet", type: "boolean", access: "r" },
            ],
        },
        {
            label: "Track",
            abstract: true,
            description:
                "トラックの抽象基底。MidiTrack / AudioTrack / ReturnTrack / MainTrack の総称。",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "name", type: "string", access: "rw" },
                {
                    name: "kind",
                    type: "string",
                    access: "r",
                    description: "midi/audio/return/main",
                },
                { name: "arm", type: "boolean", access: "rw" },
                { name: "mute", type: "boolean", access: "rw" },
                { name: "solo", type: "boolean", access: "rw" },
                { name: "mutedViaSolo", type: "boolean", access: "r" },
            ],
        },
        { label: "MidiTrack", extends: "Track", properties: [] },
        { label: "AudioTrack", extends: "Track", properties: [] },
        { label: "ReturnTrack", extends: "Track", properties: [] },
        { label: "MainTrack", extends: "Track", properties: [] },
        {
            label: "Mixer",
            description: "トラックのミキサー。volume / panning / sends を Parameter として持つ。",
            properties: [],
        },
        {
            label: "Clip",
            abstract: true,
            description: "クリップの抽象基底。MidiClip / AudioClip の総称。",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "name", type: "string", access: "rw" },
                { name: "color", type: "number", access: "rw" },
                { name: "muted", type: "boolean", access: "rw" },
                { name: "looping", type: "boolean", access: "rw" },
                { name: "loopStart", type: "number", access: "r" },
                { name: "loopEnd", type: "number", access: "r" },
                { name: "startMarker", type: "number", access: "r" },
                { name: "endMarker", type: "number", access: "r" },
                { name: "startTime", type: "number", access: "r" },
                { name: "endTime", type: "number", access: "r" },
                { name: "duration", type: "number", access: "r" },
            ],
        },
        { label: "MidiClip", extends: "Clip", properties: [] },
        {
            label: "AudioClip",
            extends: "Clip",
            properties: [
                { name: "filePath", type: "string", access: "r" },
                { name: "warping", type: "boolean", access: "rw" },
                { name: "warpMode", type: "enum", access: "rw", enumValues: WARP_MODES },
            ],
        },
        {
            label: "ClipSlot",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "hasClip", type: "boolean", access: "r" },
            ],
        },
        {
            label: "Scene",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "name", type: "string", access: "rw" },
                { name: "tempo", type: "number", access: "r" },
                { name: "signatureNumerator", type: "number", access: "r" },
                { name: "signatureDenominator", type: "number", access: "r" },
            ],
        },
        {
            label: "Device",
            abstract: true,
            description: "デバイスの抽象基底。RackDevice / DrumRack / Simpler を含む。",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "name", type: "string", access: "r" },
            ],
        },
        { label: "RackDevice", extends: "Device", properties: [] },
        { label: "DrumRack", extends: "Device", properties: [] },
        { label: "Simpler", extends: "Device", properties: [] },
        {
            label: "Parameter",
            description: "デバイス／ミキサーのパラメータ。",
            properties: [
                { name: "name", type: "string", access: "r" },
                { name: "value", type: "number", access: "rw" },
                { name: "min", type: "number", access: "r" },
                { name: "max", type: "number", access: "r" },
                { name: "defaultValue", type: "number", access: "r" },
                { name: "isQuantized", type: "boolean", access: "r" },
                { name: "valueItems", type: "string[]", access: "r" },
            ],
        },
        { label: "Chain", properties: [{ name: "index", type: "number", access: "r" }] },
        { label: "DrumChain", extends: "Chain", properties: [] },
        {
            label: "Note",
            description: "MidiClip 内の MIDI ノート。読みはクエリ可、書きは write_notes 専用。",
            properties: [
                { name: "pitch", type: "number", access: "rw" },
                { name: "startTime", type: "number", access: "rw" },
                { name: "duration", type: "number", access: "rw" },
                { name: "velocity", type: "number", access: "rw" },
                { name: "muted", type: "boolean", access: "rw" },
                { name: "probability", type: "number", access: "rw" },
                { name: "releaseVelocity", type: "number", access: "rw" },
                { name: "velocityDeviation", type: "number", access: "rw" },
                { name: "selected", type: "boolean", access: "rw" },
            ],
        },
        {
            label: "CuePoint",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "name", type: "string", access: "rw" },
                { name: "time", type: "number", access: "r" },
            ],
        },
        {
            label: "TakeLane",
            properties: [
                { name: "index", type: "number", access: "r" },
                { name: "name", type: "string", access: "rw" },
            ],
        },
    ],
    relationships: [
        { type: "HAS_TRACK", from: "Song", to: "Track", array: true },
        { type: "HAS_RETURN", from: "Song", to: "ReturnTrack", array: true },
        { type: "HAS_MAIN", from: "Song", to: "MainTrack", array: false },
        { type: "HAS_SCENE", from: "Song", to: "Scene", array: true },
        { type: "HAS_CUE", from: "Song", to: "CuePoint", array: true },
        { type: "HAS_MIXER", from: "Track", to: "Mixer", array: false },
        { type: "HAS_VOLUME", from: "Mixer", to: "Parameter", array: false },
        { type: "HAS_PAN", from: "Mixer", to: "Parameter", array: false },
        { type: "HAS_SEND", from: "Mixer", to: "Parameter", array: true },
        { type: "HAS_DEVICE", from: "Track", to: "Device", array: true },
        { type: "HAS_CLIPSLOT", from: "Track", to: "ClipSlot", array: true },
        { type: "HAS_CLIP", from: "ClipSlot", to: "Clip", array: false },
        { type: "HAS_ARRANGEMENT_CLIP", from: "Track", to: "Clip", array: true },
        { type: "HAS_TAKELANE", from: "Track", to: "TakeLane", array: true },
        { type: "HAS_PARAM", from: "Device", to: "Parameter", array: true },
        { type: "HAS_CHAIN", from: "RackDevice", to: "Chain", array: true },
        { type: "HAS_NOTE", from: "MidiClip", to: "Note", array: true },
    ],
}

/** エージェントが構文を学習するための例クエリ。 */
export const EXAMPLE_QUERIES: string[] = [
    "MATCH (t:Track) RETURN t.index, t.name, t.kind, t.mute, t.arm",
    'MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"}) RETURN p.value, p.min, p.max',
    'MATCH (t:AudioTrack {name:"Print"}) RETURN t',
    'MATCH (t:Track {name:"Print"})-[:HAS_ARRANGEMENT_CLIP]->(c:Clip) RETURN c.index, c.name, c.startTime, c.duration',
    "MATCH (c:CuePoint) RETURN c.index, c.name, c.time",
    'MATCH (t:MidiTrack {name:"Drums"})-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) RETURN s',
    "MATCH (t:MidiTrack {mute:true})-[:HAS_CLIPSLOT]->(:ClipSlot)-[:HAS_CLIP]->(c:Clip) RETURN t.name, c.index, c.name",
    "MATCH (c:MidiClip {index:0})-[:HAS_NOTE]->(n:Note) WHERE n.pitch >= 60 RETURN n",
]
