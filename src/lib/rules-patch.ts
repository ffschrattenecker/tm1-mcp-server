// Find/replace patching of a cube's rule text, so a one-line change to a
// 16 KB rule file does not mean shipping all 16 KB back through a tool call.
//
// Every `find` must occur exactly once in the text as it stands when that edit
// runs (edits apply in order). Zero matches means the caller's picture of the
// file is stale; two or more means the edit is ambiguous — both are rejected
// with the count, and nothing is written, because the patch is applied in
// memory first.
//
// Line endings: TM1 stores rules with CRLF, while a caller quoting a
// get_cube_rules slice sends LF. Matching runs on LF-normalized text, and the
// result is written back with the line ending the stored text used.
import { TM1Error, TM1ErrorCode } from "../types.js";

export interface RulesEdit {
  find: string;
  replace: string;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function applyRulesPatch(current: string, edits: RulesEdit[]): string {
  const crlf = current.includes("\r\n");
  let text = current.replace(/\r\n/g, "\n");
  edits.forEach((edit, i) => {
    const find = edit.find.replace(/\r\n/g, "\n");
    if (find === "") {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `edits[${i}].find is empty.`,
      });
    }
    const at: number[] = [];
    for (let p = text.indexOf(find); p !== -1; p = text.indexOf(find, p + 1))
      at.push(p);
    if (at.length !== 1) {
      const where =
        at.length > 1
          ? ` at lines ${at
              .slice(0, 10)
              .map((p) => lineOf(text, p))
              .join(", ")}${at.length > 10 ? ", …" : ""}`
          : "";
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `edits[${i}].find matches ${at.length} times${where}; it must match exactly once. Nothing was written.`,
        hint:
          at.length === 0
            ? "Re-read the current text with tm1_get_cube_rules (lineRange) and quote it verbatim — earlier edits in the same call apply first."
            : "Extend find with neighbouring lines until it is unique.",
        details: JSON.stringify({ edit: i, matches: at.length }),
      });
    }
    const p = at[0]!;
    text =
      text.slice(0, p) +
      edit.replace.replace(/\r\n/g, "\n") +
      text.slice(p + find.length);
  });
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}
