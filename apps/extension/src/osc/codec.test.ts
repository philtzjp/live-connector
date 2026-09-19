import { BadRequestError } from "@live-connector/error"
import { describe, expect, it } from "vitest"
import { decodeOscMessage, encodeOscMessage } from "./codec"

describe("OSC codec", () => {
    it("round-trips address, int, float, string and booleans", () => {
        const encoded = encodeOscMessage({
            address: "/live/song/set/current_song_time",
            args: [32, 2.5, "Resampling", true, false],
        })
        const decoded = decodeOscMessage(encoded)
        expect(decoded.address).toBe("/live/song/set/current_song_time")
        expect(decoded.args).toEqual([32, 2.5, "Resampling", true, false])
    })

    it("round-trips a message with no arguments", () => {
        const decoded = decodeOscMessage(
            encodeOscMessage({ address: "/live/song/start_playing", args: [] }),
        )
        expect(decoded).toEqual({ address: "/live/song/start_playing", args: [] })
    })

    it("pads strings to the 4-byte boundary", () => {
        const encoded = encodeOscMessage({ address: "/a", args: ["abc"] })
        expect(encoded.length % 4).toBe(0)
        expect(decodeOscMessage(encoded).args).toEqual(["abc"])
    })

    it("encodes an integer outside the int32 range as float32", () => {
        const decoded = decodeOscMessage(
            encodeOscMessage({ address: "/live/song/set/loop_length", args: [10_000_000_000] }),
        )
        expect(decoded.args).toHaveLength(1)
        expect(decoded.args[0]).toBeCloseTo(10_000_000_000, -4)
    })

    it("rejects an empty datagram", () => {
        expect(() => decodeOscMessage(Buffer.alloc(0))).toThrow(BadRequestError)
    })

    it("rejects a datagram without an address pattern", () => {
        expect(() => decodeOscMessage(Buffer.from("nope\0\0\0\0", "utf8"))).toThrow(BadRequestError)
    })
})
