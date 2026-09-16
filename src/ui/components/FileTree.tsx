import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileDiff } from "../../engine/types";
import { useShortcuts } from "../hooks/useShortcuts";
import { requestScrollTo } from "../scrollBus";
import {
  isViewed,
  type SidebarLayout,
  selectTreeModel,
  selectVisibleFiles,
  useStore,
} from "../store";
import { flattenTree, type TreeDir } from "../treeModel";
import { FileRow } from "./FileRow";

/** Rows above this count are virtualised (T5.2; Plan §6.7). */
const VIRTUALISE_ABOVE = 300;
const DIR_ROW = 24;
const FILE_ROW = 26;

type Row =
  | { key: string; kind: "dir"; node: TreeDir; depth: number }
  | { key: string; kind: "file"; file: FileDiff; depth: number };

export interface FileTreeProps {
  layout: SidebarLayout;
  /** Test seam for the virtualiser's initial viewport (happy-dom has no layout). */
  initialRect?: { width: number; height: number };
}

/**
 * Tree (collapsible, compacted chains) or flat list of changed files with roving tabindex,
 * `j`/`k`/`v` shortcuts, `prioritise()` for the visible window and virtualisation above 300 rows.
 */
export function FileTree({ layout, initialRect }: FileTreeProps) {
  const files = useStore(selectVisibleFiles);
  const tree = useStore(selectTreeModel);
  const filter = useStore((s) => s.filter);
  const activeFileId = useStore((s) => s.activeFileId);
  const statsMap = useStore((s) => s.stats);
  const viewedSet = useStore((s) => s.viewed);
  const diff = useStore((s) => s.diff);
  const repoId = useStore((s) => s.repoId);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const prioritise = useStore((s) => s.prioritise);

  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo<Row[]>(() => {
    if (layout === "flat")
      return files.map((f) => ({ key: f.id, kind: "file", file: f, depth: 0 }));
    return flattenTree(tree, collapsedDirs).map(({ node, depth }) =>
      node.kind === "dir"
        ? { key: `d:${node.path}`, kind: "dir", node, depth }
        : { key: node.file.id, kind: "file", file: node.file, depth },
    );
  }, [layout, files, tree, collapsedDirs]);
  const fileRows = useMemo(() => rows.filter((r) => r.kind === "file"), [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "dir" ? DIR_ROW : FILE_ROW),
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

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activate = useCallback(
    (file: FileDiff) => {
      setActiveFile(file.id);
      requestScrollTo(file.id);
    },
    [setActiveFile],
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
        if (row?.kind === "dir") {
          e.preventDefault();
          if (collapsedDirs.has(row.node.path)) toggleDir(row.node.path);
          else focusRow(focusIndex + 1);
        }
        break;
      case "ArrowLeft":
        if (row?.kind === "dir" && !collapsedDirs.has(row.node.path)) {
          e.preventDefault();
          toggleDir(row.node.path);
        } else if (row && row.depth > 0) {
          e.preventDefault();
          for (let i = focusIndex - 1; i >= 0; i--) {
            if (rows[i]?.depth === row.depth - 1) {
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
        if (row.kind === "dir") toggleDir(row.node.path);
        else activate(row.file);
        break;
      default:
    }
  };

  const renderRow = (row: Row, index: number, style?: CSSProperties) => {
    const tabIndex = index === focusIndex ? 0 : -1;
    const onFocus = () => setFocusIndex(index);
    if (row.kind === "dir") {
      const open = !collapsedDirs.has(row.node.path);
      return (
        <div
          key={row.key}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={open}
          aria-selected={false}
          data-index={index}
          tabIndex={tabIndex}
          className="flex h-6 cursor-pointer items-center gap-1 text-xs text-muted select-none hover:bg-surface-raised"
          style={{ ...style, paddingLeft: 12 + row.depth * 14 }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onClick={() => toggleDir(row.node.path)}
        >
          {open ? (
            <ChevronDown size={9} aria-hidden className="shrink-0" />
          ) : (
            <ChevronRight size={9} aria-hidden className="shrink-0" />
          )}
          <Folder size={14} aria-hidden className="shrink-0" />
          <span className="truncate">{row.node.name}</span>
        </div>
      );
    }
    const f = row.file;
    return (
      <FileRow
        key={row.key}
        role={layout === "tree" ? "treeitem" : "option"}
        aria-level={layout === "tree" ? row.depth + 1 : undefined}
        aria-selected={f.id === activeFileId}
        data-index={index}
        tabIndex={tabIndex}
        file={f}
        depth={row.depth}
        layout={layout}
        active={f.id === activeFileId}
        viewed={diff ? isViewed({ diff, viewed: viewedSet, repoId }, f) : false}
        stats={statsMap[f.id] ?? f.stats}
        onActivate={() => activate(f)}
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
  return layout === "tree" ? (
    <div role="tree" aria-label="Changed files tree" {...containerProps}>
      {body}
    </div>
  ) : (
    <div role="listbox" aria-label="Changed files" {...containerProps}>
      {body}
    </div>
  );
}
