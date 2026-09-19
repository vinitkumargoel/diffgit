import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileDiff } from "../../engine/types";
import { useShortcuts } from "../hooks/useShortcuts";
import { type FileGroup, filePathOf, type SidebarSectionId } from "../treeModel";
import type { Row } from "./fileTree.styles";

export interface VirtualizerLike {
  scrollToIndex: (index: number, options?: { align?: "auto" | "start" | "center" | "end" }) => void;
}

export interface UseFileTreeNavigationOptions {
  rows: Row[];
  scrollRef: RefObject<HTMLDivElement | null>;
  virtual: boolean;
  virtualizer: VirtualizerLike;
  activeFileId: string | null;
  activate: (file: FileDiff) => void;
  toggleViewed: (fileId: string) => void;
  setViewed: (fileIds: string[], viewed: boolean) => void;
  allViewedIn: (group: FileGroup) => boolean;
  toggleGroup: (id: SidebarSectionId) => void;
  toggleDir: (key: string) => void;
  collapsedGroups: ReadonlySet<SidebarSectionId>;
  collapsedDirs: ReadonlySet<string>;
  grouped: boolean;
  openExplain: (path: string, index: number) => void;
}

function pathOfRow(row: Row | undefined): string | null {
  return row?.kind === "hidden"
    ? row.entry.path
    : row?.kind === "file"
      ? filePathOf(row.file)
      : null;
}

export function useFileTreeNavigation({
  rows,
  scrollRef,
  virtual,
  virtualizer,
  activeFileId,
  activate,
  toggleViewed,
  setViewed,
  allViewedIn,
  toggleGroup,
  toggleDir,
  collapsedGroups,
  collapsedDirs,
  grouped,
  openExplain,
}: UseFileTreeNavigationOptions) {
  const [focusIndex, setFocusIndex] = useState(0);
  const pendingFocus = useRef<number | null>(null);

  const focusRow = useCallback(
    (i: number) => {
      const idx = Math.max(0, Math.min(rows.length - 1, i));
      setFocusIndex(idx);
      pendingFocus.current = idx;
      if (virtual) virtualizer.scrollToIndex(idx);
    },
    [rows.length, virtual, virtualizer],
  );

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${pendingFocus.current}"]`,
    );
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  useEffect(() => {
    if (focusIndex >= rows.length) setFocusIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusIndex]);

  const fileRows = useMemo(() => rows.filter((r) => r.kind === "file"), [rows]);

  // j / k / v (Plan §6.1)
  const step = useCallback(
    (delta: 1 | -1) => {
      if (fileRows.length === 0) return;
      const at = fileRows.findIndex((r) => r.kind === "file" && r.file.id === activeFileId);
      const next =
        at === -1
          ? delta === 1
            ? 0
            : fileRows.length - 1
          : Math.max(0, Math.min(fileRows.length - 1, at + delta));
      const row = fileRows[next];
      if (row?.kind !== "file") return;
      activate(row.file);
      const idx = rows.indexOf(row);
      if (virtual) virtualizer.scrollToIndex(idx, { align: "auto" });
      else
        scrollRef.current
          ?.querySelector(`[data-index="${idx}"]`)
          ?.scrollIntoView?.({ block: "nearest" });
    },
    [fileRows, rows, activeFileId, activate, virtual, virtualizer, scrollRef],
  );

  useShortcuts({
    j: () => step(1),
    k: () => step(-1),
    v: () => {
      if (activeFileId) toggleViewed(activeFileId);
    },
  });

  /** Keyboard model (WAI-ARIA tree / listbox): attached to every row, reads the focused index. */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const row = rows[focusIndex];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(focusIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(focusIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        focusRow(0);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.kind === "hidden-group") {
          e.preventDefault();
          if (collapsedGroups.has("hidden")) toggleGroup("hidden");
          else focusRow(focusIndex + 1);
        } else if (row?.kind === "group") {
          e.preventDefault();
          if (collapsedGroups.has(row.group.id)) toggleGroup(row.group.id);
          else focusRow(focusIndex + 1);
        } else if (row?.kind === "dir") {
          e.preventDefault();
          if (collapsedDirs.has(row.dirKey)) toggleDir(row.dirKey);
          else focusRow(focusIndex + 1);
        }
        break;
      case "ArrowLeft":
        if (row?.kind === "hidden-group") {
          if (!collapsedGroups.has("hidden")) {
            e.preventDefault();
            toggleGroup("hidden");
          }
        } else if (row?.kind === "group") {
          if (!collapsedGroups.has(row.group.id)) {
            e.preventDefault();
            toggleGroup(row.group.id);
          }
        } else if (row?.kind === "dir" && !collapsedDirs.has(row.dirKey)) {
          e.preventDefault();
          toggleDir(row.dirKey);
        } else if (row && row.depth > 0) {
          e.preventDefault();
          for (let i = focusIndex - 1; i >= 0; i--) {
            if (rows[i]?.depth === row.depth - 1) {
              focusRow(i);
              break;
            }
          }
        } else if ((grouped || row?.kind === "hidden" || row?.kind === "hidden-empty") && row) {
          // a depth-0 row inside a group: its parent is the group header (P5)
          e.preventDefault();
          for (let i = focusIndex - 1; i >= 0; i--) {
            const above = rows[i];
            if (above?.kind === "group" || above?.kind === "hidden-group") {
              focusRow(i);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        if (!row) break;
        e.preventDefault();
        if (row.kind === "group") toggleGroup(row.group.id);
        else if (row.kind === "hidden-group") toggleGroup("hidden");
        else if (row.kind === "dir") toggleDir(row.dirKey);
        else if (row.kind === "hidden") openExplain(row.entry.path, focusIndex);
        else if (row.kind === "file") activate(row.file);
        break;
      case "?": {
        // T11.4: "why is this not in the diff" for the focused row — a Hidden row or any file.
        // preventDefault also stops the global `?` from opening the shortcuts dialog instead.
        const path = pathOfRow(row);
        if (path === null) break;
        e.preventDefault();
        openExplain(path, focusIndex);
        break;
      }
      case "v":
        // the group's own "mark all viewed"; preventDefault stops the global `v` as well
        if (row?.kind === "group") {
          e.preventDefault();
          setViewed(
            row.group.files.map((f) => f.id),
            !allViewedIn(row.group),
          );
        }
        break;
      default:
    }
  };

  return {
    focusIndex,
    setFocusIndex,
    focusRow,
    pendingFocus,
    onKeyDown,
  };
}
