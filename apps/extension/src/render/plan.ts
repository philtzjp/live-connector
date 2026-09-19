/**
 * Main 録音の実行計画（preview / planId / requestId）。
 * planId は永続的な権限ではなく、短い有効期限を持つ単発トークン。
 * 実行直前に Set identity・引数 hash・期限を再検証する。
 */

import { createHash, randomUUID } from "node:crypto"
import { HybridError } from "@live-connector/error"
import type { MainRenderArgs, RenderPlan } from "../types/hybrid"

/** 計画の既定有効期限。Runtime の planTtlMs が優先される。 */
const DEFAULT_PLAN_TTL_MS = 60_000

const plans = new Map<string, RenderPlan>()

/** 冪等性判定に使う引数 hash（キー順を固定した JSON の SHA-256）。 */
export function mainRenderArgHash(args: MainRenderArgs): string {
    const normalized = JSON.stringify({
        startTime: args.startTime,
        endTime: args.endTime,
        preRollBeats: args.preRollBeats,
        keepCaptureTrack: args.keepCaptureTrack,
    })
    return createHash("sha256").update(normalized).digest("hex")
}

export type CreateRenderPlanInput = {
    setId: string
    args: MainRenderArgs
    ttlMs?: number
}

export function createRenderPlan(input: CreateRenderPlanInput): RenderPlan {
    const now = Date.now()
    // 確定されなかった preview の計画が溜まり続けないよう、発行のたびに期限切れを捨てる。
    pruneRenderPlans(now)
    const ttl = input.ttlMs ?? DEFAULT_PLAN_TTL_MS
    const plan: RenderPlan = {
        planId: `plan-${randomUUID()}`,
        setId: input.setId,
        source: "main",
        method: "realtime-resampling",
        timeUnit: "quarter-note-beats",
        range: { startTime: input.args.startTime, endTime: input.args.endTime },
        preRollBeats: input.args.preRollBeats,
        keepCaptureTrack: input.args.keepCaptureTrack,
        argHash: mainRenderArgHash(input.args),
        effects: [
            "create-owned-audio-track",
            "temporarily-change-recording-and-punch-settings",
            "play-arrangement-in-real-time",
            "write-audio-artifact",
            "restore-owned-changes",
        ],
        warnings: ["Live の再生位置を使用します。録音中は Set を操作しないでください。"],
        requiresConfirmation: true,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl).toISOString(),
    }
    plans.set(plan.planId, plan)
    return plan
}

export function consumeRenderPlan(plan_id: string): void {
    plans.delete(plan_id)
}

/** 期限切れの計画を破棄する。 */
export function pruneRenderPlans(now: number = Date.now()): void {
    for (const [plan_id, plan] of plans) {
        if (Date.parse(plan.expiresAt) <= now) {
            plans.delete(plan_id)
        }
    }
}

export function clearRenderPlansForTest(): void {
    plans.clear()
}

export function listRenderPlanIdsForTest(): string[] {
    return [...plans.keys()]
}

export type VerifyPlanInput = {
    planId: string
    setId: string
    args: MainRenderArgs
    now?: number
}

/** 計画を再検証して返す。失敗時は PLAN_STALE / SET_IDENTITY_MISMATCH。 */
export function verifyRenderPlan(input: VerifyPlanInput): RenderPlan {
    const plan = plans.get(input.planId)
    if (plan === undefined) {
        throw new HybridError("PLAN_STALE", `Render plan "${input.planId}" was not found`)
    }
    const now = input.now ?? Date.now()
    if (Date.parse(plan.expiresAt) <= now) {
        plans.delete(input.planId)
        throw new HybridError("PLAN_STALE", `Render plan "${input.planId}" has expired`)
    }
    if (plan.setId !== input.setId) {
        throw new HybridError(
            "SET_IDENTITY_MISMATCH",
            "The Live Set changed since the plan was created; run preview again",
        )
    }
    if (plan.argHash !== mainRenderArgHash(input.args)) {
        throw new HybridError(
            "PLAN_STALE",
            "The render arguments differ from the plan; run preview again",
        )
    }
    return plan
}
