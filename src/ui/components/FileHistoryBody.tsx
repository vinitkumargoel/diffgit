import { useEffect, useState } from "react";
import type { FileDiff, PathHistoryEntry } from "../../engine/types";
import {
  FOLLOW_LABEL,
  LOAD_MORE_LABEL,
  pathHistoryCacheKey,
  RENAMED_TAG,
  renamedFromLabel,
  shortOid,
  WS_ONLY_TAG,
} from "../blame";
import { describeError } from "../errors";
import { useNow } from "../hooks/useNow";
import { requestScrollTo } from "../scrollBus";
import { blameTarget, useStore } from "../store";
import { timeAgo } from "../timeAgo";
import { filePathOf } from "../treeModel";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { Notice } from "./Notice";

/** A `ref`-style tag, the same shape §14.4's Hidden rows use. */
function Tag({ children, title }: { children: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-line bg-surface-raised px-1.5 text-[10.5px] leading-4 text-muted"
    >
      {children}
    </span>
  );
}

/**
 * One `PathHistoryEntry` row (atlas tab 02, the "History of …" list): short SHA in `--accent`
 * mono, subject, the `renamed` / `ws only` tags, then author and age right-aligned.
 */
function HistoryRow({
  entry,
  now,
  onSelect,
}: {
  entry: PathHistoryEntry;
  now: number;
  onSelect: () => void;
}) {
  const renamed = renamedFromLabel(entry);
  return (
    <li>
      <button
        type="button"
        data-oid={entry.oid}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12.5px] leading-5 hover:bg-surface-raised"
        onClick={onSelect}
      >
        <span className="shrink-0 font-mono text-[11px] text-accent">{shortOid(entry.oid)}</span>
        <span className="min-w-0 flex-1 truncate text-ink" title={entry.subject}>
          {entry.subject}
        </span>
        {renamed !== null && <Tag title={renamed}>{RENAMED_TAG}</Tag>}
        {entry.whitespaceOnly && <Tag title="Only whitespace changed">{WS_ONLY_TAG}</Tag>}
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted">
          {entry.author.name} · {timeAgo(entry.author.timestamp, now)}
        </span>
      </button>
    </li>
  );
}

/**
 * History mode of the file card (Design §14.1, atlas tab 02): the commits that touched this path,
 * newest first, with `Follow renames` on by default (`git log --follow`) and `Load more` while the
 * engine still has a cursor. Clicking a row selects that commit — the same mechanism T11.5's
 * commit list uses, so the source becomes `parent…commit` — switches to History mode and asks the
 * pane to scroll this file into view.
 */
export function FileHistoryBody({ file }: { file: FileDiff }) {
  const path = filePathOf(file);
  const [follow, setFollow] = useState(true);
  const now = useNow(60_000);

  const target = useStore((s) => blameTarget(s)?.oid ?? null);
  const key = target === null ? null : pathHistoryCacheKey(target, path, follow);
  const state = useStore((s) => (key === null ? undefined : s.pathHistories[key]));
  const loadPathHistory = useStore((s) => s.loadPathHistory);
  const setMode = useStore((s) => s.setMode);
  const showCommit = useStore((s) => s.showCommit);

  useEffect(() => {
    if (key === null) return;
    void loadPathHistory(path, { at: null, follow });
  }, [key, path, follow, loadPathHistory]);

  const select = (oid: string) => {
    setMode("history");
    void showCommit(oid).then(() => requestScrollTo(file.id));
  };

  const toggle = (
    <div className="flex items-center gap-3 border-b border-line-subtle px-3 py-1.5 text-[11.5px] leading-5 text-muted">
      <span>History of {path}</span>
      <label className="ml-auto flex cursor-pointer items-center gap-1.5 select-none">
        <input
          type="checkbox"
          className="size-3.5 accent-success"
          checked={follow}
          onChange={(e) => setFollow(e.target.checked)}
        />
        {FOLLOW_LABEL}
      </label>
    </div>
  );

  if (state === undefined || (state.loading && state.entries.length === 0)) {
    return (
      <div>
        {toggle}
        <LoadingSkeleton label={`Reading the history of ${path}`} />
      </div>
    );
  }
  if (state.error !== null && state.entries.length === 0) {
    return (
      <div>
        {toggle}
        <Notice
          tone="danger"
          detail={describeError(state.error.code).message}
          code={`${state.error.code} · ${state.error.message}`}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadPathHistory(path, { at: null, follow })}
            >
              Retry
            </button>
          }
        >
          Couldn’t read this file’s history
        </Notice>
      </div>
    );
  }
  if (state.entries.length === 0) {
    return (
      <div>
        {toggle}
        <Notice>No commit in this history touches {path}</Notice>
      </div>
    );
  }

  return (
    <div>
      {toggle}
      <ul aria-label={`History of ${path}`} className="divide-y divide-line-subtle">
        {state.entries.map((entry) => (
          <HistoryRow
            key={`${entry.oid}:${entry.path}`}
            entry={entry}
            now={now}
            onSelect={() => select(entry.oid)}
          />
        ))}
      </ul>
      {state.cursor !== null && (
        <div className="border-t border-line-subtle px-3 py-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={state.loading}
            onClick={() => void loadPathHistory(path, { at: null, follow, more: true })}
          >
            {state.loading ? "Loading…" : LOAD_MORE_LABEL}
          </button>
        </div>
      )}
    </div>
  );
}
