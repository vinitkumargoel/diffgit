/**
 * Patch-only mode's vocabulary (T11.14, Design §14.6, atlas tab 17): every string and every pure
 * decision about opening a `.patch` / `.diff` file with no repository behind it.
 *
 * The parsing itself is the engine's (`parsePatch`, T10.12) and the rendering is the ordinary
 * `FileCard` — a patch row is a `FileDiff` with the same id scheme — so what is left here is the
 * copy, the size gate and the two ways a file arrives: dropped on the page, or picked from the OS
 * (the file input, and the manifest's `file_handlers` through `launchQueue`).
 */

/** Extensions the file input advertises and the drop target prefers (manifest `file_handlers`). */
export const PATCH_EXTENSIONS = [".patch", ".diff"] as const;

/** `accept` for the hidden `<input type="file">`; the same set the manifest registers. */
export const PATCH_ACCEPT = ".patch,.diff,text/x-patch,text/x-diff";

/**
 * A patch is text the engine parses line by line in one message; past this it is neither a review
 * nor a diff anyone reads, and the refusal says so instead of freezing the worker.
 */
export const MAX_PATCH_BYTES = 10 * 1024 * 1024;

export const OPEN_PATCH_LABEL = "Open a patch file";
export const OPEN_PATCH_HINT =
  "Drop a .patch or .diff anywhere, or choose one — no repository needed";
export const CLOSE_PATCH_LABEL = "Close the patch";
export const DROP_TITLE = "Drop the patch to view it";
export const DROP_HINT = "A .patch or .diff file renders here with no repository open";
export const NOT_A_PATCH_TITLE = "That file is not a unified diff";
export const DISMISS_LABEL = "Dismiss";

/** The `Patch · <name>` tag the StatsRow shows where a repository would show its pickers. */
export function patchTagLabel(name: string): string {
  return `Patch · ${name}`;
}

/** `fix-rounding.patch` → `fix-rounding`: what an export from a patch-only session is named after. */
export function patchBaseName(name: string): string {
  const cut = PATCH_EXTENSIONS.reduce(
    (n, ext) => (n.toLowerCase().endsWith(ext) ? n.slice(0, -ext.length) : n),
    name,
  );
  return cut === "" ? "patch" : cut;
}

/** Why the sidebar's "Show hidden files" toggle is dead in a patch-only session. */
export const HIDDEN_DISABLED_TITLE =
  "Hidden files are a listing of the working tree; a patch file has none";

/** Why History, Branches and Insights are not available (the disabled buttons' `title`). */
export function modeDisabledTitle(label: string): string {
  return `${label} needs a repository; a patch file carries only the changed lines`;
}

/** The size refusal, with both numbers, so the user knows by how much. */
export function tooLargeMessage(name: string, bytes: number): string {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${name} is ${mb(bytes)}; diffgit opens patch files up to ${mb(MAX_PATCH_BYTES)}.`;
}

/** True for the names the OS hands over and the ones worth guessing at when several are dropped. */
export function isPatchName(name: string): boolean {
  const lower = name.toLowerCase();
  return PATCH_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True while a drag carries files at all — the overlay must not flash for a text selection. */
export function dragHasFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types ?? []).includes("Files");
}

/**
 * The one file a drop means: the first `.patch` / `.diff` when the drag carries several, otherwise
 * the first file — a diff saved as `review.txt` is still a diff, and `NOT_A_PATCH` is the answer
 * when it is not.
 */
export function patchFromTransfer(transfer: DataTransfer | null | undefined): File | null {
  const files = Array.from(transfer?.files ?? []);
  return files.find((f) => isPatchName(f.name)) ?? files[0] ?? null;
}
