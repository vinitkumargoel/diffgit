import type { HunkModel } from "../../src/engine/api";

/**
 * HunkModel → a unified-diff patch, the input DiffFile expects (one string; hunks passed as
 * separate strings without `---`/`+++` headers are parsed as empty — verified in probe.ts).
 */
export function hunkModelToDiffList(model: HunkModel, oldName = "a", newName = "b"): string[] {
  const out = [`--- a/${oldName}`, `+++ b/${newName}`];
  for (const h of model.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    for (const l of h.lines)
      out.push(`${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`);
  }
  return [out.join("\n")];
}
