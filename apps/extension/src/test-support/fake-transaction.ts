/**
 * SDK の `ExtensionContext.withinTransaction<T>(fn: () => T): T` と同じ同期シグネチャを持つ
 * フェイク。SDK の型定義は「コールバックは同期でなければならない（内部で await できない）」と
 * 定めるため、`async` 関数が渡された場合は失敗させて契約違反を検出する。
 */
export function runWithinTransaction<T>(fn: () => T): T {
    if (fn.constructor.name === "AsyncFunction") {
        throw new Error(
            "withinTransaction callback must be synchronous; an async function was passed",
        )
    }
    return fn()
}
