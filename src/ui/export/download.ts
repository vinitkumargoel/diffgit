/**
 * Getting bytes out of the page (T11.10). Two ways only, and neither of them can touch the
 * repository:
 *
 * - **Download**: a `Blob` URL on a detached `<a download>`, clicked and revoked. No `fetch`, no
 *   `XMLHttpRequest` — the production CSP is `connect-src 'none'` (`public/_headers`), so a
 *   download that went over the network would simply be blocked.
 * - **Clipboard**: `navigator.clipboard.writeText`, which is refused in an insecure context and is
 *   reported rather than swallowed.
 *
 * Design §14.6 and the task text also name `showSaveFilePicker()` "when available". It is not used
 * and cannot be: writing through the handle it hands back needs the write-capable stream call that
 * `scripts/check-guards.sh` fails the build on (invariant D16 — nothing under `src/` may hold a
 * handle it could write through). The anchor download is the whole save path; the browser's own
 * save dialog still chooses the location, and the repository is never a target.
 */

/** Media types the two exports are handed to the browser as. */
export const PATCH_MIME = "text/x-patch;charset=utf-8";
export const HTML_MIME = "text/html;charset=utf-8";

/** UTF-8 byte length — what the menu prints as the size, not the UTF-16 string length. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Saves `text` as `name` through the browser's download path. Returns false when the document is
 * not there to click into (a non-DOM test environment), so the caller can report rather than
 * pretend it saved.
 */
export function downloadText(name: string, text: string, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next task: Safari reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/** True when the text reached the clipboard; false when the context refuses it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Blocked clipboard (insecure context / permissions): the caller toasts it; nothing is lost.
    return false;
  }
}
