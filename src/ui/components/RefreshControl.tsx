import { LoaderCircle, RefreshCw } from "lucide-react";
import { useNow } from "../hooks/useNow";
import type { RefreshMode } from "../store";
import { secondsAgo } from "../timeAgo";

export interface RefreshControlProps {
  mode: RefreshMode;
  busy: boolean;
  lastAt: number | null;
  onRefresh: () => void;
}

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
export function RefreshControl({ mode, busy, lastAt, onRefresh }: RefreshControlProps) {
  const now = useNow(5000, lastAt !== null);
  const when = lastAt === null ? "Not refreshed yet" : `Last refreshed ${secondsAgo(lastAt, now)}`;
  return (
    <button
      type="button"
      className="btn"
      title={when}
      aria-label={`Refresh (${WORD[mode]}). ${when}`}
      aria-busy={busy}
      disabled={busy}
      onClick={onRefresh}
    >
      {busy ? (
        <LoaderCircle size={14} aria-hidden className="spin" />
      ) : (
        <RefreshCw size={14} aria-hidden />
      )}
      Refresh
      <span aria-hidden className={`ml-1 inline-block size-2 rounded-full ${DOT[mode]}`} />
      <span className={`font-medium ${TEXT[mode]}`}>{WORD[mode]}</span>
    </button>
  );
}
