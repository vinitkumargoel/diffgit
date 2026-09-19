import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const clampSidebarWidth = (w: number): number =>
  Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)));

export interface SidebarResize {
  /** The width to render right now: the live drag width, or the persisted one. */
  shown: number;
  /** Spread onto the 4 px `<hr>` handle at the sidebar's right edge (Design §7.4). */
  handleProps: {
    "aria-orientation": "vertical";
    "aria-label": string;
    "aria-valuemin": number;
    "aria-valuemax": number;
    "aria-valuenow": number;
    tabIndex: number;
    className: string;
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  };
}

const HANDLE_CLASS =
  "absolute top-0 right-0 m-0 h-full w-1 cursor-col-resize border-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

/**
 * The sidebar's resize handle (Design §7.4: 220–480 px, persisted in prefs, ← → move it 10 px).
 * Extracted in T11.5 so the Files sidebar and the History commit list resize identically instead of
 * one of them being the odd one out.
 */
export function useSidebarResize(width: number, commit: (w: number) => void): SidebarResize {
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const startX = useRef(0);
  const startW = useRef(width);
  const shown = dragWidth ?? width;

  const endDrag = useCallback(() => {
    if (dragWidth === null) return;
    if (dragWidth !== width) commit(dragWidth);
    setDragWidth(null);
  }, [dragWidth, width, commit]);

  useEffect(() => {
    if (dragWidth === null) return;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragWidth]);

  const nudge = (delta: number) => {
    const next = clampSidebarWidth(width + delta);
    if (next !== width) commit(next);
  };

  return {
    shown,
    handleProps: {
      "aria-orientation": "vertical",
      "aria-label": "Resize sidebar",
      "aria-valuemin": SIDEBAR_MIN,
      "aria-valuemax": SIDEBAR_MAX,
      "aria-valuenow": shown,
      tabIndex: 0,
      className: HANDLE_CLASS,
      onPointerDown: (e) => {
        startX.current = e.clientX;
        startW.current = width;
        setDragWidth(width);
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e) => {
        if (dragWidth === null) return;
        setDragWidth(clampSidebarWidth(startW.current + (e.clientX - startX.current)));
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown: (e) => {
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
      },
    },
  };
}
