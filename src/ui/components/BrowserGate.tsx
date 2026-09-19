import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { detectGateCause, type GateWindow } from "../browserGate";
import { type GateCause, useStore } from "../store";
import { GatePage } from "./GatePage";
import { canReadOnce as canReadOnceCause } from "./gate.styles";

export function supportsFileSystemAccess(
  win: unknown = typeof window === "undefined" ? undefined : window,
): boolean {
  return typeof win === "object" && win !== null && "showDirectoryPicker" in (win as object);
}

/**
 * Engines that simply do not have `showDirectoryPicker()`. Both of them do have
 * `<input webkitdirectory>`, which is snapshot mode's way in (Design §14.6, atlas tab 18). The other
 * causes are not about the engine — a phone cannot hand over a folder at all, and a framed, plain-http
 * or policy-blocked page has a real fix that is better than reading the folder once.
 */
export function canReadOnce(cause: GateCause): boolean {
  return canReadOnceCause(cause);
}

/**
 * Renders children only when a local folder can actually be opened (D3, Design §7.8 B1–B6).
 *
 * Two things can raise the gate: `detectGateCause` on load (no `showDirectoryPicker`), and the
 * store's `gateCause`, which the home screen sets to "policy" when the picker itself refuses. The
 * store wins, because it knows something detection cannot. "See the demo" drops the gate to a
 * warning strip and reveals the landing page below it, whose demo runs in every browser.
 */
export function BrowserGate({ children, win }: { children: ReactNode; win?: GateWindow }) {
  const gateCause = useStore((s) => s.gateCause);
  const snapshotMode = useStore((s) => s.snapshotMode);
  const target =
    win ?? (typeof window === "undefined" ? ({} as GateWindow) : (window as GateWindow));
  const cause = gateCause ?? detectGateCause(target);
  const [showDemo, setShowDemo] = useState(false);

  useEffect(() => {
    if (!showDemo) return;
    document.getElementById("demo")?.scrollIntoView?.();
  }, [showDemo]);

  if (!cause) return <>{children}</>;
  // T11.15: the folder was read once, so the app is usable in this browser after all. Closing the
  // repository clears the flag and puts the gate back, which is also the error screens' way out.
  if (snapshotMode) return <>{children}</>;

  if (showDemo) {
    return (
      <>
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-banner-warning-border bg-banner-warning-bg px-4 py-2 text-[13px] text-ink">
          <TriangleAlert size={14} aria-hidden="true" className="shrink-0 text-attention" />
          <span>Folder access unavailable in this browser — the demo below still works.</span>
          <button
            type="button"
            className="ml-auto cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[12px] font-medium hover:bg-surface-raised"
            onClick={() => setShowDemo(false)}
          >
            Back
          </button>
        </div>
        {children}
      </>
    );
  }

  return <GatePage cause={cause} win={target} onDemo={() => setShowDemo(true)} />;
}
