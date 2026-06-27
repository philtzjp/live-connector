import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Env } from "@live-connector/env"
import {
    AuthError,
    BadRequestError,
    MethodNotAllowedError,
    NotFoundError,
    toProblemDetails,
} from "@live-connector/error"
import type { Logger } from "@live-connector/log"
import {
    StreamableHTTPServerTransport,
    type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { ServerDeps } from "../deps"
import { createMcpServer } from "./mcp"

const MCP_PATH = "/api/v1/mcp"
const HEALTH_PATH = "/health"
const SERVICE_VERSION = "0.0.0"
const MAX_BODY_BYTES = 1024 * 1024

type RequestContext = {
    deps: ServerDeps
    env: Env
    log: Logger
}

export type StartArgs = {
    deps: ServerDeps
    env: Env
    log: Logger
}

export type ServerInfo = {
    host: string
    port: number
    mcpPath: string
}

function writeJson(
    response: ServerResponse,
    status_code: number,
    content_type: string,
    payload: unknown,
): void {
    response.writeHead(status_code, { "content-type": content_type })
    response.end(JSON.stringify(payload))
}

function writeProblem(
    response: ServerResponse,
    error: unknown,
    extra_headers: Record<string, string> = {},
): void {
    const problem = toProblemDetails(error)
    response.writeHead(problem.status, {
        "content-type": "application/problem+json",
        ...extra_headers,
    })
    response.end(JSON.stringify(problem))
}

function requestPath(request: IncomingMessage, env: Env): string {
    const url = new URL(
        request.url ?? "/",
        `http://${env.LIVE_CONNECTOR_MCP_HOST}:${env.LIVE_CONNECTOR_MCP_PORT}`,
    )
    return url.pathname
}

function timingSafeEqualString(actual: string, expected: string): boolean {
    const actual_buffer = Buffer.from(actual)
    const expected_buffer = Buffer.from(expected)
    if (actual_buffer.length !== expected_buffer.length) {
        return false
    }
    return timingSafeEqual(actual_buffer, expected_buffer)
}

function assertBearerAuth(request: IncomingMessage, env: Env): void {
    const expected_token = env.LIVE_CONNECTOR_MCP_TOKEN
    if (expected_token === undefined) {
        return
    }

    const header = request.headers.authorization
    if (header === undefined) {
        throw new AuthError("Missing bearer token")
    }
    if (!header.startsWith("Bearer ")) {
        throw new AuthError("Missing bearer token")
    }

    const actual_token = header.slice("Bearer ".length)
    if (!timingSafeEqualString(actual_token, expected_token)) {
        throw new AuthError("Invalid bearer token")
    }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let total_size = 0

        request.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total_size += buffer.byteLength
            if (total_size > MAX_BODY_BYTES) {
                request.destroy()
                reject(new BadRequestError("Request body exceeds 1 MiB"))
                return
            }
            chunks.push(buffer)
        })

        request.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8")
            if (text.length === 0) {
                reject(new BadRequestError("Request body must contain JSON"))
                return
            }
            try {
                resolve(JSON.parse(text) as unknown)
            } catch {
                reject(new BadRequestError("Request body must be valid JSON"))
            }
        })

        request.on("error", () => {
            reject(new BadRequestError("Failed to read request body"))
        })
    })
}

async function closeMcpSession(
    server: ReturnType<typeof createMcpServer>,
    transport: StreamableHTTPServerTransport,
    log: Logger,
): Promise<void> {
    try {
        await transport.close()
        await server.close()
    } catch (error) {
        log.error("Failed to close MCP transport", { error: String(error) })
    }
}

function handleHealth(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
        writeProblem(
            response,
            new MethodNotAllowedError(`Method ${request.method ?? "UNKNOWN"} is not allowed`),
        )
        return
    }
    writeJson(response, 200, "application/health+json", {
        status: "pass",
        version: SERVICE_VERSION,
        description: "live-connector MCP server",
    })
}

async function handleMcp(
    context: RequestContext,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    if (request.method !== "POST") {
        writeProblem(
            response,
            new MethodNotAllowedError(`Method ${request.method ?? "UNKNOWN"} is not allowed`),
        )
        return
    }

    try {
        assertBearerAuth(request, context.env)
    } catch (error) {
        writeProblem(response, error, { "www-authenticate": "Bearer" })
        return
    }

    const parsed_body = await readJsonBody(request)
    const server = createMcpServer(context.deps)
    const transport_options = {
        sessionIdGenerator: undefined,
    } as unknown as StreamableHTTPServerTransportOptions
    const transport = new StreamableHTTPServerTransport(transport_options)
    let closed = false

    const close_once = () => {
        if (closed) {
            return
        }
        closed = true
        void closeMcpSession(server, transport, context.log)
    }

    transport.onerror = (error) => {
        context.log.error("MCP transport failed", { error: String(error) })
    }
    response.once("close", close_once)

    try {
        await server.connect(transport as unknown as Transport)
        await transport.handleRequest(request, response, parsed_body)
    } finally {
        if (response.writableEnded) {
            close_once()
        }
    }
}

async function routeRequest(
    context: RequestContext,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    const path = requestPath(request, context.env)
    if (path === HEALTH_PATH) {
        handleHealth(request, response)
        return
    }
    if (path === MCP_PATH) {
        await handleMcp(context, request, response)
        return
    }
    writeProblem(response, new NotFoundError(`Path "${path}" was not found`))
}

/**
 * Node.js 標準 http と SDK 同梱 StreamableHTTPServerTransport で MCP サーバーを起動する。
 *
 * - `/health`: 認証不要のヘルスチェック（draft-inadarei 準拠）。
 * - `/api/v1/mcp`: `LIVE_CONNECTOR_MCP_TOKEN` 設定時のみ Bearer 認証付きの MCP エンドポイント。
 */
export function startMcpHttpServer(args: StartArgs): Promise<ServerInfo> {
    const context: RequestContext = { deps: args.deps, env: args.env, log: args.log }

    const server = createServer((request, response) => {
        void routeRequest(context, request, response).catch((error: unknown) => {
            context.log.error("HTTP request failed", { error: String(error) })
            if (!response.headersSent) {
                writeProblem(response, error)
                return
            }
            response.destroy()
        })
    })

    return new Promise<ServerInfo>((resolve, reject) => {
        const reject_startup = (error: Error) => {
            reject(error)
        }

        server.once("error", reject_startup)
        server.listen(args.env.LIVE_CONNECTOR_MCP_PORT, args.env.LIVE_CONNECTOR_MCP_HOST, () => {
            server.off("error", reject_startup)
            server.on("error", (error) => {
                args.log.error("MCP HTTP server failed", { error: String(error) })
            })
            const address = server.address()
            const port =
                typeof address === "object" && address !== null
                    ? address.port
                    : args.env.LIVE_CONNECTOR_MCP_PORT
            const server_info: ServerInfo = {
                host: args.env.LIVE_CONNECTOR_MCP_HOST,
                port,
                mcpPath: MCP_PATH,
            }
            args.log.info("MCP HTTP server listening", server_info)
            resolve(server_info)
        })
    })
}
