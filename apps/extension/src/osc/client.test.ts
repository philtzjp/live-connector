import { HybridError } from "@live-connector/error"
import { describe, expect, it } from "vitest"
import type { OscMessage } from "../types/hybrid"
import { OscClient, type OscDatagramTransport } from "./client"
import { encodeOscMessage } from "./codec"

const silent_log = {
    debug() {},
    info() {},
    warn() {},
    error() {},
}

const settings = {
    enabled: true,
    host: "127.0.0.1",
    sendPort: 11000,
    replyPort: 11001,
    timeoutMs: 10,
}

function makeTransport(overrides: Partial<OscDatagramTransport> = {}): OscDatagramTransport {
    return {
        bind: async () => {},
        send() {},
        onMessage() {},
        close: async () => {},
        ...overrides,
    }
}

describe("OscClient", () => {
    it("rejects with OSC_UNAVAILABLE when no reply arrives", async () => {
        const client = new OscClient(makeTransport(), settings, silent_log)
        await client.start()
        await expect(client.request("/live/song/get/tempo")).rejects.toMatchObject({
            code: "OSC_UNAVAILABLE",
        })
    })

    it("maps a bind EADDRINUSE to OSC_PORT_IN_USE", async () => {
        const transport = makeTransport({
            bind: async () => {
                throw Object.assign(new Error("in use"), { code: "EADDRINUSE" })
            },
        })
        const client = new OscClient(transport, settings, silent_log)
        try {
            await client.start()
            throw new Error("expected a throw")
        } catch (error) {
            expect(error).toBeInstanceOf(HybridError)
            expect((error as HybridError).code).toBe("OSC_PORT_IN_USE")
        }
    })

    it("resolves a request from a matching reply datagram", async () => {
        let listener: ((payload: Buffer) => void) | null = null
        const transport = makeTransport({
            send(payload) {
                const message = { address: "/live/song/get/tempo", args: [128] } as OscMessage
                queueMicrotask(() => listener?.(encodeOscMessage(message)))
                void payload
            },
            onMessage(next) {
                listener = next
            },
        })
        const client = new OscClient(transport, settings, silent_log)
        await client.start()

        const reply = await client.request("/live/song/get/tempo")
        expect(reply.args).toEqual([128])
    })

    it("rejects requests before start", async () => {
        const client = new OscClient(makeTransport(), settings, silent_log)
        await expect(client.request("/live/song/get/tempo")).rejects.toMatchObject({
            code: "OSC_UNAVAILABLE",
        })
    })

    it("refuses to send after stop instead of touching a closed socket", async () => {
        let sent = 0
        const client = new OscClient(
            makeTransport({
                send() {
                    sent += 1
                },
            }),
            settings,
            silent_log,
        )
        await client.start()
        await client.stop()
        expect(() => client.send("/live/song/stop_playing")).toThrow(HybridError)
        expect(sent).toBe(0)
    })
})
