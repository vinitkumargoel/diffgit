import { Command } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RepoRef } from "../../engine/types";
import { findRef, groupRefs, refBadges } from "../refGroups";
import { Badge } from "./Badge";

export interface BranchPickerProps {
  /** "base" or "compare" — used for accessible names only; the engine calls them target/source. */
  label: string;
  /** Full ref name currently selected ("refs/heads/x", "refs/remotes/o/x" or "HEAD"). */
  value: string;
  refs: readonly RepoRef[];
  onSelect: (ref: RepoRef) => void;
}

function RefRow({ entry: r, selected }: { entry: RepoRef; selected: boolean }) {
  return (
    <>
      {selected ? (
        <Check size={14} aria-label="current" className="shrink-0" />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <span className="truncate">{r.name}</span>
      {refBadges(r).map((b) => (
        <Badge key={b} kind={b} />
      ))}
    </>
  );
}

/**
 * Searchable branch dropdown (Design §7.1): fixed-min-width trigger with badges, cmdk popover with
 * "Local" / "Remote: <name>" groups, synthetic HEAD entry pinned first, ↑↓ Enter Esc.
 */
export function BranchPicker({ label, value, refs, onSelect }: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = findRef(refs, value);
  const groups = useMemo(() => groupRefs(refs), [refs]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const choose = (r: RepoRef) => {
    onSelect(r);
    close(true);
  };

  const item = (r: RepoRef) => (
    <Command.Item
      key={r.fullName}
      value={r.fullName}
      keywords={[r.name]}
      onSelect={() => choose(r)}
      aria-selected={r.fullName === value}
    >
      <RefRow entry={r} selected={r.fullName === value} />
    </Command.Item>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="btn min-w-[170px] gap-1.5 bg-bg font-mono text-xs font-medium"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label} branch: ${current?.name ?? value}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">{current?.name ?? value}</span>
        {current && refBadges(current).map((b) => <Badge key={b} kind={b} />)}
        <ChevronDown size={10} aria-hidden className="ml-auto shrink-0 text-muted" />
      </button>
      {open && (
        <div className="popover absolute top-full left-0 z-20 mt-1 w-80">
          <Command label={`Find a ${label} branch`} loop>
            <Command.Input
              autoFocus
              placeholder="Find a branch…"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close(true);
                }
              }}
            />
            <Command.List id={listId} className="max-h-80 overflow-y-auto p-1">
              <Command.Empty>No matching branches</Command.Empty>
              {groups.pinned.length > 0 && <Command.Group>{groups.pinned.map(item)}</Command.Group>}
              {groups.local.length > 0 && (
                <Command.Group heading="Local">{groups.local.map(item)}</Command.Group>
              )}
              {groups.remotes.map((g) => (
                <Command.Group key={g.remote} heading={`Remote: ${g.remote}`}>
                  {g.refs.map(item)}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}
