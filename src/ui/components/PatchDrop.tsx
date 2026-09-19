import { CircleAlert, FileDiff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DISMISS_LABEL,
  DROP_HINT,
  DROP_TITLE,
  dragHasFiles,
  NOT_A_PATCH_TITLE,
  OPEN_PATCH_HINT,
  OPEN_PATCH_LABEL,
  PATCH_ACCEPT,
  patchFromTransfer,
} from "../patch";
import { INSTALL_HINT, INSTALL_LABEL, promptInstall, useInstallPrompt } from "../pwa";
import { useStore } from "../store";

/** The hidden input, so the palette's "Open a patch file…" opens the same chooser Home does. */
let fileInput: HTMLInputElement | null = null;

/** Opens the OS file chooser for a `.patch` / `.diff`. No-op before the app has mounted. */
export function openPatchPicker(): void {
  fileInput?.click();
}

/**
 * The inline answer to a file that is not a unified diff (Design §14.6): the engine's message, its
 * hint and the `line <n>: <text>` it refused at — never a crash, and never a toast that scrolls
 * away before it has been read.
 */
function PatchError() {
  const error = useStore((s) => s.patchSession.error);
  const dismiss = useStore((s) => s.dismissPatchError);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error) button.current?.focus();
  }, [error]);
  if (!error) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex max-w-[560px] flex-col gap-1.5 rounded-[8px] border border-line bg-surface px-3.5 py-3 text-[13px] leading-5 shadow-[var(--shadow-popover)]"
      >
        <b className="flex items-center gap-2 font-medium text-ink">
          <CircleAlert size={16} aria-hidden className="text-danger" />
          {NOT_A_PATCH_TITLE}
        </b>
        <span className="text-muted">{error.message}</span>
        {error.detail && (
          <code className="font-mono text-[11.5px] break-all text-muted/80">{error.detail}</code>
        )}
        {error.hint && <span className="text-muted">{error.hint}</span>}
        <span>
          <button ref={button} type="button" className="btn btn-sm" onClick={dismiss}>
            {DISMISS_LABEL}
          </button>
        </span>
      </div>
    </div>
  );
}

/** Home's entry point, portalled into the landing page's CTA row beside "Open a repository". */
function HomeEntry({ onPick }: { onPick: () => void }) {
  const installable = useInstallPrompt();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const screen = useStore((s) => s.screen);

  // The landing page is static markup injected by HomeScreen (`src/marketing/precision.html`), so
  // this attaches itself to the hero's CTA row the same way HomeScreen portals Recent into it —
  // no marketing asset and no other component is edited to make room for it.
  useEffect(() => {
    if (screen !== "home") {
      setSlot(null);
      return;
    }
    const cta = document.querySelector(".cta");
    if (!cta) return;
    const host = document.createElement("span");
    host.className = "dg-patch-cta";
    cta.appendChild(host);
    setSlot(host);
    return () => {
      host.remove();
    };
  }, [screen]);

  if (!slot) return null;
  return createPortal(
    <>
      <button type="button" className="btn btn-lg" onClick={onPick} title={OPEN_PATCH_HINT}>
        {OPEN_PATCH_LABEL}
      </button>
      {installable && (
        <button
          type="button"
          className="btn btn-lg"
          title={INSTALL_HINT}
          onClick={() => void promptInstall()}
        >
          {INSTALL_LABEL}
        </button>
      )}
    </>,
    slot,
  );
}

/**
 * Patch-only mode's way in (T11.14, Design §14.6, atlas tab 17). Mounted once by `App`, so the same
 * three doors work on Home and on the repo screen: a `.patch` / `.diff` **dropped anywhere**, the
 * file chooser behind Home's entry and the palette's "Open a patch file…", and — through
 * `src/ui/pwa.ts` — a file the operating system hands to the installed app.
 *
 * It adds nothing to the bars (Design §14.1): the drop target is the window, the chooser is a
 * hidden input, and the only always-visible affordance is one button in Home's existing CTA row.
 */
export function PatchDropZone() {
  const openPatchFile = useStore((s) => s.openPatchFile);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const over = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault(); // without this the browser navigates to the file instead
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = patchFromTransfer(e.dataTransfer);
      if (file) void openPatchFile(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [openPatchFile]);

  const pick = useCallback(() => openPatchPicker(), []);

  return (
    <>
      <input
        ref={(el) => {
          fileInput = el;
        }}
        type="file"
        accept={PATCH_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="patch-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // so choosing the same file twice fires again
          if (file) void openPatchFile(file);
        }}
      />
      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)]"
        >
          <div className="flex flex-col items-center gap-2 rounded-[12px] border-2 border-accent border-dashed bg-surface px-10 py-8 text-center">
            <FileDiff size={28} aria-hidden className="text-accent" />
            <b className="text-[15px] font-medium text-ink">{DROP_TITLE}</b>
            <span className="text-[13px] text-muted">{DROP_HINT}</span>
          </div>
        </div>
      )}
      <PatchError />
      <HomeEntry onPick={pick} />
    </>
  );
}
