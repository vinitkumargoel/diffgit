import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReflogEntry, ResolvedRevision } from "../../engine/types";
import { short } from "../operation";
import { useStore } from "../store";
import { timeAgo } from "../timeAgo";

/** A reflog row as a compare source (T11.2 `setRevision`): the commit HEAD moved to. */
export function revisionOfReflog(entry: ReflogEntry): ResolvedRevision {
  return {
    expr: entry.newOid,
    oid: entry.newOid,
    kind: "commit",
    display: short(entry.newOid),
  };
}

/**
 * Design §14.5, "Reflog": `HEAD@{n}` rows with the action, the message, the age and an
 * `unreachable` badge on an orphaned commit. Clicking a row compares that commit (T11.2).
 *
 * T11.5 renders this as the History sidebar's `Reflog` sub-tab; until then the palette action
 * "Show reflog" opens it in `ReflogDialog`.
 */
export function ReflogList({ onPick }: { onPick?: () => void } = {}) {
  const entries = useStore((s) => s.reflog);
  const loadReflog = useStore((s) => s.loadReflog);
  const setRevision = useStore((s) => s.setRevision);
  const now = Date.now();

  useEffect(() => {
    if (entries === null) void loadReflog();
  }, [entries, loadReflog]);

  if (entries === null) {
    return (
      <p className="p-4 text-[13px] leading-5 text-muted" role="status">
        Reading the reflog…
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="p-4 text-[13px] leading-5 text-muted">
        No reflog is kept for this repository. git writes one unless{" "}
        <code className="font-mono">core.logAllRefUpdates</code> is false.
      </p>
    );
  }
  return (
    <ul aria-label="Reflog of HEAD" className="max-h-[50vh] overflow-y-auto">
      {entries.map((e) => (
        <li key={e.expr} className="border-t border-line-subtle first:border-t-0">
          <button
            type="button"
            className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12.5px] leading-5 hover:bg-surface-raised"
            onClick={() => {
              setRevision(revisionOfReflog(e), "source");
              onPick?.();
            }}
          >
            <span className="w-20 shrink-0 font-mono text-[11px] text-muted">{e.expr}</span>
            <span className="w-16 shrink-0 font-mono text-[11px] text-accent">
              {short(e.newOid)}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink" title={e.message}>
              {e.message}
            </span>
            {e.reachable === false && (
              <span
                className="shrink-0 rounded-full border border-done/40 bg-status-t-bg px-1.5 text-[11px] leading-4 font-medium text-done"
                title="No branch or tag reaches this commit any more"
              >
                unreachable
              </span>
            )}
            <span className="shrink-0 text-[11px] text-muted">{timeAgo(e.who.timestamp, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Until T11.5 ships the History sidebar, "Show reflog" in the command palette opens the list in a
 * modal `<dialog>` styled exactly like the HelpDialog (Design §7.9).
 */
export function ReflogDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    <dialog
      ref={ref}
      className="help-dialog"
      aria-labelledby="reflog-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="reflog-title" className="text-base leading-6 font-semibold">
          Reflog · HEAD
        </h2>
        <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <p className="mt-1 text-[13px] leading-5 text-muted">
        What moved HEAD, newest first, from <code className="font-mono">.git/logs/HEAD</code>. Pick
        a row to compare that commit.
      </p>
      <div className="mt-3 rounded-[6px] border border-line">
        {open && <ReflogList onPick={onClose} />}
      </div>
    </dialog>
  );
}
