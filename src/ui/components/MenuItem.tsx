/**
 * One row of a `…` menu (Design §14.1: "Bisect, rebase preflight, patch export … are row actions
 * in a `…` menu or palette commands, never buttons in the chrome"). Shared by the CommitCard
 * (T11.5) and the Branches table (T11.7) so the two menus cannot drift apart.
 *
 * An action whose task has not shipped is **disabled and still listed**, never hidden — the owner's
 * rule recorded in the T11.5 changelog: the feature stays discoverable and says when it arrives.
 */
export function MenuItem({
  label,
  onClick,
  pending,
  disabled,
  title,
}: {
  label: string;
  onClick?: () => void;
  /** Task id of the work that wires this action; renders it disabled with "coming soon (T11.x)". */
  pending?: string;
  /** Disabled here and now, for a reason `title` states (e.g. "this is already the base"). */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={pending !== undefined || disabled === true}
      title={pending === undefined ? title : `coming soon (${pending})`}
      className="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] leading-5 text-ink not-disabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
