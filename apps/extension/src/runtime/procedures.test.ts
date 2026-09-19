import { BadRequestError, HybridError } from "@live-connector/error"
import { describe, expect, it } from "vitest"
import { findAllowedProcedures, validateProcedureCall } from "./procedures"

describe("validateProcedureCall", () => {
    it("accepts allowed procedures with matching literal types", () => {
        expect(validateProcedureCall("transport.play", []).name).toBe("transport.play")
        expect(validateProcedureCall("transport.seek", [32]).name).toBe("transport.seek")
        expect(validateProcedureCall("render.cancel", ["render-1"]).name).toBe("render.cancel")
    })

    it("rejects an unknown procedure with PROCEDURE_NOT_ALLOWED", () => {
        try {
            validateProcedureCall("transport.rewind", [])
            throw new Error("expected a throw")
        } catch (error) {
            expect(error).toBeInstanceOf(HybridError)
            expect((error as HybridError).code).toBe("PROCEDURE_NOT_ALLOWED")
        }
    })

    it("rejects a wrong argument count", () => {
        expect(() => validateProcedureCall("transport.seek", [])).toThrow(BadRequestError)
        expect(() => validateProcedureCall("transport.play", [1])).toThrow(BadRequestError)
    })

    it("rejects a wrong argument type", () => {
        expect(() => validateProcedureCall("transport.seek", ["32"])).toThrow(BadRequestError)
        expect(() => validateProcedureCall("render.cancel", [1])).toThrow(BadRequestError)
    })

    it("marks every allowed procedure as runtime and non-undoable", () => {
        for (const spec of findAllowedProcedures()) {
            expect(spec.effect).toBe("runtime")
            expect(spec.undoable).toBe("none")
            expect(spec.requires_confirm).toBe(true)
        }
    })
})
