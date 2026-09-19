// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: the report below is a real
// ARIA grid for the same reason the Branches tables are (T11.7): the rows are walked with the
// keyboard and Biome's `div` alternative costs the column alignment for nothing.
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PreflightRow } from "../../engine/types";
import { describeError } from "../errors";
import { shortOid } from "../history";
import {
  CAPPED_NOTE,
  COMMAND_HEADING,
  emptyNote,
  isCapped,
  mergeNote,
  NO_OVERLAP,
  overlapLabel,
  PREDICTION_LABEL,
  PREDICTION_TITLE,
  type Prediction,
  panelTitle,
  signedNote,
  summaryLine,
  TEXTUAL_ONLY_NOTE,
  TODO_HEADING,
  todoLines,
  touchesLabel,
  UNRELATED_NOTE,
} from "../preflight";
import { useStore } from "../store";
import { CopyCommand } from "./CopyCommand";
import { Notice } from "./Notice";

const COPIED_MS = 1500;
const TH_CLASS =
  "sticky top-0 z-[1] border-b border-line bg-surface px-3 py-1.5 text-left text-[11px] leading-4 font-medium text-muted";
const TD_CLASS = "border-b border-line-subtle px-3 py-1.5 align-top";

/** The §3.3 chip palettes of the three predictions; each chip prints its own word. */
const PREDICTION_CLASS: Record<Prediction, string> = {
  likely: "border-chip-conflict-fg/40 bg-chip-conflict-bg text-chip-conflict-fg",
  possible: "border-chip-unstaged-fg/40 bg-chip-unstaged-bg text-chip-unstaged-fg",
  clean: "border-chip-staged-fg/40 bg-chip-staged-bg text-chip-staged-fg",
};

function PredictionChip({ prediction }: { prediction: Prediction }) {
  return (
    <span
      data-prediction={prediction}
      title={PREDICTION_TITLE[prediction]}
      className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[11px] leading-4 font-medium ${PREDICTION_CLASS[prediction]}`}
    >
      {PREDICTION_LABEL[prediction]}
    </span>
  );
}

/** `Copy todo`: the `pick <sha7> <subject>` lines the user pastes into git's editor. */
function CopyTodo({ todo }: { todo: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(todo);
      setState("done");
    } catch {
      // Blocked clipboard (insecure context / permissions): say so; the todo is still selectable.
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  const lines = todoLines(todo);
  return (
    <button
      type="button"
      className="btn btn-sm shrink-0"
      title={`Copy ${lines} ${lines === 1 ? "line" : "lines"} of rebase todo`}
      onClick={() => void copy()}
    >
      {state === "done" ? (
        <Check size={12} aria-hidden />
      ) : state === "failed" ? (
        <X size={12} aria-hidden />
      ) : (
        <Copy size={12} aria-hidden />
      )}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy todo"}
    </button>
  );
}

function Row({ row, index, onto }: { row: PreflightRow; index: number; onto: string }) {
  return (
    <tr data-row-index={index} data-oid={row.oid} className="hover:bg-surface-raised">
      <td className={`${TD_CLASS} tabular-nums text-muted`}>{index + 1}</td>
      <td className={`${TD_CLASS} font-mono text-[11.5px] text-muted`}>pick</td>
      <td className={`${TD_CLASS} max-w-[26rem]`}>
        <span className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-accent">{shortOid(row.oid)}</span>
          <span className="truncate text-ink" title={row.subject}>
            {row.subject}
          </span>
          {row.merge && (
            <span
              className="shrink-0 rounded-full border border-line bg-surface-raised px-1.5 text-[11px] leading-4 font-medium"
              title="A merge commit; the command keeps it with --rebase-merges."
            >
              merge
            </span>
          )}
          {row.signed && (
            <span
              className="shrink-0 rounded-full border border-line bg-surface-raised px-1.5 text-[11px] leading-4 font-medium"
              title="Signed; rebasing rewrites the commit and drops the signature."
            >
              signed
            </span>
          )}
        </span>
      </td>
      <td className={`${TD_CLASS} whitespace-nowrap font-mono text-[11.5px] text-muted`}>
        {touchesLabel(row.files)}
      </td>
      <td className={`${TD_CLASS} max-w-[30rem] font-mono text-[11.5px] text-ink`}>
        {row.overlaps.length === 0 ? (
          <span className="text-muted">{NO_OVERLAP}</span>
        ) : (
          row.overlaps.map((o) => (
            <span key={o.path} data-overlap={o.path} className="block truncate" title={o.path}>
              {overlapLabel(o, onto)}
            </span>
          ))
        )}
      </td>
      <td className={TD_CLASS}>
        <PredictionChip prediction={row.prediction} />
      </td>
    </tr>
  );
}

/**
 * Design §14.6 / atlas tab 16: "Rebase preflight opens as a panel in the diff pane area (Branches
 * mode): table of commits to replay with `Touches`, `Overlaps with <onto>`, `Prediction` (clean /
 * possible / likely chips), the `git rebase -i <onto>` command and a `Copy todo` button. Report
 * only; no reorder controls."
 *
 * It is a panel, never a mode: it replaces the Branches table while it is open, keeps the page's
 * own header, and closes back to the table — nothing was added to the bars for it, and it is
 * reached from the row `…` menu or the palette, as §14.1 requires.
 */
export function PreflightPanel() {
  const state = useStore((s) => s.preflight);
  const closePreflight = useStore((s) => s.closePreflight);
  const ref = useRef<HTMLElement>(null);

  // Escape closes the panel wherever focus is inside it, as every other overlay in the app does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.contains(document.activeElement)) closePreflight();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closePreflight]);

  if (state.branch === null || state.onto === null) return null;
  const heading = panelTitle({ branch: state.branch, onto: state.onto });
  const r = state.result;
  const merge = r ? mergeNote(r) : null;
  const signed = r ? signedNote(r) : null;

  return (
    <section ref={ref} aria-label={heading} data-preflight className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2">
        <h2 className="text-[13px] leading-5 font-semibold text-ink">{heading}</h2>
        {r && <span className="text-[12px] leading-5 text-muted">{summaryLine(r)}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {r && r.rows.length > 0 && <CopyTodo todo={r.todo} />}
          <button type="button" className="btn btn-sm" onClick={closePreflight}>
            Close
          </button>
        </span>
      </div>

      {state.loading && (
        <p role="status" className="py-3 text-[12.5px] leading-5 text-muted">
          Reading what would be replayed…
        </p>
      )}
      {state.error !== null && (
        <div className="py-3">
          <Notice detail={describeError(state.error.code).message} code={state.error.code}>
            Couldn’t work out what a rebase of {state.branch} onto {state.onto} would replay
          </Notice>
        </div>
      )}

      {r && (
        <>
          {r.mergeBase === null && (
            <p className="py-2 text-[12.5px] leading-5 text-attention">{UNRELATED_NOTE}</p>
          )}
          {r.rows.length === 0 ? (
            <p className="py-3 text-[12.5px] leading-5 text-muted">{emptyNote(r)}</p>
          ) : (
            <>
              <table
                role="grid"
                aria-label={heading}
                className="w-full border-collapse text-[12.5px]"
              >
                <thead>
                  <tr>
                    {[
                      "#",
                      "Action",
                      "Commit",
                      "Touches",
                      `Overlaps with ${r.onto}`,
                      "Prediction",
                    ].map((label) => (
                      <th key={label} scope="col" className={TH_CLASS}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody data-rows>
                  {r.rows.map((row, i) => (
                    <Row key={row.oid} row={row} index={i} onto={r.onto} />
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex flex-col gap-2">
                <p className="text-[12.5px] leading-5 text-ink">{COMMAND_HEADING}</p>
                <CopyCommand command={r.command} />
                <p className="text-[11.5px] leading-4 text-muted">{TODO_HEADING}</p>
                <pre className="max-h-48 overflow-auto rounded-[6px] border border-line bg-surface-raised px-2.5 py-1.5 font-mono text-[11.5px] leading-5 text-ink">
                  {r.todo}
                </pre>
                {merge !== null && (
                  <p className="text-[11.5px] leading-4 text-attention">{merge}</p>
                )}
                {signed !== null && (
                  <p className="text-[11.5px] leading-4 text-attention">{signed}</p>
                )}
                {isCapped(r) && (
                  <p className="text-[11.5px] leading-4 text-attention">{CAPPED_NOTE}</p>
                )}
                <p className="text-[11.5px] leading-4 text-muted">{TEXTUAL_ONLY_NOTE}</p>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
