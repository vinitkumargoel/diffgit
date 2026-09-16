import { LoaderCircle, RefreshCw } from "lucide-react";
import { useRef } from "react";
import type { ProgressPhase } from "../../engine/api";
import { useNow } from "../hooks/useNow";
import type { RefreshMode } from "../store";
import { secondsAgo } from "../timeAgo";

export interface RefreshControlProps {
  mode: RefreshMode;
  busy: boolean;
  lastAt: number | null;
  /** Engine phase currently running (shown while busy). */
  phase?: ProgressPhase | null;
  /** `force` is true for Shift+click and long-press (T6.4). */
  onRefresh: (force: boolean) => void;
}

/** Holding the button this long (ms) triggers a force refresh. */
const LONG_PRESS_MS = 600;
const FORCE_HINT =
  "Force refresh re-reads every file (use if a change isn't showing): Shift+click, hold, or Shift+R";

const PHASE_LABEL: Partial<Record<ProgressPhase, string>> = {
  layout: "Checking repository…",
  config: "Reading config…",
  refs: "Reading refs…",
  index: "Parsing index…",
  worktree: "Scanning working tree…",
  diff: "Computing diff…",
  renames: "Detecting renames…",
  stats: "Counting changes…",
  probe: "Checking for changes…",
};

const WORD: Record<RefreshMode, string> = { live: "Live", polling: "Polling", manual: "Manual" };
const DOT: Record<RefreshMode, string> = {
  live: "bg-success",
  polling: "bg-attention",
  manual: "bg-muted",
};
const TEXT: Record<RefreshMode, string> = {
  live: "text-success",
  polling: "text-attention",
  manual: "text-muted",
};

/** Refresh button + status dot/word (Design §7.1 item 7). T6.x supplies live/polling; until then Manual. */
export function RefreshControl({ mode, busy, lastAt, phase, onRefresh }: RefreshControlProps) {
  const now = useNow(5000, lastAt !== null);
  const when = lastAt === null ? "Not refreshed yet" : `Last refreshed ${secondsAgo(lastAt, now)}`;
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const label = busy && phase && PHASE_LABEL[phase] ? PHASE_LABEL[phase] : "Refresh";
  return (
    <button
      type="button"
      className="btn"
      title={`${when}. ${FORCE_HINT}`}
      aria-label={`Refresh (${WORD[mode]}). ${when}. ${busy ? label : FORCE_HINT}`}
      aria-busy={busy}
      disabled={busy}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        longPressed.current = false;
        clearPress();
        pressTimer.current = setTimeout(() => {
          longPressed.current = true;
          onRefresh(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearPress}
      onPointerLeave={clearPress}
      onPointerCancel={clearPress}
      onClick={(e) => {
        clearPress();
        if (longPressed.current) {
          longPressed.current = false;
          return; // the long-press already fired the force refresh
        }
        onRefresh(e.shiftKey);
      }}
    >
      {busy ? (
        <LoaderCircle size={14} aria-hidden className="spin" />
      ) : (
        <RefreshCw size={14} aria-hidden />
      )}
      {label}
      <span aria-hidden className={`ml-1 inline-block size-2 rounded-full ${DOT[mode]}`} />
      <span className={`font-medium ${TEXT[mode]}`}>{WORD[mode]}</span>
    </button>
  );
}
