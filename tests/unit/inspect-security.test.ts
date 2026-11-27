import { describe, it, expect, vi } from "vitest";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import {
  inspectEffectiveSecurity,
  resolveEffectiveRight,
} from "../../src/lib/security-inspector.js";
import { registerInspectSecurity } from "../../src/tools/operations/inspect-security.js";
import { captureParsedTool } from "../helpers/client-harness.js";
import { SecurityInspectionResultSchema } from "../../src/tools/schemas/items.js";

describe("resolveEffectiveRight", () => {
  it("resolves additive group precedence (NONE < READ < WRITE < RESERVE < LOCK < ADMIN)", () => {
    expect(
      resolveEffectiveRight(
        { G1: "NONE", G2: "READ", G3: "WRITE" },
        { isAdmin: false },
      ),
    ).toEqual({ effective: "WRITE", grantedBy: ["G3"] });

    expect(
      resolveEffectiveRight(
        { G1: "WRITE", G2: "LOCK", G3: "LOCK" },
        { isAdmin: false },
      ),
    ).toEqual({ effective: "LOCK", grantedBy: ["G2", "G3"] });

    expect(resolveEffectiveRight({ G1: "NONE" }, { isAdmin: false })).toEqual({
      effective: "NONE",
      grantedBy: [],
    });

    expect(resolveEffectiveRight({ G1: "READ" }, { isAdmin: true })).toEqual({
      effective: "ADMIN",
      grantedBy: ["ADMIN"],
    });
  });
});

describe("inspectEffectiveSecurity + tm1_inspect_security", () => {
  it("inspects ActiveUser when userName omitted, resolves cube/dimension/element/process rights, and flags CellSecurity/SecurityOverlay", async () => {
    const getUser = vi.fn().mockResolvedValue({
      Name: "alice",
      FriendlyName: "Alice",
      Type: "User",
      Enabled: true,
      Groups: [{ Name: "Analysts" }, { Name: "Planners" }],
    });
    const exists = vi.fn().mockImplementation(async (cube: string) => {
      if (cube === "}ElementSecurity_Region") return false;
      return true;
    });
    const executeMdx = vi.fn().mockImplementation(async (mdx: string) => {
      if (mdx.includes("[}CubeSecurity]")) {
        return {
          axes: [
            {
              tuples: [
                { members: [{ name: "Analysts" }] },
                { members: [{ name: "Planners" }] },
              ],
            },
            { tuples: [{ members: [{ name: "Sales" }] }] },
          ],
          cells: [
            { value: "READ", formattedValue: "READ" },
            { value: "WRITE", formattedValue: "WRITE" },
          ],
          totalCellCount: 2,
        };
      }
      if (mdx.includes("[}DimensionSecurity]")) {
        return {
          axes: [
            {
              tuples: [
                { members: [{ name: "Analysts" }] },
                { members: [{ name: "Planners" }] },
              ],
            },
            { tuples: [{ members: [{ name: "Region" }] }] },
          ],
          cells: [
            { value: "READ", formattedValue: "READ" },
            { value: "READ", formattedValue: "READ" },
          ],
          totalCellCount: 2,
        };
      }
      return {
        axes: [
          {
            tuples: [
              { members: [{ name: "Analysts" }] },
              { members: [{ name: "Planners" }] },
            ],
          },
          { tuples: [{ members: [{ name: "Load.Sales" }] }] },
        ],
        cells: [
          { value: "", formattedValue: "" },
          { value: "READ", formattedValue: "READ" },
        ],
        totalCellCount: 2,
      };
    });

    const client = {
      security: { getUser },
      cubes: { exists },
      cells: { executeMdx },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerInspectSecurity, client);
    const res = (await call({
      cubeName: "Sales",
      dimensionName: "Region",
      elementNames: ["EU", "US"],
      processName: "Load.Sales",
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(res.content[0].text);
    expect(() => SecurityInspectionResultSchema.parse(payload)).not.toThrow();
    expect(getUser).toHaveBeenCalledWith(undefined);
    expect(payload.cubes.items[0]).toMatchObject({
      objectName: "Sales",
      effective: "WRITE",
      grantedBy: ["Planners"],
      cellSecurityActive: true,
      securityOverlayActive: true,
    });
    expect(payload.elements.securityCubeExists).toBe(false);
    expect(payload.elements.items[0]).toMatchObject({
      objectName: "EU",
      effective: "UNRESTRICTED",
    });
    expect(payload.processes.items[0]).toMatchObject({
      objectName: "Load.Sales",
      effective: "READ",
      grantedBy: ["Planners"],
    });
    expect(
      payload.warnings.some((w: string) => w.includes("}CellSecurity_Sales")),
    ).toBe(true);
    expect(
      payload.warnings.some((w: string) =>
        w.includes("}SecurityOverlayGlobal_Sales"),
      ),
    ).toBe(true);
  });

  it("handles permission denied reading control security cube without crashing", async () => {
    const client = {
      security: {
        getUser: vi.fn().mockResolvedValue({
          Name: "bob",
          Groups: [{ Name: "Viewers" }],
        }),
      },
      cubes: {
        exists: vi.fn().mockRejectedValue(
          new TM1Error({
            code: TM1ErrorCode.PERMISSION_DENIED,
            message: "ObjectSecurityNoReadRights",
          }),
        ),
      },
      cells: { executeMdx: vi.fn() },
    } as unknown as TM1Client;

    const result = await inspectEffectiveSecurity(client, {
      userName: "bob",
      cubeName: "Sales",
    });
    expect(result.cubes?.error).toContain("Permission denied");
    expect(result.cubes?.items).toEqual([]);
  });
});
