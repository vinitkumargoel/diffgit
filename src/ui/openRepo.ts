/**
 * The one way a folder is opened (T4.4, extracted in T11.1 so the command palette's
 * "Open a repository…" is the same flow as Home's CTA and the `o` key, not a second copy).
 * D16: the picker is always asked for read access.
 */
import { resolveGitdirLine } from "../engine/git/submodules";
import {
  collectSnapshot,
  promptForRepositoryFiles,
  type SnapshotInputFile,
  type SnapshotProgress,
} from "./fs/memoryDirHandle";
import { removeRepo, upsertRepo } from "./persistence";
import { useStore } from "./store";
import {
  GITDIR_OUTSIDE_NOTE,
  gitdirInsideNote,
  openFailedNote,
  UNREADABLE_NOTE,
} from "./submodules";

type Picker = (opts: { mode: "read"; id?: string }) => Promise<FileSystemDirectoryHandle>;

/** The browser's directory picker, or null where it does not exist (the gate explains why). */
export function directoryPicker(): Picker | null {
  const w = window as unknown as { showDirectoryPicker?: Picker };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}

/** Codes from the layout checks: the picked folder can never open here (Design §7.8 E2). */
const LAYOUT_CODES: ReadonlySet<string> = new Set([
  "NOT_A_REPO",
  "WORKTREE_GITDIR",
  "BARE_REPO",
  "REFTABLE",
  "OBJECT_FORMAT_SHA256",
  "ALTERNATES",
  "PARTIAL_CLONE",
  "PACK_TOO_LARGE",
]);

function errorName(e: unknown): string {
  const name = (e as { name?: unknown })?.name;
  return typeof name === "string" && name !== "" ? name : "Error";
}

/**
 * Shows the directory picker and opens what the user chose: remembers it in Recent, opens it with
 * the remembered branch pair, and drops it from Recent again when the layout checks refuse it.
 * Cancelling is not an error; a refusal by policy is the browser gate's story (B6), anything else
 * is one toast with a Retry that runs this again (E5.1).
 */
export async function pickAndOpenRepo(): Promise<void> {
  const pick = directoryPicker();
  if (!pick) return;
  const store = useStore.getState();
  // T11.11: the dashboard must never be in the way of opening a repository. Its sweep is stopped
  // before the picker, so no background summary competes with the open the user just asked for.
  store.cancelSummaries();
  try {
    const handle = await pick({ mode: "read", id: "diffgit-repo" });
    const stored = await upsertRepo(handle);
    await store.openRepo(handle, {
      id: stored.id,
      lastSource: stored.lastSource,
      lastTarget: stored.lastTarget,
      expectedMs: stored.lastOpenMs,
    });
    const after = useStore.getState();
    if (after.screen === "error" && after.error && LAYOUT_CODES.has(after.error.code))
      await removeRepo(stored.id);
  } catch (e) {
    if (errorName(e) === "AbortError") return; // user cancelled the picker
    const name = errorName(e);
    if (name === "SecurityError" || name === "NotAllowedError") {
      store.setGateCause("policy");
      return;
    }
    store.addToast({
      level: "error",
      message: `Couldn't open the folder. The browser refused the request (${name}).`,
      action: { label: "Retry", onClick: () => void pickAndOpenRepo() },
    });
  }
}

/** A directory handle, reduced to the two read-only calls the submodule probe needs. */
interface DirLike {
  getDirectoryHandle(name: string): Promise<DirLike>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<{ text(): Promise<string> }> }>;
}

/**
 * What the submodule card may offer for one gitlink path (T11.16, atlas tab 19). The probe is two
 * reads inside the folder the user already granted: walk down to `<path>`, then look at its `.git`.
 *
 * - a `.git` **directory** — an old-style submodule, or a nested clone — is an ordinary repository
 *   and `openSubmodule` hands it straight to the engine;
 * - a `.git` **file** (`gitdir: ../.git/modules/<name>`, what git has written since 1.7.8) is
 *   refused on open with `WORKTREE_GITDIR` (T1.2, Plan §5.2). The pointer is resolved anyway, with
 *   the engine's own `resolveGitdirLine`, so the card can say whether the git directory is inside
 *   the picked folder (diffgit reads the submodule's HEAD from there — that is where
 *   `SubmoduleInfo.checkedOut` comes from) or outside it (the browser cannot see it at all).
 */
export type SubmoduleOpenability =
  | { kind: "openable" }
  | { kind: "gitdir-inside"; note: string }
  | { kind: "gitdir-outside"; note: string }
  | { kind: "unreadable"; note: string };

function rootDir(): DirLike | null {
  const handle = useStore.getState().handle;
  return handle !== null &&
    typeof handle === "object" &&
    typeof (handle as { getDirectoryHandle?: unknown }).getDirectoryHandle === "function"
    ? (handle as unknown as DirLike)
    : null;
}

/**
 * Walks `a/b/c` down from the open repository's root. D16: `getDirectoryHandle` is called with no
 * options at all, which is read mode — the guard in `scripts/check-guards.sh` would fail the build
 * on the creating form anyway.
 */
async function directoryAt(path: string): Promise<DirLike | null> {
  let dir = rootDir();
  if (!dir) return null;
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

export async function probeSubmodule(path: string): Promise<SubmoduleOpenability> {
  try {
    const dir = await directoryAt(path);
    if (!dir) return { kind: "unreadable", note: UNREADABLE_NOTE };
    let text: string;
    try {
      text = await (await (await dir.getFileHandle(".git")).getFile()).text();
    } catch {
      // Not a file. Either `.git` is a directory (an ordinary repository the engine accepts) or
      // it is absent, in which case the engine answers `NOT_A_REPO` and says so properly.
      return { kind: "openable" };
    }
    const line = /^gitdir:.*$/m.exec(text)?.[0];
    if (line === undefined) return { kind: "openable" }; // a `.git` file that is not a pointer
    const gitdir = resolveGitdirLine(path, line);
    return gitdir === null
      ? { kind: "gitdir-outside", note: GITDIR_OUTSIDE_NOTE }
      : { kind: "gitdir-inside", note: gitdirInsideNote(gitdir) };
  } catch {
    // A folder that is not there, or one the permission no longer covers: the card says so.
    return { kind: "unreadable", note: UNREADABLE_NOTE };
  }
}

/**
 * Opens the nested folder of a submodule as a repository of its own (T11.16). The handle comes
 * from the folder the user already granted, so there is no second permission prompt; it is not
 * written to Recent, because the user picked the superproject and not this.
 */
export async function openSubmodule(path: string): Promise<void> {
  const store = useStore.getState();
  const probe = await probeSubmodule(path);
  if (probe.kind !== "openable") {
    store.addToast({ level: "warning", message: probe.note });
    return;
  }
  const dir = await directoryAt(path).catch(() => null);
  if (!dir) {
    store.addToast({ level: "error", message: openFailedNote(path) });
    return;
  }
  store.cancelSummaries();
  await store.openRepo(dir, { id: `submodule:${path}` });
}

/**
 * Snapshot mode's way in (T11.15, Design §14.6): the folder is read **once**, through
 * `<input webkitdirectory>`, because Firefox and Safari have no directory handle to keep. The gate
 * passes the files its own input collected (so it can draw the counter); the palette action passes
 * nothing and a detached input is used instead. Nothing is remembered — there is no handle to
 * remember — so this never touches Recent, and the store starts no scheduler for it.
 *
 * Rejects with `SnapshotTooLargeError` above 100,000 entries; the caller decides where to say so.
 */
export async function openRepoOnce(
  files?: ArrayLike<SnapshotInputFile> | null,
  onProgress?: (p: SnapshotProgress) => void,
): Promise<void> {
  const picked = files ?? (await promptForRepositoryFiles());
  if (!picked || picked.length === 0) return; // dismissed, or an empty folder
  const snapshot = await collectSnapshot(picked, { onProgress });
  await useStore.getState().openRepo(snapshot, { id: snapshot.name });
}
