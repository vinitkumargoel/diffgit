import { useEffect } from "react";
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
 * `unreachable` badge on an orphaned commit. T11.5 mounts it as the History sidebar's `Reflog`
 * sub-tab and passes `onSelect`, so a row "opens the commit as in Commits"; without it a row falls
 * back to T11.2's behaviour and puts the commit on the compare side.
 */
export function ReflogList({
  onPick,
  onSelect,
}: {
  onPick?: () => void;
  onSelect?: (oid: string) => void;
} = {}) {
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
    <ul aria-label="Reflog of HEAD">
      {entries.map((e) => (
        <li key={e.expr} className="border-t border-line-subtle first:border-t-0">
          <button
            type="button"
            className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12.5px] leading-5 hover:bg-surface-raised"
            onClick={() => {
              if (onSelect) onSelect(e.newOid);
              else setRevision(revisionOfReflog(e), "source");
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
