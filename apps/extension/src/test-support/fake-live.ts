/**
 * Hybrid 機能テスト用の Live 模擬。Ableton SDK をモックした環境で使う。
 * 既存曲のトラックと、`createAudioTrack` / `deleteTrack` / `renderPreFxAudio` を再現する。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { AudioTrack } from "@ableton-extensions/sdk"

export type FakeClip = {
    name: string
    startTime: number
    endTime: number
    duration: number
    handle: { id: bigint }
}

export type FakeHybridTrack = {
    name: string
    handle: { id: bigint }
    arm: boolean
    mute: boolean
    solo: boolean
    devices: unknown[]
    clipSlots: { clip: null }[]
    arrangementClips: FakeClip[]
    mixer: { sends: unknown[] }
}

export type FakeLive = {
    song: {
        handle: { id: bigint }
        tracks: FakeHybridTrack[]
        scenes: unknown[]
        cuePoints: unknown[]
        tempo: number
        createAudioTrack: () => Promise<FakeHybridTrack>
        deleteTrack: (track: FakeHybridTrack) => Promise<void>
    }
    context: {
        application: { song: FakeLive["song"] }
        environment: { storageDirectory: string }
        resources: {
            renderPreFxAudio: (
                track: FakeHybridTrack,
                start: number,
                end: number,
            ) => Promise<string>
        }
        withinTransaction: <T>(fn: () => T) => T
    }
    renderedPaths: string[]
}

let handle_counter = 1000n

export function makeHybridTrack(
    name: string,
    extra: Partial<FakeHybridTrack> = {},
): FakeHybridTrack {
    handle_counter += 1n
    return Object.assign(Object.create(AudioTrack.prototype), {
        name,
        handle: { id: handle_counter },
        arm: false,
        mute: false,
        solo: false,
        devices: [] as unknown[],
        clipSlots: [{ clip: null }],
        arrangementClips: [] as FakeClip[],
        mixer: { sends: [] as unknown[] },
        ...extra,
    }) as FakeHybridTrack
}

export function makeClip(start: number, end: number): FakeClip {
    handle_counter += 1n
    return {
        name: `__LC_PRINT_${handle_counter}`,
        startTime: start,
        endTime: end,
        duration: end - start,
        handle: { id: handle_counter },
    }
}

/** 16-bit PCM 無音 WAV を組み立てる。 */
export function buildSilentWav(options: {
    sampleRate?: number
    channels?: number
    frames?: number
}): Buffer {
    const sample_rate = options.sampleRate ?? 48000
    const channels = options.channels ?? 2
    const frames = options.frames ?? 480
    const bits = 16
    const block_align = (bits / 8) * channels
    const data_size = frames * block_align
    const buffer = Buffer.alloc(44 + data_size)
    buffer.write("RIFF", 0, "ascii")
    buffer.writeUInt32LE(36 + data_size, 4)
    buffer.write("WAVE", 8, "ascii")
    buffer.write("fmt ", 12, "ascii")
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(channels, 22)
    buffer.writeUInt32LE(sample_rate, 24)
    buffer.writeUInt32LE(sample_rate * block_align, 28)
    buffer.writeUInt16LE(block_align, 32)
    buffer.writeUInt16LE(bits, 34)
    buffer.write("data", 36, "ascii")
    buffer.writeUInt32LE(data_size, 40)
    return buffer
}

export function createFakeLive(options: {
    storageDirectory: string
    tracks?: FakeHybridTrack[]
    wav?: Buffer
}): FakeLive {
    const storage_directory = options.storageDirectory
    const rendered_paths: string[] = []
    let render_counter = 0

    const song: FakeLive["song"] = {
        handle: { id: 42n },
        tracks: options.tracks ?? [],
        scenes: [],
        cuePoints: [],
        tempo: 120,
        async createAudioTrack() {
            const track = makeHybridTrack("")
            song.tracks.push(track)
            return track
        },
        async deleteTrack(track) {
            const index = song.tracks.indexOf(track)
            if (index >= 0) {
                song.tracks.splice(index, 1)
            }
        },
    }

    const context: FakeLive["context"] = {
        application: { song },
        environment: { storageDirectory: storage_directory },
        resources: {
            async renderPreFxAudio(_track, _start, _end) {
                render_counter += 1
                const directory = path.join(storage_directory, "tmp")
                await mkdir(directory, { recursive: true })
                const file_path = path.join(directory, `render-${render_counter}.wav`)
                await writeFile(file_path, options.wav ?? buildSilentWav({}))
                rendered_paths.push(file_path)
                return file_path
            },
        },
        withinTransaction<T>(fn: () => T) {
            return fn()
        },
    }

    return { song, context, renderedPaths: rendered_paths }
}
