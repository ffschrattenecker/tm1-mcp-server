import { z } from "zod";
import type { ObjectSecurityRight } from "../../types.js";
import {
  inspectEffectiveSecurity,
  type SecurityInspectionResult,
  type SecuritySection,
} from "../../lib/security-inspector.js";
import {
  FORMAT_SCHEMA,
  columnsOf,
  payloadResponse,
  renderTable,
} from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { SecurityInspectionResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

function renderSection(title: string, sec: SecuritySection): string[] {
  const lines = [`### ${title}`];
  if (sec.error) {
    lines.push("", `> Error: ${sec.error}`);
    return lines;
  }
  if (!sec.securityCubeExists && sec.items.length === 0) {
    lines.push("", "_Security cube not present._");
    return lines;
  }
  const cols = columnsOf<ObjectSecurityRight>([
    "objectName",
    "effective",
    {
      header: "grantedBy",
      get: (r) => r.grantedBy.join(", "),
    },
    {
      header: "byGroup",
      get: (r) =>
        Object.entries(r.byGroup)
          .map(([g, v]) => `${g}:${v}`)
          .join(", "),
    },
  ]);
  lines.push("", renderTable(sec.items, cols));
  if (sec.truncated) {
    lines.push("", "_(truncated to limit)_");
  }
  return lines;
}

function renderSecurityMarkdown(p: SecurityInspectionResult): string {
  const lines = [
    `## Effective Security: ${p.user.name}`,
    "",
    `Groups: ${p.user.groups.length > 0 ? p.user.groups.join(", ") : "(none)"} · isAdmin: ${p.user.isAdmin}`,
  ];
  if (p.warnings?.length) {
    lines.push("", ...p.warnings.map((w) => `> ${w}`));
  }
  if (p.cubes) lines.push("", ...renderSection("Cubes", p.cubes));
  if (p.dimensions)
    lines.push("", ...renderSection("Dimensions", p.dimensions));
  if (p.elements)
    lines.push(
      "",
      ...renderSection(
        `Elements (${p.elements.dimensionName ?? ""})`,
        p.elements,
      ),
    );
  if (p.processes) lines.push("", ...renderSection("Processes", p.processes));
  return lines.join("\n");
}

export const registerInspectSecurity = defineTool({
  name: "tm1_inspect_security",
  description: [
    "Inspect effective TM1 security rights for a user (or the current ActiveUser) across groups, cubes, dimensions, elements, and processes.",
    "Resolves additive group precedence (NONE < READ < WRITE < RESERVE < LOCK < ADMIN) and flags }CellSecurity / }SecurityOverlayGlobal cubes.",
  ],
  annotations: READ_ONLY,
  output: SecurityInspectionResultSchema,
  input: {
    userName: z
      .string()
      .optional()
      .describe(
        "TM1 user name to inspect. Omit to inspect the current authenticated ActiveUser.",
      ),
    cubeName: z
      .string()
      .optional()
      .describe("Inspect rights for this specific cube."),
    dimensionName: z
      .string()
      .optional()
      .describe(
        "Inspect rights for this dimension and its }ElementSecurity_<dim> cube.",
      ),
    elementNames: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        "Optional specific element names within dimensionName to inspect.",
      ),
    processName: z
      .string()
      .optional()
      .describe("Inspect rights for this specific TI process."),
    includeAllObjects: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Inspect all non-control cubes, dimensions, and processes (default true when no specific object is named).",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe("Max objects per section when listing all objects (1–500)."),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    {
      userName,
      cubeName,
      dimensionName,
      elementNames,
      processName,
      includeAllObjects,
      limit,
      format,
    },
    tm1Client,
  ) => {
    const result = await inspectEffectiveSecurity(tm1Client, {
      userName,
      cubeName,
      dimensionName,
      elementNames,
      processName,
      includeAllObjects,
      limit,
    });
    return payloadResponse(result, format, renderSecurityMarkdown);
  },
});
