import { describe, expect, it } from "vitest";
import {
  formatTm1ErrorResult,
  normalizeErrorResult,
  withToolHint,
} from "../../src/tools/error-format.js";
import { TM1Error, TM1ErrorCode, hintForCode } from "../../src/types.js";

function parsePayload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("formatTm1ErrorResult", () => {
  it("wraps a TM1Error into a uniform isError result with hint", () => {
    const err = new TM1Error({
      code: TM1ErrorCode.NOT_FOUND,
      message: "Cube not found",
      httpStatus: 404,
      endpoint: "/api/v1/Cubes('Sales')",
    });

    const result = formatTm1ErrorResult(err);
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe("NOT_FOUND");
    expect(payload.message).toBe("Cube not found");
    expect(payload.httpStatus).toBe(404);
    expect(payload.endpoint).toBe("/api/v1/Cubes('Sales')");
    expect(payload.hint).toContain("tm1_rest_read");
  });

  it("wraps a generic Error with the default TM1_ERROR code and hint", () => {
    const result = formatTm1ErrorResult(new Error("boom"));
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe("TM1_ERROR");
    expect(payload.message).toBe("boom");
    expect(typeof payload.hint).toBe("string");
    expect(payload.hint.length).toBeGreaterThan(0);
  });

  it("handles non-Error throws via String coercion", () => {
    const payload = parsePayload(formatTm1ErrorResult("string thrown"));
    expect(payload.message).toBe("string thrown");
    expect(payload.code).toBe("TM1_ERROR");
  });
});

describe("normalizeErrorResult", () => {
  it("adds hint to JSON payloads that already carry a code", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: "PERMISSION_DENIED", message: "no" }),
        },
      ],
    });
    const payload = parsePayload(result);

    expect(payload.code).toBe("PERMISSION_DENIED");
    expect(payload.hint).toContain("rights");
  });

  it("preserves extra fields attached by tools (e.g. partialApply)", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "CONFLICT",
            message: "version mismatch",
            partialApply: true,
            failedStep: "compile",
          }),
        },
      ],
    });
    const payload = parsePayload(result);

    expect(payload.partialApply).toBe(true);
    expect(payload.failedStep).toBe("compile");
    expect(payload.hint.length).toBeGreaterThan(0);
  });

  it("does not duplicate the payload into message when message is absent", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCount: 2,
            errors: ["a", "b"],
          }),
        },
      ],
    });
    const payload = parsePayload(result);

    expect(payload.code).toBe("TM1_ERROR");
    expect(payload.errorCount).toBe(2);
    expect(payload.message).not.toContain("errorCount");
    expect(payload.message.length).toBeLessThan(100);
  });

  it("wraps plain-text error bodies into the uniform shape", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [{ type: "text", text: "TM1 error: kaputt" }],
    });
    const payload = parsePayload(result);

    expect(payload.code).toBe("TM1_ERROR");
    expect(payload.message).toBe("kaputt");
    expect(payload.hint).toBeTruthy();
  });

  it("returns the result untouched when content is missing or non-text", () => {
    const empty = { isError: true, content: [] };
    expect(normalizeErrorResult(empty)).toEqual(empty);
  });

  it("masks secret values in plain-text error results", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: "TM1 error: ODBC failed PWD=hunter2;UID=admin; token=tok123",
        },
      ],
    });
    const payload = parsePayload(result);
    expect(payload.message).not.toContain("hunter2");
    expect(payload.message).not.toContain("admin");
    expect(payload.message).not.toContain("tok123");
    expect(payload.message).toContain("PWD=***");
    expect(payload.message).toContain("UID=***");
    expect(payload.message).toContain("token=***");
  });

  it("masks secret values and secret-named fields in JSON error results without mangling hints", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "AUTH_FAILED",
            message: "Login failed with password=mysecret",
            details: "api_key=abc999",
            processErrorStatus: "ODBCOpen PWD=secret123;",
            password: "raw-password",
            errorLog: {
              content: "Error: token=secretTok",
            },
          }),
        },
      ],
    });
    const payload = parsePayload(result);
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("mysecret");
    expect(wire).not.toContain("abc999");
    expect(wire).not.toContain("secret123");
    expect(wire).not.toContain("raw-password");
    expect(wire).not.toContain("secretTok");
    expect(payload.password).toBe("***");
    expect(payload.errorLog.content).toBe("Error: token=***");
    expect(payload.hint).toContain("TM1_USER and the password: in");
  });
});

describe("withToolHint", () => {
  const TOOL_HINT = "Tool-level advice.";

  async function caught(p: Promise<unknown>): Promise<TM1Error> {
    try {
      await p;
    } catch (e) {
      return e as TM1Error;
    }
    throw new Error("expected a rejection");
  }

  it("keeps an error's own hint instead of replacing it", async () => {
    const own = "Delete the entries first; an empty folder is deleted.";
    const err = await caught(
      withToolHint(
        Promise.reject(
          new TM1Error({
            code: TM1ErrorCode.UNSUPPORTED_OPERATION,
            message: "folder",
            hint: own,
          }),
        ),
        TOOL_HINT,
      ),
    );
    expect(err).toBeInstanceOf(TM1Error);
    expect(err.hint).toBe(own);
  });

  it("gives an error without a hint the tool's hint", async () => {
    const err = await caught(
      withToolHint(
        Promise.reject(
          new TM1Error({ code: TM1ErrorCode.NOT_FOUND, message: "missing" }),
        ),
        TOOL_HINT,
      ),
    );
    expect(err.hint).toBe(TOOL_HINT);
  });

  it("leaves a keep code's hint untouched when it has none", async () => {
    const err = await caught(
      withToolHint(
        Promise.reject(
          new TM1Error({ code: TM1ErrorCode.LOCK_TIMEOUT, message: "timeout" }),
        ),
        TOOL_HINT,
        [TM1ErrorCode.LOCK_TIMEOUT],
      ),
    );
    expect(err.hintOverride).toBeUndefined();
    expect(err.hint).toBe(hintForCode(TM1ErrorCode.LOCK_TIMEOUT));
  });

  it("leaves a keep code's own hint alone", async () => {
    const own = "Still running; do not re-run.";
    const err = await caught(
      withToolHint(
        Promise.reject(
          new TM1Error({
            code: TM1ErrorCode.CONNECTION_FAILED,
            message: "lost",
            hint: own,
          }),
        ),
        TOOL_HINT,
        [TM1ErrorCode.CONNECTION_FAILED],
      ),
    );
    expect(err.hint).toBe(own);
  });

  it("wraps a non-TM1 failure with the tool's hint", async () => {
    const err = await caught(
      withToolHint(Promise.reject(new Error("boom")), TOOL_HINT),
    );
    expect(err).toBeInstanceOf(TM1Error);
    expect(err.message).toBe("boom");
    expect(err.hint).toBe(TOOL_HINT);
  });
});
