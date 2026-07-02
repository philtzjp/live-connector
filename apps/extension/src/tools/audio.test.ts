import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

import { AudioTrack } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"
import { clearRenderJobsForTest, registerAudioTools } from "./audio"

function buildServer(): {
    server: FakeMcpServer
    resolveRender: (path: string) => void
} {
    const audioTrack = Object.assign(Object.create(AudioTrack.prototype), {
        name: "Print",
        handle: 7,
    })
    let resolveRender: (path: string) => void = () => {}
    const renderPromise = new Promise<string>((resolve) => {
        resolveRender = resolve
    })
    const song = {
        tracks: [audioTrack],
        returnTracks: [],
        scenes: [],
        cuePoints: [],
        mainTrack: {},
    }
    const deps = {
        context: {
            application: { song },
            resources: { renderPreFxAudio: () => renderPromise },
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServerDeps
    const server = new FakeMcpServer()
    registerAudioTools(server.asMcpServer(), deps)
    return { server, resolveRender }
}

describe("render_audio background jobs", () => {
    let server: FakeMcpServer
    let resolveRender: (path: string) => void

    beforeEach(() => {
        const built = buildServer()
        server = built.server
        resolveRender = built.resolveRender
    })

    it("starts a job and reports running, then done with the rendered filePath", async () => {
        const started = (await server.call("render_audio", {
            select: 'MATCH (t:AudioTrack {name:"Print"}) RETURN t',
            startTime: 0,
            endTime: 16,
            background: true,
        })) as { json: { status: string; jobId: string } }
        expect(started.json.status).toBe("started")
        const jobId = started.json.jobId

        const running = (await server.call("get_render_job", { jobId })) as {
            json: { status: string }
        }
        expect(running.json.status).toBe("running")

        resolveRender("/tmp/print.wav")
        await Promise.resolve()
        await Promise.resolve()

        const done = (await server.call("get_render_job", { jobId })) as {
            json: { status: string; filePath?: string }
        }
        expect(done.json.status).toBe("done")
        expect(done.json.filePath).toBe("/tmp/print.wav")
    })

    it("returns not_found for an unknown jobId", async () => {
        const { isError, json } = await server.call("get_render_job", { jobId: "nope" })
        expect(isError).toBe(true)
        expect((json as { error?: string }).error).toBe("not_found")
    })
})

const RENDER_SELECT = 'MATCH (t:AudioTrack {name:"Print"}) RETURN t'

async function startJob(server: FakeMcpServer): Promise<string> {
    const started = (await server.call("render_audio", {
        select: RENDER_SELECT,
        startTime: 0,
        endTime: 4,
        background: true,
    })) as { isError: boolean; json: { status?: string; jobId?: string; detail?: string } }
    if (started.isError) {
        throw new Error(started.json.detail ?? "start failed")
    }
    return started.json.jobId ?? ""
}

describe("render job eviction", () => {
    beforeEach(() => {
        clearRenderJobsForTest()
    })

    it("keeps a running job queryable even when many finished jobs push past the cap", async () => {
        const { server } = buildServer()
        const running_job_id = await startJob(server)

        // 先行の running を残したまま、完了ジョブで上限（50）を溢れさせる。
        for (let index = 0; index < 55; index++) {
            const { server: another, resolveRender: resolve_another } = buildServer()
            await startJob(another)
            resolve_another(`/tmp/out-${index}.wav`)
            await Promise.resolve()
            await Promise.resolve()
        }

        const queried = await server.call("get_render_job", { jobId: running_job_id })
        expect(queried.isError).toBe(false)
        expect((queried.json as { status: string }).status).toBe("running")
    })

    it("rejects a new background render when running jobs fill the store", async () => {
        // running のまま resolve しないジョブで上限まで埋める。
        for (let index = 0; index < 50; index++) {
            const { server: filler } = buildServer()
            await startJob(filler)
        }
        const { server } = buildServer()
        const { isError, json } = await server.call("render_audio", {
            select: RENDER_SELECT,
            startTime: 0,
            endTime: 4,
            background: true,
        })
        expect(isError).toBe(true)
        const payload = json as { detail?: string; hint?: string }
        expect(payload.detail).toContain("fill the job store")
        expect(payload.hint).toContain("get_render_job")
    })
})
