import { ConfigError } from "@live-connector/error"

/**
 * 配布バージョンの正本。ビルド時に `build.ts` の esbuild `define` が
 * リポジトリルートの `VERSION`（manifest.json / package.json と一致を検証済み）から注入する。
 * 注入が無い場合は明示的に失敗させる（暗黙のフォールバック値は使わない）。
 */

declare const __LIVE_CONNECTOR_VERSION__: string | undefined

function resolveServiceVersion(): string {
    if (typeof __LIVE_CONNECTOR_VERSION__ === "string" && __LIVE_CONNECTOR_VERSION__.length > 0) {
        return __LIVE_CONNECTOR_VERSION__
    }
    throw new ConfigError(
        "Build did not inject __LIVE_CONNECTOR_VERSION__. Bundle via build.ts so the version is defined from VERSION.",
    )
}

export const SERVICE_VERSION: string = resolveServiceVersion()
