/**
 * 録音済みファイルの検証と artifact 確定。
 * 一時ファイルへコピーし、検証後に rename して確定する。
 * sample rate / channels / frames / format / SHA-256 を実測して記録する。
 */

import { createHash } from "node:crypto"
import { copyFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { HybridError } from "@live-connector/error"
import type { ServerDeps } from "../deps"
import type { AudioArtifact } from "../types/hybrid"

const RENDERS_DIRECTORY_NAME = "renders"

export type AudioAnalysis = {
    artifact: AudioArtifact
    warnings: string[]
}

function storageDirectory(deps: ServerDeps): string {
    const storage = deps.context.environment.storageDirectory
    if (storage === undefined || storage.length === 0) {
        throw new HybridError(
            "ARTIFACT_STORAGE_UNAVAILABLE",
            "Ableton Extensions SDK did not provide environment.storageDirectory",
        )
    }
    return storage
}

function framesToDuration(frames: number, sample_rate: number): number {
    if (sample_rate <= 0) {
        return 0
    }
    return frames / sample_rate
}

function decodeExtended80(bytes: Buffer): number {
    const exponent = (((bytes[0] ?? 0) & 0x7f) << 8) | (bytes[1] ?? 0)
    const sign = ((bytes[0] ?? 0) & 0x80) !== 0 ? -1 : 1
    if (exponent === 0) {
        return 0
    }
    let mantissa = 0
    for (let index = 2; index < 10; index++) {
        mantissa = mantissa * 256 + (bytes[index] ?? 0)
    }
    return sign * mantissa * 2 ** (exponent - 16383 - 63)
}

function sampleFormatFor(format_code: number, bits: number): string {
    if (format_code === 3) {
        return bits === 64 ? "pcm_f64le" : "pcm_f32le"
    }
    return `pcm_s${bits}le`
}

async function analyzeWav(buffer: Buffer): Promise<AudioAnalysis | null> {
    if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF") {
        return null
    }
    if (buffer.toString("ascii", 8, 12) !== "WAVE") {
        return null
    }
    let offset = 12
    let format_code = 1
    let channels = 0
    let sample_rate = 0
    let bits = 0
    let block_align = 0
    let data_offset = 0
    let data_size = 0

    while (offset + 8 <= buffer.length) {
        const chunk_id = buffer.toString("ascii", offset, offset + 4)
        const chunk_size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8
        if (chunk_id === "fmt " && chunk_size >= 16) {
            format_code = buffer.readUInt16LE(body)
            channels = buffer.readUInt16LE(body + 2)
            sample_rate = buffer.readUInt32LE(body + 4)
            block_align = buffer.readUInt16LE(body + 12)
            bits = buffer.readUInt16LE(body + 14)
            if (format_code === 0xfffe && chunk_size >= 26) {
                format_code = buffer.readUInt16LE(body + 24)
            }
        } else if (chunk_id === "data") {
            data_offset = body
            data_size = Math.min(chunk_size, buffer.length - body)
        }
        offset = body + chunk_size + (chunk_size % 2)
    }

    if (channels <= 0 || sample_rate <= 0 || block_align <= 0) {
        throw new HybridError("AUDIO_ARTIFACT_INVALID", "WAV file is missing a valid fmt chunk")
    }
    const frames = Math.floor(data_size / block_align)
    const warnings: string[] = []
    if (data_size === 0) {
        throw new HybridError("AUDIO_ARTIFACT_INVALID", "WAV file contains no audio data")
    }
    if (isSilent(buffer.subarray(data_offset, data_offset + data_size))) {
        warnings.push("all samples are silent; check track routing and mute state")
    }
    return {
        artifact: {
            sampleRate: sample_rate,
            channels,
            frames,
            sha256: "", // finalizeArtifact で確定する
            durationSeconds: framesToDuration(frames, sample_rate),
            sampleFormat: sampleFormatFor(format_code, bits),
        },
        warnings,
    }
}

async function analyzeAiff(buffer: Buffer): Promise<AudioAnalysis | null> {
    if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "FORM") {
        return null
    }
    const form_type = buffer.toString("ascii", 8, 12)
    if (form_type !== "AIFF" && form_type !== "AIFC") {
        return null
    }
    let offset = 12
    let channels = 0
    let frames = 0
    let bits = 0
    let sample_rate = 0
    let found_comm = false

    while (offset + 8 <= buffer.length) {
        const chunk_id = buffer.toString("ascii", offset, offset + 4)
        const chunk_size = buffer.readUInt32BE(offset + 4)
        const body = offset + 8
        if (chunk_id === "COMM" && chunk_size >= 18) {
            channels = buffer.readInt16BE(body)
            frames = buffer.readUInt32BE(body + 2)
            bits = buffer.readInt16BE(body + 6)
            sample_rate = Math.round(decodeExtended80(buffer.subarray(body + 8, body + 18)))
            found_comm = true
        }
        offset = body + chunk_size + (chunk_size % 2)
    }

    if (!found_comm || channels <= 0 || sample_rate <= 0) {
        throw new HybridError("AUDIO_ARTIFACT_INVALID", "AIFF file is missing a valid COMM chunk")
    }
    return {
        artifact: {
            sampleRate: sample_rate,
            channels,
            frames,
            sha256: "",
            durationSeconds: framesToDuration(frames, sample_rate),
            sampleFormat: `pcm_s${bits}be`,
        },
        warnings: [],
    }
}

function isSilent(data: Buffer): boolean {
    for (const byte of data) {
        if (byte !== 0) {
            return false
        }
    }
    return true
}

/** ファイルを読み、コンテナと音声メタデータを実測する。 */
export async function analyzeAudioFile(file_path: string): Promise<AudioAnalysis> {
    const info = await stat(file_path).catch(() => null)
    if (info === null || !info.isFile()) {
        throw new HybridError(
            "AUDIO_ARTIFACT_INVALID",
            `Rendered file "${file_path}" was not found`,
        )
    }
    if (info.size === 0) {
        throw new HybridError("AUDIO_ARTIFACT_INVALID", `Rendered file "${file_path}" is empty`)
    }
    const buffer = await readFile(file_path)
    const analysis = (await analyzeWav(buffer)) ?? (await analyzeAiff(buffer))
    if (analysis === null) {
        throw new HybridError(
            "AUDIO_ARTIFACT_INVALID",
            `Rendered file "${file_path}" is neither WAV nor AIFF`,
        )
    }
    return analysis
}

/** ファイル全体をメモリへ載せずに SHA-256 を計算する。 */
async function sha256OfFile(file_path: string): Promise<string> {
    const hash = createHash("sha256")
    const handle = await open(file_path, "r")
    try {
        for await (const chunk of handle.createReadStream()) {
            hash.update(chunk)
        }
    } finally {
        await handle.close()
    }
    return hash.digest("hex")
}

export type FinalizeResult = {
    filePath: string
    audio: AudioArtifact
    warnings: string[]
}

/** 中間ファイルを検証し、artifact ディレクトリへ確定コピーする。 */
export async function finalizeArtifact(
    deps: ServerDeps,
    job_id: string,
    intermediate_path: string,
    max_artifact_bytes: number,
): Promise<FinalizeResult> {
    const storage = storageDirectory(deps)
    // 解析はファイル全体をメモリへ読み込むため、先に上限を確かめる。
    const source_info = await stat(intermediate_path)
    if (source_info.size > max_artifact_bytes) {
        throw new HybridError(
            "RECORDING_LIMIT_EXCEEDED",
            `Rendered artifact is ${source_info.size} bytes, exceeding the ${max_artifact_bytes} byte limit`,
        )
    }
    const analysis = await analyzeAudioFile(intermediate_path)

    const extension =
        path.extname(intermediate_path).length > 0 ? path.extname(intermediate_path) : ".wav"
    const directory = path.join(storage, RENDERS_DIRECTORY_NAME, job_id)
    await mkdir(directory, { recursive: true })
    const final_path = path.join(directory, `audio${extension}`)
    const temp_path = `${final_path}.tmp`

    await copyFile(intermediate_path, temp_path)
    const sha256 = await sha256OfFile(temp_path)
    await rename(temp_path, final_path)

    const audio: AudioArtifact = { ...analysis.artifact, sha256 }
    await writeFile(
        path.join(directory, "manifest.json"),
        `${JSON.stringify(
            {
                jobId: job_id,
                filePath: final_path,
                audio,
                warnings: analysis.warnings,
                generatedAt: new Date().toISOString(),
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
    return { filePath: final_path, audio, warnings: analysis.warnings }
}

/** storageDirectory が利用可能かを検査する。 */
export function assertArtifactStorage(deps: ServerDeps): void {
    const storage = deps.context.environment.storageDirectory
    if (storage === undefined || storage.length === 0) {
        throw new HybridError(
            "ARTIFACT_STORAGE_UNAVAILABLE",
            "Ableton Extensions SDK did not provide environment.storageDirectory",
        )
    }
}
