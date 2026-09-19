import { LoaderCircle, FileDiff as PatchGlyph } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { FileDiff } from "../../engine/types";
import { useNow } from "../hooks/useNow";
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
import { ExportMenu } from "./ExportMenu";
import { FileFilter } from "./FileFilter";
import { notCountedTitle, StatsBreakdown, StatsNotCounted } from "./StatsBreakdown";
import {
  Divider,
  layerTitleOf,
  StatsLayerFilters,
  statusTitleOf,
  toggleFilterToken,
} from "./StatsLayerFilters";
import {
  readAtLabel,
  STALL_MS,
  StatsProgressIndicator,
  StatsSnapshotMeta,
  StatsStalledIndicator,
} from "./StatsSnapshotMeta";
import { formatNumber, INDICATOR_ACCENT, PATCH_TAG, STATS_ROW_CONTAINER } from "./statsRow.styles";
import { ViewControls } from "./ViewControls";
import { ViewedCounter } from "./ViewedCounter";

export { notCountedTitle, readAtLabel, STALL_MS, toggleFilterToken };

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

  // S6: a filter that matches nothing keeps the whole-diff viewed counter (12 / 118, not 0 / 0)
  const viewedOver = filtering && files.length === 0 ? allFiles : files;
  let viewedCount = 0;
  for (const f of viewedOver)
    if (diff && isViewed({ diff, viewed: viewedSet, repoId }, f)) viewedCount++;

  const noFiles = allFiles.length === 0;
  const notCounted =
    progress.notCounted.tooLarge + progress.notCounted.binary + progress.notCounted.failed;

  const statusTitle = statusTitleOf(breakdown);
  const layerTitle = layerTitleOf(breakdown);
  const titleParts: string[] = [];
  if (filtering) {
    const t = sum(allFiles);
    titleParts.push(
      `${formatNumber(allFiles.length)} files · +${formatNumber(t.additions)} −${formatNumber(t.deletions)} in total`,
    );
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

  return (
    <div className={STATS_ROW_CONTAINER}>
      <StatsBreakdown
        filesCount={files.length}
        totalFilesCount={allFiles.length}
        filtering={filtering}
        dimCls={dimCls}
        countTitle={countTitle}
        totals={totals}
        complete={progress.complete}
        stalled={stalled}
        dim={dim}
      />
      {patchName !== "" && (
        <span
          data-testid="patch-tag"
          className={PATCH_TAG}
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

      <StatsProgressIndicator
        complete={progress.complete}
        stalled={stalled}
        counted={progress.counted}
        total={progress.total}
      />
      <StatsStalledIndicator
        stalled={stalled}
        counted={progress.counted}
        total={progress.total}
        onRecount={() => requestRefresh("force")}
      />
      <StatsNotCounted
        notCounted={notCounted}
        progressNotCounted={progress.notCounted}
        onJump={jumpToNotCounted}
      />
      {dim && (
        <span className={INDICATOR_ACCENT}>
          <LoaderCircle size={13} aria-hidden className="spin" />
          updating
        </span>
      )}

      {!noFiles && (
        <>
          <StatsLayerFilters
            breakdown={breakdown}
            filter={filter}
            dimCls={dimCls}
            onFilterChange={setFilter}
          />
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
      <StatsSnapshotMeta />

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
