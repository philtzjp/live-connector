/**
 * Extension Host は extension を `vm` コンテキストで評価する。そのコンテキストには
 * Web 標準グローバル（Request/Response/Headers/ReadableStream/URL 等）が存在しないため、
 * SDK の StreamableHTTPServerTransport が内部利用する Node HTTP 変換層などが
 * 読み込み時の `class … extends Response` で失敗する。
 *
 * このファイルは esbuild の `inject` で他モジュールより先に実行され、Node 組み込みから
 * 不足しているグローバルを補う。
 */

import { Blob } from "node:buffer"
import {
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    ReadableStream,
    TransformStream,
    WritableStream,
} from "node:stream/web"
import { URL, URLSearchParams } from "node:url"
import { TextDecoder, TextEncoder } from "node:util"
import { FormData, fetch, Headers, Request, Response } from "undici"

const target = globalThis as unknown as Record<string, unknown>

function provide(name: string, value: unknown): void {
    if (target[name] === undefined) {
        target[name] = value
    }
}

provide("Request", Request)
provide("Response", Response)
provide("Headers", Headers)
provide("FormData", FormData)
provide("fetch", fetch)
provide("Blob", Blob)
provide("ReadableStream", ReadableStream)
provide("WritableStream", WritableStream)
provide("TransformStream", TransformStream)
provide("ByteLengthQueuingStrategy", ByteLengthQueuingStrategy)
provide("CountQueuingStrategy", CountQueuingStrategy)
provide("TextEncoder", TextEncoder)
provide("TextDecoder", TextDecoder)
provide("URL", URL)
provide("URLSearchParams", URLSearchParams)
provide("queueMicrotask", (callback: () => void) => {
    Promise.resolve().then(callback)
})
