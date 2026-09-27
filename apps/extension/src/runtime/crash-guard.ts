/**
 * Extension Host のプロセス終了を防ぐ保険。
 *
 * Extensions SDK は応答処理のコールバック内から `getObjectIsOfClass` を呼び、Live 側で
 * 対象を失った Handle に対して `TypeError: Invalid object reference` を投げる。これは
 * 非同期コールバックの内側で発生するため呼び出し側の try/catch では捕まえられず、
 * Node.js の uncaughtException となって Extension Host のプロセスごと終了する。
 * 同じホストに載っている他の Extension も巻き添えで停止する（#151）。
 *
 * ここでは例外を記録してプロセスを生かす。Node.js 一般の作法としては uncaughtException を
 * 握って継続するのは推奨されないが、Extension Host は複数の Extension を相乗りさせる
 * 共有プロセスであり、1 つの無効な Handle で全体を落とす方が失うものが大きい。
 * 無効化された Handle が原因の根本解決は SDK 側の Handle キャッシュに依存する。
 */

import type { Logger } from "@live-connector/log"

/** SDK が無効な Handle を参照したときのメッセージ。 */
const INVALID_OBJECT_REFERENCE = "Invalid object reference"

let installed = false

type CrashGuardHandle = {
    /** 登録したハンドラを外す。テストと、activate が再入した場合の掃除に使う。 */
    uninstall: () => void
}

function describeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            ...(error.stack !== undefined ? { stack: error.stack } : {}),
            isInvalidObjectReference: error.message.includes(INVALID_OBJECT_REFERENCE),
        }
    }
    return { name: "NonError", message: String(error), isInvalidObjectReference: false }
}

/**
 * uncaughtException と unhandledRejection を記録してプロセスを継続させる。
 *
 * 二重登録はしない（activate が複数回呼ばれてもハンドラは 1 組だけ残る）。
 *
 * @param log - 記録先のロガー。
 * @returns 登録を解除するハンドル。既に登録済みの場合は何もしない解除関数を返す。
 */
export function installCrashGuard(log: Logger): CrashGuardHandle {
    if (installed) {
        return { uninstall: () => {} }
    }

    const onUncaughtException = (error: unknown): void => {
        log.error("uncaught exception was contained; process stays alive", describeError(error))
    }

    const onUnhandledRejection = (reason: unknown): void => {
        log.error("unhandled rejection was contained; process stays alive", describeError(reason))
    }

    process.on("uncaughtException", onUncaughtException)
    process.on("unhandledRejection", onUnhandledRejection)
    installed = true

    return {
        uninstall: () => {
            process.off("uncaughtException", onUncaughtException)
            process.off("unhandledRejection", onUnhandledRejection)
            installed = false
        },
    }
}
