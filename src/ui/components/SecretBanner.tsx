import { CircleX } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SecretFinding } from "../../engine/types";
import { requestScrollTo } from "../scrollBus";
import {
  bannerCopy,
  cappedLine,
  findingLabel,
  locationLabel,
  RULES_HELP,
  RULESET_DATE,
} from "../secrets";
import { selectSecretGate, useStore } from "../store";
import { BANNER_LEVEL_CLASS } from "../warnings";

/**
 * Focuses the card and the flagged line of one finding — T11.6's jump, with a line: the pane
 * scrolls the card into view and `DiffBody` focuses that line's marker. The card is forced back to
 * `Diff` and expanded first, because a collapsed card or one in Blame mode has no line to jump to.
 */
function useJumpToFinding(): (finding: SecretFinding) => void {
  const setMode = useStore((s) => s.setMode);
  const setCardMode = useStore((s) => s.setCardMode);
  const setCollapsed = useStore((s) => s.setCollapsed);
  const setActiveFile = useStore((s) => s.setActiveFile);
  return useCallback(
    (finding: SecretFinding) => {
      setMode("files");
      setCardMode(finding.fileId, "diff");
      setCollapsed(finding.fileId, false);
      setActiveFile(finding.fileId);
      requestScrollTo(finding.fileId, finding.line);
    },
    [setMode, setCardMode, setCollapsed, setActiveFile],
  );
}

/** `Rules`: what the rule set is, what it looked at, and the two ways to silence a finding. */
function RulesPopover({ id }: { id: string }) {
  return (
    <div
      id={id}
      role="dialog"
      aria-label="Secret scan rules"
      data-testid="secret-rules"
      className="popover absolute top-full right-0 z-20 mt-1 w-[26rem] max-w-[calc(100vw-2rem)] p-3"
    >
      <h2 className="text-xs font-semibold text-ink">Scan rules · {RULESET_DATE}</h2>
      <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-[12px] leading-5">
        {RULES_HELP.map((r) => (
          <div key={r.term} className="contents">
            <dt className="text-muted">{r.term}</dt>
            <dd className="min-w-0 text-ink">{r.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Design §14.3: the contextual danger banner for a repository whose uncommitted work contains
 * something that looks like a credential. It lives in the WarningBanners stack (§14.2) and exists
 * only while a finding does, so the repo screen is exactly v1's when nothing is wrong.
 *
 * `Show` opens the finding list and jumps to the first one; `Rules` explains the rule set and the
 * two allowlists. The `SECRETS_FOUND` cap is printed at the foot of that list rather than as a
 * second banner — one surface per fact.
 */
export function SecretBanner() {
  const gate = useStore(selectSecretGate);
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState(false);
  const jump = useJumpToFinding();
  const rootRef = useRef<HTMLDivElement>(null);
  const rulesTrigger = useRef<HTMLButtonElement>(null);
  const rulesId = useId();
  const listId = useId();

  const closeRules = useCallback((refocus: boolean) => {
    setRules(false);
    if (refocus) rulesTrigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!rules) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeRules(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRules(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [rules, closeRules]);

  // A recompute that clears the findings must not leave the list or the popover behind.
  const count = gate.count;
  useEffect(() => {
    if (count === 0) {
      setOpen(false);
      setRules(false);
    }
  }, [count]);

  if (count === 0) return null;
  const copy = bannerCopy(count);
  const capped = cappedLine(count, gate.total);
  const first = gate.findings[0];

  return (
    <div
      ref={rootRef}
      data-level="error"
      data-testid="secret-banner"
      className={`relative border-b ${BANNER_LEVEL_CLASS.error}`}
    >
      <div
        role="alert"
        className="flex items-center gap-2 px-4 py-2 text-[12.5px] leading-[18px] text-ink"
      >
        <CircleX size={14} className="shrink-0 text-danger" aria-hidden />
        <p className="min-w-0 flex-1">
          <strong className="font-semibold">{copy.subject}</strong> {copy.message}
        </p>
        <button
          type="button"
          className="shrink-0 font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && first) jump(first);
          }}
        >
          {open ? "Hide" : "Show"}
        </button>
        <button
          ref={rulesTrigger}
          type="button"
          className="shrink-0 font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
          aria-haspopup="dialog"
          aria-expanded={rules}
          aria-controls={rules ? rulesId : undefined}
          onClick={() => (rules ? closeRules(true) : setRules(true))}
        >
          Rules
        </button>
      </div>
      {rules && <RulesPopover id={rulesId} />}
      {open && (
        <ul id={listId} aria-label="Possible secrets" className="px-4 pb-2">
          {gate.findings.map((f) => (
            <li key={`${f.fileId}:${f.line}:${f.rule}:${f.masked}`}>
              <button
                type="button"
                data-secret-finding={`${f.path}:${f.line}`}
                aria-label={findingLabel(f)}
                className="flex w-full items-center gap-2 rounded-[4px] px-1 py-0.5 text-left text-[12px] leading-5 hover:bg-surface-raised"
                onClick={() => jump(f)}
              >
                <span className="shrink-0 font-mono text-chip-conflict-fg">{f.rule}</span>
                <span className="min-w-0 truncate font-mono text-ink">{locationLabel(f)}</span>
                <span className="ml-auto shrink-0 font-mono text-muted">{f.masked}</span>
              </button>
            </li>
          ))}
          {capped !== null && <li className="px-1 py-0.5 text-[11px] text-muted">{capped}</li>}
        </ul>
      )}
    </div>
  );
}
