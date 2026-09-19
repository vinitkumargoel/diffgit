/**
 * H1 — exactly one stored repository: the hero's right column becomes a Continue card instead of a
 * one-row list, because "the same one again" is nearly always the intent and the card has room for
 * the last pair and the access state.
 */
import { Clock, LoaderCircle, X } from "lucide-react";
import { GRANT_LABEL, lastSeenLine, NEEDS_PERMISSION_TITLE } from "../../dashboard";
import type { PermissionAnswer, StoredRepo } from "../../persistence";
import type { DashboardEntry } from "../../store";
import { timeAgo } from "../../timeAgo";
import { Logo } from "../Logo";
import { AccessDot, Pair, RecentRow, RowMessage, shortRef } from "./RecentRow";
import { RepoSummaryStrip } from "./RepoCard";
import type { RowState } from "./useRecents";

const ACCESS_TEXT: Record<PermissionAnswer, string> = {
  granted: "granted for this session",
  prompt: "will ask once",
  denied: "denied",
};

export interface ContinueCardProps {
  repo: StoredRepo;
  access: PermissionAnswer;
  state: RowState;
  /** T11.11: the same summary a RepoCard shows, so one stored repository is not a poorer card. */
  entry: DashboardEntry;
  now: number;
  onOpen(repo: StoredRepo): void;
  onForget(repo: StoredRepo): void;
  onUndo(repo: StoredRepo): void;
  /** Grants read access without opening, so the card's summary can be read (T11.11). */
  onGrant(repo: StoredRepo): void;
  /** "Different folder" / "Choose it again" / "Choose another" — the read-only picker. */
  onChoose(): void;
}

export function ContinueCard({
  repo,
  access,
  state,
  entry,
  now,
  onOpen,
  onForget,
  onUndo,
  onGrant,
  onChoose,
}: ContinueCardProps) {
  // Forgetting the only repository leaves the row itself behind, so the 5 s Undo still has a home.
  if (state === "forgotten") {
    return (
      <section className="recent" aria-label="Recent repositories">
        <div className="hd">
          Recent <span className="n">· 1</span>
        </div>
        <RecentRow
          repo={repo}
          access={access}
          state={state}
          now={now}
          onOpen={onOpen}
          onForget={onForget}
          onUndo={onUndo}
        />
        <div className="rsep" />
      </section>
    );
  }

  return (
    <section className="contin" aria-label="Recent repositories">
      <div className="t">
        <Clock className="ic" aria-hidden="true" />
        Continue
        <span className="rt">opened {timeAgo(repo.lastOpenedAt, now)}</span>
      </div>
      <div className="nmrow">
        <Logo size={22} />
        <b>{repo.name}</b>
        <AccessDot access={access} />
      </div>
      <div className="meta">
        <span>Last compared</span>
        <Pair repo={repo} className="v pair" />
        <span>Access</span>
        <span className="v">
          <AccessDot access={access} />
          {ACCESS_TEXT[access]}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <RepoSummaryStrip
          entry={entry}
          fallback={lastSeenLine(shortRef(repo.lastSource))}
          now={now}
        />
      </div>
      <div className="acts">
        <button
          type="button"
          className="btn btn-ink btn-sm"
          disabled={state === "opening"}
          onClick={() => onOpen(repo)}
        >
          Open {repo.name}
        </button>
        {access !== "granted" && (
          <button
            type="button"
            className="btn btn-sm"
            title={NEEDS_PERMISSION_TITLE}
            onClick={() => onGrant(repo)}
          >
            {GRANT_LABEL}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onChoose}>
          Different folder
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="Forget"
          aria-label={`Forget ${repo.name}`}
          onClick={() => onForget(repo)}
        >
          <X className="ic" aria-hidden="true" />
        </button>
      </div>
      {state === "opening" && (
        <div className="rmsg">
          <LoaderCircle className="ic load spin" aria-hidden="true" />
          <span className="tx">Asking the browser for read access…</span>
        </div>
      )}
      <RowMessage
        repo={repo}
        state={state}
        onRetry={onOpen}
        onChoose={onChoose}
        onForget={onForget}
      />
    </section>
  );
}
