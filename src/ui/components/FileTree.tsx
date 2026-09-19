import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { sourceLabels } from "../../engine/diffSource";
import type { FileDiff } from "../../engine/types";
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
  type FileGroup,
  filePathOf,
  flattenTree,
  type LayerCodeInfo,
  layerCode,
  type SidebarSectionId,
} from "../treeModel";
import { FileRow } from "./FileRow";
import { FileTreeDirRow } from "./FileTreeDirRow";
import { FileTreeGroupHeader, FileTreeHiddenGroupHeader } from "./FileTreeGroupHeader";
import { DIR_ROW, FILE_ROW, GROUP_ROW, type Row, VIRTUALISE_ABOVE } from "./fileTree.styles";
import { HiddenRow } from "./HiddenRow";
import { useFileTreeNavigation } from "./useFileTreeNavigation";
import { type PopoverAnchor, WhyHiddenPopover } from "./WhyHiddenPopover";

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

  const { focusIndex, setFocusIndex, focusRow, onKeyDown } = useFileTreeNavigation({
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
  });

  const closeExplain = useCallback(
    (refocus: boolean) => {
      setExplain(null);
      if (refocus) focusRow(focusIndex);
    },
    [focusRow, focusIndex],
  );

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

  const renderRow = (row: Row, index: number, style?: CSSProperties) => {
    const tabIndex = index === focusIndex ? 0 : -1;
    const onFocus = () => setFocusIndex(index);
    if (row.kind === "group") {
      return (
        <FileTreeGroupHeader
          key={row.key}
          group={row.group}
          index={index}
          open={!collapsedGroups.has(row.group.id)}
          compare={compare}
          total={groupTotals[row.group.id]}
          filtering={filtering}
          tabIndex={tabIndex}
          statsOf={statsOf}
          viewedOf={viewedOf}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onToggle={() => toggleGroup(row.group.id)}
          onSetViewed={setViewed}
          onCollapseOthers={() => collapseOthers(row.group.id)}
          style={style}
        />
      );
    }
    if (row.kind === "hidden-group") {
      return (
        <FileTreeHiddenGroupHeader
          key={row.key}
          entries={row.entries}
          total={row.total}
          index={index}
          open={!collapsedGroups.has("hidden")}
          filtering={filtering}
          tabIndex={tabIndex}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onToggle={() => toggleGroup("hidden")}
          onCollapseOthers={() => collapseOthers("hidden")}
          style={style}
        />
      );
    }
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
      return (
        <FileTreeDirRow
          key={row.key}
          node={row.node}
          depth={row.depth}
          dirKey={row.dirKey}
          index={index}
          open={!collapsedDirs.has(row.dirKey)}
          grouped={grouped}
          tabIndex={tabIndex}
          statsOf={statsOf}
          onToggle={() => toggleDir(row.dirKey)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          style={style}
        />
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
