/**
 * Viewed-checkbox key (T4.2 amendment): includes the file id so two untracked files with
 * `newOid = null` never share a key, and the side oids so the mark clears when content changes.
 * `FileDiff` carries no mtime, so the worktree fallback uses the size (follow-up logged in CHANGELOG).
 */
import { sourceRefs } from "../engine/diffSource";
import type { DiffSource, FileDiff } from "../engine/types";

export function viewedKey(repoId: string, src: DiffSource, file: FileDiff): string {
  const newSide = file.newOid ?? `wt:${file.newSize}`;
  const oldSide = file.oldOid ?? "-";
  const { sourceRef, targetRef } = sourceRefs(src);
  return `${repoId}|${sourceRef}|${targetRef}|${file.id}|${newSide}|${oldSide}`;
}
