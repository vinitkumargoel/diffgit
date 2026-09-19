import { useEffect } from "react";
import { STACK_LIMIT, shortOid } from "../history";
import { selectCanIncludeWorktree, useStore } from "../store";

/**
 * The `Stack` sub-tab (Design §14.5, atlas tab 04): the commits compare has since the merge base,
 * newest on top, each a collapsed card with its subject, SHA, file count and `+n −m`. An
 * `Uncommitted` entry sits above them while the working tree is part of the comparison.
 *
 * **Expanding shows the commit in the diff pane rather than inside the card.** A `RepoSession` has
 * exactly one current diff (`requireGeneration`), so a second `computeDiff` would make the pane's
 * own generation STALE; the honest reading of "expand → its per-commit diff" is therefore to select
 * that commit, which is what clicking a row in the Commits tab does (recorded in the CHANGELOG).
 */
export function StackList() {
  const stack = useStore((s) => s.stack);
  const statsMap = useStore((s) => s.commitStats);
  const selected = useStore((s) => s.history.selected);
  const loadStack = useStore((s) => s.loadStack);
  const showCommit = useStore((s) => s.showCommit);
  const setSpecialSource = useStore((s) => s.setSpecialSource);
  const worktree = useStore(selectCanIncludeWorktree);
  const includeWorktree = useStore((s) => s.diffSource?.includeWorktree === true);
  const uncommitted = useStore(
    (s) => s.diff?.files.filter((f) => f.layers.some((l) => l !== "committed")).length ?? 0,
  );
  const isCommitSelected = useStore((s) => s.diffSource?.kind === "range");

  useEffect(() => {
    if (!stack.ready && !stack.loading) void loadStack();
  }, [stack.ready, stack.loading, loadStack]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <p className="px-1 pb-2 text-[11px] leading-4 text-muted">
        {stack.loading
          ? "Walking back to the merge base…"
          : stack.base === null
            ? `${stack.label || "compare"} · no merge base`
            : `${stack.label} · merge base ${shortOid(stack.base)}`}
      </p>
      {stack.capped && (
        <p className="mb-2 rounded-[6px] border border-banner-warning-border bg-banner-warning-bg px-2 py-1 text-[11.5px] leading-4 text-ink">
          Stopped after {STACK_LIMIT} commits without reaching the merge base.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {worktree && includeWorktree && (
          <li>
            <button
              type="button"
              aria-pressed={!isCommitSelected}
              className={`w-full rounded-[6px] border border-line px-2.5 py-1.5 text-left ${
                isCommitSelected ? "bg-surface" : "bg-accent-subtle"
              }`}
              onClick={() => setSpecialSource("worktree")}
            >
              <span className="block truncate text-[12.5px] leading-5 font-medium text-ink">
                Uncommitted changes
              </span>
              <span className="text-[11px] leading-4 text-muted">
                working tree · {uncommitted} {uncommitted === 1 ? "file" : "files"}
              </span>
            </button>
          </li>
        )}
        {stack.commits.map((c, i) => {
          const stats = statsMap[c.oid];
          const isSelected = c.oid === selected && isCommitSelected;
          return (
            <li key={c.oid}>
              <button
                type="button"
                data-oid={c.oid}
                aria-pressed={isSelected}
                className={`w-full rounded-[6px] border border-line px-2.5 py-1.5 text-left ${
                  isSelected ? "bg-accent-subtle" : "bg-surface hover:bg-surface-raised"
                }`}
                onClick={() => void showCommit(c.oid)}
              >
                <span className="flex items-baseline gap-2">
                  <span aria-hidden className="shrink-0 font-mono text-[11px] text-muted">
                    {stack.commits.length - i}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-medium text-ink">
                    {c.subject}
                  </span>
                </span>
                <span className="mt-0.5 flex items-baseline gap-2 text-[11px] leading-4 text-muted">
                  <span className="font-mono text-accent">{shortOid(c.oid)}</span>
                  {stats === undefined ? (
                    <span>counting…</span>
                  ) : stats === null ? (
                    <span>not counted</span>
                  ) : (
                    <>
                      <span>
                        {stats.files} {stats.files === 1 ? "file" : "files"}
                      </span>
                      <span className="font-mono tabular-nums">
                        <span className="text-success">+{stats.additions}</span>{" "}
                        <span className="text-danger">−{stats.deletions}</span>
                      </span>
                    </>
                  )}
                  <span className="ml-auto text-accent">{isSelected ? "Shown" : "Expand"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!stack.loading && stack.commits.length === 0 && (
        <p className="px-1 py-2 text-[12.5px] leading-5 text-muted">
          Compare is at the base — there is nothing stacked on top of it.
        </p>
      )}
      <p className="px-1 pt-3 text-center text-[11px] leading-4 text-muted">
        ▲ newest on top · a card opens its commit in the pane
      </p>
    </div>
  );
}
