/**
 * エラー定義・共通エラーハンドリングの集約パッケージ。
 * 他パッケージは Error を直接 throw せず、ここで定義したエラーを使用する。
 *
 * HTTP 表現は RFC 9457 (Problem Details for HTTP APIs) に準拠する。
 */

const ERROR_TYPE_BASE_URI = "urn:live-connector:error"

export type ProblemDetails = {
    type: string
    title: string
    status: number
    detail?: string
    instance?: string
}

export type McpErrorMetadata = {
    hint?: string
    validProperties?: string[]
    validRelationships?: string[]
    validStartLabels?: string[]
}

export type McpError = {
    error: string
    detail: string
    hint?: string
    validProperties?: string[]
    validRelationships?: string[]
    validStartLabels?: string[]
}

export type AppErrorArgs = {
    type?: string
    title: string
    status: number
    detail?: string
    metadata?: McpErrorMetadata | undefined
}

/** すべてのアプリケーションエラーの基底。RFC 9457 の Problem Details に変換できる。 */
export class AppError extends Error {
    readonly type: string
    readonly title: string
    readonly status: number
    readonly detail: string | undefined
    readonly metadata: McpErrorMetadata | undefined

    constructor(args: AppErrorArgs) {
        super(args.detail ?? args.title)
        this.name = new.target.name
        this.type = args.type ?? "about:blank"
        this.title = args.title
        this.status = args.status
        this.detail = args.detail
        this.metadata = args.metadata
    }

    toProblemDetails(instance?: string): ProblemDetails {
        const problem: ProblemDetails = {
            type: this.type,
            title: this.title,
            status: this.status,
        }
        if (this.detail !== undefined) {
            problem.detail = this.detail
        }
        if (instance !== undefined) {
            problem.instance = instance
        }
        return problem
    }
}

/** 環境変数・設定の不備。 */
export class ConfigError extends AppError {
    constructor(detail: string) {
        super({
            type: `${ERROR_TYPE_BASE_URI}:config`,
            title: "Configuration Error",
            status: 500,
            detail,
        })
    }
}

/** 認証・認可失敗。 */
export class AuthError extends AppError {
    constructor(detail = "Missing or invalid credentials") {
        super({
            type: `${ERROR_TYPE_BASE_URI}:unauthorized`,
            title: "Unauthorized",
            status: 401,
            detail,
        })
    }
}

/** クライアント入力の不正。 */
export class BadRequestError extends AppError {
    constructor(detail: string, metadata?: McpErrorMetadata) {
        super({
            type: `${ERROR_TYPE_BASE_URI}:bad-request`,
            title: "Bad Request",
            status: 400,
            detail,
            metadata,
        })
    }
}

/** 対象オブジェクトが見つからない（ロケータ・クエリ解決失敗など）。 */
export class NotFoundError extends AppError {
    constructor(detail: string, metadata?: McpErrorMetadata) {
        super({
            type: `${ERROR_TYPE_BASE_URI}:not-found`,
            title: "Not Found",
            status: 404,
            detail,
            metadata,
        })
    }
}

/** 許可されていない HTTP メソッド。 */
export class MethodNotAllowedError extends AppError {
    constructor(detail: string, metadata?: McpErrorMetadata) {
        super({
            type: `${ERROR_TYPE_BASE_URI}:method-not-allowed`,
            title: "Method Not Allowed",
            status: 405,
            detail,
            metadata,
        })
    }
}

function errorCodeFor(error: AppError): string {
    switch (error.name) {
        case "ConfigError":
            return "config"
        case "AuthError":
            return "unauthorized"
        case "BadRequestError":
            return "bad_request"
        case "NotFoundError":
            return "not_found"
        case "MethodNotAllowedError":
            return "method_not_allowed"
        default:
            return "application_error"
    }
}

function appendMcpMetadata(target: McpError, metadata: McpErrorMetadata | undefined): McpError {
    if (metadata?.hint !== undefined) {
        target.hint = metadata.hint
    }
    if (metadata?.validProperties !== undefined) {
        target.validProperties = metadata.validProperties
    }
    if (metadata?.validRelationships !== undefined) {
        target.validRelationships = metadata.validRelationships
    }
    if (metadata?.validStartLabels !== undefined) {
        target.validStartLabels = metadata.validStartLabels
    }
    return target
}

/** 任意のエラー値を MCP ツール向けの簡潔な構造化エラーに正規化する。 */
export function toMcpError(error: unknown): McpError {
    if (error instanceof AppError) {
        return appendMcpMetadata(
            {
                error: errorCodeFor(error),
                detail: error.detail ?? error.title,
            },
            error.metadata,
        )
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { error: "internal_error", detail }
}

/** 任意のエラー値を Problem Details に正規化する。AppError 以外は 500 に丸める。 */
export function toProblemDetails(error: unknown, instance?: string): ProblemDetails {
    if (error instanceof AppError) {
        return error.toProblemDetails(instance)
    }
    const detail = error instanceof Error ? error.message : String(error)
    const problem: ProblemDetails = {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        detail,
    }
    if (instance !== undefined) {
        problem.instance = instance
    }
    return problem
}
