import { afterEach, describe, expect, it } from "vitest"
import { installCrashGuard } from "./crash-guard"

type CapturedLog = { message: string; fields?: Record<string, unknown> }

function makeLog(captured: CapturedLog[]) {
    return {
        debug() {},
        info() {},
        warn() {},
        error(message: string, fields?: Record<string, unknown>) {
            captured.push({ message, ...(fields !== undefined ? { fields } : {}) })
        },
    }
}

const uninstalls: (() => void)[] = []

afterEach(() => {
    for (const uninstall of uninstalls.splice(0)) {
        uninstall()
    }
})

describe("installCrashGuard", () => {
    it("uncaughtException を記録してプロセスを継続させる", () => {
        const captured: CapturedLog[] = []
        const guard = installCrashGuard(makeLog(captured))
        uninstalls.push(guard.uninstall)

        process.emit("uncaughtException", new TypeError("Invalid object reference"))

        expect(captured).toHaveLength(1)
        expect(captured[0]?.message).toContain("process stays alive")
        expect(captured[0]?.fields).toMatchObject({
            name: "TypeError",
            message: "Invalid object reference",
            isInvalidObjectReference: true,
        })
    })

    it("SDK の無効な Handle 以外の例外も記録する", () => {
        const captured: CapturedLog[] = []
        const guard = installCrashGuard(makeLog(captured))
        uninstalls.push(guard.uninstall)

        process.emit("uncaughtException", new Error("something else"))

        expect(captured[0]?.fields).toMatchObject({ isInvalidObjectReference: false })
    })

    it("Error 以外が投げられても記録する", () => {
        const captured: CapturedLog[] = []
        const guard = installCrashGuard(makeLog(captured))
        uninstalls.push(guard.uninstall)

        process.emit("uncaughtException", "raw string" as unknown as Error)

        expect(captured[0]?.fields).toMatchObject({ name: "NonError", message: "raw string" })
    })

    it("unhandledRejection を記録する", () => {
        const captured: CapturedLog[] = []
        const guard = installCrashGuard(makeLog(captured))
        uninstalls.push(guard.uninstall)

        process.emit("unhandledRejection", new Error("rejected"), Promise.resolve())

        expect(captured[0]?.fields).toMatchObject({ name: "Error", message: "rejected" })
    })

    it("二重に登録しない", () => {
        const captured: CapturedLog[] = []
        const first = installCrashGuard(makeLog(captured))
        uninstalls.push(first.uninstall)
        const second = installCrashGuard(makeLog(captured))
        uninstalls.push(second.uninstall)

        process.emit("uncaughtException", new Error("once"))

        expect(captured).toHaveLength(1)
    })

    it("解除するとハンドラが残らない", () => {
        const captured: CapturedLog[] = []
        const guard = installCrashGuard(makeLog(captured))
        const before = process.listenerCount("uncaughtException")
        guard.uninstall()

        expect(process.listenerCount("uncaughtException")).toBe(before - 1)
    })
})
