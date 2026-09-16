export interface IncludeWorktreeToggleProps {
  checked: boolean;
  /** False unless the compare (source) branch is the checked-out one (Plan D6). */
  enabled: boolean;
  /** `repo.headDisplay`, for the disabled tooltip. */
  headDisplay: string;
  onChange: (on: boolean) => void;
}

export function disabledReason(headDisplay: string): string {
  return `Only available when the source is the checked-out branch (${headDisplay})`;
}

/** Checkbox + "Include uncommitted changes" (Design §7.1 item 5). */
export function IncludeWorktreeToggle({
  checked,
  enabled,
  headDisplay,
  onChange,
}: IncludeWorktreeToggleProps) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 text-[13px] leading-5 select-none ${
        enabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"
      }`}
      title={enabled ? undefined : disabledReason(headDisplay)}
    >
      <input
        type="checkbox"
        className="size-3.5 rounded-[3px] accent-accent"
        checked={checked && enabled}
        disabled={!enabled}
        aria-describedby={enabled ? undefined : "include-worktree-why"}
        onChange={(e) => onChange(e.target.checked)}
      />
      Include uncommitted changes
      {!enabled && (
        <span id="include-worktree-why" className="sr-only">
          {disabledReason(headDisplay)}
        </span>
      )}
    </label>
  );
}
