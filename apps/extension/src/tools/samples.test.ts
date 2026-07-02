import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { MidiTrack, Simpler } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { assertSamplePath, isSupportedAudioPath, registerSampleTools } from "./samples"

describe("isSupportedAudioPath", () => {
    it("accepts common audio extensions case-insensitively", () => {
        expect(isSupportedAudioPath("/a/kick.wav")).toBe(true)
        expect(isSupportedAudioPath("/a/loop.AIFF")).toBe(true)
        expect(isSupportedAudioPath("/a/take.mp3")).toBe(true)
    })

    it("rejects non-audio extensions", () => {
        expect(isSupportedAudioPath("/a/preset.adv")).toBe(false)
        expect(isSupportedAudioPath("/a/notes.txt")).toBe(false)
    })
})

describe("assertSamplePath", () => {
    it("passes for an absolute supported path", () => {
        expect(() => assertSamplePath("/Users/x/Samples/kick.wav")).not.toThrow()
    })

    it("rejects relative paths", () => {
        expect(() => assertSamplePath("Samples/kick.wav")).toThrow(/absolute path/)
    })

    it("rejects unsupported formats with a hint", () => {
        expect(() => assertSamplePath("/Users/x/preset.adv")).toThrow(/unsupported audio format/)
    })
})

describe("load_sample import → replace flow", () => {
    it("imports the file into the project and replaces the Simpler sample", async () => {
        const storage_dir = await mkdtemp(path.join(tmpdir(), "lc-samples-"))
        const wav_path = path.join(storage_dir, "kick.wav")
        await writeFile(wav_path, "RIFF", "utf8")

        const replaced: unknown[] = []
        const simpler: Record<string, unknown> = Object.assign(Object.create(Simpler.prototype), {
            name: "Simpler",
            handle: { id: 71n },
        })
        simpler.replaceSample = (sample: unknown) => {
            replaced.push(sample)
            return Promise.resolve()
        }
        const track = Object.assign(Object.create(MidiTrack.prototype), {
            name: "Drums",
            handle: { id: 1n },
            clipSlots: [],
            arrangementClips: [],
            devices: [simpler],
        })
        const song = {
            tracks: [track],
            returnTracks: [],
            scenes: [],
            cuePoints: [],
            mainTrack: {},
        }
        const imported_paths: string[] = []
        const deps = {
            context: {
                application: { song },
                withinTransaction: (fn: () => unknown) => fn(),
                resources: {
                    importIntoProject: (file_path: string) => {
                        imported_paths.push(file_path)
                        return Promise.resolve(
                            `/project/Samples/Imported/${path.basename(file_path)}`,
                        )
                    },
                },
            },
            log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as ServerDeps
        const server = new FakeMcpServer()
        registerSampleTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("load_sample", {
            select: 'MATCH (:MidiTrack {name:"Drums"})-[:HAS_DEVICE]->(s:Simpler) RETURN s',
            audioFilePath: wav_path,
        })
        expect(isError).toBe(false)
        const payload = json as { status: string; importedPath: string }
        expect(payload.status).toBe("ok")
        expect(imported_paths).toEqual([wav_path])
        expect(payload.importedPath).toBe("/project/Samples/Imported/kick.wav")
        expect(replaced).toEqual(["/project/Samples/Imported/kick.wav"])

        await rm(storage_dir, { recursive: true, force: true })
    })

    it("rejects a missing file before touching the project", async () => {
        const deps = {
            context: {},
            log: { debug() {}, info() {}, warn() {}, error() {} },
        } as unknown as ServerDeps
        const server = new FakeMcpServer()
        registerSampleTools(server.asMcpServer(), deps)

        const { isError, json } = await server.call("load_sample", {
            select: "MATCH (s:Simpler) RETURN s",
            audioFilePath: "/tmp/definitely-missing-lc-sample.wav",
        })
        expect(isError).toBe(true)
        expect((json as { error?: string }).error).toBe("not_found")
    })
})
