import { LoaderCircle, FileDiff as PatchGlyph, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { FileDiff, FileStatus } from "../../engine/types";
import { useNow } from "../hooks/useNow";
import { openRepoOnce } from "../openRepo";
import { patchTagLabel } from "../patch";
import { requestScrollTo } from "../scrollBus";
import {
  breakdownOf,
  isViewed,
  selectFailedFiles,
  selectSourceLabel,
  selectVisibleFiles,
  statsProgressOf,
  useStore,
} from "../store";
import { parseFilter } from "../treeModel";
import { ExportMenu } from "./ExportMenu";
import { FileFilter } from "./FileFilter";
import { LayerChip } from "./LayerChip";
import { ViewControls } from "./ViewControls";
import { ViewedCounter } from "./ViewedCounter";

/** No stats batch for this long while incomplete ⇒ S8 "stats stalled". */
export const STALL_MS = 10_000;

const n = (x: number) => x.toLocaleString("en-US");

/** T11.15: "14:02" — the clock time the snapshot was read, 24 h so the tag stays one short line. */
export function readAtLabel(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function Divider() {
  return <span aria-hidden className="h-[18px] w-px shrink-0 bg-line" />;
}

const STATUS_KEYS = ["M", "A", "D", "R", "T"] as const;
type StatusKey = (typeof STATUS_KEYS)[number];

const STATUS_META: Record<
  StatusKey,
  { status: FileStatus; word: string; token: string; cls: string }
> = {
  M: {
    status: "modified",
    word: "modified",
    token: "status:M",
    cls: "bg-status-m-bg text-status-m-fg",
  },
  A: { status: "added", word: "added", token: "status:A", cls: "bg-status-a-bg text-status-a-fg" },
  D: {
    status: "deleted",
    word: "deleted",
    token: "status:D",
    cls: "bg-status-d-bg text-status-d-fg",
  },
  R: {
    status: "renamed",
    word: "renamed",
    token: "status:R",
    cls: "bg-status-r-bg text-status-r-fg",
  },
  T: {
    status: "typechange",
    word: "type changed",
    token: "status:T",
    cls: "bg-status-t-bg text-status-t-fg",
  },
};

const LAYER_KEYS = ["staged", "unstaged", "untracked", "conflict"] as const;

/** Adds the token when absent, removes it when already there; every other word survives. */
export function toggleFilterToken(filter: string, token: string): string {
  const words = filter.trim().split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => w.toLowerCase() === token.toLowerCase());
  if (at >= 0) words.splice(at, 1);
  else words.push(token);
  return words.join(" ");
}

/** "2 files over 1 MB, 3 binary, 1 read error" — zero parts are left out. */
export function notCountedTitle(p: { tooLarge: number; binary: number; failed: number }): string {
  const parts: string[] = [];
  if (p.tooLarge > 0)
    parts.push(`${n(p.tooLarge)} ${p.tooLarge === 1 ? "file" : "files"} over 1 MB`);
  if (p.binary > 0) parts.push(`${n(p.binary)} binary`);
  if (p.failed > 0) parts.push(`${n(p.failed)} read ${p.failed === 1 ? "error" : "errors"}`);
  return parts.join(", ");
}

function listTitle(pairs: [number, string][]): string {
  return pairs
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${n(count)} ${word}`)
    .join(", ");
}

/** The 15 px status square of the breakdown — a toggle for its `status:` filter token. */
function StatusToggle({
  letter,
  pressed,
  onToggle,
  count,
}: {
  letter: StatusKey;
  pressed: boolean;
  onToggle: () => void;
  count: number;
}) {
  const m = STATUS_META[letter];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`Filter: ${m.word} (${n(count)})`}
      title={`Filter: ${m.token}`}
      onClick={onToggle}
      className={`inline-flex size-[15px] shrink-0 items-center justify-center rounded-[4px] font-mono text-[9.5px] leading-none font-bold ${m.cls} ${
        pressed ? "outline-2 outline-offset-1 outline-accent" : ""
      }`}
    >
      {letter}
    </button>
  );
}

/**
 * Row 2 of the top bar (mockup §3 `.stats`, S1–S8): file count, `+/−`, the status and layer
 * breakdowns, the viewed counter, the filter and the view controls — plus an honest marker for
 * every moment the numbers are not final. A number that is not yet true is never printed.
 */
export function StatsRow() {
  const diff = useStore((s) => s.diff);
  const filter = useStore((s) => s.filter);
  const statsMap = useStore((s) => s.stats);
  const statsLastAt = useStore((s) => s.statsLastAt);
  const refreshBusy = useStore((s) => s.refresh.busy);
  const prefs = useStore((s) => s.prefs);
  const viewedSet = useStore((s) => s.viewed);
  const repoId = useStore((s) => s.repoId);
  const failedFiles = useStore(useShallow(selectFailedFiles));
  const visible = useStore(useShallow(selectVisibleFiles));
  const setFilter = useStore((s) => s.setFilter);
  const setPref = useStore((s) => s.setPref);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const requestRefresh = useStore((s) => s.requestRefresh);
  // T11.15: null unless the folder was read once (Firefox/Safari, or the palette's snapshot action).
  const snapshotReadAt = useStore((s) => s.snapshotReadAt);
  const addToast = useStore((s) => s.addToast);
  // T11.2: printed only for a range — a branch pair is already spelled out by the two pickers, and
  // Design §14 rule 1 keeps the bars looking like v1 until something unusual is being compared.
  const rangeLabel = useStore((s) => (s.diffSource?.kind === "range" ? selectSourceLabel(s) : ""));
  // T11.14 / Design §14.6: in a patch-only session the pickers are gone from row 1, so this tag is
  // what names the thing on screen — one `--attention` tag, like snapshot mode's, never a banner.
  const patchName = useStore((s) => (s.patchOnly ? s.patchSession.name : ""));

  const allFiles: readonly FileDiff[] = diff?.files ?? [];
  const filtering = filter.trim() !== "";
  const files = filtering ? visible : allFiles;

  const progress = statsProgressOf(files, statsMap, failedFiles);
  // Only ticks while the stream is open; a complete row never re-renders on a timer.
  const now = useNow(1000, !progress.complete);
  const stalled = !progress.complete && statsLastAt !== null && now - statsLastAt > STALL_MS;

  const sum = (list: readonly FileDiff[]) => {
    let additions = 0;
    let deletions = 0;
    for (const f of list) {
      const st = statsMap[f.id] ?? f.stats;
      if (st) {
        additions += st.additions;
        deletions += st.deletions;
      }
    }
    return { additions, deletions };
  };
  const totals = sum(files);
  const breakdown = breakdownOf(files);
  const parsed = parseFilter(filter);

  // S6: a filter that matches nothing keeps the whole-diff viewed counter (12 / 118, not 0 / 0)
  const viewedOver = filtering && files.length === 0 ? allFiles : files;
  let viewedCount = 0;
  for (const f of viewedOver)
    if (diff && isViewed({ diff, viewed: viewedSet, repoId }, f)) viewedCount++;

  const noFiles = allFiles.length === 0;
  const notCounted =
    progress.notCounted.tooLarge + progress.notCounted.binary + progress.notCounted.failed;

  const statusTitle = listTitle(
    STATUS_KEYS.map((k) => [breakdown.status[k], STATUS_META[k].word] as [number, string]),
  );
  const layerTitle = listTitle(LAYER_KEYS.map((k) => [breakdown.layers[k], k] as [number, string]));
  const titleParts: string[] = [];
  if (filtering) {
    const t = sum(allFiles);
    titleParts.push(`${n(allFiles.length)} files · +${n(t.additions)} −${n(t.deletions)} in total`);
  }
  // Below 1100 px the two breakdown groups are hidden, so their text lives in this tooltip.
  if (statusTitle) titleParts.push(statusTitle);
  if (layerTitle) titleParts.push(layerTitle);
  const countTitle = titleParts.join(" · ") || undefined;

  const dim = refreshBusy && diff !== null;
  const dimCls = dim ? "opacity-55" : "";

  const firstNotCounted = files.find((f) => failedFiles.has(f.id) || f.binary || f.tooLarge);
  const jumpToNotCounted = () => {
    if (!firstNotCounted) return;
    setActiveFile(firstNotCounted.id);
    requestScrollTo(firstNotCounted.id);
  };

  let totalsNode: ReactNode;
  if (progress.complete || stalled) {
    totalsNode = (
      <span
        className={`font-mono font-semibold tabular-nums ${dim || stalled ? "opacity-55" : ""}`}
      >
        <span className="text-success">+{n(totals.additions)}</span>{" "}
        <span className="text-danger">−{n(totals.deletions)}</span>
      </span>
    );
  } else {
    totalsNode = (
      <span
        role="img"
        aria-label="Counting changes"
        className="inline-flex shrink-0 items-center gap-1.5"
      >
        <span className="inline-block h-2.5 w-9 rounded-[3px] bg-surface-raised" />
        <span className="inline-block h-2.5 w-9 rounded-[3px] bg-surface-raised" />
      </span>
    );
  }

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-3 bg-surface px-3 py-1 text-[12.5px] leading-5 text-muted">
      <span className={`shrink-0 tabular-nums ${dimCls}`} title={countTitle}>
        <b className="font-semibold text-ink">{n(files.length)}</b>{" "}
        {filtering
          ? `of ${n(allFiles.length)} match`
          : `${files.length === 1 ? "file" : "files"} changed`}
      </span>
      {totalsNode}
      {patchName !== "" && (
        <span
          data-testid="patch-tag"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-attention/40 px-1.5 text-[11.5px] text-attention"
          title="A patch file is open; there is no repository behind these changes"
        >
          <PatchGlyph size={12} aria-hidden />
          {patchTagLabel(patchName)}
        </span>
      )}
      {rangeLabel !== "" && (
        <span
          data-testid="compare-label"
          className={`shrink-0 font-mono text-[12px] ${dimCls}`}
          title="What is being compared"
        >
          {rangeLabel}
        </span>
      )}

      {!progress.complete && !stalled && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-accent">
          <LoaderCircle size={13} aria-hidden className="spin" />
          <span className="tabular-nums">
            stats {n(progress.counted)} / {n(progress.total)}
          </span>
        </span>
      )}
      {stalled && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-attention">
          <TriangleAlert size={13} aria-hidden />
          <span className="tabular-nums">
            stats stopped at {n(progress.counted)} / {n(progress.total)} ·{" "}
          </span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => requestRefresh("force")}
          >
            re-count
          </button>
        </span>
      )}
      {notCounted > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-attention"
          title={notCountedTitle(progress.notCounted)}
        >
          <TriangleAlert size={13} aria-hidden />
          <button type="button" className="text-accent hover:underline" onClick={jumpToNotCounted}>
            {n(notCounted)} not counted
          </button>
        </span>
      )}
      {dim && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-accent">
          <LoaderCircle size={13} aria-hidden className="spin" />
          updating
        </span>
      )}

      {!noFiles && (
        <>
          {statusTitle !== "" && (
            <>
              <Divider />
              <span
                title={statusTitle}
                className={`hidden shrink-0 items-center gap-1.5 min-[1100px]:inline-flex ${dimCls}`}
              >
                {STATUS_KEYS.filter((k) => breakdown.status[k] > 0).map((k) => (
                  <Fragment key={k}>
                    <StatusToggle
                      letter={k}
                      count={breakdown.status[k]}
                      pressed={parsed.statuses?.includes(STATUS_META[k].status) ?? false}
                      onToggle={() => setFilter(toggleFilterToken(filter, STATUS_META[k].token))}
                    />
                    <span className="font-mono text-[12px] tabular-nums text-ink/80">
                      {n(breakdown.status[k])}
                    </span>
                  </Fragment>
                ))}
              </span>
            </>
          )}
          {layerTitle !== "" && (
            <>
              <Divider />
              <span
                title={layerTitle}
                className={`hidden shrink-0 items-center gap-1.5 min-[1100px]:inline-flex ${dimCls}`}
              >
                {LAYER_KEYS.filter((k) => breakdown.layers[k] > 0).map((k) => (
                  <Fragment key={k}>
                    <button
                      type="button"
                      aria-pressed={parsed.layers?.includes(k) ?? false}
                      aria-label={`Filter: ${k} (${n(breakdown.layers[k])})`}
                      title={`Filter: layer:${k}`}
                      className={
                        parsed.layers?.includes(k)
                          ? "rounded-full outline-2 outline-offset-1 outline-accent"
                          : "rounded-full"
                      }
                      onClick={() => setFilter(toggleFilterToken(filter, `layer:${k}`))}
                    >
                      <LayerChip kind={k} />
                    </button>
                    <span className="-ml-px font-mono text-[11.5px] tabular-nums">
                      {n(breakdown.layers[k])}
                    </span>
                  </Fragment>
                ))}
              </span>
            </>
          )}
          <Divider />
          <div className={`shrink-0 ${dimCls}`}>
            <ViewedCounter viewed={viewedCount} total={viewedOver.length} />
          </div>
        </>
      )}
      {noFiles && (
        <>
          <Divider />
          <span className="shrink-0 text-muted/70">nothing to view</span>
        </>
      )}

      {/* T11.15 / Design §14.6: snapshot mode says so in row 2, and re-opening is its refresh. */}
      {snapshotReadAt !== null && (
        <span className="inline-flex shrink-0 items-center gap-1.5" data-testid="snapshot-tag">
          <span className="inline-flex h-4 items-center rounded-full border border-attention/40 bg-banner-warning-bg px-1.5 font-sans text-[11px] font-semibold leading-4 text-attention">
            Snapshot mode
          </span>
          <span className="tabular-nums">{`read at ${readAtLabel(snapshotReadAt)} · `}</span>
          <button
            type="button"
            className="text-accent hover:underline"
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
      )}

      <span className="flex-1" />
      <FileFilter value={filter} onChange={setFilter} disabled={noFiles} />
      {noFiles ? (
        // `inert` keeps the disabled controls out of the tab order without forking ViewControls.
        <div inert className="opacity-50">
          <ViewControls
            viewMode={prefs.viewMode}
            ignoreWhitespace={prefs.ignoreWhitespace}
            onViewMode={(m) => setPref("viewMode", m)}
            onIgnoreWhitespace={(on) => setPref("ignoreWhitespace", on)}
          />
        </div>
      ) : (
        <ViewControls
          viewMode={prefs.viewMode}
          ignoreWhitespace={prefs.ignoreWhitespace}
          onViewMode={(m) => setPref("viewMode", m)}
          onIgnoreWhitespace={(on) => setPref("ignoreWhitespace", on)}
        />
      )}
      {/* T11.10: Design §14.1's one new StatsRow control, after the whitespace button. */}
      <ExportMenu />
    </div>
  );
}
