import { useCallback, useEffect, useRef, useState } from "react";
import { type SidebarLayout, selectVisibleFiles, useStore } from "../store";
import { FileTree } from "./FileTree";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 480;
const clampSidebarWidth = (w: number): number =>
  Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)));

const LAYOUTS: { value: SidebarLayout; label: string }[] = [
  { value: "tree", label: "Tree" },
  { value: "flat", label: "Flat" },
];

/**
 * Left file navigator (Design §6, §7.4): 36 px header with count and `Tree | Flat`, the file tree,
 * and a 4 px resize handle (220–480 px, persisted in prefs; ← → keys move it 10 px).
 */
export function Sidebar({ initialRect }: { initialRect?: { width: number; height: number } }) {
  const width = useStore((s) => s.prefs.sidebarWidth);
  const layout = useStore((s) => s.prefs.sidebarLayout);
  const setPref = useStore((s) => s.setPref);
  const total = useStore((s) => s.diff?.files.length ?? 0);
  const visible = useStore(selectVisibleFiles).length;
  const filtering = useStore((s) => s.filter.trim() !== "");

  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const startX = useRef(0);
  const startW = useRef(width);
  const shown = dragWidth ?? width;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    startX.current = e.clientX;
    startW.current = width;
    setDragWidth(width);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragWidth === null) return;
    setDragWidth(clampSidebarWidth(startW.current + (e.clientX - startX.current)));
  };
  const endDrag = useCallback(() => {
    if (dragWidth === null) return;
    if (dragWidth !== width) setPref("sidebarWidth", dragWidth);
    setDragWidth(null);
  }, [dragWidth, width, setPref]);
  useEffect(() => {
    if (dragWidth === null) return;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragWidth]);

  const nudge = (delta: number) => {
    const next = clampSidebarWidth(width + delta);
    if (next !== width) setPref("sidebarWidth", next);
  };

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface-sunken text-ink"
      style={{ width: shown }}
      aria-label="Changed files"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-xs font-semibold">
          {filtering ? (
            <>
              {visible} <span className="font-normal text-muted">of {total} files</span>
            </>
          ) : (
            <>
              Files changed <span className="font-normal text-muted">({total})</span>
            </>
          )}
        </span>
        <fieldset className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
          <legend className="sr-only">Sidebar layout</legend>
          {LAYOUTS.map((l) => (
            <button
              key={l.value}
              type="button"
              aria-pressed={layout === l.value}
              className={`rounded-[6px] px-[7px] py-[2px] text-[11px] leading-4 font-medium ${
                layout === l.value ? "pressed" : "text-muted hover:text-ink"
              }`}
              onClick={() => setPref("sidebarLayout", l.value)}
            >
              {l.label}
            </button>
          ))}
        </fieldset>
      </div>
      <FileTree layout={layout} initialRect={initialRect} />
      <hr
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={shown}
        tabIndex={0}
        className="absolute top-0 right-0 m-0 h-full w-1 cursor-col-resize border-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            nudge(-10);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            nudge(10);
          } else if (e.key === "Home") {
            e.preventDefault();
            nudge(SIDEBAR_MIN - width);
          } else if (e.key === "End") {
            e.preventDefault();
            nudge(SIDEBAR_MAX - width);
          }
        }}
      />
    </aside>
  );
}
