import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useStore } from "../store";
import {
  branchLabel,
  EMPTY_LINE,
  LOADING_LINE,
  OPEN_IT_NOTE,
  OPEN_IT_TITLE,
  PATH_TITLE,
  PRUNABLE,
  PRUNABLE_TITLE,
  pathLabel,
  THIS_FOLDER,
  THIS_FOLDER_TITLE,
  WORKTREES_SOURCE,
  WORKTREES_TITLE,
  worktreeCount,
} from "../worktrees";

/** A `ref`-style tag, the shape `ConflictTag` / `SecretTag` / the branch `Badge` already use. */
function Tag({
  children,
  title,
  tone,
}: {
  children: string;
  title: string;
  tone: "muted" | "warn";
}) {
  const palette =
    tone === "warn"
      ? "border-chip-unstaged-fg/40 bg-chip-unstaged-bg text-chip-unstaged-fg"
      : "border-chip-generated-fg/40 bg-chip-generated-bg text-chip-generated-fg";
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 font-sans text-[11px] leading-4 font-medium ${palette}`}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * `git worktree list`, as far as a browser can see it (T11.16, Design §14.1, atlas tab 19).
 *
 * Design §14.1's last paragraph keeps this out of the bars: it is a palette action
 * (`Worktrees`) and the repo-name button, never a control of its own. Listing is all it does —
 * File System Access permission is scoped to the folder the user picked, so another checkout
 * needs its own pick, and a linked worktree (whose `.git` is a pointer file) is refused on open
 * with `WORKTREE_GITDIR` anyway. The two columns that are honest gaps rather than facts carry
 * their explanation in a `title` (`src/ui/worktrees.ts`).
 */
export function WorktreesDialog() {
  const open = useStore((s) => s.worktreesOpen);
  const setOpen = useStore((s) => s.setWorktreesOpen);
  const worktrees = useStore((s) => s.worktrees);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  const close = () => setOpen(false);
  return (
    <dialog
      ref={ref}
      className="help-dialog"
      aria-labelledby="worktrees-title"
      onClose={close}
      onCancel={close}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="worktrees-title" className="text-base leading-6 font-semibold">
          {WORKTREES_TITLE}
          {worktrees !== null && (
            <span className="ml-2 text-[13px] font-normal text-muted">
              {worktreeCount(worktrees.length)}
            </span>
          )}
        </h2>
        <button type="button" className="btn btn-icon" aria-label="Close" onClick={close}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted">{WORKTREES_SOURCE}</p>
      {worktrees === null ? (
        <p className="mt-3 text-[13px] leading-5 text-muted">{LOADING_LINE}</p>
      ) : worktrees.length === 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-muted">{EMPTY_LINE}</p>
      ) : (
        <ul className="mt-3 text-[13px] leading-5">
          {worktrees.map((w) => (
            <li
              key={w.name}
              className="flex flex-wrap items-center gap-2 border-t border-line py-1.5"
            >
              <span className="min-w-0 truncate font-mono" title={PATH_TITLE}>
                {pathLabel(w)}
              </span>
              <Tag
                tone="muted"
                title={w.branch === null ? "HEAD names no branch here." : (w.branch as string)}
              >
                {branchLabel(w)}
              </Tag>
              {w.prunable && (
                <Tag tone="warn" title={PRUNABLE_TITLE}>
                  {PRUNABLE}
                </Tag>
              )}
              <span
                className="ml-auto shrink-0 text-xs text-muted"
                title={w.isThis ? THIS_FOLDER_TITLE : OPEN_IT_TITLE}
              >
                {w.isThis ? THIS_FOLDER : OPEN_IT_NOTE}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs leading-5 text-muted">{OPEN_IT_TITLE}</p>
    </dialog>
  );
}
