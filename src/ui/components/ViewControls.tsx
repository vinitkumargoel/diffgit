import { Space } from "lucide-react";
import type { ViewMode } from "../store";

export interface ViewControlsProps {
  viewMode: ViewMode;
  ignoreWhitespace: boolean;
  onViewMode: (mode: ViewMode) => void;
  onIgnoreWhitespace: (on: boolean) => void;
}

const SEGMENTS: { mode: ViewMode; label: string }[] = [
  { mode: "unified", label: "Unified" },
  { mode: "split", label: "Split" },
];

/** `Unified | Split` segmented control + whitespace toggle (Design §7.2, §8 pressed state). */
export function ViewControls({
  viewMode,
  ignoreWhitespace,
  onViewMode,
  onIgnoreWhitespace,
}: ViewControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <fieldset className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
        <legend className="sr-only">Diff view</legend>
        {SEGMENTS.map((s) => (
          <button
            key={s.mode}
            type="button"
            aria-pressed={viewMode === s.mode}
            className={`rounded-[6px] px-2.5 py-1 text-xs leading-[18px] font-medium ${
              viewMode === s.mode ? "pressed" : "text-muted hover:text-ink"
            }`}
            onClick={() => onViewMode(s.mode)}
          >
            {s.label}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        className={`btn btn-icon ${ignoreWhitespace ? "pressed" : ""}`}
        aria-pressed={ignoreWhitespace}
        aria-label="Ignore whitespace"
        title="Ignore whitespace"
        onClick={() => onIgnoreWhitespace(!ignoreWhitespace)}
      >
        <Space size={14} aria-hidden />
      </button>
    </div>
  );
}
