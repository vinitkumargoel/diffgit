/**
 * The one way a folder is opened (T4.4, extracted in T11.1 so the command palette's
 * "Open a repository…" is the same flow as Home's CTA and the `o` key, not a second copy).
 * D16: the picker is always asked for read access.
 */
import {
  collectSnapshot,
  promptForRepositoryFiles,
  type SnapshotInputFile,
  type SnapshotProgress,
} from "./fs/memoryDirHandle";
import { removeRepo, upsertRepo } from "./persistence";
import { useStore } from "./store";

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
