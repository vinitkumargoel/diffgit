import { Command } from "cmdk";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { requestScrollTo } from "../scrollBus";
import { selectVisibleFiles, useStore } from "../store";
import { filePathOf } from "../treeModel";

/** How many "Go to file" rows are handed to cmdk; it scores and orders what it gets. */
export const MAX_FILE_ROWS = 50;

/** Subsequence match, the cheap pre-narrowing in front of cmdk's scorer (case-insensitive). */
export function subsequence(haystack: string, needle: string): boolean {
  if (needle === "") return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

export interface PaletteFileGroupProps {
  search: string;
  onRun: (action: () => void) => void;
}

/**
 * "Go to file" results group (capped at `MAX_FILE_ROWS`, pre-filtered by `subsequence`).
 */
export function PaletteFileGroup({ search, onRun }: PaletteFileGroupProps) {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const files = useStore(useShallow(selectVisibleFiles));

  // Pre-narrowed so a 5,000-file diff never renders 5,000 rows; cmdk ranks the survivors.
  const fileRows = useMemo(
    () => files.filter((f) => subsequence(filePathOf(f), search)).slice(0, MAX_FILE_ROWS),
    [files, search],
  );

  if (fileRows.length === 0) return null;

  return (
    <Command.Group heading="Go to file">
      {fileRows.map((f) => (
        <Command.Item
          key={f.id}
          value={`file:${f.id}`}
          keywords={[filePathOf(f)]}
          onSelect={() =>
            onRun(() => {
              if (mode !== "files") setMode("files");
              setActiveFile(f.id);
              requestScrollTo(f.id);
            })
          }
        >
          <span className="truncate">{filePathOf(f)}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}
