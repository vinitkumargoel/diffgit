import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeData, HunkData, HunkTokens, TokenNode } from "react-diff-view";
import type { BlamePayload, FileDiff, Oid } from "../../engine/types";
import {
  BLAME_REVISION_STEP,
  type BlameRow,
  blameCacheKey,
  blameRows,
  CONTINUE_LABEL,
  cappedLine,
  heatClass,
  IGNORE_WS_LABEL,
  revisionsLabel,
  shortOid,
  splitLines,
  UNCOMMITTED_SHA,
} from "../blame";
import { describeError } from "../errors";
import { tokenizeHunks } from "../highlight/highlightClient";
import { blameTarget, useStore } from "../store";
import { timeAgo } from "../timeAgo";
import { filePathOf } from "../treeModel";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { Notice } from "./Notice";

/** Shiki tokens carry both theme colours; CSS picks `--shl` or `--shd` (Design §11). */
function renderToken(token: TokenNode, key: number): ReactNode {
  if (token.type === "text") return (token as { value?: string }).value ?? "";
  const children = token.children?.map((c, i) => renderToken(c, i));
  if (token.type !== "sh") return <span key={key}>{children}</span>;
  const style = { "--shl": token.l, "--shd": token.d } as CSSProperties;
  return (
    <span key={key} data-sh="" style={style}>
      {children}
    </span>
  );
}

/**
 * One synthetic hunk covering the whole file as context lines, so the existing highlight worker —
 * which only knows how to tokenise `HunkData` — can colour a plain file too. `tokens.new[i]` is
 * then the i-th line, because every change is `normal` and appears on both sides.
 */
function wholeFileHunk(lines: readonly string[]): HunkData[] {
  const changes: ChangeData[] = lines.map((content, i) => ({
    type: "normal",
    isNormal: true,
    oldLineNumber: i + 1,
    newLineNumber: i + 1,
    content,
  }));
  return [
    {
      content: `@@ -1,${lines.length} +1,${lines.length} @@`,
      oldStart: 1,
      oldLines: lines.length,
      newStart: 1,
      newLines: lines.length,
      changes,
    },
  ];
}

/**
 * Design §14.1 / atlas tab 02: the commit behind one line — SHA, author, age, subject — with
 * `Show commit diff` (→ the commit in History mode) and `Blame at parent ↶`, the "blame digging"
 * step. Opened by hovering or clicking the SHA; Escape and an outside click close it.
 */
function LinePopover({
  oid,
  payload,
  onShowCommit,
  onBlameParent,
  onClose,
}: {
  oid: Oid;
  payload: BlamePayload;
  onShowCommit: () => void;
  onBlameParent: () => void;
  onClose: () => void;
}) {
  const commit = payload.commits[oid];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  if (!commit) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Commit ${shortOid(oid)}`}
      className="absolute top-full left-0 z-20 mt-1 w-[320px] rounded-[6px] border border-line bg-surface p-3 text-left shadow-popover"
    >
      <div className="font-mono text-[11px] leading-4 text-muted">
        <span className="text-accent">{shortOid(oid)}</span> · {commit.author.name} ·{" "}
        {timeAgo(commit.author.timestamp)}
      </div>
      <p className="mt-1 text-[12.5px] leading-5 text-ink">{commit.subject}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className="btn btn-sm" onClick={onShowCommit}>
          Show commit diff
        </button>
        <button type="button" className="btn btn-sm" onClick={onBlameParent}>
          Blame at parent ↶
        </button>
      </div>
    </div>
  );
}

/** One `<tr>` of the blame table; the age strip, author and SHA print once per run of a commit. */
function BlameTableRow({
  row,
  tokens,
  text,
  payload,
  open,
  onOpen,
  onShowCommit,
  onBlameParent,
}: {
  row: BlameRow;
  tokens: TokenNode[] | undefined;
  text: string;
  payload: BlamePayload;
  open: boolean;
  onOpen: (line: number | null) => void;
  onShowCommit: (oid: Oid) => void;
  onBlameParent: (oid: Oid) => void;
}) {
  const uncommitted = row.oid === null;
  return (
    <tr
      data-line={row.line.line}
      data-oid={row.oid ?? "working"}
      data-heat={row.heat}
      className={uncommitted ? "bg-accent-subtle" : undefined}
    >
      <td className={`w-[6px] p-0 ${heatClass(row.heat)}`} aria-hidden />
      <td className="w-24 truncate px-2 text-[11px] leading-[21px] text-muted">
        {row.first ? (
          <span className={uncommitted ? "text-attention" : undefined}>{row.author}</span>
        ) : (
          ""
        )}
      </td>
      <td className="relative w-[60px] px-0 font-mono text-[11px] leading-[21px]">
        {row.first &&
          (uncommitted ? (
            <span className="text-attention">{UNCOMMITTED_SHA}</span>
          ) : (
            <>
              <button
                type="button"
                className="text-accent hover:underline"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => onOpen(open ? null : row.line.line)}
                onMouseEnter={() => onOpen(row.line.line)}
              >
                {shortOid(row.oid as Oid)}
              </button>
              {open && (
                <LinePopover
                  oid={row.oid as Oid}
                  payload={payload}
                  onShowCommit={() => onShowCommit(row.oid as Oid)}
                  onBlameParent={() => onBlameParent(row.oid as Oid)}
                  onClose={() => onOpen(null)}
                />
              )}
            </>
          ))}
      </td>
      <td className="w-[34px] pr-2 text-right font-mono text-[10.5px] leading-[21px] text-muted">
        {row.line.line}
      </td>
      <td className="pl-2.5 font-mono text-[11.5px] leading-[21px] whitespace-pre">
        {tokens ? tokens.map((t, i) => renderToken(t, i)) : text}
      </td>
    </tr>
  );
}

export interface BlameBodyProps {
  file: FileDiff;
  /** The newest text of the file — the same one the Diff mode renders (`newText ?? oldText`). */
  text: string | null;
  /** Engine language id for the highlight worker ("typescript", "text", …). */
  language: string;
}

/**
 * Blame mode of the file card (Design §14.1, atlas tab 02). A `table`: a 6 px age strip in the
 * §3.6 heat ramp, the author, the short SHA, the line number and the code. Rows from one commit
 * collapse their author and SHA into the first of the run; working-tree lines read
 * `you, uncommitted` in `--attention`. `BLAME_CAPPED` is one inline line with a `Continue`
 * button, never a banner: the cap belongs to this blame, not to the repository.
 */
export function BlameBody({ file, text, language }: BlameBodyProps) {
  const path = filePathOf(file);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);
  /** `null` = blame at the compare side; an oid = the "Blame at parent" chain (atlas tab 02). */
  const [at, setAt] = useState<Oid | null>(null);
  const [maxRevisions, setMaxRevisions] = useState<number | undefined>(undefined);
  const [openLine, setOpenLine] = useState<number | null>(null);

  const target = useStore((s) => blameTarget(s, at)?.oid ?? null);
  const key = target === null ? null : blameCacheKey(target, path, ignoreWhitespace);
  const entry = useStore((s) => (key === null ? undefined : s.blames[key]));
  const loadBlame = useStore((s) => s.loadBlame);
  const setMode = useStore((s) => s.setMode);
  const showCommit = useStore((s) => s.showCommit);
  const loadCommitDetails = useStore((s) => s.loadCommitDetails);

  useEffect(() => {
    if (key === null) return;
    void loadBlame(path, {
      at,
      ignoreWhitespace,
      ...(maxRevisions === undefined ? {} : { maxRevisions }),
    });
  }, [key, path, at, ignoreWhitespace, maxRevisions, loadBlame]);
  // A different revision or a different `-w` setting is a different answer; the popover of the
  // previous one must not stay open over rows it no longer describes.
  useEffect(() => {
    setOpenLine(null);
  }, []);

  const payload = entry?.status === "ready" ? entry.data : null;
  const lines = useMemo(() => (text === null ? [] : splitLines(text)), [text]);
  const rows = useMemo(() => (payload ? blameRows(payload) : []), [payload]);

  const [tokens, setTokens] = useState<HunkTokens | null>(null);
  useEffect(() => {
    if (lines.length === 0) {
      setTokens(null);
      return;
    }
    let alive = true;
    tokenizeHunks({ language, hunks: wholeFileHunk(lines), oldSource: null })
      .then((r) => {
        if (alive) setTokens(r.tokens);
      })
      .catch(() => {
        if (alive) setTokens(null);
      });
    return () => {
      alive = false;
    };
  }, [lines, language]);

  if (entry === undefined || entry.status === "loading") {
    return <LoadingSkeleton label={`Blaming ${path}`} />;
  }
  if (entry.status === "error") {
    return (
      <Notice
        tone="danger"
        detail={describeError(entry.error.code).message}
        code={`${entry.error.code} · ${entry.error.message}`}
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              void loadBlame(path, {
                at,
                ignoreWhitespace,
                ...(maxRevisions === undefined ? {} : { maxRevisions }),
              })
            }
          >
            Retry
          </button>
        }
      >
        Couldn’t blame this file
      </Notice>
    );
  }
  if (text === null) {
    return (
      <Notice detail="Blame needs the file's text, which this side does not have.">
        Nothing to blame
      </Notice>
    );
  }

  const data = entry.data;
  const blameParent = async (oid: Oid) => {
    setOpenLine(null);
    await loadCommitDetails(oid);
    const details = useStore.getState().commitDetails[oid];
    const parent = details?.status === "ready" ? (details.data.parents[0] ?? null) : null;
    if (parent === null) return;
    setAt(parent);
    setMaxRevisions(undefined);
  };
  const jump = (oid: Oid) => {
    setOpenLine(null);
    setMode("history");
    void showCommit(oid);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle px-3 py-1.5 text-[11.5px] leading-5 text-muted">
        <span data-testid="blame-revisions">{revisionsLabel(data.revisions)}</span>
        {at !== null && (
          <span className="flex items-center gap-1.5">
            <span>
              at <span className="font-mono text-accent">{shortOid(at)}</span>
            </span>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => {
                setAt(null);
                setMaxRevisions(undefined);
              }}
            >
              Back to the compare side
            </button>
          </span>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            className="size-3.5 accent-success"
            checked={ignoreWhitespace}
            onChange={(e) => {
              setIgnoreWhitespace(e.target.checked);
              setOpenLine(null);
            }}
          />
          {IGNORE_WS_LABEL}
        </label>
      </div>
      {data.capped && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-[11.5px] leading-5 text-attention"
        >
          {cappedLine(data.revisions)}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMaxRevisions(entry.maxRevisions + BLAME_REVISION_STEP)}
          >
            {CONTINUE_LABEL}
          </button>
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left" aria-label={`Blame of ${path}`}>
          <thead className="sr-only">
            <tr>
              <th scope="col">Age</th>
              <th scope="col">Author</th>
              <th scope="col">Commit</th>
              <th scope="col">Line</th>
              <th scope="col">Code</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <BlameTableRow
                key={row.line.line}
                row={row}
                tokens={tokens?.new[row.line.line - 1]}
                text={lines[row.line.line - 1] ?? ""}
                payload={data}
                open={openLine === row.line.line}
                onOpen={setOpenLine}
                onShowCommit={jump}
                onBlameParent={(oid) => void blameParent(oid)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
