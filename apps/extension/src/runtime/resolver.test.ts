import { describe, expect, it } from "vitest"
import type { OscRoutingAdapter } from "../osc/routing"
import { CaptureResolver } from "./resolver"

function routingWith(names: string[]): OscRoutingAdapter {
    return { listTrackNames: async () => names } as unknown as OscRoutingAdapter
}

describe("CaptureResolver", () => {
    it("resolves the index when the unique name is unique and aligned", async () => {
        const resolver = new CaptureResolver(routingWith(["Drums", "__LC_PRINT_x"]))
        await expect(
            resolver.resolveOscIndex("__LC_PRINT_x", ["Drums", "__LC_PRINT_x"]),
        ).resolves.toBe(1)
    })

    it("rejects duplicate unique names", async () => {
        const resolver = new CaptureResolver(routingWith(["__LC_PRINT_x", "__LC_PRINT_x"]))
        await expect(
            resolver.resolveOscIndex("__LC_PRINT_x", ["__LC_PRINT_x", "__LC_PRINT_x"]),
        ).rejects.toMatchObject({ code: "SET_IDENTITY_MISMATCH" })
    })

    it("rejects SDK/OSC order disagreement", async () => {
        const resolver = new CaptureResolver(routingWith(["__LC_PRINT_x", "Drums"]))
        await expect(
            resolver.resolveOscIndex("__LC_PRINT_x", ["Drums", "__LC_PRINT_x"]),
        ).rejects.toMatchObject({ code: "SET_IDENTITY_MISMATCH" })
    })

    it("rejects a missing capture track", async () => {
        const resolver = new CaptureResolver(routingWith(["Drums"]))
        await expect(resolver.resolveOscIndex("__LC_PRINT_x", ["Drums"])).rejects.toMatchObject({
            code: "SET_IDENTITY_MISMATCH",
        })
    })
})
