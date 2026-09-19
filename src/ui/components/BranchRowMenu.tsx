import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BranchRow } from "../../engine/types";
import { useStore } from "../store";
import { MenuItem } from "./MenuItem";

/** The `…` menu of one branch row (Design §14.6). Closes on Escape and on an outside click. */
export function RowMenu({
  row,
  base,
}: {
  row: BranchRow;
  base: { fullName: string; display: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const setSource = useStore((s) => s.setSource);
  const setTarget = useStore((s) => s.setTarget);
  const compareBranchWithBase = useStore((s) => s.compareBranchWithBase);
  const runPreflight = useStore((s) => s.runPreflight);
  const addToast = useStore((s) => s.addToast);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const copyName = async () => {
    setOpen(false);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(row.ref.name);
      setCopied(true);
    } catch {
      // Blocked clipboard (insecure context / permissions): say so rather than pretend it worked.
      addToast({ level: "warning", message: `Could not copy ${row.ref.name} to the clipboard.` });
    }
  };
  const isBase = base !== null && base.fullName === row.ref.fullName;

  return (
    <div ref={ref} className="relative flex justify-end">
      <button
        type="button"
        className="btn btn-icon size-6"
        aria-label={`More actions for ${row.ref.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${row.ref.name}`}
          className="absolute top-full right-0 z-10 mt-1 w-64 rounded-[6px] border border-line bg-surface py-1 shadow-popover"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MenuItem label="Set as compare" onClick={() => run(() => setSource(row.ref.fullName))} />
          <MenuItem label="Set as base" onClick={() => run(() => setTarget(row.ref.fullName))} />
          <MenuItem
            label={`Compare with ${base?.display ?? "base"}`}
            disabled={isBase || base === null}
            title={isBase ? "This branch is the base." : undefined}
            onClick={() => run(() => compareBranchWithBase(row.ref.fullName))}
          />
          <MenuItem
            label={`Preflight rebase onto ${base?.display ?? "base"}`}
            disabled={isBase || base === null}
            title={
              isBase
                ? "This branch is the base."
                : `Report what git rebase -i ${base?.display ?? "base"} would replay`
            }
            onClick={() => run(() => void runPreflight(row.ref.name, base?.display ?? ""))}
          />
          <MenuItem label={copied ? "Copied" : "Copy name"} onClick={() => void copyName()} />
        </div>
      )}
    </div>
  );
}

export { RowMenu as BranchRowMenu };
