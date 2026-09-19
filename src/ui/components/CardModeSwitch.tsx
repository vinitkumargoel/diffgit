import type { CardMode } from "../store";

const MODES: { id: CardMode; label: string; key: string }[] = [
  { id: "diff", label: "Diff", key: "d" },
  { id: "blame", label: "Blame", key: "b" },
  { id: "history", label: "History", key: "h" },
];

/**
 * Design §14.1: the mini `Diff | Blame | History` segmented control on a FileHeader, 11 px, in the
 * same style as `Unified | Split` (§7.2 item 7). Rendered only when the file has a committed side
 * — blame and file history need a commit to walk back from — which the caller decides.
 */
export function CardModeSwitch({
  mode,
  onMode,
  path,
}: {
  mode: CardMode;
  onMode: (mode: CardMode) => void;
  path: string;
}) {
  return (
    <fieldset className="inline-flex shrink-0 items-center rounded-[4px] border border-line bg-surface-raised p-0">
      <legend className="sr-only">View of {path}</legend>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={mode === m.id}
          title={`${m.label} (${m.key})`}
          className={`rounded-[3px] px-1.5 py-[1px] text-[11px] leading-4 ${
            mode === m.id ? "pressed" : "text-muted hover:text-ink"
          }`}
          onClick={() => onMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </fieldset>
  );
}
