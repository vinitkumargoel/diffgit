/**
 * One Recent row and its inline outcome (mockup §s1 H2/H4), shared by the hero list and the nav
 * popover (H5). Styling comes from the marketing stylesheet (`.rrow`, `.rmsg`, `.dot`, `.pair`),
 * which is injected by HomeScreen; that is where this design's literal colours live.
 */
import { CircleX, FolderGit2, LoaderCircle, Lock, TriangleAlert, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { PermissionAnswer, StoredRepo } from "../../persistence";
import { timeAgo } from "../../timeAgo";
import type { RowState } from "./useRecents";

const ACCESS_CLASS: Record<PermissionAnswer, string> = {
  granted: "dot g",
  prompt: "dot y",
  denied: "dot r",
};
const ACCESS_TITLE: Record<PermissionAnswer, string> = {
  granted: "Access granted",
  prompt: "Will ask for access",
  denied: "Missing",
};

export function AccessDot({ access }: { access: PermissionAnswer }) {
  return (
    <span
      className={ACCESS_CLASS[access]}
      role="img"
      aria-label={ACCESS_TITLE[access]}
      title={ACCESS_TITLE[access]}
    />
  );
}

/** `base…compare` in the app's own blue/green, so a row reads like the top bar it will open. */
export function Pair({ repo, className = "m" }: { repo: StoredRepo; className?: string }) {
  if (!repo.lastSource && !repo.lastTarget) {
    return <span className={`${className} none`}>never compared</span>;
  }
  return (
    <span className={className}>
      {/* base is the target ref, compare the source ref (Plan §4 DiffSource) */}
      <span className="b">{shortRef(repo.lastTarget)}</span>
      <span className="arr">…</span>
      <span className="c">{shortRef(repo.lastSource)}</span>
    </span>
  );
}

/** `refs/heads/main` → `main`; anything else (a sha, `HEAD`) is shown as stored. */
export function shortRef(ref: string | undefined): string {
  if (!ref) return "HEAD";
  return ref.replace(/^refs\/(heads|remotes|tags)\//, "");
}

/** The filter's matched substring, marked (H3). */
function Highlight({ text, match }: { text: string; match: string }) {
  const at = match ? text.toLowerCase().indexOf(match.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + match.length)}</mark>
      {text.slice(at + match.length)}
    </>
  );
}

export interface RecentRowProps {
  repo: StoredRepo;
  access: PermissionAnswer;
  state: RowState;
  now: number;
  /** Shortened relative time in the nav popover ("3 h", not "3 h ago"). */
  compact?: boolean;
  filter?: string;
  onOpen(repo: StoredRepo): void;
  onForget(repo: StoredRepo): void;
  onUndo(repo: StoredRepo): void;
  onKeyDown?(e: KeyboardEvent<HTMLButtonElement>, repo: StoredRepo): void;
}

export function RecentRow({
  repo,
  access,
  state,
  now,
  compact = false,
  filter = "",
  onOpen,
  onForget,
  onUndo,
  onKeyDown,
}: RecentRowProps) {
  const when = timeAgo(repo.lastOpenedAt, now);
  const busy = state === "opening";
  const forgotten = state === "forgotten";
  const rowClass = `rrow${busy ? " dis" : ""}${forgotten ? " gone" : ""}`;

  return (
    <div className={rowClass}>
      {busy ? (
        <LoaderCircle className="ic load spin" aria-hidden="true" />
      ) : (
        <FolderGit2 className="ic" aria-hidden="true" />
      )}
      <button
        type="button"
        className="nm"
        aria-label={`Open ${repo.name}`}
        disabled={busy || forgotten}
        onClick={() => onOpen(repo)}
        onKeyDown={(e) => onKeyDown?.(e, repo)}
      >
        <b>
          <Highlight text={repo.name} match={filter} />
        </b>
        {busy ? (
          <span className="m">Asking the browser for read access…</span>
        ) : forgotten ? (
          <span className="m">Forgotten</span>
        ) : (
          <Pair repo={repo} />
        )}
      </button>
      <span className="rt">
        {forgotten ? (
          <button type="button" className="btn btn-xs" onClick={() => onUndo(repo)}>
            Undo
          </button>
        ) : (
          <>
            {!busy && <AccessDot access={access} />}
            {compact ? when.replace(/ ago$/, "") : when}
            {!busy && !compact && (
              <button
                type="button"
                className="x"
                aria-label={`Forget ${repo.name}`}
                title="Forget"
                onClick={() => onForget(repo)}
              >
                <X className="ic" aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

export interface RowMessageProps {
  repo: StoredRepo;
  state: RowState;
  onRetry(repo: StoredRepo): void;
  onChoose(): void;
  onForget(repo: StoredRepo): void;
}

/** H4: the inline result of a click — never a toast, never the error screen. */
export function RowMessage({ repo, state, onRetry, onChoose, onForget }: RowMessageProps) {
  if (state === "denied") {
    return (
      <div className="rmsg bad" role="alert">
        <Lock className="ic" aria-hidden="true" />
        <span className="tx">Read access was denied.</span>
        <button type="button" className="btn btn-xs" onClick={() => onRetry(repo)}>
          Try again
        </button>
        <button type="button" className="btn btn-xs btn-ghost" onClick={() => onForget(repo)}>
          Forget
        </button>
      </div>
    );
  }
  if (state === "gone") {
    return (
      <div className="rmsg bad" role="alert">
        <TriangleAlert className="ic" aria-hidden="true" />
        <span className="tx">Folder not found — moved, renamed or deleted.</span>
        <button type="button" className="btn btn-xs" onClick={onChoose}>
          Choose it again
        </button>
        <button type="button" className="btn btn-xs btn-ghost" onClick={() => onForget(repo)}>
          Forget
        </button>
      </div>
    );
  }
  if (state === "notrepo") {
    return (
      <div className="rmsg bad" role="alert">
        <CircleX className="ic" aria-hidden="true" />
        <span className="tx">
          Not a git repository any more (<span className="mono">.git</span> is gone).
        </span>
        <button type="button" className="btn btn-xs" onClick={onChoose}>
          Choose another
        </button>
        <button type="button" className="btn btn-xs btn-ghost" onClick={() => onForget(repo)}>
          Forget
        </button>
      </div>
    );
  }
  return null;
}
