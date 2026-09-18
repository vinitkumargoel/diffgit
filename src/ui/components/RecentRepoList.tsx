import { FolderGit2, X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import type { StoredRepo } from "../persistence";
import { timeAgo } from "../timeAgo";

export interface RecentRepoListProps {
  repos: StoredRepo[];
  /** Resolves to "granted" | "denied"; must run inside the click/keydown handler (user gesture). */
  onOpen(repo: StoredRepo): Promise<"granted" | "denied">;
  onRemove(repo: StoredRepo): void;
  now?: number;
}

/**
 * Design §7.8, "Precision" home: hairline rows that match the facts list above — 36 px tall,
 * name 500, "opened 3 h ago" in mono on the right, × on hover/focus.
 */
export function RecentRepoList({ repos, onOpen, onRemove, now }: RecentRepoListProps) {
  const [denied, setDenied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (repos.length === 0) return null;

  async function open(repo: StoredRepo) {
    setBusy(repo.id);
    try {
      const result = await onOpen(repo);
      setDenied(result === "denied" ? repo.id : null);
    } finally {
      setBusy(null);
    }
  }
  function onKey(e: KeyboardEvent<HTMLElement>, repo: StoredRepo) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void open(repo);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(repo);
    }
  }

  return (
    <section aria-label="Recent repositories" className="w-full text-left">
      <h2 className="mb-2 font-mono text-[11px] uppercase leading-4 tracking-[0.06em] text-muted">
        Recent
      </h2>
      <ul className="border-t border-line-subtle">
        {repos.map((repo) => (
          <li key={repo.id} className="group border-b border-line-subtle">
            <div className="flex min-h-9 items-center gap-1">
              <button
                type="button"
                className="-mx-2 flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[6px] px-2 text-left hover:bg-surface-raised focus-visible:bg-surface-raised disabled:opacity-60"
                onClick={() => void open(repo)}
                onKeyDown={(e) => onKey(e, repo)}
                disabled={busy === repo.id}
                aria-label={`Open ${repo.name}`}
              >
                <FolderGit2 size={15} className="shrink-0 text-muted" aria-hidden="true" />
                <span className="truncate text-[13px] font-medium">{repo.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                  opened {timeAgo(repo.lastOpenedAt, now)}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-icon h-6 w-6 border-transparent bg-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={`Remove ${repo.name} from recent repositories`}
                onClick={() => onRemove(repo)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {denied === repo.id && (
              <p className="pb-2 text-xs text-danger" role="alert">
                Permission denied.{" "}
                <button type="button" className="underline" onClick={() => void open(repo)}>
                  Try again
                </button>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
