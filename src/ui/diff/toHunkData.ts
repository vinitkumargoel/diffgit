import type { ChangeData, DiffType, HunkData } from "react-diff-view";
import type { Hunk, HunkLine, HunkModel } from "../../engine/api";
import type { FileStatus } from "../../engine/types";

/** `@@ -a,b +c,d @@` for a hunk (react-diff-view shows `content` in its own header; we render ours). */
export function hunkHeader(
  h: Pick<Hunk, "oldStart" | "oldCount" | "newStart" | "newCount">,
): string {
  return `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
}

function toChange(l: HunkLine): ChangeData {
  switch (l.type) {
    case "add":
      return { type: "insert", isInsert: true, lineNumber: l.new ?? 0, content: l.text };
    case "del":
      return { type: "delete", isDelete: true, lineNumber: l.old ?? 0, content: l.text };
    default:
      return {
        type: "normal",
        isNormal: true,
        oldLineNumber: l.old ?? 0,
        newLineNumber: l.new ?? 0,
        content: l.text,
      };
  }
}

/**
 * Orders every run of changed lines as git does (deletions, then insertions) so the split view
 * pairs a removed line with its replacement; context lines keep their place.
 */
function normaliseLines(lines: readonly HunkLine[]): HunkLine[] {
  const out: HunkLine[] = [];
  let dels: HunkLine[] = [];
  let adds: HunkLine[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.type === "ctx") {
      flush();
      out.push(l);
    } else if (l.type === "del") dels.push(l);
    else adds.push(l);
  }
  flush();
  return out;
}

/** Engine `HunkModel` (T3.4) → react-diff-view hunks (ADR-001). */
export function toHunkData(model: HunkModel): HunkData[] {
  return model.hunks.map((h) => ({
    content: hunkHeader(h),
    oldStart: h.oldStart,
    oldLines: h.oldCount,
    newStart: h.newStart,
    newLines: h.newCount,
    changes: normaliseLines(h.lines).map(toChange),
  }));
}

export function diffTypeFor(status: FileStatus): DiffType {
  switch (status) {
    case "added":
      return "add";
    case "deleted":
      return "delete";
    case "renamed":
      return "rename";
    case "copied":
      return "copy";
    default:
      return "modify";
  }
}

/** True when some old-side context is hidden between/around the hunks (so "Expand all" has work). */
export function hasCollapsedContext(model: HunkModel, oldText: string | null): boolean {
  if (oldText === null) return false;
  let cursor = 1;
  for (const h of model.hunks) {
    if (h.oldStart > cursor) return true;
    cursor = Math.max(cursor, h.oldStart + h.oldCount);
  }
  return cursor <= lineCount(oldText);
}

/** Number of lines in a text; a trailing newline does not start an extra line. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}
