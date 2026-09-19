/**
 * 環境変数の集約パッケージ。`process.env` を直接参照するのはこのパッケージのみ。
 *
 * - host は loopback のみを許可し、ローカル MCP サーバーを外部ネットワークへ公開しない。
 * - port は仕様上の既定値を明示的な default として与える。
 * - OSC（AbletonOSC）は既定で無効。有効時も loopback host のみを受け付ける。
 * - 録音長・生成量の上限は仕様として既定値を持ち、無期限録音は受理しない。
 */

import { ConfigError } from "@live-connector/error"
import { z } from "zod"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 7799
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

const DEFAULT_OSC_HOST = "127.0.0.1"
const DEFAULT_OSC_SEND_PORT = 11000
const DEFAULT_OSC_REPLY_PORT = 11001
const DEFAULT_OSC_TIMEOUT_MS = 1500
const DEFAULT_PLAN_TTL_MS = 60_000
const DEFAULT_MAX_CAPTURE_BEATS = 2048
const DEFAULT_MAX_ARTIFACT_BYTES = 536_870_912

function normalizeHost(host: string): string {
    const normalized_host = host.trim().toLowerCase()
    if (normalized_host.startsWith("[") && normalized_host.endsWith("]")) {
        return normalized_host.slice(1, -1)
    }
    return normalized_host
}

const loopback_host = z
    .string()
    .min(1)
    .transform((host) => normalizeHost(host))
    .refine((host) => LOOPBACK_HOSTS.has(host), {
        message: "must be a loopback host: 127.0.0.1, localhost, or ::1",
    })

const boolean_env = z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1")

const env_schema = z.object({
    LIVE_CONNECTOR_MCP_HOST: loopback_host.default(DEFAULT_HOST),
    LIVE_CONNECTOR_MCP_PORT: z.coerce.number().int().positive().max(65535).default(DEFAULT_PORT),
    LIVE_CONNECTOR_OSC_ENABLED: boolean_env.default(false),
    LIVE_CONNECTOR_OSC_HOST: loopback_host.default(DEFAULT_OSC_HOST),
    LIVE_CONNECTOR_OSC_SEND_PORT: z.coerce
        .number()
        .int()
        .positive()
        .max(65535)
        .default(DEFAULT_OSC_SEND_PORT),
    LIVE_CONNECTOR_OSC_REPLY_PORT: z.coerce
        .number()
        .int()
        .positive()
        .max(65535)
        .default(DEFAULT_OSC_REPLY_PORT),
    LIVE_CONNECTOR_OSC_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .positive()
        .max(60_000)
        .default(DEFAULT_OSC_TIMEOUT_MS),
    LIVE_CONNECTOR_CAPTURE_VALIDATION_LEVEL: z
        .enum(["unverified", "integration-tested"])
        .default("unverified"),
    LIVE_CONNECTOR_CAPTURE_VALIDATION_ID: z.string().min(1).optional(),
    LIVE_CONNECTOR_PLAN_TTL_MS: z.coerce.number().int().positive().default(DEFAULT_PLAN_TTL_MS),
    LIVE_CONNECTOR_MAX_CAPTURE_BEATS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_CAPTURE_BEATS),
    LIVE_CONNECTOR_MAX_ARTIFACT_BYTES: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_ARTIFACT_BYTES),
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
