import { Info, Play, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RepoOperation } from "../../engine/types";
import { describeOperation, operationSteps, STEP_LABEL, STEP_MARK, short } from "../operation";
import { useStore } from "../store";
import { BANNER_LEVEL_CLASS } from "../warnings";
import { CopyCommand } from "./CopyCommand";

/** The todo list behind "Show steps": done ✓ / current ▶ / remaining, plus the two commands. */
function StepsPopover({ operation, id }: { operation: RepoOperation; id: string }) {
  const steps = operationSteps(operation);
  const copy = describeOperation(operation);
  return (
    <div
      id={id}
      role="dialog"
      aria-label="Steps of this operation"
      className="popover absolute top-full right-0 z-20 mt-1 w-[24rem] max-w-[calc(100vw-2rem)] p-3"
    >
      <h2 className="text-xs font-semibold text-ink">
        {copy.subject}
        {operation.total !== undefined && (
          <span className="ml-1.5 font-normal text-muted">{operation.total} steps</span>
        )}
      </h2>
      {steps.length > 0 ? (
        <ol className="mt-2 max-h-56 overflow-y-auto">
          {steps.map((s) => (
            <li
              key={`${s.state}:${s.oid}`}
              data-state={s.state}
              className={`flex items-baseline gap-2 py-0.5 text-[12px] leading-5 ${
                s.state === "remaining" ? "text-muted" : "text-ink"
              }`}
            >
              <span
                aria-hidden
                className={`w-3 shrink-0 text-center ${
                  s.state === "current"
                    ? "text-accent"
                    : s.state === "done"
                      ? "text-success"
                      : "text-muted"
                }`}
              >
                {STEP_MARK[s.state]}
              </span>
              <span className="font-mono">{short(s.oid)}</span>
              <span className="text-muted">{STEP_LABEL[s.state]}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-[12px] leading-5 text-muted">
          This layout keeps no todo list, so diffgit cannot list the steps.
        </p>
      )}
      <div className="mt-3 flex flex-col gap-1.5">
        {copy.continueCommand && <CopyCommand command={copy.continueCommand} />}
        <CopyCommand command={copy.abortCommand} />
      </div>
      <p className="mt-2 text-[11px] leading-4 text-muted">
        diffgit never runs these; copy one into your terminal.
      </p>
    </div>
  );
}

/**
 * Design §14.3: the contextual banner for the merge / rebase / cherry-pick / revert / bisect git is
 * in the middle of. It lives at the top of the WarningBanners stack, is **not** dismissible while
 * the operation persists (dismissing a fact about the repository would only hide it), and follows
 * `RepoInfo.operation`, which `reloadRefs()` refreshes on every git-side refresh tick.
 */
export function OperationBanner() {
  const operation = useStore((s) => s.operation);
  const detached = useStore((s) => s.repo?.detached ?? false);
  const headDisplay = useStore((s) => s.repo?.headDisplay ?? "");
  const [steps, setSteps] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const close = useCallback((refocus: boolean) => {
    setSteps(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!steps) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [steps, close]);

  // The operation ended (or the repo closed): the popover must not outlive it.
  useEffect(() => {
    if (operation === null) setSteps(false);
  }, [operation]);

  if (operation === null) return null;
  const copy = describeOperation(operation);
  const branch = operation.headName?.replace(/^refs\/heads\//, "") ?? null;
  return (
    <>
      <div
        ref={rootRef}
        role={copy.level === "warning" ? "alert" : "status"}
        data-level={copy.level}
        data-operation={operation.kind}
        className={`relative flex items-center gap-2 border-b px-4 py-2 text-[12.5px] leading-[18px] text-ink ${BANNER_LEVEL_CLASS[copy.level]}`}
      >
        {copy.level === "warning" ? (
          <TriangleAlert size={14} className="shrink-0 text-attention" aria-hidden />
        ) : (
          <Play size={14} className="shrink-0 text-accent" aria-hidden />
        )}
        <p className="min-w-0 flex-1">
          <strong className="font-semibold">{copy.subject}</strong>
          {copy.message !== "" && <span> · {copy.message}</span>}
          {copy.note !== null && <span className="text-muted"> {copy.note}</span>}
        </p>
        <button
          ref={triggerRef}
          type="button"
          className="shrink-0 font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
          aria-haspopup="dialog"
          aria-expanded={steps}
          aria-controls={steps ? popoverId : undefined}
          onClick={() => setSteps((o) => !o)}
        >
          Show steps
        </button>
        {steps && <StepsPopover operation={operation} id={popoverId} />}
      </div>
      {detached && (
        <div
          role="status"
          data-level="info"
          data-testid="detached-banner"
          className={`flex items-center gap-2 border-b px-4 py-2 text-[12.5px] leading-[18px] text-ink ${BANNER_LEVEL_CLASS.info}`}
        >
          <Info size={14} className="shrink-0 text-accent" aria-hidden />
          <p className="min-w-0 flex-1">
            <strong className="font-semibold">Detached HEAD</strong>{" "}
            <span>
              at <span className="font-mono">{short(operation.current) || headDisplay}</span> while
              the {operation.kind} runs
              {branch !== null && (
                <>
                  . Compare defaults to the branch being replayed,{" "}
                  <span className="font-mono">{branch}</span>
                </>
              )}
              .
            </span>
          </p>
        </div>
      )}
    </>
  );
}
