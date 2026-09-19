/**
 * 限定 CALL の許可手続きレジストリと引数の型検査。
 * 任意コード・動的関数名・複数文は受理しない。SDK 呼び出しを伴う実行は tools/do/call.ts が担う。
 */

import type { ProcedureArgument } from "@live-connector/cypher"
import { BadRequestError, HybridError } from "@live-connector/error"

/** 手続き引数として許可するリテラル型。 */
export type ProcedureArgType = "string" | "number" | "boolean" | "null"

/** 許可手続きの仕様。 */
export type ProcedureSpec = {
    name: string
    arg_types: ProcedureArgType[]
    effect: "runtime"
    undoable: "none"
    requires_confirm: true
}

/** 許可する CALL 手続き。ここにない名前は PROCEDURE_NOT_ALLOWED。 */
export const ALLOWED_PROCEDURES: readonly ProcedureSpec[] = [
    {
        name: "transport.play",
        arg_types: [],
        effect: "runtime",
        undoable: "none",
        requires_confirm: true,
    },
    {
        name: "transport.stop",
        arg_types: [],
        effect: "runtime",
        undoable: "none",
        requires_confirm: true,
    },
    {
        name: "transport.seek",
        arg_types: ["number"],
        effect: "runtime",
        undoable: "none",
        requires_confirm: true,
    },
    {
        name: "render.cancel",
        arg_types: ["string"],
        effect: "runtime",
        undoable: "none",
        requires_confirm: true,
    },
]

export function findAllowedProcedures(): ProcedureSpec[] {
    return [...ALLOWED_PROCEDURES]
}

export function findProcedureSpec(procedure: string): ProcedureSpec | undefined {
    return ALLOWED_PROCEDURES.find((spec) => spec.name === procedure)
}

function argTypeOf(value: ProcedureArgument): ProcedureArgType {
    if (value === null) {
        return "null"
    }
    if (typeof value === "number") {
        return "number"
    }
    if (typeof value === "boolean") {
        return "boolean"
    }
    return "string"
}

/** 手続き名と引数を検査し、適合する仕様を返す。 */
export function validateProcedureCall(procedure: string, args: ProcedureArgument[]): ProcedureSpec {
    const spec = findProcedureSpec(procedure)
    if (spec === undefined) {
        throw new HybridError(
            "PROCEDURE_NOT_ALLOWED",
            `Procedure "${procedure}" is not allowed`,
            400,
            {
                hint: `Allowed procedures: ${ALLOWED_PROCEDURES.map((entry) => entry.name).join(", ")}`,
            },
        )
    }
    if (args.length !== spec.arg_types.length) {
        throw new BadRequestError(
            `Procedure "${procedure}" expects ${spec.arg_types.length} argument(s), received ${args.length}`,
        )
    }
    for (const [index, expected] of spec.arg_types.entries()) {
        const value = args[index]
        if (value === undefined) {
            throw new BadRequestError(`Procedure "${procedure}" is missing argument ${index}`)
        }
        const actual = argTypeOf(value)
        if (actual !== expected) {
            throw new BadRequestError(
                `Procedure "${procedure}" argument ${index} expects ${expected}, received ${actual}`,
            )
        }
    }
    return spec
}
