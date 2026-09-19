/**
 * Every string, name and number the Export menu shows (T11.10, Design §14.6, atlas tab 12).
 *
 * Pure: no DOM, no store, no engine. The menu renders what is here, the store's export slice writes
 * what is here, and the tests assert against it, so the wording cannot drift between the three.
 *
 * Two rules from the brief live in this file:
 *
 * 1. **What carries the lines.** `Copy as unified diff`, `Save as .patch` and the snapshot contain
 *    the changed source; the two list items contain path names and counts only. Only the first
 *    three go through the secret gate (`carriesLines`).
 * 2. **What is masked.** Design §14.3 masks a finding *diffgit itself writes down*. The patch and
 *    the snapshot bodies are the user's own lines, reproduced verbatim — masking them would produce
 *    a patch `git apply` rejects — so the gate, not a rewrite, is their protection. The two list
 *    items are text diffgit authors, so they run through `redactFindings` before they are copied.
 */
import type { FileStats } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { filePathOf } from "../treeModel";

/** The five rows of Design §14.6, in the order the menu lists them. */
export type ExportKind =
  | "copy-patch"
  | "save-patch"
  | "snapshot"
  | "copy-list"
  | "copy-stats"
  | "file-patch"
  | "commit-patch";

export const EXPORT_LABELS: Record<ExportKind, string> = {
  "copy-patch": "Copy as unified diff",
  "save-patch": "Save as .patch",
  snapshot: "Save review snapshot (.html)",
  "copy-list": "Copy file list as Markdown",
  "copy-stats": "Copy stats line",
  "file-patch": "Export this file as .patch",
  "commit-patch": "Export as .patch",
};

/** The menu's two groups plus the two list rows (atlas tab 12's headings). */
export const MENU_KINDS: readonly ExportKind[] = [
  "copy-patch",
  "save-patch",
  "snapshot",
  "copy-list",
  "copy-stats",
];

/** True when this export reproduces the changed lines, and therefore needs the secret gate. */
export function carriesLines(kind: ExportKind): boolean {
  return kind !== "copy-list" && kind !== "copy-stats";
}

export const MENU_TITLE = "Export";
export const SNAPSHOT_NOTE =
  "A self-contained page with these diffs, the file tree and viewed ticks. It contains the source lines shown here; no git, no server and no network are needed to open it.";
export const NOTHING_TO_EXPORT = "Nothing matches the filter.";
export const PREPARING = "Working out sizes…";

/** Header row of the menu: what the items would export (atlas: "This comparison · 6 files"). */
export function scopeLabel(total: number, visible: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  if (visible === total) return `This comparison · ${n(total)} ${total === 1 ? "file" : "files"}`;
  return `Filtered · ${n(visible)} of ${n(total)} files`;
}

// ---- The secret gate (Design §14.3, contracts `<!-- T11.9 -->` `selectSecretGate`) ----

export const GATE_CONFIRM = "Export anyway";
export const GATE_CANCEL = "Cancel";

/**
 * The gate's question. `scanned: false` is *unknown*, never clean: a diff whose scan has not
 * finished is gated with wording that says so instead of a count it does not have.
 */
export function gateQuestion(gate: { scanned: boolean; count: number; total: number }): string {
  if (!gate.scanned) return "This comparison has not been scanned for secrets yet — export anyway?";
  const n = gate.total.toLocaleString("en-US");
  const noun = gate.total === 1 ? "possible secret" : "possible secrets";
  return `${n} ${noun} in this diff — export anyway?`;
}

/** The one-line warning the menu shows in place of the three line-carrying rows. */
export function gateSummary(gate: { scanned: boolean; count: number; total: number }): string {
  if (!gate.scanned) return "Not scanned for secrets yet";
  const n = gate.total.toLocaleString("en-US");
  return `${n} possible ${gate.total === 1 ? "secret" : "secrets"} in this diff`;
}

/** Said once the user has confirmed: the next export of this diff goes straight through. */
export const GATE_CONFIRMED = "Secret gate overridden for this comparison.";

/**
 * Printed inside a snapshot that was written past the gate. The snapshot is a document that leaves
 * the machine, so the finding count travels with it instead of staying in the window that made it.
 */
export function exportedPastGate(gate: { scanned: boolean; count: number; total: number }): string {
  if (!gate.scanned)
    return "This snapshot was exported before the secret scan finished. Check it before sharing it.";
  const n = gate.total.toLocaleString("en-US");
  const noun = gate.total === 1 ? "possible secret" : "possible secrets";
  return `${n} ${noun} were found in these changes and are reproduced below. Rotate them and do not share this file.`;
}

// ---- File names ----

/** Characters no common filesystem accepts, plus the separators. Everything else survives. */
const ILLEGAL = /[/\\:*?"<>|]+/g;

/** Control characters, dropped rather than replaced (a regex for them is a lint failure). */
function stripControl(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * A safe file name component: path separators and reserved characters become `-`, runs collapse,
 * leading/trailing dots and dashes go. `·` and `…` are legal everywhere and are kept, because the
 * suggested name in Design §14.6 and atlas tab 12 is spelled with them.
 */
export function sanitiseName(name: string): string {
  const cleaned = stripControl(name).replace(ILLEGAL, "-").replace(/-{2,}/g, "-").trim();
  const trimmed = cleaned.replace(/^[.\-\s]+/, "").replace(/[.\-\s]+$/, "");
  return trimmed === "" ? "export" : trimmed;
}

/** `2026-09-19` in UTC, so the same diff exported twice in a row cannot be named two ways. */
export function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The suggested save name of Design §14.6: `<repo> · <from>…<to> · <date>.<ext>`. `label` is
 * `labelOf(diffSource)` with the spaces around the separator squeezed out, so the name stays short.
 */
export function exportFileName(
  repo: string,
  label: string,
  ext: "patch" | "html",
  at: number,
): string {
  const slug = label.replace(/\s+(…|\.\.)\s+/g, "$1").trim();
  const parts = [repo, slug, isoDate(at)].filter((p) => p !== "");
  return `${sanitiseName(parts.join(" · "))}.${ext}`;
}

/** `acme-web · src-a.txt · 2026-09-19.patch` — the per-file row of the FileHeader menu. */
export function filePatchName(repo: string, path: string, at: number): string {
  return `${sanitiseName([repo, path, isoDate(at)].join(" · "))}.patch`;
}

/** `acme-web · a1b2c3d · 2026-09-19.patch` — the CommitCard's `Export as .patch`. */
export function commitPatchName(repo: string, oid: string, at: number): string {
  return `${sanitiseName([repo, oid.slice(0, 7), isoDate(at)].join(" · "))}.patch`;
}

// ---- The two list exports ----

const WORD: Record<FileDiff["status"], string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  typechange: "type changed",
};

/** `+3 −1`, or `—` for a row that never gets a count (binary, over the gate, unreadable). */
export function countsOf(stats: FileStats | null | undefined): string {
  return stats ? `+${stats.additions} −${stats.deletions}` : "—";
}

/**
 * One checklist line per file — the thing a reviewer pastes into a pull request description. A file
 * already ticked as viewed is pasted ticked.
 */
export function fileListMarkdown(
  files: readonly FileDiff[],
  statsOf: (f: FileDiff) => FileStats | null,
  viewedOf: (f: FileDiff) => boolean,
): string {
  return files
    .map((f) => {
      const rename =
        (f.status === "renamed" || f.status === "copied") && f.oldPath
          ? ` (from \`${f.oldPath}\`)`
          : "";
      return `- [${viewedOf(f) ? "x" : " "}] \`${filePathOf(f)}\` — ${WORD[f.status]}${rename}, ${countsOf(statsOf(f))}`;
    })
    .join("\n");
}

/** `6 files, +148 −37` (atlas tab 12). */
export function statsLine(
  files: readonly FileDiff[],
  statsOf: (f: FileDiff) => FileStats | null,
): string {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    const st = statsOf(f);
    if (st) {
      additions += st.additions;
      deletions += st.deletions;
    }
  }
  const n = (x: number) => x.toLocaleString("en-US");
  return `${n(files.length)} ${files.length === 1 ? "file" : "files"}, +${n(additions)} −${n(deletions)}`;
}

// ---- Outcomes (toasts) ----

export function savedNote(name: string): string {
  return `Saved ${name} to your downloads.`;
}
export function copiedNote(kind: ExportKind): string {
  return `${EXPORT_LABELS[kind]}: copied to the clipboard.`;
}
export const COPY_FAILED = "Could not write to the clipboard — it is blocked in this context.";
export function exportFailed(message: string): string {
  return `Export failed: ${message}`;
}
