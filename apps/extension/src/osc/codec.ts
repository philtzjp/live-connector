/**
 * 必要最小限の OSC 1.0 メッセージ codec。
 * AbletonOSC が扱う address / string / int32 / float32 / T / F のみ対応する。
 * Ableton SDK へ依存しないため単体テスト可能。
 */

import { BadRequestError } from "@live-connector/error"
import type { OscArg, OscMessage } from "../types/hybrid"

const TYPE_INT32 = "i"
const TYPE_FLOAT32 = "f"
const TYPE_STRING = "s"
const TYPE_TRUE = "T"
const TYPE_FALSE = "F"

/** 4 バイト境界まで null パディングする。 */
function padToBoundary(bytes: Buffer): Buffer {
    const remainder = bytes.length % 4
    if (remainder === 0) {
        return bytes
    }
    return Buffer.concat([bytes, Buffer.alloc(4 - remainder)])
}

function encodeOscString(value: string): Buffer {
    // OSC 文字列は必ず 1 バイト以上の null 終端を持ち、4 バイト境界までパディングする。
    return padToBoundary(Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]))
}

const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647

/** int32 で表現できる整数だけを int32 とし、範囲外の整数は float32 として送る。 */
function isInt32(value: number): boolean {
    return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
}

function typeTagFor(value: OscArg): string {
    if (typeof value === "boolean") {
        return value ? TYPE_TRUE : TYPE_FALSE
    }
    if (typeof value === "number") {
        return isInt32(value) ? TYPE_INT32 : TYPE_FLOAT32
    }
    return TYPE_STRING
}

/** OSC メッセージを UDP 送信用のバイト列へエンコードする。 */
export function encodeOscMessage(message: OscMessage): Buffer {
    const tags = `,${message.args.map(typeTagFor).join("")}`
    const parts: Buffer[] = [encodeOscString(message.address), encodeOscString(tags)]
    for (const arg of message.args) {
        if (typeof arg === "boolean") {
            continue
        }
        if (typeof arg === "number") {
            const buffer = Buffer.alloc(4)
            if (isInt32(arg)) {
                buffer.writeInt32BE(arg, 0)
            } else {
                buffer.writeFloatBE(arg, 0)
            }
            parts.push(buffer)
            continue
        }
        parts.push(encodeOscString(arg))
    }
    return Buffer.concat(parts)
}

function readOscString(buffer: Buffer, offset: number): { value: string; next: number } {
    let end = offset
    while (end < buffer.length && buffer[end] !== 0) {
        end++
    }
    const value = buffer.toString("utf8", offset, end)
    let next = end + 1
    while (next % 4 !== 0) {
        next++
    }
    return { value, next }
}

/** UDP 受信バイト列を OSC メッセージへデコードする。 */
export function decodeOscMessage(buffer: Buffer): OscMessage {
    if (buffer.length === 0) {
        throw new BadRequestError("Empty OSC datagram")
    }
    const address_read = readOscString(buffer, 0)
    if (address_read.value.length === 0 || address_read.value[0] !== "/") {
        throw new BadRequestError("OSC datagram does not start with an address pattern")
    }
    const tag_read = readOscString(buffer, address_read.next)
    if (!tag_read.value.startsWith(",")) {
        throw new BadRequestError("OSC datagram is missing a type tag string")
    }

    const args: OscArg[] = []
    let offset = tag_read.next
    for (const tag of tag_read.value.slice(1)) {
        if (tag === TYPE_TRUE) {
            args.push(true)
            continue
        }
        if (tag === TYPE_FALSE) {
            args.push(false)
            continue
        }
        if (tag === TYPE_INT32) {
            args.push(buffer.readInt32BE(offset))
            offset += 4
            continue
        }
        if (tag === TYPE_FLOAT32) {
            args.push(buffer.readFloatBE(offset))
            offset += 4
            continue
        }
        if (tag === TYPE_STRING) {
            const read = readOscString(buffer, offset)
            args.push(read.value)
            offset = read.next
            continue
        }
        throw new BadRequestError(`Unsupported OSC type tag "${tag}"`)
    }

    return { address: address_read.value, args }
}
