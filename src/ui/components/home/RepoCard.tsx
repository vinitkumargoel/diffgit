/**
 * One repository on Home (T11.11, Design §14.6, atlas tab 11). The RecentRow facts — name, access,
 * age, Forget/Undo — plus the summary a throw-away engine session read in the background: current
 * branch, ahead/behind vs upstream, the uncommitted work as counted `LayerChip`s, the operation
 * the repository is in the middle of, and its last commit.
 *
 * The card never waits for its summary: it renders the cached one immediately (or the plain recent
 * facts when there is none) and fills in when the summariser gets to it. A handle the browser has
 * not granted yet is never read — `requestPermission()` needs a user gesture — so it shows what
 * was last known behind a dashed border with a `Re-authorise` button, exactly as the atlas draws it.
 *
 * Colours are Design tokens only; the surrounding landing page's own palette (`src/marketing`)
 * redefines the shared neutrals while Home is mounted, which is what keeps the card in its company.
 */
import { FolderGit2, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import type { RepoSummary } from "../../../engine/types";
import { aheadBehindLabel, CAPPED_TITLE, NO_UPSTREAM } from "../../branches";
import {
  CLEAN_LABEL,
  countChips,
  GRANT_LABEL,
  isStale,
  lastCommitLine,
  lastSeenLine,
  NEEDS_PERMISSION,
  NEEDS_PERMISSION_TITLE,
  operationTag,
  STALE_LABEL,
  STALE_TITLE,
  SUMMARISING,
  UPSTREAM_TITLE,
} from "../../dashboard";
import { describeError } from "../../errors";
import type { PermissionAnswer, StoredRepo } from "../../persistence";
import type { DashboardEntry } from "../../store";
import { timeAgo } from "../../timeAgo";
import { LayerChip } from "../LayerChip";
import { AccessDot, Highlight, RowMessage, shortRef } from "./RecentRow";
import type { RowState } from "./useRecents";

/** A small `ref`-style tag: the operation badge, `needs permission`, `stale`. */
function Tag({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "attention";
  title?: string;
}) {
  const cls =
    tone === "attention"
      ? "border-attention/40 bg-chip-unstaged-bg text-chip-unstaged-fg"
      : "border-line bg-surface-raised text-muted";
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[11px] leading-4 font-medium ${cls}`}
      title={title}
    >
      {children}
    </span>
  );
}

export interface RepoSummaryStripProps {
  entry: DashboardEntry;
  /** What to show under the name before any summary exists (the last compare side). */
  fallback: string;
  now: number;
}

/**
 * The summary half of a card: `main · 4 ↑ 0 ↓`, the layer chips, and the last commit. Shared with
 * the Continue card (H1), so a single stored repository reads exactly like one of many.
 */
export function RepoSummaryStrip({ entry, fallback, now }: RepoSummaryStripProps) {
  const summary: RepoSummary | null = entry.summary;
  const stale = isStale(entry);
  const chips = summary ? countChips(summary.counts) : [];
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] text-muted">
        {summary ? (
          <>
            <span className="truncate text-ink">{summary.headDisplay}</span>
            {summary.vsUpstream ? (
              <span
                className="shrink-0"
                title={summary.vsUpstream.capped ? CAPPED_TITLE : UPSTREAM_TITLE}
              >
                {aheadBehindLabel(summary.vsUpstream)}
              </span>
            ) : (
              <span className="shrink-0 text-muted/70">{NO_UPSTREAM}</span>
            )}
          </>
        ) : (
          <span className="truncate">{fallback}</span>
        )}
      </div>
      {summary && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.length === 0 ? (
            <span className="text-[11px] leading-4 font-medium text-success">{CLEAN_LABEL}</span>
          ) : (
            chips.map((c) => <LayerChip key={c.kind} kind={c.kind} count={c.count} />)
          )}
          {stale && <Tag title={STALE_TITLE}>{STALE_LABEL}</Tag>}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-muted">
        {entry.loading ? (
          <span className="flex items-center gap-1.5">
            <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
            {SUMMARISING}
          </span>
        ) : entry.error ? (
          <span className="flex items-center gap-1.5 text-danger" title={entry.error.message}>
            <TriangleAlert className="h-3 w-3" aria-hidden="true" />
            {describeError(entry.error.code).title}
          </span>
        ) : summary ? (
          <span className="truncate">{lastCommitLine(summary, (t) => timeAgo(t, now))}</span>
        ) : null}
      </div>
    </>
  );
}

export interface RepoCardProps {
  repo: StoredRepo;
  access: PermissionAnswer;
  state: RowState;
  entry: DashboardEntry;
  now: number;
  /** The panel's filter text, marked in the name (H3). */
  filter?: string;
  onOpen(repo: StoredRepo): void;
  onGrant(repo: StoredRepo): void;
  onForget(repo: StoredRepo): void;
  onUndo(repo: StoredRepo): void;
  onChoose(): void;
  onKeyDown?(e: KeyboardEvent<HTMLButtonElement>, repo: StoredRepo): void;
}

export function RepoCard({
  repo,
  access,
  state,
  entry,
  now,
  filter = "",
  onOpen,
  onGrant,
  onForget,
  onUndo,
  onChoose,
  onKeyDown,
}: RepoCardProps) {
  const busy = state === "opening";
  const forgotten = state === "forgotten";
  const granted = access === "granted";
  const tag = entry.summary ? operationTag(entry.summary.operation) : null;
  const border = granted ? "border-line" : "border-line border-dashed";

  // `[&_.rmsg]:px-0`: the shared RowMessage is indented for a 20 px row icon; a card has none.
  return (
    <div
      data-repo-card={repo.id}
      className={`flex flex-col gap-2 rounded-xl border ${border} bg-surface p-3 [&_.rmsg]:px-0 ${forgotten ? "opacity-50" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {busy ? (
          <LoaderCircle
            className="h-3.5 w-3.5 shrink-0 animate-spin text-muted"
            aria-hidden="true"
          />
        ) : (
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        )}
        <b className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
          <Highlight text={repo.name} match={filter} />
        </b>
        {tag && <Tag tone="attention">{tag}</Tag>}
        {!granted && <Tag title={NEEDS_PERMISSION_TITLE}>{NEEDS_PERMISSION}</Tag>}
        <AccessDot access={access} />
      </div>

      <RepoSummaryStrip
        entry={entry}
        fallback={
          repo.lastSource || repo.lastTarget
            ? lastSeenLine(shortRef(repo.lastSource))
            : "never compared"
        }
        now={now}
      />

      <div className="flex items-center gap-2 pt-0.5">
        {forgotten ? (
          <>
            <span className="flex-1 text-[11.5px] text-muted">Forgotten</span>
            <button type="button" className="btn btn-xs" onClick={() => onUndo(repo)}>
              Undo
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 truncate text-[11.5px] text-muted">
              {/* the same sentence the row used to show while the permission prompt is up (H4) */}
              {busy
                ? "Asking the browser for read access…"
                : `opened ${timeAgo(repo.lastOpenedAt, now)}`}
            </span>
            {!granted && (
              <button
                type="button"
                className="btn btn-xs"
                title={NEEDS_PERMISSION_TITLE}
                onClick={() => onGrant(repo)}
              >
                {GRANT_LABEL}
              </button>
            )}
            <button
              type="button"
              className="btn btn-xs"
              data-card-open
              disabled={busy}
              aria-label={`Open ${repo.name}`}
              onClick={() => onOpen(repo)}
              onKeyDown={(e) => onKeyDown?.(e, repo)}
            >
              Open
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              aria-label={`Forget ${repo.name}`}
              title="Forget"
              onClick={() => onForget(repo)}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      <RowMessage
        repo={repo}
        state={state}
        onRetry={onOpen}
        onChoose={onChoose}
        onForget={onForget}
      />
    </div>
  );
}
