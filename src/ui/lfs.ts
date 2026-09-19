/**
 * Every string and every rule the Git LFS card shows (T11.16, Design §14.3, atlas tab 19).
 *
 * A file tracked by `filter=lfs` is stored in git as a pointer of three ASCII lines; the bytes it
 * names live on an LFS server. diffgit never contacts one — that is the whole privacy claim — so
 * the card renders what the pointer says and nothing else. `FileClassification.lfs` carries one
 * pointer (the new side wins, `docs/v2-contracts.md` `<!-- T10.12 -->`), so the card reads both
 * sides itself, out of the **local object database**, through the same `fileBytes` path
 * `BinaryNotice`'s "View as text" uses — and only for a side small enough to be a pointer.
 */
import { LFS_POINTER_MAX_BYTES, type LfsPointer } from "../engine/diff/lfs";
import type { FileStatus } from "../engine/types";
import { formatBytes } from "./format";

export const LFS_TAG = "LFS";
export const LFS_SUBTITLE = "Git LFS pointer";

export const OBJECT_LABEL = "Object";
export const SIZE_LABEL = "Size";
export const CONTENT_LABEL = "Content";

/** The one sentence the card exists for. */
export const NOT_FETCHED =
  "Not fetched. diffgit reads the pointer git stores and never contacts an LFS server.";

/** Printed under the rows when only one side could be read as a pointer. */
export const ONE_SIDE_NOTE = "The other side is not an LFS pointer.";
export const UNREADABLE_NOTE = "The pointer on that side could not be read.";

/**
 * True when a side is small enough to be a pointer at all (the spec caps one at 1 KiB). The size
 * is the blob's, which the classification already carries, so a file that was converted to LFS is
 * never read back in full just to find that out.
 */
export function canBePointer(size: number): boolean {
  return size > 0 && size <= LFS_POINTER_MAX_BYTES;
}

/** `sha256:9f86d08…f00a08` — the full oid stays in the `title`. */
export function shortLfsOid(oid: string): string {
  const colon = oid.indexOf(":");
  const algo = colon === -1 ? "" : oid.slice(0, colon + 1);
  const hex = colon === -1 ? oid : oid.slice(colon + 1);
  return hex.length <= 16 ? oid : `${algo}${hex.slice(0, 7)}…${hex.slice(-6)}`;
}

/** `sha256:9f86d08…f00a08 → sha256:4d7a214…7e2393`, or one side when there is only one. */
export function objectLine(oldP: LfsPointer | null, newP: LfsPointer | null): string {
  if (oldP && newP) {
    return oldP.oid === newP.oid
      ? shortLfsOid(newP.oid)
      : `${shortLfsOid(oldP.oid)} → ${shortLfsOid(newP.oid)}`;
  }
  const one = newP ?? oldP;
  return one === null ? "—" : shortLfsOid(one.oid);
}

/** `12.4 MB → 12.9 MB`, or the one size a one-sided row claims. */
export function sizeLine(oldP: LfsPointer | null, newP: LfsPointer | null): string {
  if (oldP && newP) {
    return oldP.size === newP.size
      ? formatBytes(newP.size)
      : `${formatBytes(oldP.size)} → ${formatBytes(newP.size)}`;
  }
  const one = newP ?? oldP;
  return one === null ? "—" : formatBytes(one.size);
}

/** What the row does to the pointer, for the sentence under the file name. */
export function lfsSubtitle(status: FileStatus): string {
  if (status === "added") return "Git LFS pointer added";
  if (status === "deleted") return "Git LFS pointer removed";
  return LFS_SUBTITLE;
}
