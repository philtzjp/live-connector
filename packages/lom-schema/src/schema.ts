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
    "WriteEvent",
    "RenderJob",
    "Transport",
]

export const query_contract: QueryContract = {
    grammar:
        "MATCH <pattern> [WHERE <expr>] RETURN [DISTINCT] <items> [ORDER BY ...] [SKIP n] [LIMIT n]; MATCH ... SET n.prop = <value> [, ...]; CREATE (n:Label {prop: value}); MATCH ... CREATE (a)-[:REL]->(n:Label {...}); MATCH ... [DETACH] DELETE n; MATCH ... COPY n; CALL <allowed-procedure>(<literal>, ...)",
    start_labels: startable_labels,
    time_coordinates: {
        absolute:
            "アレンジメント絶対拍。Clip.startTime / endTime、CuePoint.time、CREATE arrangement clip の startTime はこの系。",
        relative:
            "クリップ相対拍 [0, クリップ長)。Note.startTime、startMarker / endMarker / loopStart / loopEnd、MidiClip SET notes はこの系。範囲外 startTime はエラー。",
    },
    read: {
        tool: "do",
        return_contract:
            "do に MATCH ... RETURN を渡す。RETURN は *, ノード変数、プロパティ射影、集計（count/min/max/avg/sum）、DISTINCT、ORDER BY、SKIP/LIMIT に対応。LIMIT 省略時は 500 行で truncated:true。",
        allowed_returns: [
            "RETURN *",
            "RETURN node_variable",
            "RETURN node_variable.property",
            "RETURN count(*) | count(var) | min/max/avg/sum(var.prop)",
            "... ORDER BY ... SKIP n LIMIT n",
            "MATCH (e:WriteEvent) RETURN e",
            "MATCH (j:RenderJob) RETURN j",
            "MATCH (t:Transport) RETURN t",
        ],
    },
    write: {
        tool: "do",
        target_resolution:
            '書き込み文の MATCH は複数ノードにマッチ可（Cypher 意味論）。0 件は {status:"no_match"}。preview:true で対象と予定差分を返す。',
        set_properties: {
            Song: ["tempo"],
            Track: ["name", "arm", "mute", "solo"],
            Clip: [
                "name",
                "color",
                "muted",
                "looping",
                "startTime",
                "duration",
                "startMarker",
                "endMarker",
            ],
            MidiClip: [
                "name",
                "color",
                "muted",
                "looping",
                "notes",
                "startTime",
                "duration",
                "startMarker",
                "endMarker",
            ],
            AudioClip: [
                "name",
                "color",
                "muted",
                "looping",
                "warping",
                "warpMode",
                "startTime",
                "duration",
                "startMarker",
                "endMarker",
            ],
            Scene: ["name"],
            CuePoint: ["name"],
            Parameter: ["value"],
            Simpler: ["sampleFile"],
            Note: [
                "pitch",
                "startTime",
                "duration",
                "velocity",
                "muted",
                "probability",
                "releaseVelocity",
                "velocityDeviation",
            ],
        },
        create_patterns: [
            "CREATE (t:MidiTrack|AudioTrack {name?})",
            "CREATE (s:Scene {index?, name?})",
            "CREATE (c:CuePoint {time, name?})",
            "MATCH (t:Track) CREATE (t)-[:HAS_DEVICE]->(d:Device {name, index?})",
            "MATCH (s:ClipSlot) CREATE (s)-[:HAS_CLIP]->(c:MidiClip {length}) | (c:AudioClip {filePath})",
            "MATCH (t:Track) CREATE (t)-[:HAS_ARRANGEMENT_CLIP]->(c:MidiClip|AudioClip {startTime, duration, ...})",
            "MATCH (c:MidiClip) CREATE (c)-[:HAS_NOTE]->(n:Note {pitch, startTime, duration, velocity?})",
        ],
        delete_labels: [
            "Track",
            "Scene",
            "Device",
            "Clip",
            "MidiClip",
            "AudioClip",
            "CuePoint",
            "Note",
        ],
        copy_labels: ["Track", "Scene", "Device"],
        undoable_levels: {
            full: "スカラー SET、notes/Note、create/copy（逆=生成物削除）、多くの delete 再作成",
            partial:
                "sampleFile、配置プロパティ（カスタム warp/marker）、delete Device（カタログ名）",
            none: "delete Track（confirm 必須、undo 不可）",
        },
        guards: {
            preview: "全書き込みでドライラン可",
            confirm:
                "undoable partial/none の書き込みは confirm:true 必須。full は件数に関わらず即実行。",
            no_match: "0 件マッチはエラーではなく no_match",
        },
    },
    procedure: {
        tool: "do",
        grammar:
            "CALL <procedure>(<literal> [, ...])。手続き名は許可リストのみ、引数は文字列・数値・真偽値・null のリテラルに限る。動的関数名・変数参照・複数文は受理しない。例: CALL transport.seek(32)",
        allowed: [
            {
                name: "transport.play",
                args: "",
                effect: "runtime",
                undoable: "none",
                requiresConfirm: true,
            },
            {
                name: "transport.stop",
                args: "",
                effect: "runtime",
                undoable: "none",
                requiresConfirm: true,
            },
            {
                name: "transport.seek",
                args: "beats:number",
                effect: "runtime",
                undoable: "none",
                requiresConfirm: true,
            },
            {
                name: "render.cancel",
                args: "jobId:string",
                effect: "runtime",
                undoable: "none",
                requiresConfirm: true,
            },
        ],
        guards: {
            literals_only: "引数はリテラルのみ。式・変数・動的関数名は拒否する。",
            preview: "preview:true は OSC 送信を含め副作用ゼロ。計画と事前検査のみを返す。",
            confirm: "全手続きで confirm:true 必須。confirm なしは confirm_required を返す。",
            lock: "Main 録音中は書き込み・別 render・transport.play/seek を拒否し、cancel と読取は許可する。",
        },
    },
    virtual_labels: {
        WriteEvent: "undo ログ（id, time, kind, statement, undoable, status）— 書き込み不可",
        RenderJob:
            "render ジョブ（id, status, source, method, phase, progress, audioStatus, cleanupStatus, filePath?, error?）— 読み取り専用",
        Transport:
            "Transport 状態（isPlaying, currentSongTime, tempo, recordMode, loop, loopStart, loopLength, punchIn, punchOut, observedAt）— 読み取り専用。切断後の古い値は返さない",
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
            description:
                "MidiClip 内の MIDI ノート。読みは do read、書きは do SET notes または Note ノード直接 SET。",
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

export const EXAMPLE_QUERIES: string[] = [
    "MATCH (t:Track) RETURN t.index, t.name, t.kind, t.mute, t.arm",
    'MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"}) RETURN p.value',
    'MATCH (t:MidiTrack {name:"Drums"}) SET t.mute = true',
    "MATCH (s:Song) SET s.tempo = 120",
    'CREATE (t:MidiTrack {name:"New"})',
    'MATCH (c:MidiClip {name:"Bass"}) SET c.notes = [{pitch:60, startTime:0, duration:1, velocity:100}]',
    "MATCH (t:MidiTrack)-[:HAS_CLIPSLOT]->(s:ClipSlot {index:0}) CREATE (s)-[:HAS_CLIP]->(c:MidiClip {length:4})",
    "MATCH (s:Scene {index:0}) COPY s",
    "MATCH (e:WriteEvent) RETURN e.id, e.statement, e.undoable, e.status",
    "MATCH (j:RenderJob) RETURN j.id, j.status, j.filePath",
    "MATCH (t:Transport) RETURN t.isPlaying, t.currentSongTime, t.tempo",
    "CALL transport.seek(32)",
    "CALL transport.play()",
    "CALL transport.stop()",
    'CALL render.cancel("render-abc")',
]
