/**
 * JSON 直列化の集約。
 *
 * Ableton Extensions SDK は `Handle.id` を `bigint` で公開し、低レベル `HostApi` にも
 * `bigint` を返すメソッドがある。`bigint` を含む値を `JSON.stringify` へ渡すと
 * `TypeError: Do not know how to serialize a BigInt` が投げられるため、
 * 応答・ログ・永続化の直列化はすべてこのモジュールを経由する。
 */

/**
 * `bigint` を JSON で表現できる値へ変換する。
 *
 * 安全整数の範囲内は `number`、範囲外は精度を落とさないよう 10 進文字列を返す。
 * 値を丸めたり既定値へ置き換えたりはしない。
 */
export function bigintToJsonValue(value: bigint): number | string {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value)
    }
    return value.toString(10)
}

/**
 * `JSON.stringify` の replacer。`bigint` のみを変換し、他の値はそのまま通す。
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
        return bigintToJsonValue(value)
    }
    return value
}

/**
 * `bigint` を正規化したうえで JSON 文字列を返す。
 *
 * @param value - 直列化する値。
 * @param space - `JSON.stringify` のインデント幅。省略時は整形しない。
 */
export function stringifyJson(value: unknown, space?: number): string {
    return space === undefined
        ? JSON.stringify(value, jsonReplacer)
        : JSON.stringify(value, jsonReplacer, space)
}
