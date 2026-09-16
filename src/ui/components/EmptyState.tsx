import { GitCompare } from "lucide-react";
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

/** Design §7.8 / Plan D7: replaces sidebar + pane when the diff has no files. */
export function EmptyState() {
  const src = useStore((s) => s.diffSource);
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
      <button type="button" className="btn" onClick={() => openBasePicker()}>
        Change base
      </button>
    </CenteredColumn>
  );
}
