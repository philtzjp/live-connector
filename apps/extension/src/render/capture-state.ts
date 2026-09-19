/**
 * Main 録音が変更する設定の before 値の取得と復旧。
 * 復旧は before 値と「自分が設定した値」を比較し、ユーザー操作で別の値になっている場合は
 * 無条件に上書きせず競合として報告する。
 */

import type { Logger } from "@live-connector/log"
import type { OscTransportAdapter } from "../osc/transport"
import type { AppliedSetting, CaptureBeforeState } from "../types/hybrid"

export type RestoreOutcome = {
    restored: string[]
    unrecovered: string[]
}

/** 録音前に変更対象となり得る設定のスナップショットを取る。 */
export async function captureBeforeState(
    transport: OscTransportAdapter,
): Promise<CaptureBeforeState> {
    const state = await transport.readState()
    return {
        currentSongTime: state.currentSongTime,
        isPlaying: state.isPlaying,
        loop: state.loop,
        loopStart: state.loopStart,
        loopLength: state.loopLength,
        punchIn: state.punchIn,
        punchOut: state.punchOut,
        recordMode: state.recordMode,
        backToArranger: state.backToArranger,
    }
}

type RestorableKey = "loop" | "loopStart" | "loopLength" | "punchIn" | "punchOut" | "recordMode"

const RESTORABLE_KEYS: RestorableKey[] = [
    "loop",
    "loopStart",
    "loopLength",
    "punchIn",
    "punchOut",
    "recordMode",
]

function currentValue(snapshot: CaptureBeforeState, key: RestorableKey): number | boolean | null {
    return snapshot[key]
}

/** 変更した設定を before へ戻す。競合は上書きせず unrecovered に列挙する。 */
export async function restoreTransport(
    transport: OscTransportAdapter,
    before: CaptureBeforeState,
    applied: AppliedSetting[],
    log: Logger,
): Promise<RestoreOutcome> {
    const restored: string[] = []
    const unrecovered: string[] = []
    const applied_by_key = new Map(applied.map((entry) => [entry.key, entry.value]))
    const snapshot = await transport.readState()

    for (const key of RESTORABLE_KEYS) {
        const applied_value = applied_by_key.get(key)
        const before_value = before[key]
        if (applied_value === undefined || before_value === null || before_value === undefined) {
            continue
        }
        const current = currentValue(snapshot, key)
        if (current === null || current === undefined) {
            continue
        }
        if (current === before_value) {
            continue
        }
        if (current !== applied_value) {
            // ユーザーが別の値へ変更した。競合として報告し、上書きしない。
            unrecovered.push(`${key} (expected ${String(applied_value)}, found ${String(current)})`)
            continue
        }
        try {
            await applyRestore(transport, key, before_value)
            restored.push(key)
        } catch (error) {
            log.error("Failed to restore transport setting", { key, error: String(error) })
            unrecovered.push(`${key} (restore failed)`)
        }
    }

    // 再生位置は常に before へ戻す。録音中の位置は変更対象である。
    const before_time = before.currentSongTime
    if (before_time !== null) {
        try {
            await transport.seek(before_time)
            restored.push("currentSongTime")
        } catch (error) {
            log.error("Failed to restore song position", { error: String(error) })
            unrecovered.push("currentSongTime (restore failed)")
        }
    }

    return { restored, unrecovered }
}

async function applyRestore(
    transport: OscTransportAdapter,
    key: RestorableKey,
    value: number | boolean,
): Promise<void> {
    switch (key) {
        case "loop":
            await transport.setLoop(Boolean(value))
            return
        case "loopStart":
            await transport.setLoopStart(Number(value))
            return
        case "loopLength":
            await transport.setLoopLength(Number(value))
            return
        case "punchIn":
            await transport.setPunchIn(Boolean(value))
            return
        case "punchOut":
            await transport.setPunchOut(Boolean(value))
            return
        case "recordMode":
            await transport.setRecordMode(Boolean(value))
            return
    }
}
