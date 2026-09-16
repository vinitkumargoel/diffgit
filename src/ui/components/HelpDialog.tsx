import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { SHORTCUTS } from "../hooks/useShortcuts";

export const PRIVACY_SENTENCES = [
  "diffgoel opens your folder read-only and never writes to it.",
  "Nothing leaves the browser: no uploads, no network requests, no cloud.",
  "There are no analytics and no tracking.",
] as const;

/** Design §7.9: native modal `<dialog>`, 520 px, shortcuts table + privacy section. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
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
      <table className="mt-3 w-full border-collapse text-[13px] leading-5">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.key} className="border-t border-line">
              <td className="w-20 py-1.5 pr-3">
                <kbd className="kbd">{"label" in s ? s.label : s.key}</kbd>
              </td>
              <td className="py-1.5 text-ink">{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="mt-5 text-sm font-semibold leading-5">Privacy</h3>
      <p className="mt-1 text-[13px] leading-5 text-muted">{PRIVACY_SENTENCES.join(" ")}</p>
    </dialog>
  );
}
