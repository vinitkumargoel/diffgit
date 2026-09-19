import { ChevronDown, ChevronUp, UnfoldVertical } from "lucide-react";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Decoration,
  Diff,
  expandFromRawCode,
  Hunk,
  type HunkData,
  type HunkTokens,
  type RenderGutter,
  type RenderToken,
  type TokenNode,
  type ViewType,
} from "react-diff-view";
import type { FileDiffPayload, HunkModel } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { diffTypeFor, lineCount, toHunkData } from "../diff/toHunkData";
import { tokenizeHunks } from "../highlight/highlightClient";
import { filePathOf } from "../treeModel";

/** Lines revealed by one `↑` / `↓` click (GitHub uses 20). */
const EXPAND_STEP = 20;
/** Whole-file tokenisation (grammar context, no re-tokenising on expand) below this old-text size. */
const FULL_SOURCE_LIMIT = 200_000;

/**
 * Design §9: the change type is only a colour + a CSS `::before` sign, so the gutter that carries
 * the line number also gets visually-hidden "added line" / "deleted line" text for screen readers.
 */
const renderGutter: RenderGutter = ({ change, side, renderDefault }) => {
  const label =
    change.type === "insert" && side === "new"
      ? "added line"
      : change.type === "delete" && side === "old"
        ? "deleted line"
        : null;
  return (
    <>
      {renderDefault()}
      {label && <span className="sr-only"> {label}</span>}
    </>
  );
};

/** Shiki tokens carry both theme colours; CSS picks `--shl` or `--shd` (Design §11). */
const renderToken: RenderToken = (token, renderDefault, i) => {
  if (token.type !== "sh") return renderDefault(token, i);
  const style = { "--shl": token.l, "--shd": token.d } as CSSProperties;
  return (
    <span key={i} data-sh="" style={style}>
      {token.children?.map((c: TokenNode, j: number) => renderToken(c, renderDefault, j))}
    </span>
  );
};

function MiniButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="btn-mini"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Hunk header row (Design §7.6): `↑ ↓ all` mini-buttons then `@@ -a,b +c,d @@`. */
function HunkHeader({
  text,
  up,
  down,
  all,
}: {
  text: string;
  up?: () => void;
  down?: () => void;
  all?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] leading-4">
      <span className="flex gap-1">
        <MiniButton label="Expand up" onClick={up}>
          <ChevronUp size={12} aria-hidden />
        </MiniButton>
        <MiniButton label="Expand down" onClick={down}>
          <ChevronDown size={12} aria-hidden />
        </MiniButton>
        <MiniButton label="Expand all" onClick={all}>
          <UnfoldVertical size={12} aria-hidden />
        </MiniButton>
      </span>
      <span className="font-mono">{text}</span>
    </div>
  );
}

export interface DiffBodyProps {
  file: FileDiff;
  payload: FileDiffPayload & { hunks: HunkModel };
  viewType: ViewType;
  /** Increment to expand every collapsed gap (FileHeader "⇕ Expand all"). */
  expandAllToken: number;
  /** Overrides the region's accessible name (T11.3: one card holds three of these). */
  label?: string;
}

/**
 * The diff table (ADR-001): react-diff-view over our `HunkModel`, expand context from the full
 * old text, tokens (syntax + word-level marks) from the highlight worker.
 */
export function DiffBody({ file, payload, viewType, expandAllToken, label }: DiffBodyProps) {
  const initial = useMemo(() => toHunkData(payload.hunks), [payload.hunks]);
  // Expanded hunks are keyed to the payload they came from: a new payload (e.g. whitespace toggle)
  // renders its own hunks in the same frame, with no effect-driven re-sync (T7.5 review).
  const [expanded, setExpanded] = useState<{ base: HunkData[]; hunks: HunkData[] } | null>(null);
  const hunks = expanded && expanded.base === initial ? expanded.hunks : initial;
  const setHunks = useCallback(
    (update: (hs: HunkData[]) => HunkData[]) =>
      setExpanded((prev) => {
        const current = prev && prev.base === initial ? prev.hunks : initial;
        return { base: initial, hunks: update(current) };
      }),
    [initial],
  );

  const oldSource = payload.oldText;
  const totalOld = oldSource === null ? 0 : lineCount(oldSource);
  const canExpand = oldSource !== null && totalOld > 0;

  const expand = useCallback(
    (start: number, end: number) => {
      if (oldSource === null || end <= start) return;
      setHunks((hs) => expandFromRawCode(hs, oldSource, start, end));
    },
    [oldSource, setHunks],
  );
  const expandAll = useCallback(() => {
    if (oldSource === null) return;
    setHunks((hs) => {
      let next = hs;
      let cursor = 1;
      for (const h of hs) {
        if (h.oldStart > cursor) next = expandFromRawCode(next, oldSource, cursor, h.oldStart);
        cursor = Math.max(cursor, h.oldStart + h.oldLines);
      }
      if (cursor <= totalOld) next = expandFromRawCode(next, oldSource, cursor, totalOld + 1);
      return next;
    });
  }, [oldSource, totalOld, setHunks]);
  const seenToken = useRef(expandAllToken);
  useEffect(() => {
    if (expandAllToken !== seenToken.current) {
      seenToken.current = expandAllToken;
      expandAll();
    }
  }, [expandAllToken, expandAll]);

  // tokens: whole files when both sides are known and small, otherwise the current hunks
  const useFull =
    oldSource !== null && payload.newText !== null && oldSource.length <= FULL_SOURCE_LIMIT;
  const tokenHunks = useFull ? initial : hunks;
  const [tokens, setTokens] = useState<HunkTokens | null>(null);
  useEffect(() => {
    let alive = true;
    tokenizeHunks({
      language: payload.language,
      hunks: tokenHunks,
      oldSource: useFull ? oldSource : null,
    })
      .then((r) => {
        if (alive) setTokens(r.tokens);
      })
      .catch(() => {
        if (alive) setTokens(null);
      });
    return () => {
      alive = false;
    };
  }, [tokenHunks, useFull, oldSource, payload.language]);

  // first paint mark for the T5.3 render-time check (`dg:ready:<id>` is set by FileCard)
  const painted = useRef(false);
  useEffect(() => {
    if (painted.current) return;
    painted.current = true;
    requestAnimationFrame(() => performance.mark(`dg:painted:${file.id}`));
  }, [file.id]);

  const path = filePathOf(file);
  return (
    <section className="dg-diff overflow-x-auto" aria-label={label ?? `Diff of ${path}`}>
      <Diff
        viewType={viewType}
        diffType={diffTypeFor(file.status)}
        hunks={hunks}
        tokens={tokens}
        renderToken={renderToken}
        renderGutter={renderGutter}
        optimizeSelection
      >
        {(hs) =>
          hs.flatMap((h, i) => {
            const prev = hs[i - 1];
            const prevEnd = prev ? prev.oldStart + prev.oldLines : 1;
            const gap = h.oldStart - prevEnd;
            const out: ReactElement[] = [];
            if (gap > 0) {
              out.push(
                <Decoration key={`gap-${h.oldStart}`}>
                  <HunkHeader
                    text={h.content}
                    up={
                      canExpand
                        ? () => expand(Math.max(prevEnd, h.oldStart - EXPAND_STEP), h.oldStart)
                        : undefined
                    }
                    down={
                      canExpand && prev
                        ? () => expand(prevEnd, Math.min(prevEnd + EXPAND_STEP, h.oldStart))
                        : undefined
                    }
                    all={canExpand ? () => expand(prevEnd, h.oldStart) : undefined}
                  />
                </Decoration>,
              );
            }
            out.push(<Hunk key={`hunk-${h.oldStart}-${h.newStart}`} hunk={h} />);
            if (i === hs.length - 1) {
              const end = h.oldStart + h.oldLines;
              if (canExpand && end <= totalOld) {
                out.push(
                  <Decoration key="tail">
                    <HunkHeader
                      text=""
                      down={() => expand(end, Math.min(end + EXPAND_STEP, totalOld + 1))}
                      all={() => expand(end, totalOld + 1)}
                    />
                  </Decoration>,
                );
              }
            }
            return out;
          })
        }
      </Diff>
    </section>
  );
}
