import type { AppMode } from "../store";
import { useStore } from "../store";

export const MODES: { mode: AppMode; label: string; key: string }[] = [
  { mode: "files", label: "Files", key: "1" },
  { mode: "history", label: "History", key: "2" },
  { mode: "branches", label: "Branches", key: "3" },
  { mode: "insights", label: "Insights", key: "4" },
];

/**
 * Design §14.1: the one control v2 adds to TopBar row 1, right after the repo name. Same segmented
 * styling as `Unified | Split` (§7.2 item 7) — no new look — 28 px tall, with `1`–`4` as the hint.
 */
export function ModeSwitch() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  return (
    <fieldset
      aria-label="View"
      className="inline-flex items-center rounded-[6px] border border-line bg-surface-raised p-0"
    >
      <legend className="sr-only">View</legend>
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          aria-pressed={mode === m.mode}
          title={`${m.label} (${m.key})`}
          className={`h-7 rounded-[6px] px-2.5 text-xs leading-[18px] font-medium ${
            mode === m.mode ? "pressed" : "text-muted hover:text-ink"
          }`}
          onClick={() => setMode(m.mode)}
        >
          {m.label}
        </button>
      ))}
    </fieldset>
  );
}
