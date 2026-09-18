import { Circle, CircleCheck, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ProgressPhase } from "../../engine/api";
import type { WarningCode } from "../../engine/errors";
import type { RepoWarning } from "../../engine/types";
import { describeError, type UiError } from "../errors";
import { useErrorActions } from "../hooks/useErrorActions";
import { useNow } from "../hooks/useNow";
import { useShortcuts } from "../hooks/useShortcuts";
import {
  LOADING_LABELS,
  LOADING_STEPS,
  type LoadingState,
  type LoadingStep,
  MAX_OPEN_ATTEMPTS,
  stepForPhase,
  useStore,
} from "../store";
import { CenteredColumn } from "./CenteredColumn";
import { renderInline } from "./InlineText";
import { Logo } from "./Logo";

const fmt = new Intl.NumberFormat("en-US");

/** Elapsed / phase durations: "0.3 s" under ten seconds, "23 s" above (review §2 L1–L5). */
function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)} s` : `${s.toFixed(1)} s`;
}

/** Sub-phases that fold into a step's mono caption once they finish ("layout ok · config ok"). */
const SUB_LABELS: Partial<Record<ProgressPhase, string>> = {
  layout: "layout ok",
  config: "config ok",
  renames: "renames ok",
};

/** Neutral caption for the step that is running; the engine reports no path-level detail. */
const CURRENT_CAPTION: Record<LoadingStep, string> = {
  refs: "reading refs",
  index: "parsing index",
  worktree: "scanning",
  diff: "computing",
};

/** What a finished step counted ("412 refs", "8,120 entries", "5,000 files"). */
const DONE_UNITS: Record<LoadingStep, string> = {
  refs: "refs",
  index: "entries",
  worktree: "files",
  diff: "files",
};

/** Which warnings belong on which phase row (L6). UNTRACKED_CAPPED gets its own line under the bar. */
const STEP_WARNINGS: Record<LoadingStep, readonly WarningCode[]> = {
  refs: ["SHALLOW", "LFS_PRESENT", "AUTOCRLF", "PACK_LARGE", "MULTI_PACK_INDEX"],
  index: ["INDEX_CHECKSUM", "SPARSE_INDEX", "SPLIT_INDEX", "INDEX_TOO_LARGE"],
  worktree: ["EMBEDDED_REPO", "PATH_TYPE_CHANGED"],
  diff: [],
};

/** Short mono tags for the phase caption; the full copy arrives as a banner once the repo is open. */
const WARNING_TAGS: Partial<Record<WarningCode, string>> = {
  SHALLOW: "shallow",
  LFS_PRESENT: "LFS",
  AUTOCRLF: "autocrlf",
  PACK_LARGE: "large packs",
  MULTI_PACK_INDEX: "multi-pack index",
  INDEX_CHECKSUM: "checksum mismatch, retried",
  SPARSE_INDEX: "sparse",
  SPLIT_INDEX: "split index",
  INDEX_TOO_LARGE: "index too large",
  EMBEDDED_REPO: "embedded repository",
  PATH_TYPE_CHANGED: "path type changed",
};

/** The indeterminate sweep (index.css owns no keyframes for it); reduced motion gets a still bar. */
const SWEEP_CSS = `
.dg-sweep{position:absolute;top:0;left:-35%;width:35%;height:100%;animation:dg-sweep 1.4s ease-in-out infinite}
@keyframes dg-sweep{to{left:100%}}
@media (prefers-reduced-motion:reduce){.dg-sweep{animation:none;left:0;width:100%}}
`;

export type StepState = "done" | "current" | "pending" | "failed";

export function stepStatus(loading: LoadingState, step: LoadingStep): StepState {
  if (loading.failed && loading.failedStep === step) return "failed";
  if (loading.completed.includes(step)) return "done";
  if (loading.step === step) return "current";
  return "pending";
}

/** "large packs and a large untracked area" → the reason sentence in the slow callout (L3). */
function slowReason(codes: ReadonlySet<WarningCode>): string {
  const parts: string[] = [];
  if (codes.has("PACK_LARGE")) parts.push("large packs");
  if (codes.has("UNTRACKED_CAPPED")) parts.push("a large untracked area");
  if (codes.has("INDEX_TOO_LARGE") || codes.has("SPARSE_INDEX")) parts.push("a very large index");
  if (parts.length === 0) return "This repository is large.";
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `This checkout has ${list}.`;
}

/** "More than 5000 untracked files…" → "5,000 untracked files listed — the rest will be capped". */
function cappedLine(w: RepoWarning): string {
  const n = /([\d,]+)/.exec(w.message)?.[1];
  const count = n ? fmt.format(Number(n.replaceAll(",", ""))) : null;
  return count
    ? `${count} untracked files listed — the rest will be capped`
    : "Untracked files listed — the rest will be capped";
}

/** The muted line under the red callout: the engine hint, then the "What to do" / "Found" rows. */
function detailLine(failed: UiError): string {
  const rows = describeError(failed.code).fix.map((f) =>
    f.label === "What to do" ? f.text : `${f.label}: ${f.text}`,
  );
  return [failed.hint, ...rows].filter((t): t is string => Boolean(t)).join(" ");
}

function PhaseIcon({ status }: { status: StepState }) {
  if (status === "done") {
    return <CircleCheck size={16} className="text-success" role="img" aria-label="done" />;
  }
  if (status === "current") {
    return (
      <LoaderCircle size={16} className="spin text-accent" role="img" aria-label="in progress" />
    );
  }
  if (status === "failed") {
    return <CircleX size={16} className="text-danger" role="img" aria-label="failed" />;
  }
  return <Circle size={16} className="text-muted/70" role="img" aria-label="pending" />;
}

/** 6 px determinate / indeterminate bar under the running phase. */
function PhaseBar({ done, total }: { done?: number; total?: number }) {
  const determinate = total !== undefined && total > 0;
  const pct = determinate ? Math.min(100, Math.round(((done ?? 0) / (total as number)) * 100)) : 0;
  return (
    <div
      className="relative h-[6px] w-full overflow-hidden rounded-[3px] bg-progress-track"
      aria-hidden="true"
    >
      {determinate ? (
        <span className="block h-full rounded-[3px] bg-accent" style={{ width: `${pct}%` }} />
      ) : (
        <span className="dg-sweep rounded-[3px] bg-accent" />
      )}
    </div>
  );
}

/**
 * Design §7.8 / review §2 (L1–L6) LoadingScreen: which repository and which pair is opening, how
 * long it has taken, and what each of the four phases found — including the phase a failure
 * happened on, with the earlier phases still ticked.
 */
export function LoadingScreen() {
  const loading = useStore((s) => s.loading);
  const warnings = useStore((s) => s.warnings);
  const diffSource = useStore((s) => s.diffSource);
  const closeRepo = useStore((s) => s.closeRepo);
  const repoName = useStore(
    (s) => s.repo?.name ?? (s.handle as { name?: string } | null)?.name ?? "Repository",
  );
  const actions = useErrorActions();
  const [keepWaiting, setKeepWaiting] = useState(false);

  const failed = loading.failed;
  const now = useNow(250, loading.startedAt !== null && failed === null);
  const elapsed = loading.startedAt === null ? 0 : Math.max(0, now - loading.startedAt);
  const slow = elapsed > 8000 && failed === null && !keepWaiting;

  const cancel = () => void closeRepo();
  useShortcuts({ Escape: cancel });

  // The store keeps every finished engine sub-phase for the whole open; group them by the step
  // they belong to so a finished row keeps "layout ok · config ok" (L1).
  const subByStep: Partial<Record<LoadingStep, ProgressPhase[]>> = {};
  for (const p of loading.subPhases) {
    const st = stepForPhase(p);
    if (!st) continue;
    const list = subByStep[st] ?? [];
    list.push(p);
    subByStep[st] = list;
  }

  const codes = new Set(warnings.map((w) => w.code));
  const capped = warnings.find((w) => w.code === "UNTRACKED_CAPPED");

  const elapsedLine = failed
    ? "stopped"
    : loading.attempt > 1
      ? `attempt ${loading.attempt} of ${MAX_OPEN_ATTEMPTS}`
      : loading.expectedMs !== null
        ? `usually ~${Math.max(1, Math.round(loading.expectedMs / 1000))} s`
        : "first open";

  return (
    <CenteredColumn label="Opening repository">
      <style>{SWEEP_CSS}</style>
      <div className="flex w-full flex-col gap-[22px] text-left">
        <div className="flex items-center gap-3">
          <Logo size={32} className="rounded-[8px]" />
          <div className="min-w-0">
            <h1 className="text-[22px] leading-[1.1] font-semibold tracking-[-0.02em]">
              {repoName}
            </h1>
            {diffSource && (
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[12.5px] text-ink/80">
                <span className="text-accent">{diffSource.target}</span>
                <span className="text-muted/70">…</span>
                <span className="text-success">{diffSource.source}</span>
                {diffSource.includeWorktree && (
                  <span className="text-muted/70">· uncommitted included</span>
                )}
              </div>
            )}
          </div>
          <div className="ml-auto text-right font-mono text-[12px] leading-[1.4] text-muted/70">
            {(elapsed >= 2000 || failed !== null) && loading.startedAt !== null && (
              <b className="block font-medium text-muted">{formatSeconds(elapsed)}</b>
            )}
            {elapsedLine}
          </div>
        </div>

        {loading.attempt > 1 && failed === null && (
          <div className="flex items-start gap-2.5 rounded-[8px] border border-accent/45 bg-accent-subtle px-3 py-2.5 text-[13px] leading-[19px]">
            <LoaderCircle
              size={14}
              className="spin mt-0.5 shrink-0 text-accent"
              aria-hidden="true"
            />
            <p className="m-0">
              <b className="font-semibold">The diff engine stopped and was restarted.</b> Re-opening
              from the start. If this happens again the repository is probably too large for the
              tab's memory. <span className="text-muted">Attempt {loading.attempt} of 3.</span>
            </p>
          </div>
        )}

        <ol className="m-0 w-full list-none border-t border-line-subtle p-0" aria-live="polite">
          {LOADING_STEPS.map((step) => {
            const status = stepStatus(loading, step);
            const result = loading.phases[step];
            const tags = STEP_WARNINGS[step].filter((c) => codes.has(c));

            let caption: ReactNode = null;
            if (status === "failed" && failed) {
              caption = (
                <span className="text-danger">
                  {describeError(failed.code).title} · {failed.code}
                </span>
              );
            } else if (status === "done") {
              const bits: string[] = [];
              for (const p of subByStep[step] ?? []) {
                const label = SUB_LABELS[p];
                if (label) bits.push(label);
              }
              if (result?.count !== undefined) {
                bits.push(`${fmt.format(result.count)} ${DONE_UNITS[step]}`);
              }
              caption =
                bits.length > 0 || tags.length > 0 ? (
                  <>
                    {bits.join(" · ")}
                    {bits.length > 0 && tags.length > 0 ? " · " : null}
                    {tags.length > 0 && (
                      <span className="text-attention">
                        {tags.map((c) => WARNING_TAGS[c] ?? c).join(" · ")}
                      </span>
                    )}
                  </>
                ) : null;
            } else if (status === "current") {
              caption = CURRENT_CAPTION[step];
            }

            const count =
              status === "current"
                ? loading.total !== undefined
                  ? `${fmt.format(loading.done ?? 0)} / ${fmt.format(loading.total)}`
                  : "—"
                : result !== undefined
                  ? formatSeconds(result.durationMs)
                  : "";

            return (
              <li
                key={step}
                className={`grid min-h-[44px] grid-cols-[20px_1fr_auto] items-center gap-3 border-b border-line-subtle py-2 text-[14px] ${
                  status === "pending" ? "text-muted/70" : ""
                }`}
                aria-current={status === "current" ? "step" : undefined}
              >
                <PhaseIcon status={status} />
                <span className="flex min-w-0 flex-col leading-[1.3]">
                  <b className="font-medium">{LOADING_LABELS[step]}</b>
                  {caption !== null && (
                    <span
                      className={`font-mono text-[11.5px] ${
                        status === "current" ? "text-ink/80" : "text-muted"
                      }`}
                    >
                      {caption}
                    </span>
                  )}
                </span>
                <span
                  className={`min-w-[90px] text-right font-mono text-[12.5px] tabular-nums ${
                    status === "done" ? "text-muted/70" : "text-muted"
                  }`}
                >
                  {count}
                </span>
                {status === "current" && (
                  <span className="col-start-2 col-end-4 mt-1">
                    <PhaseBar done={loading.done} total={loading.total} />
                    {step === "worktree" && capped && (
                      <small className="mt-[5px] block font-mono text-[11.5px] text-muted">
                        {cappedLine(capped)}
                      </small>
                    )}
                  </span>
                )}
                {status === "failed" && failed && (
                  <span className="col-start-2 col-end-4 mt-1 block">
                    <span className="flex items-start gap-2.5 rounded-[8px] border border-danger/50 bg-banner-error-bg px-3 py-2.5 text-[13px] leading-[19px]">
                      <CircleX size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
                      <span className="block">
                        <span className="block font-semibold">
                          {renderInline(describeError(failed.code).message, "mono")}
                        </span>
                        <span className="mt-1 block text-muted">
                          {renderInline(detailLine(failed), "mono")}
                        </span>
                        {actions.denied && (
                          <span className="mt-1 block text-danger" role="alert">
                            Permission denied. Try again, or choose another folder.
                          </span>
                        )}
                        <span className="mt-2 flex flex-wrap gap-2">
                          {failed.code === "PERMISSION" ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-ink"
                              disabled={actions.busy}
                              onClick={() => void actions.regrant()}
                            >
                              Grant access
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-ink"
                              disabled={actions.busy}
                              onClick={() => void actions.reopen()}
                            >
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={actions.chooseFolder}
                          >
                            Choose another folder
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => void actions.copyReport()}
                          >
                            {actions.copied === "done"
                              ? "Copied"
                              : actions.copied === "failed"
                                ? "Copy failed"
                                : "Copy details"}
                          </button>
                        </span>
                      </span>
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {slow && (
          <div className="flex items-start gap-2.5 rounded-[8px] border border-attention/55 bg-banner-warning-bg px-3 py-2.5 text-[13px] leading-[19px]">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-attention" aria-hidden />
            <div>
              <p className="m-0">
                <b className="font-semibold">Taking longer than usual.</b> {slowReason(codes)}{" "}
                Everything still runs locally.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={actions.busy}
                  onClick={() => void actions.reopen({ skipWorktree: true })}
                >
                  Skip uncommitted changes
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setKeepWaiting(true)}
                >
                  Keep waiting
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2.5">
          {failed ? (
            <button type="button" className="btn btn-sm" onClick={cancel}>
              Back to start
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-sm" onClick={cancel}>
                Cancel
              </button>
              <span className="ml-auto text-[12.5px] text-muted/70">
                {slow ? (
                  "Nothing has been written"
                ) : warnings.length > 0 ? (
                  `${warnings.length} warning${warnings.length === 1 ? "" : "s"} so far · shown as banners once open`
                ) : elapsed < 2000 ? (
                  "Elapsed appears after 2 s"
                ) : (
                  <>
                    <kbd className="kbd">esc</kbd> cancels · nothing has been written
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>
    </CenteredColumn>
  );
}
