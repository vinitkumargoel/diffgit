// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: the `<table role="grid">`
// table below is a real ARIA grid — its rows are focusable, walked with `j` / `k` and opened
// with Enter (T11.7 / Design §14.6). Biome's alternative, a `div` tree, would lose table layout
// and demand a focusable wrapper per cell without making anything more accessible.
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BranchRow } from "../../engine/types";
import { type BranchCells, MERGED_TITLE, NO_UPSTREAM, SYNC_TITLE, syncHint } from "../branches";
import { shortOid } from "../history";
import { useShortcuts } from "../hooks/useShortcuts";
import { refBadges } from "../refGroups";
import { selectBranchBase, useStore } from "../store";
import { timeAgo } from "../timeAgo";
import { AheadBehindCell, CellSkeleton, NoValue, RefTag } from "./AheadBehindCell";
import { Badge } from "./Badge";
import { RowMenu } from "./BranchRowMenu";
import { GRID_CLASS, TD_CLASS, TH_CLASS } from "./branches.styles";

/** Row focus for `j` / `k`, shared by the branches and the tags table (keyboard row navigation). */
export function useRowNavigation(count: number) {
  const [focusIndex, setFocusIndex] = useState(0);
  const pending = useRef<number | null>(null);
  const focusRow = useCallback(
    (i: number) => {
      const idx = Math.max(0, Math.min(count - 1, i));
      setFocusIndex(idx);
      pending.current = idx;
    },
    [count],
  );
  useEffect(() => {
    if (pending.current === null) return;
    document.querySelector<HTMLElement>(`[data-row-index="${pending.current}"]`)?.focus();
    pending.current = null;
  });
  useShortcuts({ j: () => focusRow(focusIndex + 1), k: () => focusRow(focusIndex - 1) });
  return { focusIndex, setFocusIndex, focusRow };
}

export function BranchRowCells({
  row,
  cells,
  base,
  now,
}: {
  row: BranchRow;
  cells: BranchCells | undefined;
  base: { fullName: string; display: string } | null;
  now: number;
}) {
  const hint = syncHint(cells?.vsUpstream ?? null);
  const isDefault = row.ref.isDefault;
  return (
    <>
      <td className={TD_CLASS}>
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-mono text-[12px] font-semibold text-ink">{row.ref.name}</span>
          {refBadges(row.ref).map((kind) => (
            <Badge key={kind} kind={kind} />
          ))}
          {row.tags.map((t) => (
            <span
              key={t}
              title={`Tag: ${t}`}
              className="inline-flex h-4 items-center rounded-full border border-status-m-fg/40 bg-status-m-bg px-1.5 font-mono text-[10.5px] leading-4 font-semibold text-status-m-fg"
            >
              {t}
            </span>
          ))}
        </span>
      </td>
      <td className={TD_CLASS} data-cell="upstream">
        {row.upstream === null ? (
          <span className="text-muted" title="This branch tracks no remote branch.">
            {NO_UPSTREAM}
          </span>
        ) : cells === undefined ? (
          <CellSkeleton />
        ) : cells.vsUpstream === null ? (
          <NoValue title={`${row.upstream} could not be counted.`} />
        ) : (
          <>
            <AheadBehindCell ab={cells.vsUpstream} />
            {hint !== null && <RefTag label={hint} title={SYNC_TITLE[hint]} />}
          </>
        )}
      </td>
      <td className={TD_CLASS} data-cell="base">
        {isDefault ? (
          <NoValue title="This is the branch the others are compared with." />
        ) : cells === undefined ? (
          <CellSkeleton />
        ) : cells.vsDefault === null ? (
          <NoValue title={`${base?.display ?? "the base branch"} could not be counted.`} />
        ) : (
          <>
            <AheadBehindCell ab={cells.vsDefault} />
            {cells.merged === true && <RefTag label="merged" title={MERGED_TITLE} />}
          </>
        )}
      </td>
      <td className={`${TD_CLASS} max-w-[26rem]`}>
        {row.lastCommit === null ? (
          <NoValue title={`The commit ${row.ref.name} points at could not be read.`} />
        ) : (
          <span className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] text-accent">
              {shortOid(row.lastCommit.oid)}
            </span>
            <span className="truncate text-ink" title={row.lastCommit.subject}>
              {row.lastCommit.subject}
            </span>
          </span>
        )}
      </td>
      <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>
        {row.lastCommit?.author ?? "—"}
      </td>
      <td className={`${TD_CLASS} whitespace-nowrap text-muted tabular-nums`}>
        {row.lastCommit === null ? "—" : timeAgo(row.lastCommit.timestamp, now)}
      </td>
      <td className={`${TD_CLASS} w-8`}>
        <RowMenu row={row} base={base} />
      </td>
    </>
  );
}

/** The branches table of Design §14.6: a `grid`, one focusable row per branch. */
export function BranchTable({ rows, now }: { rows: BranchRow[]; now: number }) {
  const cells = useStore((s) => s.branches.cells);
  const base = useStore(useShallow(selectBranchBase));
  const defaultName = useStore((s) => s.repo?.defaultRef?.name ?? null);
  const requestBranchCells = useStore((s) => s.requestBranchCells);
  const showBranchHistory = useStore((s) => s.showBranchHistory);
  const { focusIndex, setFocusIndex } = useRowNavigation(rows.length);

  // Lazily filled cells: the rows the table is showing, which the store asks for 50 at a time.
  const names = rows.map((r) => r.ref.fullName).join("\n");
  useEffect(() => {
    if (names === "") return;
    requestBranchCells(names.split("\n"));
  }, [names, requestBranchCells]);

  return (
    <table role="grid" aria-label="Branches" className={GRID_CLASS}>
      <thead>
        <tr>
          {[
            "Branch",
            "vs upstream",
            `vs ${defaultName ?? "base"}`,
            "Last commit",
            "Author",
            "Age",
          ].map((label) => (
            <th key={label} scope="col" className={TH_CLASS}>
              {label}
            </th>
          ))}
          <th scope="col" className={TH_CLASS}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody data-rows>
        {rows.map((row, i) => (
          <tr
            key={row.ref.fullName}
            data-row-index={i}
            data-ref={row.ref.fullName}
            tabIndex={i === focusIndex ? 0 : -1}
            title={`Show the history of ${row.ref.name}`}
            className="cursor-pointer hover:bg-surface-raised focus-visible:bg-accent-subtle"
            onFocus={() => setFocusIndex(i)}
            onClick={() => showBranchHistory(row.ref.fullName)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                showBranchHistory(row.ref.fullName);
              }
            }}
          >
            <BranchRowCells row={row} cells={cells[row.ref.fullName]} base={base} now={now} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
