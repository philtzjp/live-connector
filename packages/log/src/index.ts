/**
 * ログ実装の集約パッケージ。他パッケージは独自にロガーを生成しない。
 *
 * Extension は Node.js プロセスとして動作し、標準出力は Live の Max Window に表示される。
 * 構造化フィールドを 1 行 JSON として付随させる。
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogFields = Record<string, unknown>

export type Logger = {
    debug: (message: string, fields?: LogFields) => void
    info: (message: string, fields?: LogFields) => void
    warn: (message: string, fields?: LogFields) => void
    error: (message: string, fields?: LogFields) => void
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
}

function formatLine(scope: string, level: LogLevel, message: string, fields?: LogFields): string {
    const head = `[${level}] ${scope}: ${message}`
    if (fields === undefined || Object.keys(fields).length === 0) {
        return head
    }
    return `${head} ${JSON.stringify(fields)}`
}

/**
 * スコープ名付きロガーを生成する。
 *
 * @param scope - 発生源を示す短い識別子（例: "extension", "mcp"）。
 * @param min_level - 出力する最小レベル。既定は "info"。
 */
export function createLogger(scope: string, min_level: LogLevel = "info"): Logger {
    const threshold = LEVEL_ORDER[min_level]

    const emit = (level: LogLevel, message: string, fields?: LogFields) => {
        if (LEVEL_ORDER[level] < threshold) {
            return
        }
        const line = formatLine(scope, level, message, fields)
        if (level === "error" || level === "warn") {
            console.error(line)
        } else {
            console.log(line)
        }
    }

    return {
        debug: (message, fields) => emit("debug", message, fields),
        info: (message, fields) => emit("info", message, fields),
        warn: (message, fields) => emit("warn", message, fields),
        error: (message, fields) => emit("error", message, fields),
    }
}
