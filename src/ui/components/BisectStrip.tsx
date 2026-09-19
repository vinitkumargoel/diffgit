import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ALL_SKIPPED_NOTE,
  type BisectMark,
  candidateLabel,
  checkoutCommand,
  DIRTY_NOTE,
  FIRST_BAD_NOTE,
  firstBadLabel,
  MARK_TITLE,
  ON_CANDIDATE_NOTE,
  PICK_BAD_PROMPT,
  PICK_GOOD_PROMPT,
  READ_ONLY_NOTE,
  REMAINING_TITLE,
  rangeLabel,
  remainingLabel,
  STASH_COMMAND,
  STRIP_LABEL,
  skippedLabel,
  stepsLabel,
} from "../bisect";
import { describeError } from "../errors";
import { hasUncommittedLayer } from "../secrets";
import { useStore } from "../store";
import { CopyCommand } from "./CopyCommand";

/** A `·` separator between the facts of the strip. */
function Dot() {
  return (
    <span aria-hidden className="text-muted">
      ·
    </span>
  );
}

/**
 * Design §14.5: "Bisect is a strip above the commit list once started (from the palette or the
 * CommitCard menu): `Bisect · good 6345f55 … bad 414e4ed · 14 between · ≈ 4 steps · test a1b2c3d`
 * with `Good` `Bad` `Skip` `Stop` buttons and a copyable checkout command; the candidate is
 * selected in the list."
 *
 * It is a strip, not a mode and not a bar: it exists only while a bisect runs (Design §14, rule 1)
 * and it spans the History body above the commit list, because the command block and the four
 * buttons do not fit the sidebar's width. Nothing is added to TopBar row 1 or the StatsRow.
 *
 * diffgit never writes (D16): the checkout is the user's own command, and the strip's whole job is
 * to do the bookkeeping `git bisect` would otherwise do in the repository.
 */
export function BisectStrip() {
  const bisect = useStore(useShallow((s) => s.bisect));
  const headOid = useStore((s) => s.repo?.headOid ?? null);
  const dirty = useStore((s) => (s.diff?.files ?? []).some(hasUncommittedLayer));
  const markBisect = useStore((s) => s.markBisect);
  const stopBisect = useStore((s) => s.stopBisect);
  const showCommit = useStore((s) => s.showCommit);

  if (bisect === null) return null;

  const stop = (
    <button type="button" className="btn btn-sm" onClick={() => void stopBisect()}>
      Stop
    </button>
  );

  const shell = (children: ReactNode) => (
    <section
      aria-label="Bisect"
      data-bisect={bisect.picking ?? (bisect.firstBad !== null ? "done" : "running")}
      className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface-raised px-3 py-2"
    >
      {children}
    </section>
  );

  // Design §14.5's two-step start: the strip is a prompt and the next click in the list is a mark.
  if (bisect.picking !== null) {
    return shell(
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] leading-5">
        <span className="font-semibold text-ink">{STRIP_LABEL}</span>
        <Dot />
        <span className="text-ink">
          {bisect.picking === "good" ? PICK_GOOD_PROMPT : PICK_BAD_PROMPT}
        </span>
        {bisect.bad !== "" && (
          <>
            <Dot />
            <span className="font-mono text-[11.5px] text-muted">{rangeLabel(bisect)}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">{stop}</span>
      </div>,
    );
  }

  const done = bisect.firstBad !== null;
  const onCandidate = bisect.candidate !== null && headOid === bisect.candidate;

  return shell(
    <>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] leading-5">
        <span className="font-semibold text-ink">{STRIP_LABEL}</span>
        <Dot />
        <span className="font-mono text-[11.5px] text-ink">{rangeLabel(bisect)}</span>
        {!done && (
          <>
            <Dot />
            <span className="text-ink tabular-nums" title={REMAINING_TITLE}>
              {remainingLabel(bisect.remaining)}
            </span>
            <Dot />
            <span className="text-muted tabular-nums">{stepsLabel(bisect.steps)}</span>
          </>
        )}
        {bisect.skipped.length > 0 && (
          <>
            <Dot />
            <span className="text-muted tabular-nums">{skippedLabel(bisect.skipped.length)}</span>
          </>
        )}
        {bisect.candidate !== null && (
          <>
            <Dot />
            <span className="font-mono text-[11.5px] font-semibold text-accent">
              {candidateLabel(bisect.candidate)}
            </span>
          </>
        )}
        {bisect.loading && (
          <span role="status" className="text-[11.5px] text-muted">
            Narrowing…
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {bisect.candidate !== null && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                title="This commit works (g)"
                onClick={() => void markBisect("good")}
              >
                Good <kbd className="kbd ml-1">g</kbd>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="This commit is broken (x)"
                onClick={() => void markBisect("bad")}
              >
                Bad <kbd className="kbd ml-1">x</kbd>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="This commit cannot be tested"
                onClick={() => void markBisect("skip")}
              >
                Skip
              </button>
            </>
          )}
          {done && bisect.firstBad !== null && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void showCommit(bisect.firstBad as string)}
            >
              Show
            </button>
          )}
          {stop}
        </span>
      </div>
      {done && bisect.firstBad !== null && (
        <p className="text-[12.5px] leading-5 text-ink">
          <b className="font-semibold text-danger">{firstBadLabel(bisect.firstBad)}</b>{" "}
          <span className="text-muted">{FIRST_BAD_NOTE}</span>
        </p>
      )}
      {!done && bisect.candidate === null && !bisect.loading && (
        <p className="text-[12.5px] leading-5 text-attention">{ALL_SKIPPED_NOTE}</p>
      )}
      {bisect.candidate !== null &&
        (onCandidate ? (
          <p className="text-[12.5px] leading-5 text-success">
            {ON_CANDIDATE_NOTE} <span className="text-muted">{READ_ONLY_NOTE}</span>
          </p>
        ) : (
          <>
            <CopyCommand command={checkoutCommand(bisect.candidate)} />
            <p className="text-[11.5px] leading-4 text-muted">{READ_ONLY_NOTE}</p>
          </>
        ))}
      {dirty && bisect.candidate !== null && !onCandidate && (
        <p className="text-[11.5px] leading-4 text-attention">
          {DIRTY_NOTE} <code className="font-mono">{STASH_COMMAND}</code>
        </p>
      )}
      {bisect.error !== null && (
        <p className="text-[11.5px] leading-4 text-danger">
          {describeError(bisect.error.code).message}
        </p>
      )}
    </>,
  );
}

/**
 * The §3.3 chip palette each mark wears. Colour is never the only signal (Design §2.1): every tag
 * prints its word and carries the sentence `bisect.ts` writes for it.
 */
const MARK_CLASS: Record<BisectMark, string> = {
  good: "border-chip-staged-fg/40 bg-chip-staged-bg text-chip-staged-fg",
  bad: "border-chip-conflict-fg/40 bg-chip-conflict-bg text-chip-conflict-fg",
  skip: "border-chip-generated-fg/40 bg-chip-generated-bg text-chip-generated-fg",
  test: "border-badge-default-border bg-badge-default-bg text-badge-default-fg",
};

/** The mark a commit row wears while a bisect runs (Design §14.5: the marks are on the rows). */
export function BisectTag({ mark }: { mark: BisectMark }) {
  return (
    <span
      data-bisect-mark={mark}
      className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[10.5px] leading-4 font-semibold ${MARK_CLASS[mark]}`}
      role="img"
      aria-label={`Bisect: ${mark}`}
      title={MARK_TITLE[mark]}
    >
      {mark}
    </span>
  );
}
