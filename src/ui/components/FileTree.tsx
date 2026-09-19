import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Folder,
  ListCollapse,
  RotateCcw,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { sourceLabels } from "../../engine/diffSource";
import type { FileDiff, HiddenEntry } from "../../engine/types";
import { useShortcuts } from "../hooks/useShortcuts";
import { requestScrollTo } from "../scrollBus";
import {
  isViewed,
  type SidebarLayout,
  selectConflictKinds,
  selectFailedFiles,
  selectGroupedModel,
  selectGroupTotals,
  selectHasLayers,
  selectHiddenEntries,
  selectSecretCounts,
  selectTreeModel,
  selectVisibleFiles,
  useStore,
} from "../store";
import {
  dirSummary,
  type FileGroup,
  filePathOf,
  flattenTree,
  type LayerCodeInfo,
  layerCode,
  type SidebarGroupId,
  type SidebarSectionId,
  type TreeDir,
} from "../treeModel";
import { FileRow } from "./FileRow";
import { HiddenRow } from "./HiddenRow";
import { type PopoverAnchor, WhyHiddenPopover } from "./WhyHiddenPopover";

/** Rows above this count are virtualised (T5.2; Plan §6.7). */
const VIRTUALISE_ABOVE = 300;
const DIR_ROW = 24;
const FILE_ROW = 26;
const GROUP_ROW = 28;

/** D1 labels; `committed` gains the compare branch ("Committed on feature"). */
const GROUP_LABELS: Record<SidebarGroupId, string> = {
  conflict: "Conflicts",
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
  committed: "Committed",
};
/** D6 item 2: the 7 px dot, one token per layer. */
const GROUP_DOT: Record<SidebarGroupId, string> = {
  conflict: "bg-chip-conflict-fg",
  staged: "bg-chip-staged-fg",
  unstaged: "bg-chip-unstaged-fg",
  untracked: "bg-chip-untracked-fg",
  committed: "bg-muted",
};
const ACTION_CLASS =
  "hidden size-5 shrink-0 items-center justify-center rounded-[4px] text-muted hover:bg-line group-hover:inline-flex group-focus-within:inline-flex";

type Row =
  | { key: string; kind: "group"; group: FileGroup; depth: 0 }
  | { key: string; kind: "dir"; node: TreeDir; depth: number; dirKey: string }
  | { key: string; kind: "file"; file: FileDiff; depth: number }
  /** T11.4: the Hidden section header and its rows (Design §14.4). */
  | { key: string; kind: "hidden-group"; entries: HiddenEntry[]; total: number; depth: 0 }
  | { key: string; kind: "hidden"; entry: HiddenEntry; depth: 0 }
  | { key: string; kind: "hidden-empty"; depth: 0 };

export interface FileTreeProps {
  layout: SidebarLayout;
  /** Test seam for the virtualiser's initial viewport (happy-dom has no layout). */
  initialRect?: { width: number; height: number };
}

/**
 * Tree (collapsible, compacted chains) or flat list of changed files with roving tabindex,
 * `j`/`k`/`v` shortcuts, `prioritise()` for the visible window and virtualisation above 300 rows.
 * With more than one change layer it groups by layer (T9.1, D1–D9): a sticky header per group,
 * the tree (or the flat list) inside it, and the XY code on the rows the header cannot explain.
 */
export function FileTree({ layout, initialRect }: FileTreeProps) {
  const files = useStore(selectVisibleFiles);
  const tree = useStore(selectTreeModel);
  const groups = useStore(selectGroupedModel);
  const groupTotals = useStore(selectGroupTotals);
  const hasLayers = useStore(selectHasLayers);
  const sidebarGroup = useStore((s) => s.prefs.sidebarGroup);
  const filter = useStore((s) => s.filter);
  const activeFileId = useStore((s) => s.activeFileId);
  const statsMap = useStore((s) => s.stats);
  const viewedSet = useStore((s) => s.viewed);
  const diff = useStore((s) => s.diff);
  const repoId = useStore((s) => s.repoId);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const setViewed = useStore((s) => s.setViewed);
  const prioritise = useStore((s) => s.prioritise);
  const failedFiles = useStore(useShallow(selectFailedFiles));
  const conflictKinds = useStore(useShallow(selectConflictKinds));
  /** T11.9: findings per file id; `{}` while nothing has been scanned or found. */
  const secretCounts = useStore(useShallow(selectSecretCounts));
  const loadFileDiff = useStore((s) => s.loadFileDiff);
  /** T11.4: null while the toggle is off or the listing walk has not answered yet. */
  const hiddenEntries = useStore(selectHiddenEntries);
  const hiddenTotal = useStore((s) => s.hidden?.length ?? 0);

  /** D2: layout-independent — grouping needs a second layer *and* the pref. */
  const grouped = hasLayers && sidebarGroup === "layer";
  const filtering = filter.trim() !== "";
  const compare = diff ? sourceLabels(diff.source).source : "";

  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<SidebarSectionId>>(
    () => new Set(),
  );
  /** The open WhyHidden popover: which path, and the viewport box of the row it belongs to. */
  const [explain, setExplain] = useState<{ path: string; anchor: PopoverAnchor } | null>(null);

  const rows = useMemo<Row[]>(() => {
    /**
     * Design §14.4: `Hidden` is appended after the last group — in Layer mode after
     * `Committed on <compare>`, in Path mode after the plain tree — and exists only while the
     * toggle is on. Its rows are `HiddenEntry`s, never files, so they are always flat: an ignored
     * directory is one row and is never descended into.
     */
    const hidden = (out: Row[]): Row[] => {
      if (hiddenEntries === null) return out;
      out.push({
        key: "g:hidden",
        kind: "hidden-group",
        entries: hiddenEntries,
        total: hiddenTotal,
        depth: 0,
      });
      if (collapsedGroups.has("hidden")) return out;
      if (hiddenEntries.length === 0)
        out.push({ key: "hidden:none", kind: "hidden-empty", depth: 0 });
      for (const entry of hiddenEntries)
        out.push({ key: `h:${entry.path}`, kind: "hidden", entry, depth: 0 });
      return out;
    };
    if (grouped) {
      const out: Row[] = [];
      for (const group of groups) {
        out.push({ key: `g:${group.id}`, kind: "group", group, depth: 0 });
        if (collapsedGroups.has(group.id)) continue;
        if (layout === "flat") {
          for (const f of group.files)
            out.push({ key: `${group.id}:${f.id}`, kind: "file", file: f, depth: 0 });
          continue;
        }
        for (const { node, depth } of flattenTree(group.tree, collapsedDirs, 0, `${group.id}:`)) {
          if (node.kind === "dir") {
            out.push({
              key: `d:${group.id}:${node.path}`,
              kind: "dir",
              node,
              depth,
              dirKey: `${group.id}:${node.path}`,
            });
          } else
            out.push({ key: `${group.id}:${node.file.id}`, kind: "file", file: node.file, depth });
        }
      }
      return hidden(out);
    }
    if (layout === "flat")
      return hidden(files.map((f) => ({ key: f.id, kind: "file", file: f, depth: 0 })));
    return hidden(
      flattenTree(tree, collapsedDirs).map(({ node, depth }) =>
        node.kind === "dir"
          ? { key: `d:${node.path}`, kind: "dir", node, depth, dirKey: node.path }
          : { key: node.file.id, kind: "file", file: node.file, depth },
      ),
    );
  }, [
    grouped,
    groups,
    collapsedGroups,
    layout,
    files,
    tree,
    collapsedDirs,
    hiddenEntries,
    hiddenTotal,
  ]);
  const fileRows = useMemo(() => rows.filter((r) => r.kind === "file"), [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const kind = rows[i]?.kind;
      if (kind === "group" || kind === "hidden-group") return GROUP_ROW;
      return kind === "dir" ? DIR_ROW : FILE_ROW;
    },
    overscan: 10,
    ...(initialRect ? { initialRect } : {}),
  });
  const virtualItems = virtualizer.getVirtualItems();

  // roving tabindex
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

  const toggleDir = useCallback((key: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Collapsing a group unmounts its rows; when the focused row was one of them, DOM focus falls back
   * to <body> and the arrow keys stop reaching the tree. The effect below moves focus to the header
   * that caused it, but only when focus really left the tree (a mouse click on the header or its
   * buttons already focuses them).
   */
  const pendingGroupFocus = useRef<SidebarSectionId | null>(null);
  useEffect(() => {
    const id = pendingGroupFocus.current;
    if (id === null) return;
    pendingGroupFocus.current = null;
    const container = scrollRef.current;
    const active = document.activeElement;
    if (!container || (active && active !== document.body && container.contains(active))) return;
    const idx = rows.findIndex((r) =>
      r.kind === "hidden-group" ? id === "hidden" : r.kind === "group" && r.group.id === id,
    );
    if (idx !== -1) focusRow(idx);
  }, [rows, focusRow]);

  const toggleGroup = useCallback((id: SidebarSectionId) => {
    pendingGroupFocus.current = id;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Header action 2: collapse every other group and open this one. */
  const collapseOthers = useCallback(
    (id: SidebarSectionId) => {
      pendingGroupFocus.current = id;
      const all: SidebarSectionId[] = [...groups.map((g) => g.id)];
      if (hiddenEntries !== null) all.push("hidden");
      setCollapsedGroups(new Set(all.filter((g) => g !== id)));
    },
    [groups, hiddenEntries],
  );

  const activate = useCallback(
    (file: FileDiff) => {
      setActiveFile(file.id);
      requestScrollTo(file.id);
    },
    [setActiveFile],
  );

  /**
   * Opens the WhyHidden popover (Design §14.3) under a row: a click on a Hidden row, `?` on any
   * focused row, or a right-click. Anchored to the row's viewport box and rendered `fixed`, so the
   * scrolling sidebar body never clips it.
   */
  const openExplain = useCallback((path: string, index: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    const box = el?.getBoundingClientRect();
    setExplain({
      path,
      anchor: { left: box ? box.left : 0, bottom: box ? box.bottom : 0 },
    });
  }, []);
  const closeExplain = useCallback(
    (refocus: boolean) => {
      setExplain(null);
      if (refocus) focusRow(focusIndex);
    },
    [focusRow, focusIndex],
  );
  const pathOfRow = (row: Row | undefined): string | null =>
    row?.kind === "hidden" ? row.entry.path : row?.kind === "file" ? filePathOf(row.file) : null;

  const statsOf = useCallback(
    (f: FileDiff): FileDiff["stats"] => statsMap[f.id] ?? f.stats,
    [statsMap],
  );
  const viewedOf = useCallback(
    (f: FileDiff): boolean => (diff ? isViewed({ diff, viewed: viewedSet, repoId }, f) : false),
    [diff, viewedSet, repoId],
  );
  /**
   * D4: grouped, the header says the layer — only a staged-*and*-unstaged file needs the code.
   * T11.3 adds the conflicted rows: `UU` / `AA` / `UD` are the whole point of the Conflicts group
   * (Design §14.3, atlas tab 06), and one "Conflicts" header cannot say which of the five it is.
   */
  const codeOf = useCallback(
    (f: FileDiff): LayerCodeInfo | null => {
      const conflict = f.layers.includes("conflict");
      if (!grouped || conflict) return layerCode(f, conflictKinds[f.id]);
      return f.layers.includes("staged") && f.layers.includes("unstaged") ? layerCode(f) : null;
    },
    [grouped, conflictKinds],
  );
  const allViewedIn = useCallback(
    (group: FileGroup): boolean => group.files.length > 0 && group.files.every(viewedOf),
    [viewedOf],
  );

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
    [fileRows, rows, activeFileId, activate, virtual, virtualizer],
  );
  useShortcuts({
    j: () => step(1),
    k: () => step(-1),
    v: () => {
      if (activeFileId) toggleViewed(activeFileId);
    },
  });

  // prioritise stats for the visible window (debounced 100 ms)
  const visibleIds = useMemo(() => {
    const source = virtual ? virtualItems.map((v) => rows[v.index]) : rows;
    return source.flatMap((r) => (r && r.kind === "file" ? [r.file.id] : []));
  }, [virtual, virtualItems, rows]);
  const visibleKey = visibleIds.join("\n");
  useEffect(() => {
    if (!visibleKey) return;
    const t = setTimeout(() => prioritise(visibleKey.split("\n")), 100);
    return () => clearTimeout(t);
  }, [visibleKey, prioritise]);

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

  const renderGroup = (group: FileGroup, index: number, style?: CSSProperties) => {
    const label =
      group.id === "committed" && compare ? `Committed on ${compare}` : GROUP_LABELS[group.id];
    const open = !collapsedGroups.has(group.id);
    const shown = group.files.length;
    const total = groupTotals[group.id];
    let additions = 0;
    let deletions = 0;
    let counted = 0;
    let seen = 0;
    for (const f of group.files) {
      const st = statsOf(f);
      if (st) {
        additions += st.additions;
        deletions += st.deletions;
        counted++;
      }
      if (viewedOf(f)) seen++;
    }
    const allViewed = shown > 0 && seen === shown;
    const markLabel = allViewed ? `Clear viewed in ${label}` : `Mark all in ${label} viewed`;
    return (
      <div
        key={`g:${group.id}`}
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        aria-selected={false}
        aria-label={`${label}, ${shown} ${shown === 1 ? "file" : "files"}`}
        data-index={index}
        tabIndex={index === focusIndex ? 0 : -1}
        className={`group sticky top-0 z-[1] flex h-7 cursor-pointer items-center gap-[6px] border-b border-line bg-surface-sunken pr-2 select-none ${
          allViewed ? "opacity-55" : ""
        }`}
        style={{ ...style, paddingLeft: 10 }}
        onFocus={() => setFocusIndex(index)}
        onKeyDown={onKeyDown}
        onClick={() => toggleGroup(group.id)}
      >
        {open ? (
          <ChevronDown size={9} aria-hidden className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={9} aria-hidden className="shrink-0 text-muted" />
        )}
        <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${GROUP_DOT[group.id]}`} />
        <span className="truncate text-xs font-semibold">{label}</span>
        <span className="shrink-0 rounded-full border border-line bg-surface-raised px-[5px] font-mono text-[10px] leading-[15px] font-semibold">
          {filtering ? `${shown} of ${total}` : shown}
        </span>
        <span className="flex-1" />
        {counted > 0 && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums whitespace-nowrap">
            <span className="text-success">+{additions}</span>{" "}
            <span className="text-danger">−{deletions}</span>
          </span>
        )}
        <span
          className={`shrink-0 font-mono text-[11px] whitespace-nowrap ${
            allViewed ? "text-success" : "text-muted"
          }`}
        >
          {allViewed ? "✓ " : ""}
          {seen}/{shown}
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={markLabel}
          title={markLabel}
          className={ACTION_CLASS}
          onClick={(e) => {
            e.stopPropagation();
            setViewed(
              group.files.map((f) => f.id),
              !allViewed,
            );
          }}
        >
          {allViewed ? <RotateCcw size={12} aria-hidden /> : <CheckCheck size={12} aria-hidden />}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Collapse other groups"
          title="Collapse other groups"
          className={ACTION_CLASS}
          onClick={(e) => {
            e.stopPropagation();
            collapseOthers(group.id);
          }}
        >
          <ListCollapse size={12} aria-hidden />
        </button>
      </div>
    );
  };

  /**
   * Design §14.4: the Hidden header. No `+n −m` and no viewed count — a hidden path has no stats
   * and cannot be reviewed — and no "mark all viewed" action for the same reason.
   */
  const renderHiddenGroup = (
    entries: HiddenEntry[],
    total: number,
    index: number,
    style?: CSSProperties,
  ) => {
    const open = !collapsedGroups.has("hidden");
    return (
      <div
        key="g:hidden"
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        aria-selected={false}
        aria-label={`Hidden, ${entries.length} ${entries.length === 1 ? "path" : "paths"}`}
        data-index={index}
        data-group="hidden"
        tabIndex={index === focusIndex ? 0 : -1}
        className="group sticky top-0 z-[1] flex h-7 cursor-pointer items-center gap-[6px] border-b border-line bg-surface-sunken pr-2 select-none"
        style={{ ...style, paddingLeft: 10 }}
        onFocus={() => setFocusIndex(index)}
        onKeyDown={onKeyDown}
        onClick={() => toggleGroup("hidden")}
      >
        {open ? (
          <ChevronDown size={9} aria-hidden className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={9} aria-hidden className="shrink-0 text-muted" />
        )}
        <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-muted" />
        <span className="truncate text-xs font-semibold text-muted">Hidden</span>
        <span className="shrink-0 rounded-full border border-line bg-surface-raised px-[5px] font-mono text-[10px] leading-[15px] font-semibold text-muted">
          {filtering && entries.length !== total ? `${entries.length} of ${total}` : entries.length}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Collapse other groups"
          title="Collapse other groups"
          className={ACTION_CLASS}
          onClick={(e) => {
            e.stopPropagation();
            collapseOthers("hidden");
          }}
        >
          <ListCollapse size={12} aria-hidden />
        </button>
      </div>
    );
  };

  const renderRow = (row: Row, index: number, style?: CSSProperties) => {
    const tabIndex = index === focusIndex ? 0 : -1;
    const onFocus = () => setFocusIndex(index);
    if (row.kind === "group") return renderGroup(row.group, index, style);
    if (row.kind === "hidden-group") return renderHiddenGroup(row.entries, row.total, index, style);
    if (row.kind === "hidden-empty") {
      return (
        <p
          key={row.key}
          data-index={index}
          className="px-3 py-1 text-[11px] leading-5 text-muted"
          style={style}
        >
          {filtering ? "No hidden path matches the filter" : "Nothing is hidden in this repository"}
        </p>
      );
    }
    if (row.kind === "hidden") {
      return (
        <HiddenRow
          key={row.key}
          entry={row.entry}
          active={explain?.path === row.entry.path}
          onExplain={() => openExplain(row.entry.path, index)}
          index={index}
          tabIndex={tabIndex}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          {...(style ? { style } : {})}
        />
      );
    }
    if (row.kind === "dir") {
      const open = !collapsedDirs.has(row.dirKey);
      const summary = open ? null : dirSummary(row.node, statsOf);
      return (
        <div
          key={row.key}
          role="treeitem"
          aria-level={row.depth + (grouped ? 2 : 1)}
          aria-expanded={open}
          aria-selected={false}
          data-index={index}
          tabIndex={tabIndex}
          className={`flex h-6 cursor-pointer items-center gap-1 text-xs text-muted select-none hover:bg-surface-raised${
            summary ? " pr-2" : ""
          }`}
          style={{ ...style, paddingLeft: 12 + row.depth * 14 }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onClick={() => toggleDir(row.dirKey)}
        >
          {open ? (
            <ChevronDown size={9} aria-hidden className="shrink-0" />
          ) : (
            <ChevronRight size={9} aria-hidden className="shrink-0" />
          )}
          <Folder size={14} aria-hidden className="shrink-0" />
          <span className="truncate">{row.node.name}</span>
          {summary && (
            <>
              <span className="flex-1" />
              <span className="shrink-0 font-mono text-[11px] text-muted">{summary.files}</span>
              {summary.complete && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums whitespace-nowrap">
                  <span className="text-success">+{summary.additions}</span>{" "}
                  <span className="text-danger">−{summary.deletions}</span>
                </span>
              )}
            </>
          )}
        </div>
      );
    }
    const f = row.file;
    const asTree = grouped || layout === "tree";
    return (
      <FileRow
        key={row.key}
        role={asTree ? "treeitem" : "option"}
        aria-level={asTree ? row.depth + (grouped ? 2 : 1) : undefined}
        aria-selected={f.id === activeFileId}
        data-index={index}
        tabIndex={tabIndex}
        file={f}
        depth={row.depth}
        layout={layout}
        active={f.id === activeFileId}
        viewed={viewedOf(f)}
        stats={statsOf(f)}
        code={codeOf(f)}
        secrets={secretCounts[f.id] ?? 0}
        failed={failedFiles.has(f.id)}
        onRetry={() => void loadFileDiff(f.id)}
        onActivate={() => activate(f)}
        onExplain={() => openExplain(filePathOf(f), index)}
        onToggleViewed={() => toggleViewed(f.id)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        style={style}
      />
    );
  };

  if (rows.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted">
        {filter.trim() ? `No files match “${filter.trim()}”` : "No changed files"}
      </p>
    );
  }

  const body = virtual ? (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualItems.map((v) => {
        const row = rows[v.index];
        return row
          ? renderRow(row, v.index, {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${v.start}px)`,
            })
          : null;
      })}
    </div>
  ) : (
    rows.map((row, i) => renderRow(row, i))
  );
  const containerProps = {
    ref: scrollRef,
    className: "min-h-0 flex-1 overflow-y-auto py-1.5",
    "data-total": rows.length,
    "data-virtual": virtual ? "true" : "false",
  };
  const popover =
    explain === null ? null : (
      <WhyHiddenPopover path={explain.path} anchor={explain.anchor} onClose={closeExplain} />
    );
  // Grouped: always a tree, because the group headers are the level-1 treeitems (both layouts).
  return grouped || layout === "tree" ? (
    <>
      <div role="tree" aria-label="Changed files tree" {...containerProps}>
        {body}
      </div>
      {popover}
    </>
  ) : (
    <>
      <div role="listbox" aria-label="Changed files" {...containerProps}>
        {body}
      </div>
      {popover}
    </>
  );
}
