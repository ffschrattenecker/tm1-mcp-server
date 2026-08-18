import { describe, it, expect } from "vitest";
import { dataSourceSchema } from "../../src/lib/process-parts-schema.js";

// The exact field set a real ODBC source carries on the wire. Measured
// 2026-08-18 against two TM1 11.8.02900.8 instances: 29 ODBC processes, every
// one of them exposing these seven keys and nothing else.
const ODBC_WIRE_FIELDS = {
  type: "ODBC" as const,
  dataSourceNameForServer: "ProbeDsn",
  dataSourceNameForClient: "ProbeDsn",
  userName: "probe_user",
  password: "probe-secret",
  query: "SELECT 1 AS x",
  usesUnicode: true,
};

describe("dataSourceSchema", () => {
  it("accepts every field a real ODBC source has", () => {
    const parsed = dataSourceSchema.parse(ODBC_WIRE_FIELDS);
    expect(parsed).toEqual(ODBC_WIRE_FIELDS);
  });

  // oDBCConnection was in our model from the initial release and is not a TM1
  // field: 11.8 answers a write with 400 'unprocessed properties were
  // "oDBCConnection"', v12 takes the write and never returns the field. Strict
  // parsing turns both server behaviours into one named client-side error.
  it("rejects oDBCConnection, which TM1 has never had", () => {
    const result = dataSourceSchema
      .strict()
      .safeParse({ ...ODBC_WIRE_FIELDS, oDBCConnection: "DRIVER={x};" });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("oDBCConnection");
  });

  it("is non-strict by default, so a read path can carry unknown server keys", () => {
    const parsed = dataSourceSchema.parse({
      ...ODBC_WIRE_FIELDS,
      someFutureField: "x",
    });
    expect(parsed).not.toHaveProperty("someFutureField");
  });
});
