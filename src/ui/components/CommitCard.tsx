import { Copy, MoreHorizontal, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CommitDetails } from "../../engine/types";
import { describeError } from "../errors";
import { cherryPickCommand, formatCommitDate, formatSignature, shortOid } from "../history";
import { useStore } from "../store";
import { RefChip } from "./CommitRow";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { Notice } from "./Notice";

/** Lines of the commit message body shown before "Show more" (Design §14.5). */
const BODY_LINES = 6;
const COPIED_MS = 1500;

/** One `term / detail` pair of the card's fact grid. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11px] leading-5 text-muted">{term}</dt>
      <dd className="min-w-0 text-[12px] leading-5 text-ink">{children}</dd>
    </>
  );
}

/** A `…` menu row; an action whose task has not shipped is disabled, never hidden. */
function MenuItem({
  label,
  onClick,
  pending,
}: {
  label: string;
  onClick?: () => void;
  pending?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={pending !== undefined}
      title={pending === undefined ? undefined : `coming soon (${pending})`}
      className="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] leading-5 text-ink not-disabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * Design §14.5: the card above the FileCards in History mode — subject, body, author, committer,
 * date, parents, tree, signature, note and refs, with `Show diff`, `Compare with base…`,
 * `Copy SHA` and a `…` menu. Menu entries owned by a later task are disabled and say so.
 */
export function CommitCard({ oid }: { oid: string }) {
  const entry = useStore((s) => s.commitDetails[oid]);
  const refs = useStore((s) => s.repo);
  const loadCommitDetails = useStore((s) => s.loadCommitDetails);
  const showCommit = useStore((s) => s.showCommit);
  const compareCommitWithBase = useStore((s) => s.compareCommitWithBase);
  const baseName = useStore((s) => s.compareBase?.display ?? "base");
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState<"idle" | "sha" | "cherry" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (entry === undefined) void loadCommitDetails(oid);
  }, [entry, oid, loadCommitDetails]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /**
   * T11.6 / Design §14.5: show this commit and put every one of its file cards into Blame mode.
   * Selecting the commit makes the source `parent…commit`, so the blame each card then asks for is
   * a blame *at this commit* — which is what "Blame here" means.
   */
  const blameHere = async () => {
    setMenu(false);
    await showCommit(oid);
    const { diff, setCardMode } = useStore.getState();
    for (const f of diff?.files ?? []) setCardMode(f.id, "blame");
  };

  const copy = async (text: string, what: "sha" | "cherry") => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // Blocked clipboard (insecure context / permissions): the label says so, nothing is lost.
      setCopied("failed");
    }
    timer.current = setTimeout(() => setCopied("idle"), COPIED_MS);
  };

  const shell = (children: ReactNode) => (
    <section
      aria-label={`Commit ${shortOid(oid)}`}
      data-oid={oid}
      className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-line bg-surface px-4 py-3"
    >
      {children}
    </section>
  );

  if (entry === undefined || entry.status === "loading") return shell(<LoadingSkeleton />);
  if (entry.status === "error") {
    return shell(
      <Notice detail={describeError(entry.error.code).message} code={entry.error.code}>
        Couldn’t read commit {shortOid(oid)}
      </Notice>,
    );
  }

  const c: CommitDetails = entry.data;
  const bodyLines = c.body.split("\n");
  const longBody = bodyLines.length > BODY_LINES;
  const body = expanded ? c.body : bodyLines.slice(0, BODY_LINES).join("\n");
  const sameAuthor =
    c.committer.name === c.author.name &&
    c.committer.email === c.author.email &&
    c.committer.timestamp === c.author.timestamp;

  return shell(
    <>
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-[14px] leading-5 font-semibold text-ink">{c.subject}</h2>
        <span className="shrink-0 font-mono text-[12px] leading-5 text-accent">
          {shortOid(oid)}
        </span>
        {c.signed && (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[11px] leading-5 text-success"
            title="This commit carries a signature; diffgit does not verify it"
          >
            <ShieldCheck size={13} aria-hidden />
            signed
          </span>
        )}
      </div>
      {c.refs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {c.refs.map((r) => (
            <RefChip key={r} name={r} refs={refs} />
          ))}
        </div>
      )}
      {c.body.trim() !== "" && (
        <>
          <p className="mt-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-ink">
            {body}
          </p>
          {longBody && (
            <button
              type="button"
              className="mt-1 text-[11.5px] leading-4 text-accent"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : `Show all ${bodyLines.length} lines`}
            </button>
          )}
        </>
      )}
      <dl className="mt-2.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3">
        <Fact term="Author">
          {formatSignature(c.author)} · {formatCommitDate(c.author)}
        </Fact>
        {!sameAuthor && (
          <Fact term="Committer">
            {formatSignature(c.committer)} · {formatCommitDate(c.committer)}
          </Fact>
        )}
        <Fact term={c.parents.length === 1 ? "Parent" : "Parents"}>
          {c.parents.length === 0 ? (
            <span className="text-muted">none — this is a root commit</span>
          ) : (
            c.parents.map((p) => (
              <button
                key={p}
                type="button"
                className="mr-2 font-mono text-[12px] text-accent hover:underline"
                onClick={() => void showCommit(p)}
              >
                {shortOid(p)}
              </button>
            ))
          )}
        </Fact>
        <Fact term="Tree">
          <span className="font-mono text-[12px]">{shortOid(c.tree)}</span>
        </Fact>
        {c.stats && (
          <Fact term="Files">
            {c.stats.files} · <span className="text-success">+{c.stats.additions}</span>{" "}
            <span className="text-danger">−{c.stats.deletions}</span>
          </Fact>
        )}
        {c.note !== null && (
          <Fact term="Note">
            <span className="whitespace-pre-wrap">{c.note}</span>
          </Fact>
        )}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => void showCommit(oid)}>
          Show diff
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => compareCommitWithBase(oid)}
          title={`Compare ${baseName} with this commit`}
        >
          Compare with {baseName}…
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void copy(oid, "sha")}>
          <Copy size={12} aria-hidden />
          {copied === "sha" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy SHA"}
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            className="btn btn-sm"
            aria-label="More commit actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={14} aria-hidden />
          </button>
          {menu && (
            <div
              role="menu"
              aria-label="More commit actions"
              className="absolute top-full right-0 z-10 mt-1 w-60 rounded-[6px] border border-line bg-surface py-1 shadow-popover"
            >
              <MenuItem label="Export as .patch" pending="T11.10" />
              <MenuItem
                label={copied === "cherry" ? "Copied" : "Copy cherry-pick command"}
                onClick={() => void copy(cherryPickCommand(oid), "cherry")}
              />
              <MenuItem label="Bisect: mark good" pending="T11.13" />
              <MenuItem label="Bisect: mark bad" pending="T11.13" />
              <MenuItem label="Blame here" onClick={() => void blameHere()} />
            </div>
          )}
        </div>
      </div>
    </>,
  );
}
