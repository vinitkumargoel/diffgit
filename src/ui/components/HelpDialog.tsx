import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../format";
import { PALETTE_SHORTCUT, SHORTCUTS, V2_SHORTCUTS } from "../hooks/useShortcuts";
import { clearDerived, type DerivedSize, derivedSize } from "../persistence/derived";

export const PRIVACY_SENTENCES = [
  "diffgit opens your folder read-only and never writes to it.",
  "Nothing leaves the browser: no uploads, no network requests, no cloud.",
  "There are no analytics and no tracking.",
] as const;

interface Row {
  key: string;
  label?: string;
  description: string;
  pending?: boolean;
}

function Shortcuts({ rows, caption }: { rows: readonly Row[]; caption: string }) {
  return (
    <table className="mt-3 w-full border-collapse text-[13px] leading-5">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.map((s) => (
          <tr key={s.key} className="border-t border-line">
            <td className="w-20 py-1.5 pr-3">
              <kbd className="kbd">{s.label ?? s.key}</kbd>
            </td>
            <td className="py-1.5 text-ink">
              {s.description}
              {s.pending && <span className="ml-2 text-xs text-muted">when available</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Design §7.9 + §14.1: native modal `<dialog>`, 520 px, shortcut tables, cache footer, privacy. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [cache, setCache] = useState<DerivedSize | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  // The derived cache (blame, file history, insights, summaries) is measured while the dialog is up.
  useEffect(() => {
    if (open) void derivedSize().then(setCache);
  }, [open]);

  const v2Rows: Row[] = [
    { key: "⌘K", description: PALETTE_SHORTCUT.description },
    ...V2_SHORTCUTS.map((s) => ({
      key: s.key,
      ...("label" in s ? { label: s.label } : {}),
      description: s.description,
      ...("pending" in s && s.pending ? { pending: true } : {}),
    })),
  ];

  return (
    <dialog ref={ref} className="help-dialog" aria-labelledby="help-title" onClose={onClose}>
      <div className="flex items-center justify-between gap-4">
        <h2 id="help-title" className="text-base font-semibold leading-6">
          Keyboard shortcuts
        </h2>
        <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <Shortcuts rows={SHORTCUTS as readonly Row[]} caption="Shortcuts" />
      <h3 className="mt-5 text-sm font-semibold leading-5">Modes and the palette</h3>
      <Shortcuts rows={v2Rows} caption="Mode and palette shortcuts" />
      <h3 className="mt-5 text-sm font-semibold leading-5">Privacy</h3>
      <p className="mt-1 text-[13px] leading-5 text-muted">{PRIVACY_SENTENCES.join(" ")}</p>
      <p className="mt-3 flex items-center gap-2 text-xs leading-5 text-muted">
        <span data-testid="cache-size">Cached data: {cache ? formatBytes(cache.bytes) : "…"}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void clearDerived().then(() => setCache({ entries: 0, bytes: 0 }))}
        >
          Clear
        </button>
      </p>
      <p className="mt-3 text-xs leading-5 text-muted" data-testid="build-id">
        Build {__BUILD_ID__}
      </p>
    </dialog>
  );
}
