/**
 * 限定 CALL 文の実行。許可手続きだけを実行し、preview は OSC 送信を含め副作用ゼロ。
 * Transport 手続きは録音中の競合検査を通す。render.cancel は録音中の唯一の許可操作。
 */

import type { CallStatement } from "@live-connector/cypher"
import { BadRequestError, NotFoundError, toMcpError } from "@live-connector/error"
import type { ServerDeps } from "../../deps"
import { getRenderJob } from "../../render/jobs"
import { requestCaptureCancel } from "../../render/resampling"
import { validateProcedureCall } from "../../runtime/procedures"

const RUNTIME_VERIFY_TIMEOUT_MS = 2_000

function previewResult(statement: CallStatement): Record<string, unknown> {
    return {
        status: "preview",
        operation: statement.procedure,
        effect: "runtime",
        undoable: "none",
        requiresConfirmation: true,
        args: statement.args,
        note: "preview does not send any OSC message.",
    }
}

function confirmRequired(statement: CallStatement): Record<string, unknown> {
    return {
        status: "confirm_required",
        operation: statement.procedure,
        effect: "runtime",
        undoable: "none",
        requiresConfirmation: true,
        hint: "Re-run with confirm:true to execute this runtime procedure.",
    }
}

export async function executeCall(
    deps: ServerDeps,
    statement: CallStatement,
    preview: boolean | undefined,
    confirm: boolean | undefined,
): Promise<Record<string, unknown>> {
    validateProcedureCall(statement.procedure, statement.args)
    if (preview === true) {
        return previewResult(statement)
    }
    if (confirm !== true) {
        return confirmRequired(statement)
    }
    try {
        return await executeProcedure(deps, statement)
    } catch (error) {
        deps.log.error("CALL failed", { procedure: statement.procedure, error: String(error) })
        return { ...toMcpError(error), status: "error" }
    }
}

async function executeProcedure(
    deps: ServerDeps,
    statement: CallStatement,
): Promise<Record<string, unknown>> {
    const locks = deps.runtime.locks
    switch (statement.procedure) {
        case "transport.play": {
            locks.assertTransportFree("transport.play")
            const transport = deps.runtime.requireTransport()
            transport.play()
            await transport.waitForPlaying(RUNTIME_VERIFY_TIMEOUT_MS)
            return runtimeOk(statement.procedure)
        }
        case "transport.stop": {
            locks.assertTransportFree("transport.stop")
            const transport = deps.runtime.requireTransport()
            transport.stop()
            await transport.waitForStopped(RUNTIME_VERIFY_TIMEOUT_MS)
            return runtimeOk(statement.procedure)
        }
        case "transport.seek": {
            locks.assertTransportFree("transport.seek")
            const beats = statement.args[0]
            if (typeof beats !== "number") {
                throw new BadRequestError("transport.seek requires a numeric beat position")
            }
            const transport = deps.runtime.requireTransport()
            await transport.seek(beats)
            return runtimeOk(statement.procedure)
        }
        case "render.cancel": {
            const job_id = statement.args[0]
            if (typeof job_id !== "string") {
                throw new BadRequestError("render.cancel requires a jobId string")
            }
            const job = getRenderJob(job_id)
            if (job === undefined) {
                throw new NotFoundError(`Render job "${job_id}" was not found`)
            }
            const accepted = requestCaptureCancel(job_id)
            return {
                status: "ok",
                operation: statement.procedure,
                effect: "runtime",
                undoable: "none",
                verified: true,
                jobId: job_id,
                jobStatus: job.status,
                cancelAccepted: accepted,
                note: accepted
                    ? "Cancellation accepted; poll the RenderJob for stop and cleanup completion."
                    : "Job is not an active Main capture.",
            }
        }
        default:
            // validateProcedureCall で到達しないが、型の網羅性のために残す。
            throw new BadRequestError(`Procedure "${statement.procedure}" is not implemented`)
    }
}

function runtimeOk(operation: string): Record<string, unknown> {
    return {
        status: "ok",
        operation,
        effect: "runtime",
        undoable: "none",
        verified: true,
    }
}
