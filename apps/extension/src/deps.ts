import type { ExtensionContext } from "@ableton-extensions/sdk"
import type { Logger } from "@live-connector/log"

/** このextensionが対象とする Extensions API バージョン。 */
export const API_VERSION = "1.0.0" as const

/** API_VERSION の型タグ（ジェネリック引数用）。 */
export type TargetApiVersion = typeof API_VERSION

/** MCP ツールが Live と対話するために共有する依存。 */
export type ServerDeps = {
    context: ExtensionContext<typeof API_VERSION>
    log: Logger
}
