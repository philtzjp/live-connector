/**
 * 環境変数の集約パッケージ。`process.env` を直接参照するのはこのパッケージのみ。
 *
 * - host は loopback のみを許可し、ローカル MCP サーバーを外部ネットワークへ公開しない。
 * - port は仕様上の既定値を明示的な default として与える。
 */

import { ConfigError } from "@live-connector/error"
import { z } from "zod"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 7799
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

function normalizeHost(host: string): string {
    const normalized_host = host.trim().toLowerCase()
    if (normalized_host.startsWith("[") && normalized_host.endsWith("]")) {
        return normalized_host.slice(1, -1)
    }
    return normalized_host
}

const env_schema = z.object({
    LIVE_CONNECTOR_MCP_HOST: z
        .string()
        .min(1)
        .transform((host) => normalizeHost(host))
        .refine((host) => LOOPBACK_HOSTS.has(host), {
            message: "must be a loopback host: 127.0.0.1, localhost, or ::1",
        })
        .default(DEFAULT_HOST),
    LIVE_CONNECTOR_MCP_PORT: z.coerce.number().int().positive().max(65535).default(DEFAULT_PORT),
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
