/**
 * 環境変数の集約パッケージ。`process.env` を直接参照するのはこのパッケージのみ。
 *
 * - `LIVE_CONNECTOR_MCP_TOKEN` は認証情報のため既定値を持たず、欠落時はエラーにする。
 * - host / port は仕様上の既定値を明示的な default として与える。
 */

import { ConfigError } from "@live-connector/error"
import { z } from "zod"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 7799

const env_schema = z.object({
    LIVE_CONNECTOR_MCP_HOST: z.string().min(1).default(DEFAULT_HOST),
    LIVE_CONNECTOR_MCP_PORT: z.coerce.number().int().positive().max(65535).default(DEFAULT_PORT),
    // 任意。設定されている場合のみ Bearer 認証を有効化する（未設定 = ローカル限定で認証なし）。
    LIVE_CONNECTOR_MCP_TOKEN: z.string().min(1).optional(),
})

export type Env = z.infer<typeof env_schema>

/**
 * `process.env` を検証して型付き Env を返す。必須値の欠落・不正時は ConfigError を投げる。
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
    const parsed = env_schema.safeParse(source)
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        throw new ConfigError(`Invalid environment variables: ${detail}`)
    }
    return parsed.data
}
