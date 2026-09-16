import { CircleX, Info, TriangleAlert, X } from "lucide-react";
import type { RepoWarning } from "../../engine/types";
import { useStore } from "../store";
import { type BannerLevel, describeWarning } from "../warnings";

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

/** One §7.3 row: icon, bold subject, message, optional engine detail, dismiss. */
export function WarningBanner({
  warning,
  onDismiss,
}: {
  warning: RepoWarning;
  onDismiss: () => void;
}) {
  const copy = describeWarning(warning.code);
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
      </p>
      <button
        type="button"
        className="rounded-[3px] p-0.5 text-muted hover:bg-surface-raised hover:text-ink"
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
