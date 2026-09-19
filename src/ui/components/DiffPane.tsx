import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import type { FileDiff } from "../../engine/types";
import { useShortcuts } from "../hooks/useShortcuts";
import { onScrollRequest } from "../scrollBus";
import { selectVisibleFiles, useStore } from "../store";
import { FileCard, hasCommittedSide } from "./FileCard";

const HEADER_PX = 41;
const ROW_PX = 20;
const MAX_ESTIMATE = 900;

/** Rough card height before measurement: header + a row per changed line (+ context), capped. */
function estimateCardHeight(stats: FileDiff["stats"], collapsed: boolean): number {
  if (collapsed) return HEADER_PX;
  const changed = stats ? stats.additions + stats.deletions : 12;
  return Math.min(HEADER_PX + ROW_PX * (changed + 8), MAX_ESTIMATE);
}

/**
 * Virtualised list of file cards (Design §6; Plan §6.1 main column). Cards near the viewport
 * mount and load their diff; the sidebar's scroll requests land here; the scroll position is
 * preserved across recomputes when the anchored file still exists.
 */
export function DiffPane({ initialRect }: { initialRect?: { width: number; height: number } }) {
  const files = useStore(selectVisibleFiles);
  const collapsed = useStore((s) => s.collapsed);
  const statsMap = useStore((s) => s.stats);
  const activeFileId = useStore((s) => s.activeFileId);
  const setCollapsed = useStore((s) => s.setCollapsed);

  const scrollRef = useRef<HTMLElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const f = files[i];
      return f ? estimateCardHeight(statsMap[f.id] ?? f.stats, collapsed.has(f.id)) : HEADER_PX;
    },
    getItemKey: (i) => files[i]?.id ?? i,
    overscan: 3,
    gap: 16,
    ...(initialRect ? { initialRect } : {}),
  });
  const items = virtualizer.getVirtualItems();

  // sidebar → "scroll to file"
  useEffect(
    () =>
      onScrollRequest((id) => {
        const i = files.findIndex((f) => f.id === id);
        if (i >= 0) virtualizer.scrollToIndex(i, { align: "start" });
      }),
    [files, virtualizer],
  );

  // keep the anchored card in place when the file list changes (recompute / filter)
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  const prevFiles = useRef(files);
  const offset = virtualizer.scrollOffset ?? 0;
  if (prevFiles.current === files) {
    const first = items.find((it) => it.end > offset);
    const f = first ? files[first.index] : undefined;
    anchor.current = f && first ? { id: f.id, delta: offset - first.start } : null;
  }
  useEffect(() => {
    if (prevFiles.current === files) return;
    prevFiles.current = files;
    const a = anchor.current;
    if (!a) return;
    const i = files.findIndex((f) => f.id === a.id);
    if (i < 0) return;
    const [start] = virtualizer.getOffsetForIndex(i, "start") ?? [0];
    virtualizer.scrollToOffset(start + a.delta);
  }, [files, virtualizer]);

  // `[` / `]` collapse / expand the active card (Plan §6.5); `b` / `h` switch it between
  // `Diff | Blame | History` (Design §14.7) and switch back when it is already there.
  const setCardMode = useStore((s) => s.setCardMode);
  const cardModes = useStore((s) => s.cardModes);
  const toggleMode = (mode: "blame" | "history") => {
    if (!activeFileId) return;
    const file = files.find((f) => f.id === activeFileId);
    if (!file || !hasCommittedSide(file)) return;
    setCardMode(activeFileId, (cardModes[activeFileId] ?? "diff") === mode ? "diff" : mode);
    setCollapsed(activeFileId, false);
  };
  useShortcuts({
    "[": () => {
      if (activeFileId) setCollapsed(activeFileId, true);
    },
    "]": () => {
      if (activeFileId) setCollapsed(activeFileId, false);
    },
    b: () => toggleMode("blame"),
    h: () => toggleMode("history"),
  });

  return (
    <section
      id="diff"
      ref={scrollRef}
      aria-label="Diff"
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto bg-bg p-4"
      data-count={files.length}
    >
      {files.length > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const f = files[v.index];
            return f ? (
              <FileCard
                key={v.key}
                file={f}
                index={v.index}
                measureRef={virtualizer.measureElement}
                // `top` rather than `transform: translateY`: sticky offsets are computed from
                // the pre-transform layout box, so translated cards would pin their headers to
                // the card bottom as soon as the pane scrolls.
                style={{ position: "absolute", top: v.start, left: 0, width: "100%" }}
              />
            ) : null;
          })}
        </div>
      )}
    </section>
  );
}
