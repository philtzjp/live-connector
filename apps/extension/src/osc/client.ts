/**
 * UDP 上の OSC クライアント。AbletonOSC は requestId を持たないため、
 * address 単位で 1 件ずつ直列化して応答を照合する。
 * socket と listener は Runtime（activation 単位の singleton）で共有する。
 */

import dgram from "node:dgram"
import { HybridError } from "@live-connector/error"
import { createLogger, type Logger } from "@live-connector/log"
import type { OscArg, OscMessage, OscSettings } from "../types/hybrid"
import { decodeOscMessage, encodeOscMessage } from "./codec"

/** OSC 送受信の下位トランスポート。テストではフェイクへ差し替える。 */
export type OscDatagramTransport = {
    bind(): Promise<void>
    send(payload: Buffer, host: string, port: number): void
    onMessage(listener: (payload: Buffer) => void): void
    close(): Promise<void>
}

/** node:dgram による実トランスポート。 */
export function createDgramTransport(settings: OscSettings, log: Logger): OscDatagramTransport {
    const socket = dgram.createSocket("udp4")
    let message_listener: ((payload: Buffer) => void) | null = null

    socket.on("message", (payload) => {
        message_listener?.(payload)
    })
    socket.on("error", (error) => {
        log.error("OSC socket error", { error: String(error) })
    })

    return {
        bind() {
            return new Promise<void>((resolve, reject) => {
                const on_bind_error = (error: NodeJS.ErrnoException) => {
                    socket.off("listening", on_bind_success)
                    reject(error)
                }
                const on_bind_success = () => {
                    socket.off("error", on_bind_error)
                    resolve()
                }
                socket.once("error", on_bind_error)
                socket.once("listening", on_bind_success)
                socket.bind(settings.replyPort, settings.host)
            })
        },
        send(payload, host, port) {
            socket.send(payload, port, host)
        },
        onMessage(listener) {
            message_listener = listener
        },
        close() {
            return new Promise<void>((resolve) => {
                try {
                    socket.close(() => resolve())
                } catch {
                    resolve()
                }
            })
        },
    }
}

type PendingRequest = {
    address: string
    args: OscArg[]
    resolve: (message: OscMessage) => void
    reject: (error: unknown) => void
    retries_left: number
    timer: NodeJS.Timeout | undefined
}

const GET_RETRY_LIMIT = 2

/** 型付き OSC リクエスト／応答クライアント。 */
export class OscClient {
    private readonly transport: OscDatagramTransport
    private readonly settings: OscSettings
    private readonly log: Logger
    private readonly queues = new Map<string, PendingRequest[]>()
    private started = false
    private last_reply_at: number | null = null

    constructor(transport: OscDatagramTransport, settings: OscSettings, log?: Logger) {
        this.transport = transport
        this.settings = settings
        this.log = log ?? createLogger("osc")
    }

    /** 応答ポートを bind して受信 listener を登録する。 */
    async start(): Promise<void> {
        if (this.started) {
            return
        }
        try {
            await this.transport.bind()
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === "EADDRINUSE") {
                throw new HybridError(
                    "OSC_PORT_IN_USE",
                    `OSC reply port ${this.settings.replyPort} is already in use`,
                )
            }
            throw new HybridError(
                "OSC_UNAVAILABLE",
                `Failed to bind OSC reply port: ${String(error)}`,
            )
        }
        this.transport.onMessage((payload) => this.handleMessage(payload))
        this.started = true
    }

    /** listener と socket を解放する。 */
    async stop(): Promise<void> {
        for (const queue of this.queues.values()) {
            for (const pending of queue) {
                if (pending.timer !== undefined) {
                    clearTimeout(pending.timer)
                }
                pending.reject(new HybridError("OSC_UNAVAILABLE", "OSC client stopped"))
            }
        }
        this.queues.clear()
        this.started = false
        await this.transport.close()
    }

    isStarted(): boolean {
        return this.started
    }

    /** 直近に応答を受信した時刻（epoch ms）。未受信なら null。 */
    lastReplyAt(): number | null {
        return this.last_reply_at
    }

    /** GET 相当。応答を待ち、タイムアウト時は限定回数だけ再送する。 */
    request(
        address: string,
        args: OscArg[] = [],
        options: { retries?: number } = {},
    ): Promise<OscMessage> {
        if (!this.started) {
            return Promise.reject(new HybridError("OSC_UNAVAILABLE", "OSC client is not connected"))
        }
        return new Promise<OscMessage>((resolve, reject) => {
            const pending: PendingRequest = {
                address,
                args,
                resolve,
                reject,
                retries_left: options.retries ?? GET_RETRY_LIMIT,
                timer: undefined,
            }
            const queue = this.queues.get(address) ?? []
            const was_empty = queue.length === 0
            queue.push(pending)
            this.queues.set(address, queue)
            if (was_empty) {
                this.dispatch(pending)
            }
        })
    }

    /**
     * 副作用を持つ命令の送信。応答は待たない。
     * 再送は行わない（適用状況不明を避けるため、呼び出し側が読み戻して確認する）。
     */
    send(address: string, args: OscArg[] = []): void {
        if (!this.started) {
            throw new HybridError("OSC_UNAVAILABLE", "OSC client is not connected")
        }
        this.transport.send(
            encodeOscMessage({ address, args }),
            this.settings.host,
            this.settings.sendPort,
        )
    }

    private dispatch(pending: PendingRequest): void {
        this.transport.send(
            encodeOscMessage({ address: pending.address, args: pending.args }),
            this.settings.host,
            this.settings.sendPort,
        )
        pending.timer = setTimeout(() => this.onTimeout(pending), this.settings.timeoutMs)
    }

    private onTimeout(pending: PendingRequest): void {
        const queue = this.queues.get(pending.address)
        if (queue === undefined || queue[0] !== pending) {
            return
        }
        if (pending.retries_left > 0) {
            pending.retries_left -= 1
            this.log.debug("OSC request timed out; retrying", { address: pending.address })
            this.dispatch(pending)
            return
        }
        queue.shift()
        pending.reject(
            new HybridError("OSC_UNAVAILABLE", `OSC request to "${pending.address}" timed out`),
        )
        this.advance(pending.address, queue)
    }

    private handleMessage(payload: Buffer): void {
        let message: OscMessage
        try {
            message = decodeOscMessage(payload)
        } catch (error) {
            this.log.warn("Discarded malformed OSC datagram", { error: String(error) })
            return
        }
        this.last_reply_at = Date.now()
        const queue = this.queues.get(message.address)
        const pending = queue?.[0]
        if (queue === undefined || pending === undefined) {
            this.log.debug("OSC reply without pending request", { address: message.address })
            return
        }
        if (pending.timer !== undefined) {
            clearTimeout(pending.timer)
        }
        queue.shift()
        pending.resolve(message)
        this.advance(message.address, queue)
    }

    private advance(address: string, queue: PendingRequest[]): void {
        if (queue.length === 0) {
            this.queues.delete(address)
            return
        }
        const next = queue[0]
        if (next !== undefined) {
            this.dispatch(next)
        }
    }
}
