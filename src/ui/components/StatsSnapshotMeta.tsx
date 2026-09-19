import { LoaderCircle, TriangleAlert } from "lucide-react";
import { openRepoOnce } from "../openRepo";
import { useStore } from "../store";
import {
  formatNumber,
  INDICATOR_ACCENT,
  INDICATOR_ATTENTION,
  LINK_BUTTON,
  SNAPSHOT_BADGE,
} from "./statsRow.styles";

/** No stats batch for this long while incomplete ⇒ S8 "stats stalled". */
export const STALL_MS = 10_000;

/** T11.15: "14:02" — the clock time the snapshot was read, 24 h so the tag stays one short line. */
export function readAtLabel(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export interface StatsProgressIndicatorProps {
  complete: boolean;
  stalled: boolean;
  counted: number;
  total: number;
}

export function StatsProgressIndicator({
  complete,
  stalled,
  counted,
  total,
}: StatsProgressIndicatorProps) {
  if (complete || stalled) return null;
  return (
    <span className={INDICATOR_ACCENT}>
      <LoaderCircle size={13} aria-hidden className="spin" />
      <span className="tabular-nums">
        stats {formatNumber(counted)} / {formatNumber(total)}
      </span>
    </span>
  );
}

export interface StatsStalledIndicatorProps {
  stalled: boolean;
  counted: number;
  total: number;
  onRecount: () => void;
}

export function StatsStalledIndicator({
  stalled,
  counted,
  total,
  onRecount,
}: StatsStalledIndicatorProps) {
  if (!stalled) return null;
  return (
    <span className={INDICATOR_ATTENTION}>
      <TriangleAlert size={13} aria-hidden />
      <span className="tabular-nums">
        stats stopped at {formatNumber(counted)} / {formatNumber(total)} ·{" "}
      </span>
      <button type="button" className={LINK_BUTTON} onClick={onRecount}>
        re-count
      </button>
    </span>
  );
}

export interface StatsSnapshotMetaProps {
  readAt?: number | null;
}

export function StatsSnapshotMeta({ readAt }: StatsSnapshotMetaProps = {}) {
  const storeReadAt = useStore((s) => s.snapshotReadAt);
  const addToast = useStore((s) => s.addToast);
  const snapshotReadAt = readAt !== undefined ? readAt : storeReadAt;

  if (snapshotReadAt === null) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-testid="snapshot-tag">
      <span className={SNAPSHOT_BADGE}>Snapshot mode</span>
      <span className="tabular-nums">{`read at ${readAtLabel(snapshotReadAt)} · `}</span>
      <button
        type="button"
        className={LINK_BUTTON}
        onClick={() =>
          void openRepoOnce().catch((e: unknown) =>
            addToast({
              level: "error",
              message: e instanceof Error ? e.message : "Couldn't read the folder.",
            }),
          )
        }
      >
        Re-open to refresh
      </button>
    </span>
  );
}
