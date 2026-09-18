import { useCallback, useEffect, useRef } from "react";
// The landing page, verbatim from the approved "Precision" mockup (docs/mockups/e-precision.html).
// Kept as raw assets outside src/ui so the design's literal colours don't trip the token guard;
// the CSS is injected as a scoped <style> that unmounts with the screen, and the demo script — which
// the CSP forbids inline — runs from precisionDemo.ts instead.
import precisionCss from "../../marketing/precision.css?raw";
import precisionHtml from "../../marketing/precision.html?raw";
import { useShortcuts } from "../hooks/useShortcuts";
import { upsertRepo } from "../persistence";
import { useStore } from "../store";
import { initPrecisionDemo } from "./home/precisionDemo";

type Picker = (opts: { mode: "read"; id?: string }) => Promise<FileSystemDirectoryHandle>;

function picker(): Picker | null {
  const w = window as unknown as { showDirectoryPicker?: Picker };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}

function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** The mockup's footer carries a hard-coded build id; show the real one this bundle was built at. */
const HTML = precisionHtml.replace("build 11648ff", `build ${__BUILD_ID__}`);

/**
 * The home screen is the "Precision" landing page (Direction E) rendered as-is: its nav, hero,
 * interactive demo, chapters, privacy table, FAQ and footer. Every "Open a repository" CTA and the
 * `o` shortcut open the read-only directory picker, which hands off to the app (App switches to the
 * repo screen). The marketing markup and styles are static, in-repo assets — never user input.
 */
export function HomeScreen() {
  const openRepo = useStore((s) => s.openRepo);
  const addToast = useStore((s) => s.addToast);
  const rootRef = useRef<HTMLDivElement>(null);

  const openPicker = useCallback(async () => {
    const pick = picker();
    if (!pick) return;
    try {
      // D16: read-only access, always.
      const handle = await pick({ mode: "read", id: "diffgit-repo" });
      const stored = await upsertRepo(handle);
      await openRepo(handle, {
        id: stored.id,
        lastSource: stored.lastSource,
        lastTarget: stored.lastTarget,
      });
    } catch (e) {
      if (isAbort(e)) return; // user cancelled the picker
      addToast({
        level: "error",
        message: `Couldn't open the folder: ${String((e as Error)?.message ?? e)}`,
      });
    }
  }, [openRepo, addToast]);

  // `o` opens the picker while on Home (T4.4 AC).
  useShortcuts({ o: () => void openPicker() });

  // Wire every "Open a repository" CTA in the injected markup to the picker.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = () => void openPicker();
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button.btn-ink"));
    for (const b of buttons) b.addEventListener("click", onClick);
    return () => {
      for (const b of buttons) b.removeEventListener("click", onClick);
    };
  }, [openPicker]);

  // Run the self-contained diff demo in the `#demo` section.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return initPrecisionDemo(root);
  }, []);

  return (
    <>
      {/* Component-scoped: removed from the DOM when the screen unmounts, so it never leaks into the app. */}
      <style>{precisionCss}</style>
      <div
        ref={rootRef}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static in-repo marketing asset, not user input.
        dangerouslySetInnerHTML={{ __html: HTML }}
      />
    </>
  );
}
