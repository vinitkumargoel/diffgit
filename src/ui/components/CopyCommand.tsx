import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** How long the button keeps its Copied / Copy failed label (FileHeader uses the same 1.5 s). */
const COPIED_MS = 1500;

/**
 * A command diffgit suggests but never runs (atlas tabs 06 / 07): mono line on `--surface-raised`
 * in a `--line` box, with a Copy button. diffgit is read-only (D16); this is the escape hatch to
 * the terminal, so the text is selectable as well as copyable.
 */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(command);
      setState("done");
    } catch {
      // Blocked clipboard (insecure context / permissions): say so, the text is still selectable.
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  const name =
    state === "done" ? "Copied" : state === "failed" ? "Copy failed" : `Copy: ${command}`;
  return (
    <div className="flex items-center gap-2 rounded-[6px] border border-line bg-surface-raised px-2.5 py-1.5">
      {label && <span className="shrink-0 text-[11px] text-muted">{label}</span>}
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11.5px] leading-5 whitespace-pre text-ink">
        {command}
      </code>
      <button
        type="button"
        className="btn btn-sm shrink-0"
        aria-label={name}
        title={name}
        onClick={() => void copy()}
      >
        {state === "done" ? (
          <Check size={12} aria-hidden />
        ) : state === "failed" ? (
          <X size={12} aria-hidden />
        ) : (
          <Copy size={12} aria-hidden />
        )}
        Copy
      </button>
    </div>
  );
}
