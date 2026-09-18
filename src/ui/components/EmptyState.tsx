import { GitCompare, Search } from "lucide-react";
import { useShortcuts } from "../hooks/useShortcuts";
import { useStore } from "../store";
import { CenteredColumn } from "./CenteredColumn";

/** Opens the base BranchPicker in the top bar (its trigger is labelled "base branch: <name>"). */
export function openBasePicker(root: ParentNode = document): boolean {
  const trigger = root.querySelector<HTMLButtonElement>('button[aria-label^="base branch"]');
  if (!trigger) return false;
  trigger.focus();
  trigger.click();
  return true;
}

const Branch = ({ name }: { name: string }) => (
  <code className="rounded-[3px] bg-surface-raised px-1.5 py-0.5 font-mono text-[13px]">
    {name}
  </code>
);

/** Design §7.8 / Plan D7 / mockup S7: replaces sidebar + pane when the diff has no files. */
export function EmptyState() {
  const src = useStore((s) => s.diffSource);
  const swapBranches = useStore((s) => s.swapBranches);
  // DiffSource.source / target are the display names; *Ref are the full ref names
  const source = src?.source ?? "";
  const target = src?.target ?? "";
  const sameRef = source !== "" && source === target;
  return (
    <CenteredColumn as="section" label="No changes">
      <GitCompare size={32} className="text-muted" aria-hidden="true" />
      <h1 className="text-xl font-semibold leading-7">
        {sameRef ? (
          <>
            No changes: <Branch name={source} /> is compared with itself
          </>
        ) : (
          <>
            No changes between <Branch name={source} /> and <Branch name={target} />
          </>
        )}
      </h1>
      {src?.includeWorktree && <p className="text-muted">Working tree is clean.</p>}
      <p className="text-muted">
        Commits on <Branch name={target} /> after the merge base are not shown by design.
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className="btn" onClick={() => openBasePicker()}>
          Change base
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => swapBranches()}>
          Swap ⇄
        </button>
      </div>
    </CenteredColumn>
  );
}

/**
 * Mockup S6: the filter matches nothing. Replaces sidebar + pane so the tree is never an empty
 * box with no explanation. Esc clears the filter from anywhere on the screen.
 */
export function FilterEmptyState() {
  const filter = useStore((s) => s.filter);
  const total = useStore((s) => s.diff?.files.length ?? 0);
  const setFilter = useStore((s) => s.setFilter);
  useShortcuts({ Escape: () => setFilter("") });
  return (
    <CenteredColumn as="section" label="No files match">
      <Search size={28} className="text-muted" aria-hidden="true" />
      <h1 className="text-xl font-semibold leading-7">
        No files match <Branch name={filter} />
      </h1>
      <p className="text-muted">
        {total.toLocaleString("en-US")} files changed in this diff. Filters match on path,{" "}
        <Branch name="status:M" /> and <Branch name="layer:staged" />.
      </p>
      <button type="button" className="btn" onClick={() => setFilter("")}>
        Clear filter
        <kbd className="kbd" aria-hidden>
          esc
        </kbd>
      </button>
    </CenteredColumn>
  );
}
