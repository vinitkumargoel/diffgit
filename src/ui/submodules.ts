/**
 * Every string and every rule the submodule card shows (T11.16, Design §14.3, atlas tab 19).
 *
 * The card answers three questions `git submodule status` answers: which commit the superproject
 * records, which commit is actually checked out under the folder the user picked, and whether the
 * two agree. `SubmoduleInfo.dirty` is null by contract (`docs/v2-contracts.md` `<!-- T10.12 -->`:
 * deciding it means a second index and a second worktree scan), so the card never claims it.
 */
import type { Oid, SubmoduleInfo } from "../engine/types";

/** The header tag on a gitlink row, and the sentence under the file name. */
export const SUBMODULE_TAG = "submodule";
export const SUBMODULE_SUBTITLE = "submodule pointer moved";
export const SUBMODULE_ADDED = "submodule added";
export const SUBMODULE_REMOVED = "submodule removed";

/** How the checked-out commit relates to the one the superproject records. */
export type SubmoduleSync = "in-sync" | "drifted" | "not-checked-out";

export const SYNC_LABEL: Record<SubmoduleSync, string> = {
  "in-sync": "in sync",
  drifted: "drifted",
  "not-checked-out": "not checked out",
};

export const SYNC_TITLE: Record<SubmoduleSync, string> = {
  "in-sync": "The checked-out commit is the one this repository records.",
  drifted:
    "The checkout is at a different commit than this repository records — commit it in the submodule, or run git submodule update.",
  "not-checked-out":
    "No repository was found at this path, or its git directory lives outside the folder you picked. git submodule status spells this -<oid>.",
};

/** The three states the card tags, derived exactly as `git submodule status` derives them. */
export function syncOf(info: SubmoduleInfo): SubmoduleSync {
  if (info.checkedOut === null) return "not-checked-out";
  return info.checkedOut === info.recorded ? "in-sync" : "drifted";
}

/** Row labels (the card is a definition list, so these are the `<dt>`s). */
export const RECORDED_LABEL = "Recorded";
export const CHECKED_OUT_LABEL = "Checked out";
export const URL_LABEL = "URL";
export const OPEN_LABEL_ROW = "Inside";

export const URL_SOURCE_NOTE = "from .gitmodules";
export const NO_URL = "no url in .gitmodules";
export const DIRTY_NOTE = "Whether the submodule's own working tree is dirty is not computed.";

/** The action the card offers when the nested folder can be handed to the engine on its own. */
export const OPEN_LABEL = "Open submodule as its own repository";
export const OPEN_TITLE = "Reads the nested folder as a repository of its own, in read mode.";

/**
 * Why a submodule cannot be opened on its own. Both sentences are about the *pointer file* git
 * writes since 1.7.8 (`gitdir: ../.git/modules/<name>`): the engine refuses a folder whose `.git`
 * is such a file (`WORKTREE_GITDIR`, T1.2 / Plan §5.2), so the card says so here instead of
 * letting the user land on an error screen that says "Linked worktree".
 */
export function gitdirInsideNote(gitdir: string): string {
  return `Its git directory is ${gitdir}, inside the folder you picked — diffgit reads the commit above from there, but a folder whose .git is a pointer file cannot be opened as a repository of its own yet.`;
}
export const GITDIR_OUTSIDE_NOTE =
  "Its git directory is outside the folder you picked, so the browser cannot read it. Pick the submodule's own folder — or its parent — to open it.";
export const NO_FOLDER_NOTE =
  "This submodule is not checked out here, so there is no folder to open.";
export const UNREADABLE_NOTE = "Its folder could not be read.";

/** The toast when the open itself failed after the checks passed. */
export function openFailedNote(path: string): string {
  return `Couldn't open ${path} as a repository.`;
}

/** `abc1234`, or the em dash for a side that does not exist. */
export function shortSubmoduleOid(oid: Oid | null): string {
  return oid === null ? "—" : oid.slice(0, 7);
}

/** `3f2a1c9 → 8b1e0f2`, with the em dash on whichever side the row does not have. */
export function pointerLine(oldOid: Oid | null, newOid: Oid | null): string {
  return `${shortSubmoduleOid(oldOid)} → ${shortSubmoduleOid(newOid)}`;
}

/** The sentence under the file name: what this row does to the pointer. */
export function pointerSubtitle(oldOid: Oid | null, newOid: Oid | null): string {
  if (oldOid === null) return SUBMODULE_ADDED;
  if (newOid === null) return SUBMODULE_REMOVED;
  return SUBMODULE_SUBTITLE;
}
