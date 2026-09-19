import { modeDisabledTitle } from "../patch";
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
  // T11.14: History, Branches and Insights walk a repository. A patch file is not one, so they are
  // disabled rather than hidden — the control keeps its shape and each button says why (§14.6).
  const patchOnly = useStore((s) => s.patchOnly);
  return (
    <fieldset
      aria-label="View"
      className="inline-flex items-center rounded-[6px] border border-line bg-surface-raised p-0"
    >
      <legend className="sr-only">View</legend>
      {MODES.map((m) => {
        const disabled = patchOnly && m.mode !== "files";
        return (
          <button
            key={m.mode}
            type="button"
            aria-pressed={mode === m.mode}
            disabled={disabled}
            title={disabled ? modeDisabledTitle(m.label) : `${m.label} (${m.key})`}
            className={`h-7 rounded-[6px] px-2.5 text-xs leading-[18px] font-medium ${
              mode === m.mode ? "pressed" : "text-muted hover:text-ink"
            } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
            onClick={() => setMode(m.mode)}
          >
            {m.label}
          </button>
        );
      })}
    </fieldset>
  );
}
