import { Eye, EyeOff, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SecretFinding } from "../../engine/types";
import {
  displayValue,
  entropyLabel,
  findingLabel,
  RULES_HELP,
  rotateChecklist,
  whereLine,
  whyFlagged,
} from "../secrets";
import { CopyCommand } from "./CopyCommand";

/** Popover offset under its trigger (Design §5). */
const GAP = 4;

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{term}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

/**
 * One finding, as the popover words it (Design §14.3: "rule, entropy, where, allowlist help,
 * Reveal and Mask buttons"). `revealed` is owned by the marker below and dies with it: it is never
 * written to the prefs, the derived cache or the hash (atlas tab 14 — a reveal is one click, for
 * one finding, for as long as the popover is open).
 */
function Finding({
  finding,
  revealed,
  onReveal,
}: {
  finding: SecretFinding;
  revealed: boolean;
  onReveal: (on: boolean) => void;
}) {
  return (
    <section className="border-line-subtle not-first:mt-3 not-first:border-t not-first:pt-3">
      <h3 className="text-xs font-semibold text-ink">
        Line {finding.line} · rule <span className="font-mono">{finding.rule}</span> · entropy{" "}
        {entropyLabel(finding)}
      </h3>
      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-[12px] leading-5">
        <Row term="Value">
          <span className="font-mono break-all" data-secret-value={revealed ? "full" : "masked"}>
            {displayValue(finding, revealed)}
          </span>
        </Row>
        <Row term="Where">{whereLine(finding)}</Row>
        <Row term="Why flagged">{whyFlagged(finding)}</Row>
        <Row term="If it is a fixture">
          {RULES_HELP[2]?.detail} {RULES_HELP[3]?.detail}
        </Row>
      </dl>
      <div className="mt-3 flex flex-col gap-1.5">
        <button
          type="button"
          className="btn btn-sm self-start"
          aria-pressed={revealed}
          onClick={() => onReveal(!revealed)}
        >
          {revealed ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
          {revealed ? "Mask" : "Reveal"}
        </button>
        <CopyCommand command={rotateChecklist(finding)} label="Rotate" />
      </div>
    </section>
  );
}

/**
 * Design §14.3 / atlas tab 14: the flagged line's inline trigger and the popover behind it. It is
 * rendered by `DiffBody` as a react-diff-view widget row directly under the line, which also
 * carries the 3 px `--danger` left rule; the button is the jump target a finding row focuses.
 */
export function SecretMarker({ line, findings }: { line: number; findings: SecretFinding[] }) {
  const [open, setOpen] = useState(false);
  /** Indices of the findings revealed while this popover is open; dropped when it closes. */
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setRevealed(new Set());
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
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
  }, [open, close]);

  const first = findings[0];
  if (!first) return null;
  const label =
    findings.length === 1
      ? findingLabel(first)
      : `${findings.length} possible secrets in ${first.path} line ${line}`;

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        data-secret-line={line}
        className="inline-flex items-center gap-1 rounded-[4px] border border-chip-conflict-fg/40 bg-chip-conflict-bg px-1.5 py-0.5 text-[11px] leading-4 font-medium text-chip-conflict-fg hover:underline"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={label}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <ShieldAlert size={12} aria-hidden />
        <span aria-hidden>
          {findings.length === 1 ? first.rule : `${findings.length} possible secrets`}
        </span>
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={`Possible secret in ${first.path} line ${line}`}
          data-testid="secret-popover"
          className="popover absolute top-full left-0 z-20 w-[28rem] max-w-[calc(100vw-2rem)] p-3 font-sans whitespace-normal"
          style={{ marginTop: GAP }}
        >
          {findings.map((f, i) => (
            <Finding
              key={`${f.rule}:${f.masked}`}
              finding={f}
              revealed={revealed.has(i)}
              onReveal={(on) =>
                setRevealed((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(i);
                  else next.delete(i);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </span>
  );
}
