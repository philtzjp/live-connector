import { describe, expect, it } from "vitest"
import { runWithinTransaction } from "./fake-transaction"

describe("runWithinTransaction", () => {
    it("同期コールバックの戻り値をそのまま返す", () => {
        expect(runWithinTransaction(() => 42)).toBe(42)
    })

    it("Promise を返す同期コールバックは許容する", async () => {
        const result = runWithinTransaction(() => Promise.resolve("ok"))
        await expect(result).resolves.toBe("ok")
    })

    it("async コールバックは契約違反として失敗させる", () => {
        expect(() => runWithinTransaction(async () => "ng")).toThrow(
            "withinTransaction callback must be synchronous",
        )
    })
})
