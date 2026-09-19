import { useCallback, useEffect, useRef, useState } from "react";
import type { PathExplanation } from "../../engine/types";
import { toUiError, type UiError } from "../errors";
import { AUTHORITY_NOTE, describeReason, explanationTitle, GLOBAL_EXCLUDES_NOTE } from "../hidden";
import { useStore } from "../store";
import { CopyCommand } from "./CopyCommand";

type State =
  | { status: "loading" }
  | { status: "ready"; data: PathExplanation }
  | { status: "error"; error: UiError };

/** Where the popover is pinned: the anchor row's viewport box (the sidebar body scrolls). */
export interface PopoverAnchor {
  left: number;
  bottom: number;
}

/** Design §5: popover offset under its anchor. */
const GAP = 4;

/**
 * Design §14.3 "Why hidden" / atlas tab 08: a path, the reasons it is not in the diff — the ignore
 * rule with its file and line, the index flag, the sparse checkout or the size gate — and the
 * copyable command that answers it authoritatively. Opened from a Hidden row, from `?` on a focused
 * sidebar row and from a right-click; T11.6 adds the card header's `…` menu.
 */
export function WhyHiddenPopover({
  path,
  anchor,
  onClose,
}: {
  path: string;
  anchor: PopoverAnchor;
  /** `refocus` asks the caller to put focus back on the row the popover belongs to. */
  onClose: (refocus: boolean) => void;
}) {
  const explainPath = useStore((s) => s.explainPath);
  const globalExcludesUnavailable = useStore((s) =>
    s.warnings.some((w) => w.code === "GLOBAL_EXCLUDES_UNAVAILABLE"),
  );
  const [state, setState] = useState<State>({ status: "loading" });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    explainPath(path).then(
      (data) => {
        if (live) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (live) setState({ status: "error", error: toUiError(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [path, explainPath]);

  // Focus moves into the popover so Escape and the Copy buttons are reachable from the keyboard.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const close = useCallback((refocus: boolean) => onClose(refocus), [onClose]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
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
  }, [close]);

  const reasons = state.status === "ready" ? state.data.reasons.map(describeReason) : [];
  const commands = [...new Set(reasons.flatMap((r) => (r.command ? [r.command] : [])))];
  const ignored = state.status === "ready" && state.data.reasons.some((r) => r.kind === "ignored");

  return (
    <div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      aria-label={`Why ${path} is hidden`}
      data-testid="why-hidden"
      className="popover fixed z-30 w-[26rem] max-w-[calc(100vw-2rem)] p-3 focus-visible:outline-none"
      style={{ left: anchor.left, top: anchor.bottom + GAP }}
    >
      <h2 className="pr-2 text-xs font-semibold text-ink">
        {state.status === "ready" ? explanationTitle(state.data) : path}
      </h2>
      {state.status === "loading" && (
        <p className="mt-2 text-[12px] leading-5 text-muted">Checking the rules…</p>
      )}
      {state.status === "error" && (
        <p className="mt-2 text-[12px] leading-5 text-danger">
          Could not explain this path: {state.error.message}
        </p>
      )}
      {state.status === "ready" && (
        <>
          {reasons.length === 0 && (
            <p className="mt-2 text-[12px] leading-5 text-muted">
              Nothing hides this path; it is listed in the diff above.
            </p>
          )}
          <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-[12px] leading-5">
            {reasons.map((r) => (
              <div key={`${r.term}:${r.detail}`} className="contents">
                <dt className="text-muted">{r.term}</dt>
                <dd className="min-w-0 text-ink">
                  {r.detail}
                  {r.code !== null && (
                    <>
                      {" "}
                      <span className="font-mono break-all">{r.code}</span>
                    </>
                  )}
                  {r.note !== null && <span className="block text-muted">{r.note}</span>}
                </dd>
              </div>
            ))}
            {ignored && globalExcludesUnavailable && (
              <div className="contents">
                <dt className="text-muted">{GLOBAL_EXCLUDES_NOTE.term}</dt>
                <dd className="min-w-0 text-muted">{GLOBAL_EXCLUDES_NOTE.detail}</dd>
              </div>
            )}
          </dl>
          {commands.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {commands.map((c) => (
                <CopyCommand key={c} command={c} />
              ))}
              <p className="text-[11px] leading-4 text-muted">{AUTHORITY_NOTE}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
