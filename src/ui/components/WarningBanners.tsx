import { CircleX, Info, TriangleAlert, X } from "lucide-react";
import type { RepoWarning } from "../../engine/types";
import { useStore } from "../store";
import { type BannerLevel, describeWarning, type WarningAction } from "../warnings";

const LEVEL_CLASS: Record<BannerLevel, string> = {
  warning: "bg-banner-warning-bg border-banner-warning-border",
  info: "bg-banner-info-bg border-banner-info-border",
  error: "bg-banner-error-bg border-banner-error-border",
};

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
      className={`flex items-center gap-2 border-b px-4 py-2 text-[12.5px] leading-[18px] text-ink ${LEVEL_CLASS[copy.level]}`}
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

/** Stacked, independently dismissible banners for the current repo + diff warnings. */
export function WarningBanners() {
  const warnings = useStore((s) => s.warnings);
  const dismissed = useStore((s) => s.dismissedWarnings);
  const dismissWarning = useStore((s) => s.dismissWarning);
  const visible = warnings.filter((w) => !dismissed.has(w.code));
  if (visible.length === 0) return null;
  return (
    <section aria-label="Warnings" className="shrink-0">
      {visible.map((w) => (
        <WarningBanner key={w.code} warning={w} onDismiss={() => dismissWarning(w.code)} />
      ))}
    </section>
  );
}
