import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { HybridError } from "@live-connector/error"
import { describe, expect, it } from "vitest"
import type { ServerDeps } from "../deps"
import { buildSilentWav } from "../test-support/fake-live"
import { analyzeAudioFile, finalizeArtifact } from "./artifacts"

async function tempDir(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "lc-artifacts-"))
}

function depsWithStorage(storage: string): ServerDeps {
    return {
        context: { environment: { storageDirectory: storage } },
    } as unknown as ServerDeps
}

function buildAiff(options: { sampleRate: number; channels: number; frames: number }): Buffer {
    const { sampleRate, channels, frames } = options
    const sample_size = 16
    const exponent = Math.floor(Math.log2(sampleRate))
    const exponent_bits = 16383 + exponent
    const mantissa = BigInt(sampleRate) << BigInt(63 - exponent)
    const header = Buffer.alloc(10)
    header.writeUInt16BE(exponent_bits, 0)
    const extended = Buffer.alloc(8)
    extended.writeBigUInt64BE(mantissa, 0)
    header.set(extended, 2)

    const comm_body = Buffer.alloc(18)
    comm_body.writeInt16BE(channels, 0)
    comm_body.writeUInt32BE(frames, 2)
    comm_body.writeInt16BE(sample_size, 6)
    header.copy(comm_body, 8)
    const comm = Buffer.concat([
        Buffer.from("COMM", "ascii"),
        (() => {
            const size = Buffer.alloc(4)
            size.writeUInt32BE(18, 0)
            return size
        })(),
        comm_body,
    ])
    const ssnd_body = Buffer.alloc(8 + frames * channels * 2)
    const ssnd = Buffer.concat([
        Buffer.from("SSND", "ascii"),
        (() => {
            const size = Buffer.alloc(4)
            size.writeUInt32BE(ssnd_body.length, 0)
            return size
        })(),
        ssnd_body,
    ])
    const body = Buffer.concat([Buffer.from("AIFF", "ascii"), comm, ssnd])
    const form = Buffer.concat([
        Buffer.from("FORM", "ascii"),
        (() => {
            const size = Buffer.alloc(4)
            size.writeUInt32BE(body.length, 0)
            return size
        })(),
        body,
    ])
    return form
}

describe("artifacts", () => {
    it("parses a silent WAV and warns about silence", async () => {
        const directory = await tempDir()
        const file_path = path.join(directory, "audio.wav")
        await writeFile(file_path, buildSilentWav({ sampleRate: 48000, channels: 2, frames: 480 }))

        const analysis = await analyzeAudioFile(file_path)
        expect(analysis.artifact.sampleRate).toBe(48000)
        expect(analysis.artifact.channels).toBe(2)
        expect(analysis.artifact.frames).toBe(480)
        expect(analysis.artifact.sampleFormat).toBe("pcm_s16le")
        expect(analysis.warnings).toHaveLength(1)
    })

    it("parses an AIFF COMM chunk", async () => {
        const directory = await tempDir()
        const file_path = path.join(directory, "audio.aiff")
        await writeFile(file_path, buildAiff({ sampleRate: 44100, channels: 2, frames: 441 }))

        const analysis = await analyzeAudioFile(file_path)
        expect(analysis.artifact.sampleRate).toBe(44100)
        expect(analysis.artifact.channels).toBe(2)
        expect(analysis.artifact.frames).toBe(441)
        expect(analysis.artifact.sampleFormat).toBe("pcm_s16be")
    })

    it("rejects an empty file", async () => {
        const directory = await tempDir()
        const file_path = path.join(directory, "empty.wav")
        await writeFile(file_path, Buffer.alloc(0))
        await expect(analyzeAudioFile(file_path)).rejects.toBeInstanceOf(HybridError)
    })

    it("rejects an unknown container", async () => {
        const directory = await tempDir()
        const file_path = path.join(directory, "audio.bin")
        await writeFile(file_path, Buffer.from("not audio at all", "utf8"))
        await expect(analyzeAudioFile(file_path)).rejects.toMatchObject({
            code: "AUDIO_ARTIFACT_INVALID",
        })
    })

    it("finalizes an artifact into the renders directory with a manifest", async () => {
        const directory = await tempDir()
        const source = path.join(directory, "source.wav")
        await writeFile(source, buildSilentWav({ frames: 480 }))
        const deps = depsWithStorage(directory)

        const result = await finalizeArtifact(deps, "render-abc", source, 10_000_000)
        expect(result.filePath).toBe(path.join(directory, "renders", "render-abc", "audio.wav"))
        expect(result.audio.sha256).toMatch(/^[0-9a-f]{64}$/)

        const manifest = JSON.parse(
            await readFile(path.join(directory, "renders", "render-abc", "manifest.json"), "utf8"),
        ) as { audio: { sha256: string } }
        expect(manifest.audio.sha256).toBe(result.audio.sha256)
    })

    it("rejects an artifact beyond the byte limit", async () => {
        const directory = await tempDir()
        const source = path.join(directory, "source.wav")
        await writeFile(source, buildSilentWav({ frames: 480 }))
        await expect(
            finalizeArtifact(depsWithStorage(directory), "render-big", source, 10),
        ).rejects.toMatchObject({ code: "RECORDING_LIMIT_EXCEEDED" })
    })

    it("checks the byte limit before reading the file for analysis", async () => {
        // 上限超過の判定を解析より先に行う。解析はファイル全体をメモリへ読み込むため、
        // 解析が先だと上限を無視して読み込んでしまう。中身が壊れていても上限違反が先に出る。
        const directory = await tempDir()
        const source = path.join(directory, "oversized.bin")
        await writeFile(source, Buffer.alloc(4096, 1))
        await expect(
            finalizeArtifact(depsWithStorage(directory), "render-oversized", source, 10),
        ).rejects.toMatchObject({ code: "RECORDING_LIMIT_EXCEEDED" })
    })
})
