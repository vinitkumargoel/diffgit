import { CircleX, Info, TriangleAlert, X } from "lucide-react";
import type { RepoWarning } from "../../engine/types";
import { useStore } from "../store";
import {
  BANNER_LEVEL_CLASS,
  type BannerLevel,
  describeWarning,
  type WarningAction,
} from "../warnings";
import { OperationBanner } from "./OperationBanner";

function LevelIcon({ level }: { level: BannerLevel }) {
  if (level === "info") return <Info size={14} className="shrink-0 text-accent" aria-hidden />;
  if (level === "error") return <CircleX size={14} className="shrink-0 text-danger" aria-hidden />;
  return <TriangleAlert size={14} className="shrink-0 text-attention" aria-hidden />;
}

/** First path-looking token of a FILE_TOO_LARGE detail ("dist/bundle.js, data/fixtures.json"). */
function firstPath(detail: string | undefined): string | null {
  const first = detail?.split(/[,;]/)[0]?.trim() ?? "";
  return first !== "" && /^[\w.@/-]+[./][\w.@/-]+$/.test(first) ? first : null;
}

/**
 * Resolves a banner's `action.kind` to the store call behind it (review E7), or null when the
 * banner has nothing to offer for this particular warning (e.g. a detail without a path).
 */
function useWarningAction(warning: RepoWarning, action: WarningAction | undefined) {
  const headBranch = useStore((s) => s.repo?.headBranch ?? null);
  const requestRefresh = useStore((s) => s.requestRefresh);
  const setPref = useStore((s) => s.setPref);
  const setSource = useStore((s) => s.setSource);
  const setFilter = useStore((s) => s.setFilter);
  const addToast = useStore((s) => s.addToast);
  if (!action) return null;
  switch (action.kind) {
    case "refresh":
      return () => requestRefresh("manual");
    case "ignore-whitespace":
      return () => setPref("ignoreWhitespace", true);
    case "compare-head":
      return () => setSource(headBranch ?? "HEAD");
    case "show-large": {
      const path = firstPath(warning.detail);
      return path === null ? null : () => setFilter(path);
    }
    case "why": {
      const detail = warning.detail;
      return detail === undefined || detail === ""
        ? null
        : () => addToast({ level: "info", message: detail });
    }
    default:
      return null;
  }
}

/** One §7.3 row: icon, bold subject, message, optional engine detail, code, action, dismiss. */
export function WarningBanner({
  warning,
  onDismiss,
}: {
  warning: RepoWarning;
  onDismiss: () => void;
}) {
  const copy = describeWarning(warning.code);
  const run = useWarningAction(warning, copy.action);
  return (
    <div
      role={copy.level === "error" ? "alert" : "status"}
      data-level={copy.level}
      className={`flex items-center gap-2 border-b px-4 py-2 text-[12.5px] leading-[18px] text-ink ${BANNER_LEVEL_CLASS[copy.level]}`}
    >
      <LevelIcon level={copy.level} />
      <p className="min-w-0 flex-1">
        <strong className="font-semibold">{copy.subject}</strong> {copy.message}
        {warning.detail && <span className="text-muted"> {warning.detail}</span>}
        <span className="ml-1 font-mono text-[10.5px] text-muted/70">{warning.code}</span>
      </p>
      {run && copy.action && (
        <button
          type="button"
          className="shrink-0 font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
          onClick={run}
        >
          {copy.action.label}
        </button>
      )}
      <button
        type="button"
        className="shrink-0 rounded-[3px] p-0.5 text-muted hover:bg-surface-raised hover:text-ink"
        aria-label={`Dismiss: ${copy.subject}`}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

/**
 * Stacked, independently dismissible banners for the current repo + diff warnings, with the
 * contextual **OperationBanner** (Design §14.3, T11.3) on top of them — it is not dismissible and
 * is driven by live state, so the engine's one-shot `OPERATION_IN_PROGRESS` warning, which says
 * strictly less and would go stale the moment the rebase ends, never gets a row of its own.
 */
export function WarningBanners() {
  const warnings = useStore((s) => s.warnings);
  const dismissed = useStore((s) => s.dismissedWarnings);
  const dismissWarning = useStore((s) => s.dismissWarning);
  const operation = useStore((s) => s.operation);
  const visible = warnings.filter(
    // T11.6: `BLAME_CAPPED` belongs to one blame of one file, not to the repository, so the card
    // prints it as a single inline line with a `Continue` button instead (Design §14, rule 2).
    (w) =>
      !dismissed.has(w.code) && w.code !== "OPERATION_IN_PROGRESS" && w.code !== "BLAME_CAPPED",
  );
  if (visible.length === 0 && operation === null) return null;
  return (
    <section aria-label="Warnings" className="shrink-0">
      <OperationBanner />
      {visible.map((w) => (
        <WarningBanner key={w.code} warning={w} onDismiss={() => dismissWarning(w.code)} />
      ))}
    </section>
  );
}
