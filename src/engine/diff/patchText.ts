/**
 * Git-format unified diff text for the rows of the current `DiffResult` (T10.10, atlas tab 12).
 *
 * Pure rendering: the session loads both sides and runs `describeFile`, this module turns those
 * descriptions into the bytes `git apply` accepts. Nothing here reads the repository, so every form
 * — mode changes, renames with a similarity index, `/dev/null` sides, the binary stub, the missing
 * final newline — is testable from a literal `FileDiff` plus a literal `FileDescription`.
 *
 * Two deliberate choices about the header:
 *
 * 1. **Object names are spelled in full** (git's `--full-index`). git abbreviates by default, but
 *    `git apply` refuses a binary row "without full index line", and a binary row is exactly how a
 *    binary or over-10-MB file is carried here — git reconstructs the postimage by reading the blob
 *    out of the object database. Abbreviating would make those rows unappliable for no gain.
 * 2. **The hunks are ours, not git's.** Myers with a three-line context produces the same *content*
 *    as git's but not always the same boundaries (git runs an indent heuristic afterwards), which is
 *    why `tasks/README.md` "Parity scope" never asserts hunk boundaries. The patch therefore applies
 *    and round-trips, but is not byte-equal to `git diff` on every file.
 */
import type { Hunk, HunkModel } from "../api";
import type { FileDiff, Oid } from "../types";
import type { FileDescription } from "./textDiff";

/** The absent side of an `index` line (git prints an abbreviation of this for added/deleted rows). */
export const NULL_OID = "0".repeat(40);

/** One row of the patch: the diff entry, what `describeFile` made of it, and the two blob names. */
export interface PatchRow {
  file: FileDiff;
  description: FileDescription;
  /** Full 40-hex blob name, or null when the side is absent or its content was never hashed. */
  oldOid: Oid | null;
  newOid: Oid | null;
}

const C_ESCAPES: Record<number, string> = {
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
  34: '\\"',
  92: "\\\\",
};

const encoder = new TextEncoder();

/**
 * git's `quote_c_style` with `core.quotepath` at its default: a path that needs no escaping is
 * printed as-is, anything else is double-quoted with C escapes, non-ASCII bytes as `\ooo` octal.
 */
export function quotePath(path: string): string {
  const bytes = encoder.encode(path);
  let needsQuotes = false;
  let out = "";
  for (const b of bytes) {
    const esc = C_ESCAPES[b];
    if (esc !== undefined) {
      needsQuotes = true;
      out += esc;
    } else if (b < 0x20 || b >= 0x7f) {
      needsQuotes = true;
      out += `\\${b.toString(8).padStart(3, "0")}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return needsQuotes ? `"${out}"` : path;
}

function octalMode(mode: number): string {
  return (mode >>> 0).toString(8).padStart(6, "0");
}

/** `@@ -a,b +c,d @@`, with git's `,1` elision for a one-line side. */
export function hunkHeader(h: Hunk): string {
  const old = h.oldCount === 1 ? `${h.oldStart}` : `${h.oldStart},${h.oldCount}`;
  const next = h.newCount === 1 ? `${h.newStart}` : `${h.newStart},${h.newCount}`;
  return `@@ -${old} +${next} @@`;
}

const NO_NEWLINE = "\\ No newline at end of file";

/** True when the side has content whose last line carries no terminating newline. */
function lacksFinalNewline(text: string | null): boolean {
  return text !== null && text.length > 0 && !text.endsWith("\n");
}

function renderHunks(model: HunkModel, oldNoEol: boolean, newNoEol: boolean): string[] {
  const out: string[] = [];
  for (const h of model.hunks) {
    out.push(hunkHeader(h));
    for (const l of h.lines) {
      out.push(`${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`);
      // A context line that is last on both sides gets the marker once, which is what git does:
      // with an exact (non `-w`) diff the two sides cannot be equal unless their EOL state is too.
      const lastOld = l.type !== "add" && oldNoEol && l.old === model.oldLines;
      const lastNew = l.type !== "del" && newNoEol && l.new === model.newLines;
      if (lastOld || lastNew) out.push(NO_NEWLINE);
    }
  }
  return out;
}

/**
 * Does the row carry content, or is it a pure rename / pure mode change? git stops after the
 * `rename to` or `new mode` line in that case and emits no `index`, no `---`/`+++` and no hunks.
 */
function hasContent(row: PatchRow): boolean {
  const c = row.description.classification;
  if (c.binary || c.huge)
    return row.oldOid === null || row.newOid === null || row.oldOid !== row.newOid;
  return row.description.hunks !== null && row.description.hunks.hunks.length > 0;
}

/** The lines of one file's section, in git's order. */
export function patchSection(row: PatchRow): string[] {
  const f = row.file;
  const oldPath = (f.oldPath ?? f.newPath) as string;
  const newPath = (f.newPath ?? f.oldPath) as string;
  const c = row.description.classification;
  const added = f.oldMode === null;
  const deleted = f.newMode === null;
  const out: string[] = [];

  if (c.huge) {
    // Garbage before `diff --git` is skipped by `git apply`'s header scan, so the note travels with
    // the patch without making it unappliable (the row itself applies from the object database).
    out.push(
      `# diffgit: ${newPath} is larger than 10 MB; the patch records its object names only.`,
    );
  }
  out.push(`diff --git ${quotePath(`a/${oldPath}`)} ${quotePath(`b/${newPath}`)}`);

  if (added && f.newMode !== null) out.push(`new file mode ${octalMode(f.newMode)}`);
  else if (deleted && f.oldMode !== null) out.push(`deleted file mode ${octalMode(f.oldMode)}`);
  else if (f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) {
    out.push(`old mode ${octalMode(f.oldMode)}`);
    out.push(`new mode ${octalMode(f.newMode)}`);
  }
  if (f.status === "renamed" || f.status === "copied") {
    const verb = f.status === "copied" ? "copy" : "rename";
    out.push(`similarity index ${f.similarity ?? 100}%`);
    out.push(`${verb} from ${quotePath(oldPath)}`);
    out.push(`${verb} to ${quotePath(newPath)}`);
  }

  if (!hasContent(row)) return out;

  const sameMode = f.oldMode !== null && f.oldMode === f.newMode;
  out.push(
    `index ${row.oldOid ?? NULL_OID}..${row.newOid ?? NULL_OID}` +
      (sameMode ? ` ${octalMode(f.oldMode as number)}` : ""),
  );

  const aLabel = added ? "/dev/null" : quotePath(`a/${oldPath}`);
  const bLabel = deleted ? "/dev/null" : quotePath(`b/${newPath}`);
  if (c.binary || c.huge) {
    out.push(`Binary files ${aLabel} and ${bLabel} differ`);
    return out;
  }
  out.push(`--- ${aLabel}`);
  out.push(`+++ ${bLabel}`);
  out.push(
    ...renderHunks(
      row.description.hunks as HunkModel,
      lacksFinalNewline(row.description.oldText),
      lacksFinalNewline(row.description.newText),
    ),
  );
  return out;
}

/**
 * The whole patch, rows in the order they were handed over (the session keeps `DiffResult` order).
 * Ends with a newline when there is anything at all, like `git diff`; an empty row list is `""`.
 */
export function patchText(rows: PatchRow[]): string {
  const lines: string[] = [];
  for (const row of rows) lines.push(...patchSection(row));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
