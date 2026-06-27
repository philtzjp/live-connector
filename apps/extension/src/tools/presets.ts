import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Device, type DeviceParameter } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, ConfigError, NotFoundError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

type SearchPresetsParams = {
    roots: string[]
    extensions: string[] | undefined
    nameContains: string | undefined
    limit: number | undefined
    maxDepth: number | undefined
}

type SaveDeviceStateParams = {
    select: string
    stateName: string
    overwrite: boolean | undefined
    preview: boolean | undefined
}

type ApplyDeviceStateParams = {
    select: string
    stateName: string
    preview: boolean | undefined
    confirm: boolean | undefined
}

type PresetSearchResult = {
    name: string
    path: string
    type: string
    ext: string
    tags?: string[]
}

type RootSearchSummary = {
    root: string
    scannedFiles: number
    matchedFiles: number
    error?: string
}

type DeviceParameterValueItemState = {
    index: number
    name: string
    shortName: string
}

type DeviceParameterState = {
    index: number
    name: string
    value: number
    min: number
    max: number
    defaultValue: number
    isQuantized: boolean
    valueItems: DeviceParameterValueItemState[]
    valueItem: DeviceParameterValueItemState | null
}

type DeviceStateFile = {
    schemaVersion: "1.0"
    kind: "live_connector_device_state"
    stateName: string
    deviceName: string
    parameters: DeviceParameterState[]
}

type ParameterApplication = {
    snapshot: DeviceParameterState
    parameter: DeviceParameter<TargetApiVersion>
    value: number
}

const DEFAULT_SEARCH_LIMIT = 200
const MAX_SEARCH_LIMIT = 2000
const DEFAULT_MAX_DEPTH = 8
const DEVICE_STATE_DIRECTORY_NAME = "device-states"
const DEVICE_STATE_SCHEMA_VERSION = "1.0"
const CONFIRM_THRESHOLD = 20

const DEFAULT_PRESET_EXTENSIONS = [
    ".adv",
    ".adg",
    ".alc",
    ".als",
    ".aupreset",
    ".fxb",
    ".fxp",
    ".nmsv",
    ".serumpreset",
    ".vstpreset",
]

const PRESET_TYPE_BY_EXTENSION: Record<string, string> = {
    ".adv": "live_device_preset",
    ".adg": "live_rack_preset",
    ".alc": "live_clip",
    ".als": "live_set",
    ".aupreset": "audio_unit_preset",
    ".fxb": "vst_bank",
    ".fxp": "vst_program",
    ".nmsv": "massive_preset",
    ".serumpreset": "serum_preset",
    ".vstpreset": "vst3_preset",
}

function textResult(payload: unknown, isError = false): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError }
}

function selectDescription(): string {
    return 'Device を単一ノード変数で RETURN する Cypher。プロパティ射影（RETURN d.name）や複数変数（RETURN t, d）は不可。例: MATCH (:Track {name:"Lead"})-[:HAS_DEVICE]->(d:Device {name:"Operator"}) RETURN d'
}

function expandHomeDirectory(input: string): string {
    if (input === "~") {
        return homedir()
    }
    if (input.startsWith("~/")) {
        return path.join(homedir(), input.slice(2))
    }
    return input
}

function normalizeRoot(input: string): string {
    const root = expandHomeDirectory(input)
    if (!path.isAbsolute(root)) {
        throw new BadRequestError("preset search roots must be absolute paths", {
            hint: "Pass absolute preset roots, e.g. /Users/name/Music/Ableton/User Library.",
        })
    }
    return path.normalize(root)
}

function normalizeExtensions(extensions: string[] | undefined): Set<string> {
    const values = extensions ?? DEFAULT_PRESET_EXTENSIONS
    return new Set(
        values.map((extension) => {
            const lower = extension.toLowerCase()
            return lower.startsWith(".") ? lower : `.${lower}`
        }),
    )
}

function presetTypeForExtension(extension: string): string {
    return PRESET_TYPE_BY_EXTENSION[extension] ?? "preset_file"
}

function tagsForPreset(root: string, file_path: string): string[] {
    const relative_dir = path.dirname(path.relative(root, file_path))
    if (relative_dir === ".") {
        return []
    }
    return relative_dir.split(path.sep).filter((part) => part.length > 0)
}

function presetResult(root: string, file_path: string): PresetSearchResult {
    const extension = path.extname(file_path).toLowerCase()
    const tags = tagsForPreset(root, file_path)
    const result: PresetSearchResult = {
        name: path.basename(file_path, path.extname(file_path)),
        path: file_path,
        type: presetTypeForExtension(extension),
        ext: extension,
    }
    if (tags.length > 0) {
        result.tags = tags
    }
    return result
}

function nameMatches(file_path: string, name_contains: string | undefined): boolean {
    if (name_contains === undefined || name_contains.length === 0) {
        return true
    }
    return path.basename(file_path).toLowerCase().includes(name_contains.toLowerCase())
}

async function collectPresetFiles(
    root: string,
    directory: string,
    depth: number,
    params: {
        extensions: Set<string>
        nameContains: string | undefined
        maxDepth: number
        limit: number
        results: PresetSearchResult[]
        summary: RootSearchSummary
    },
): Promise<void> {
    if (params.results.length >= params.limit) {
        return
    }
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
        if (params.results.length >= params.limit) {
            return
        }
        const entry_path = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            if (depth < params.maxDepth) {
                await collectPresetFiles(root, entry_path, depth + 1, params)
            }
            continue
        }
        if (!entry.isFile()) {
            continue
        }
        params.summary.scannedFiles += 1
        const extension = path.extname(entry.name).toLowerCase()
        if (!params.extensions.has(extension)) {
            continue
        }
        if (!nameMatches(entry_path, params.nameContains)) {
            continue
        }
        params.results.push(presetResult(root, entry_path))
        params.summary.matchedFiles += 1
    }
}

async function searchRoot(
    root: string,
    params: {
        extensions: Set<string>
        nameContains: string | undefined
        maxDepth: number
        limit: number
        results: PresetSearchResult[]
    },
): Promise<RootSearchSummary> {
    const summary: RootSearchSummary = { root, scannedFiles: 0, matchedFiles: 0 }
    try {
        const root_stat = await stat(root)
        if (root_stat.isFile()) {
            summary.scannedFiles = 1
            const extension = path.extname(root).toLowerCase()
            if (params.extensions.has(extension) && nameMatches(root, params.nameContains)) {
                params.results.push(presetResult(path.dirname(root), root))
                summary.matchedFiles = 1
            }
            return summary
        }
        if (!root_stat.isDirectory()) {
            summary.error = "root is neither a file nor a directory"
            return summary
        }
        await collectPresetFiles(root, root, 0, { ...params, summary })
        return summary
    } catch (error) {
        summary.error = error instanceof Error ? error.message : String(error)
        return summary
    }
}

function deviceStateDirectory(deps: ServerDeps): string {
    const storage_directory = deps.context.environment.storageDirectory
    if (storage_directory === undefined || storage_directory.length === 0) {
        throw new ConfigError("Ableton Extensions SDK did not provide environment.storageDirectory")
    }
    return path.join(storage_directory, DEVICE_STATE_DIRECTORY_NAME)
}

function stateFilePath(deps: ServerDeps, state_name: string): string {
    if (state_name.length === 0) {
        throw new BadRequestError("stateName must not be empty")
    }
    return path.join(deviceStateDirectory(deps), `${encodeURIComponent(state_name)}.json`)
}

function resolveSingleDevice(nodes: LomNode[]): Device<TargetApiVersion> {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `device state tools require the selection to match exactly one Device, but matched ${nodes.length}`,
            {
                hint: "Change select so it returns exactly one Device node.",
            },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof Device)) {
        throw new BadRequestError("select must return a Device", {
            hint: 'Use a select query such as MATCH (:Track {name:"Lead"})-[:HAS_DEVICE]->(d:Device) RETURN d.',
        })
    }
    return node.value
}

function valueItemsForParameter(
    parameter: DeviceParameter<TargetApiVersion>,
): DeviceParameterValueItemState[] {
    return parameter.valueItems.map((item, index) => ({
        index,
        name: item.name,
        shortName: item.shortName,
    }))
}

function valueItemForParameter(
    parameter: DeviceParameter<TargetApiVersion>,
    value: number,
): DeviceParameterValueItemState | null {
    if (!parameter.isQuantized) {
        return null
    }
    const index = Math.round(value)
    const item = parameter.valueItems[index]
    if (!Number.isInteger(value) || item === undefined) {
        return null
    }
    return { index, name: item.name, shortName: item.shortName }
}

async function parameterState(
    parameter: DeviceParameter<TargetApiVersion>,
    index: number,
): Promise<DeviceParameterState> {
    const value = await parameter.getValue()
    return {
        index,
        name: parameter.name,
        value,
        min: parameter.min,
        max: parameter.max,
        defaultValue: parameter.defaultValue,
        isQuantized: parameter.isQuantized,
        valueItems: valueItemsForParameter(parameter),
        valueItem: valueItemForParameter(parameter, value),
    }
}

async function deviceState(
    device: Device<TargetApiVersion>,
    state_name: string,
): Promise<DeviceStateFile> {
    const parameters = await Promise.all(device.parameters.map(parameterState))
    return {
        schemaVersion: DEVICE_STATE_SCHEMA_VERSION,
        kind: "live_connector_device_state",
        stateName: state_name,
        deviceName: device.name,
        parameters,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
}

function validateDeviceParameterState(value: unknown): DeviceParameterState {
    if (!isRecord(value)) {
        throw new BadRequestError("device state parameter entries must be JSON objects")
    }
    if (
        !isNumber(value.index) ||
        typeof value.name !== "string" ||
        !isNumber(value.value) ||
        !isNumber(value.min) ||
        !isNumber(value.max) ||
        !isNumber(value.defaultValue) ||
        typeof value.isQuantized !== "boolean" ||
        !Array.isArray(value.valueItems)
    ) {
        throw new BadRequestError("device state parameter entry has an invalid shape")
    }
    if (value.valueItem !== null && value.valueItem !== undefined && !isRecord(value.valueItem)) {
        throw new BadRequestError("device state parameter valueItem has an invalid shape")
    }
    const value_items = value.valueItems.map((item) => {
        if (
            !isRecord(item) ||
            !isNumber(item.index) ||
            typeof item.name !== "string" ||
            typeof item.shortName !== "string"
        ) {
            throw new BadRequestError("device state parameter valueItems have an invalid shape")
        }
        return {
            index: item.index,
            name: item.name,
            shortName: item.shortName,
        }
    })
    let value_item: DeviceParameterValueItemState | null = null
    if (isRecord(value.valueItem)) {
        if (
            !isNumber(value.valueItem.index) ||
            typeof value.valueItem.name !== "string" ||
            typeof value.valueItem.shortName !== "string"
        ) {
            throw new BadRequestError("device state parameter valueItem has an invalid shape")
        }
        value_item = {
            index: value.valueItem.index,
            name: value.valueItem.name,
            shortName: value.valueItem.shortName,
        }
    }
    return {
        index: value.index,
        name: value.name,
        value: value.value,
        min: value.min,
        max: value.max,
        defaultValue: value.defaultValue,
        isQuantized: value.isQuantized,
        valueItems: value_items,
        valueItem: value_item,
    }
}

function parseDeviceState(raw: string): DeviceStateFile {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        throw new BadRequestError(
            `device state file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
    if (!isRecord(parsed)) {
        throw new BadRequestError("device state file must contain a JSON object")
    }
    if (parsed.schemaVersion !== DEVICE_STATE_SCHEMA_VERSION) {
        throw new BadRequestError("unsupported device state schemaVersion", {
            hint: `Expected schemaVersion ${DEVICE_STATE_SCHEMA_VERSION}.`,
        })
    }
    if (parsed.kind !== "live_connector_device_state") {
        throw new BadRequestError("device state file kind is invalid")
    }
    if (typeof parsed.stateName !== "string" || typeof parsed.deviceName !== "string") {
        throw new BadRequestError("device state file is missing stateName or deviceName")
    }
    if (!Array.isArray(parsed.parameters)) {
        throw new BadRequestError("device state file parameters must be an array")
    }
    return {
        schemaVersion: DEVICE_STATE_SCHEMA_VERSION,
        kind: "live_connector_device_state",
        stateName: parsed.stateName,
        deviceName: parsed.deviceName,
        parameters: parsed.parameters.map(validateDeviceParameterState),
    }
}

async function readDeviceState(deps: ServerDeps, state_name: string): Promise<DeviceStateFile> {
    const file_path = stateFilePath(deps, state_name)
    try {
        return parseDeviceState(await readFile(file_path, "utf8"))
    } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
            throw new NotFoundError(`device state "${state_name}" was not found`, {
                hint: "Run save_device_state first, or pass an existing stateName.",
            })
        }
        throw error
    }
}

function resolveQuantizedValue(
    snapshot: DeviceParameterState,
    parameter: DeviceParameter<TargetApiVersion>,
): number {
    if (!parameter.isQuantized || snapshot.valueItem === null) {
        return snapshot.value
    }
    const by_name = parameter.valueItems.findIndex((item) => item.name === snapshot.valueItem?.name)
    if (by_name >= 0) {
        return by_name
    }
    if (parameter.valueItems[snapshot.valueItem.index] !== undefined) {
        return snapshot.valueItem.index
    }
    return snapshot.value
}

function validateParameterValue(
    snapshot: DeviceParameterState,
    parameter: DeviceParameter<TargetApiVersion>,
    value: number,
): void {
    if (value < parameter.min || value > parameter.max) {
        throw new BadRequestError(
            `Saved value for parameter "${snapshot.name}" is outside target range ${parameter.min}..${parameter.max}`,
            {
                hint: "Use a state saved from the same device type, or inspect target parameters with query.",
            },
        )
    }
}

function buildParameterApplications(
    state_file: DeviceStateFile,
    device: Device<TargetApiVersion>,
): ParameterApplication[] {
    const applications: ParameterApplication[] = []
    const used_indexes = new Set<number>()
    const missing_names: string[] = []
    const ambiguous_names: string[] = []

    for (const snapshot of state_file.parameters) {
        const indexed_parameter = device.parameters[snapshot.index]
        if (indexed_parameter !== undefined && indexed_parameter.name === snapshot.name) {
            const value = resolveQuantizedValue(snapshot, indexed_parameter)
            validateParameterValue(snapshot, indexed_parameter, value)
            applications.push({ snapshot, parameter: indexed_parameter, value })
            used_indexes.add(snapshot.index)
            continue
        }

        const matches = device.parameters
            .map((parameter, index) => ({ parameter, index }))
            .filter(
                (entry) => entry.parameter.name === snapshot.name && !used_indexes.has(entry.index),
            )

        if (matches.length === 0) {
            missing_names.push(snapshot.name)
            continue
        }
        if (matches.length > 1) {
            ambiguous_names.push(snapshot.name)
            continue
        }

        const match = matches[0]
        if (match === undefined) {
            missing_names.push(snapshot.name)
            continue
        }
        const value = resolveQuantizedValue(snapshot, match.parameter)
        validateParameterValue(snapshot, match.parameter, value)
        applications.push({ snapshot, parameter: match.parameter, value })
        used_indexes.add(match.index)
    }

    if (missing_names.length > 0 || ambiguous_names.length > 0) {
        throw new BadRequestError(
            `Device state does not match target device. Missing parameters: ${missing_names.join(", ") || "none"}. Ambiguous parameters: ${ambiguous_names.join(", ") || "none"}.`,
            {
                hint: "Apply the state to the same device type, or save a new state from the target device.",
            },
        )
    }

    return applications
}

async function runSearchPresetsTool(
    deps: ServerDeps,
    params: SearchPresetsParams,
): Promise<ToolResult> {
    try {
        const limit = Math.min(params.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
        const max_depth = params.maxDepth ?? DEFAULT_MAX_DEPTH
        const extensions = normalizeExtensions(params.extensions)
        const results: PresetSearchResult[] = []
        const roots: RootSearchSummary[] = []
        for (const root of params.roots) {
            roots.push(
                await searchRoot(normalizeRoot(root), {
                    extensions,
                    nameContains: params.nameContains,
                    maxDepth: max_depth,
                    limit,
                    results,
                }),
            )
        }
        return textResult({
            status: "ok",
            count: results.length,
            limit,
            limitReached: results.length >= limit,
            presets: results,
            roots,
            note: "search_presets only lists files. Ableton Extensions SDK does not provide Browser or native preset loading APIs.",
        })
    } catch (error) {
        deps.log.error("search_presets failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

async function runSaveDeviceStateTool(
    deps: ServerDeps,
    params: SaveDeviceStateParams,
): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const device = resolveSingleDevice(await selectNodes(parseQuery(params.select), adapter))
        const state_file = await deviceState(device, params.stateName)
        const file_path = stateFilePath(deps, params.stateName)

        if (params.preview === true) {
            return textResult({
                status: "preview",
                stateName: params.stateName,
                device: { name: device.name },
                parameterCount: state_file.parameters.length,
                filePath: file_path,
            })
        }

        await mkdir(path.dirname(file_path), { recursive: true })
        if (params.overwrite !== true) {
            try {
                await stat(file_path)
                throw new BadRequestError(`device state "${params.stateName}" already exists`, {
                    hint: "Pass overwrite:true to replace the existing state file.",
                })
            } catch (error) {
                if (!(isRecord(error) && error.code === "ENOENT")) {
                    throw error
                }
            }
        }
        await writeFile(file_path, `${JSON.stringify(state_file, null, 2)}\n`, "utf8")

        return textResult({
            status: "ok",
            stateName: params.stateName,
            device: { name: device.name },
            parameterCount: state_file.parameters.length,
            filePath: file_path,
        })
    } catch (error) {
        deps.log.error("save_device_state failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

async function runApplyDeviceStateTool(
    deps: ServerDeps,
    params: ApplyDeviceStateParams,
): Promise<ToolResult> {
    try {
        const adapter = new LomGraphAdapter(deps.context)
        const device = resolveSingleDevice(await selectNodes(parseQuery(params.select), adapter))
        const state_file = await readDeviceState(deps, params.stateName)
        const applications = buildParameterApplications(state_file, device)
        const changes = applications.map((application) => ({
            name: application.snapshot.name,
            from: application.snapshot.value,
            to: application.value,
            valueItem: application.snapshot.valueItem,
        }))

        if (params.preview === true) {
            return textResult({
                status: "preview",
                stateName: params.stateName,
                sourceDevice: state_file.deviceName,
                targetDevice: device.name,
                matched: applications.length,
                changes,
            })
        }
        if (applications.length > CONFIRM_THRESHOLD && params.confirm !== true) {
            return textResult({
                status: "confirm_required",
                stateName: params.stateName,
                matched: applications.length,
                hint: `This will modify ${applications.length} parameters. Pass confirm:true to proceed.`,
            })
        }

        await deps.context.withinTransaction(() =>
            Promise.all(
                applications.map((application) =>
                    application.parameter.setValue(application.value),
                ),
            ),
        )

        return textResult({
            status: "ok",
            stateName: params.stateName,
            sourceDevice: state_file.deviceName,
            targetDevice: device.name,
            applied: applications.length,
        })
    } catch (error) {
        deps.log.error("apply_device_state failed", { error: String(error) })
        return textResult(toMcpError(error), true)
    }
}

/** プリセット探索と DeviceParameter スナップショット保存/適用ツールを登録する。 */
export function registerPresetTools(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "search_presets",
        {
            title: "プリセットファイル探索",
            description:
                "指定 root 配下のプリセット候補ファイルを列挙する。探索のみを行い、Ableton/plug-in プリセットの読み込みや適用は行わない。",
            inputSchema: {
                roots: z.array(z.string().min(1)).min(1).describe("探索対象の絶対パス root 配列"),
                extensions: z
                    .array(z.string().min(1))
                    .optional()
                    .describe(
                        "対象拡張子。未指定時は .adv/.adg/.vstpreset/.serumpreset 等を対象にする",
                    ),
                nameContains: z.string().min(1).optional().describe("ファイル名の部分一致フィルタ"),
                limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
                maxDepth: z.number().int().min(0).max(32).optional(),
            },
        },
        async ({ roots, extensions, nameContains, limit, maxDepth }) =>
            runSearchPresetsTool(deps, { roots, extensions, nameContains, limit, maxDepth }),
    )

    server.registerTool(
        "save_device_state",
        {
            title: "DeviceParameter 状態保存",
            description:
                "select で選んだ 1 つの Device の公開 DeviceParameter 値を environment.storageDirectory 配下に JSON 保存する。非公開の plug-in 内部状態やネイティブプリセットは対象外。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                stateName: z.string().min(1).describe("保存する状態名"),
                overwrite: z.boolean().optional().describe("既存 stateName の JSON を上書きする"),
                preview: z.boolean().optional().describe("保存せず対象と保存先を返すドライラン"),
            },
        },
        async ({ select, stateName, overwrite, preview }) =>
            runSaveDeviceStateTool(deps, { select, stateName, overwrite, preview }),
    )

    server.registerTool(
        "apply_device_state",
        {
            title: "DeviceParameter 状態適用",
            description:
                "保存済み stateName の DeviceParameter 値を、select で選んだ 1 つの Device の同名パラメータへ一括適用する。対象は host に公開されたパラメータのみ。",
            inputSchema: {
                select: z.string().min(1).describe(selectDescription()),
                stateName: z.string().min(1).describe("適用する保存済み状態名"),
                preview: z.boolean().optional().describe("適用せず対象と変更内容を返すドライラン"),
                confirm: z.boolean().optional().describe("大量パラメータ変更を許可する"),
            },
        },
        async ({ select, stateName, preview, confirm }) =>
            runApplyDeviceStateTool(deps, { select, stateName, preview, confirm }),
    )
}
