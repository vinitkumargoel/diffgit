import { CircleX, Zap } from "lucide-react";
import { Component, type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { FileDiffPayload } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { hasCollapsedContext } from "../diff/toHunkData";
import { describeError, errorReport, type UiError } from "../errors";
import { redactFindings } from "../secrets";
import {
  type CardMode,
  isViewed,
  selectConflictKind,
  selectFileDiff,
  selectFileSecrets,
  useStore,
} from "../store";
import { filePathOf } from "../treeModel";
import { BinaryNotice, RawTextView, rawSideFor, useRawText } from "./BinaryNotice";
import { BlameBody } from "./BlameBody";
import { ConflictBody } from "./ConflictBody";
import { ConflictTag } from "./ConflictTag";
import { DiffBody } from "./DiffBody";
import { FileHeader } from "./FileHeader";
import { FileHistoryBody } from "./FileHistoryBody";
import { ImageDiff } from "./ImageDiff";
import { renderInline } from "./InlineText";
import { LargeFileGate } from "./LargeFileGate";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { Notice } from "./Notice";
import { SubmoduleNotice } from "./SubmoduleNotice";
import { TypechangeNotice } from "./TypechangeNotice";

export interface FileCardProps {
  file: FileDiff;
  index: number;
  /** Virtualiser measurement ref (DiffPane). */
  measureRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
}

interface BoundaryProps {
  children: ReactNode;
  raw: string | null;
  resetKey: unknown;
  /**
   * T11.9: masks any secret value this card knows about before the report reaches the clipboard.
   * A crash report is text diffgit writes *about* the file, so Design §14.3's "masked everywhere
   * including copy" applies to it; the raw view below is the file itself, shown as it is on disk.
   */
  redact?: (text: string) => string;
}
interface BoundaryState {
  error: Error | null;
  showRaw: boolean;
  copied: "idle" | "done" | "failed";
}

/** How long the "Copy report" button keeps its Copied / Copy failed label. */
const COPIED_MS = 1500;

/**
 * Per-card error boundary (T5.3 amendment): a renderer crash never unmounts the pane. Exported
 * so `notices.test.tsx` can drive the E6 "Couldn't render this diff" notice directly.
 */
export class CardErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, showRaw: false, copied: "idle" };
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, showRaw: false, copied: "idle" });
    }
  }

  componentWillUnmount(): void {
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
  }

  private copyReport = async (): Promise<void> => {
    const raw = errorReport({ code: "INTERNAL", message: String(this.state.error) });
    const text = this.props.redact ? this.props.redact(raw) : raw;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      this.setState({ copied: "done" });
    } catch {
      // The report is still readable in the code line below; only the label reports the failure.
      this.setState({ copied: "failed" });
    }
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.setState({ copied: "idle" }), COPIED_MS);
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const copyLabel =
      this.state.copied === "done"
        ? "Copied"
        : this.state.copied === "failed"
          ? "Copy failed"
          : "Copy report";
    return (
      <>
        <Notice
          tone="danger"
          icon={<Zap size={22} aria-hidden />}
          detail="The renderer threw. This is a diffgit bug; the raw diff is intact."
          action={
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => this.setState({ error: null, showRaw: false, copied: "idle" })}
              >
                Retry
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={this.state.showRaw}
                onClick={() => this.setState((s) => ({ showRaw: !s.showRaw }))}
              >
                View raw
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void this.copyReport()}
              >
                {copyLabel}
              </button>
            </>
          }
        >
          Couldn't render this diff
        </Notice>
        {this.state.showRaw && this.props.raw !== null && (
          <pre className="max-h-96 overflow-auto px-3 pb-3 text-left font-mono text-xs text-ink">
            {this.props.raw}
          </pre>
        )}
      </>
    );
  }
}

/**
 * E6 (1): the per-file load failure. The sentence is `describeError`'s, the code line carries the
 * public code and the engine message, and "View raw" decodes the bytes the diff could not.
 */
function LoadErrorNotice({ file, error }: { file: FileDiff; error: UiError }) {
  const loadFileDiff = useStore((s) => s.loadFileDiff);
  const side = rawSideFor(file.status);
  const raw = useRawText(file.id, side);
  if (raw.text !== null) {
    return <RawTextView side={side} text={raw.text} onHide={raw.hide} />;
  }
  return (
    <Notice
      tone="danger"
      icon={<CircleX size={22} aria-hidden />}
      detail={
        raw.error ?? (
          <>{renderInline(describeError(error.code).message, "mono")} Other files are unaffected.</>
        )
      }
      code={`${error.code} · ${error.message}`}
      action={
        <>
          <button type="button" className="btn btn-sm" onClick={() => void loadFileDiff(file.id)}>
            Retry
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={raw.busy}
            onClick={() => void raw.load()}
          >
            View raw
          </button>
        </>
      }
    >
      Couldn't load this diff
    </Notice>
  );
}

function changedLines(stats: FileDiff["stats"]): string {
  if (!stats) return "";
  const n = stats.additions + stats.deletions;
  return ` · ${n.toLocaleString("en-US")} ${n === 1 ? "line" : "lines"} changed`;
}

/**
 * Design §14.1: `Diff | Blame | History` is rendered "only when the file has a committed side
 * (`oldOid` or `newOid` reachable from a commit; untracked-only files do not get it)". An
 * untracked file has no `oldOid` and is in no committed layer, so there is nothing to walk back
 * through — and a conflicted file's card is the three-way view, which has no third mode.
 */
export function hasCommittedSide(file: FileDiff): boolean {
  if (file.layers.includes("conflict")) return false;
  return file.oldOid !== null || file.layers.includes("committed");
}

/**
 * One file (Design §7.5): sticky header + lazily loaded body. Loads its diff when mounted by
 * the virtualiser (DiffPane keeps ±1 viewport of cards mounted) and cancels on unmount.
 */
export function FileCard({ file, index, measureRef, style }: FileCardProps) {
  const id = file.id;
  const entry = useStore((s) => selectFileDiff(s, id));
  const ignoreWhitespace = useStore((s) => s.prefs.ignoreWhitespace);
  const viewMode = useStore((s) => s.prefs.viewMode);
  const collapsed = useStore((s) => s.collapsed.has(id));
  const viewed = useStore((s) => (s.diff ? isViewed(s, file) : false));
  const stats = useStore((s) => s.stats[id] ?? file.stats);
  const loadFileDiff = useStore((s) => s.loadFileDiff);
  const cancelFileDiff = useStore((s) => s.cancelFileDiff);
  const setCollapsed = useStore((s) => s.setCollapsed);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const setPref = useStore((s) => s.setPref);
  /** T11.9: findings of this file (Design §14.3); empty until the scan answers. */
  const secrets = useStore((s) => selectFileSecrets(s, id));
  // T11.14: blame and file history walk commits, and a patch file has none — so its cards are
  // Diff-only and the mini `Diff | Blame | History` control is not rendered at all (Design §14.1
  // already renders it only for a file with a committed side).
  const patchOnly = useStore((s) => s.patchOnly);
  const committed = hasCommittedSide(file) && !patchOnly;
  const cardMode: CardMode = useStore((s) => (committed ? (s.cardModes[id] ?? "diff") : "diff"));
  const setCardMode = useStore((s) => s.setCardMode);

  const [genOpen, setGenOpen] = useState(false);
  const gated = !!file.generated && !genOpen;
  // Design §14.3: a conflicted file is a three-way view of the index stages, not a two-way diff,
  // so the card loads `conflict()` (inside ConflictBody) instead of `fileDiff()`.
  const conflict = file.layers.includes("conflict");
  const conflictKind = useStore((s) => selectConflictKind(s, id));
  // Blame needs the card's text, which is the diff payload's; the file-history list does not.
  const wantsBody = !collapsed && !gated && !conflict && cardMode !== "history";
  useEffect(() => {
    if (wantsBody && !entry) void loadFileDiff(id);
  }, [wantsBody, entry, id, loadFileDiff]);
  useEffect(() => () => cancelFileDiff(id), [id, cancelFileDiff]);

  const ready = entry?.status === "ready" ? entry.data : null;
  useEffect(() => {
    if (ready) performance.mark(`dg:ready:${id}`);
  }, [ready, id]);

  const [expandAllToken, setExpandAllToken] = useState(0);
  const canExpandAll =
    !!ready &&
    ready.hunks !== null &&
    ready.hunks.hunks.length > 0 &&
    hasCollapsedContext(ready.hunks, ready.oldText);

  const renderReady = (p: FileDiffPayload): ReactNode => {
    const c = p.classification;
    // §7.7: the typechange row sits above whatever body the file otherwise gets.
    const typechange = c.typechange ? (
      <TypechangeNotice oldMode={p.oldMode} newMode={p.newMode} />
    ) : null;
    const wrap = (node: ReactNode) => (
      <>
        {typechange}
        {node}
      </>
    );
    if (c.huge || (c.tooLarge && p.hunks === null)) {
      return wrap(
        <LargeFileGate
          file={file}
          stats={stats}
          oldSize={c.oldSize}
          newSize={c.newSize}
          huge={c.huge}
          onLoad={() => void loadFileDiff(id, { loadLarge: true })}
        />,
      );
    }
    if (c.submodule) {
      return wrap(<SubmoduleNotice oldOid={p.submodule?.oldOid} newOid={p.submodule?.newOid} />);
    }
    if (c.image) return wrap(<ImageDiff key={p.generation} file={file} payload={p} />);
    if (c.binary) return wrap(<BinaryNotice file={file} payload={p} />);
    if (ignoreWhitespace && c.whitespaceOnly) {
      return wrap(
        <Notice
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPref("ignoreWhitespace", false)}
            >
              Show them
            </button>
          }
        >
          Whitespace changes only
        </Notice>,
      );
    }
    if (!p.hunks || p.hunks.hunks.length === 0) {
      const modeOnly =
        !c.typechange && p.oldMode !== null && p.newMode !== null && p.oldMode !== p.newMode;
      return wrap(<Notice>{modeOnly ? "Mode change only" : "No content changes"}</Notice>);
    }
    return wrap(
      <CardErrorBoundary
        resetKey={p}
        raw={p.newText ?? p.oldText}
        redact={(text) => redactFindings(text, secrets)}
      >
        <DiffBody
          file={file}
          payload={{ ...p, hunks: p.hunks }}
          viewType={viewMode}
          expandAllToken={expandAllToken}
          secrets={secrets}
        />
      </CardErrorBoundary>,
    );
  };

  let body: ReactNode = null;
  if (!collapsed) {
    if (cardMode === "history" && committed) {
      body = <FileHistoryBody file={file} />;
    } else if (conflict) {
      body = <ConflictBody file={file} />;
    } else if (gated) {
      body = (
        <button
          type="button"
          className="w-full p-7 text-center text-[13px] leading-5 text-muted hover:bg-surface-raised"
          onClick={() => setGenOpen(true)}
        >
          Generated file, click to expand{changedLines(stats)}
        </button>
      );
    } else if (!entry || entry.status === "loading") {
      body = <LoadingSkeleton />;
    } else if (entry.status === "error") {
      body = <LoadErrorNotice file={file} error={entry.error} />;
    } else if (cardMode === "blame" && committed) {
      body = (
        <BlameBody
          file={file}
          text={entry.data.newText ?? entry.data.oldText}
          language={entry.data.language}
        />
      );
    } else {
      body = renderReady(entry.data);
    }
  }

  return (
    <article
      ref={measureRef}
      data-index={index}
      style={style}
      // `overflow: clip` keeps the rounded corners without creating a scroll container, so the
      // header can stick to the pane (`overflow: hidden` would pin it to the card instead).
      className="overflow-clip rounded-[6px] border border-line bg-surface"
      aria-label={filePathOf(file)}
    >
      <FileHeader
        file={file}
        stats={stats}
        collapsed={collapsed}
        viewed={viewed}
        onToggleCollapse={() => setCollapsed(id, !collapsed)}
        onToggleViewed={() => toggleViewed(id)}
        onExpandAll={canExpandAll ? () => setExpandAllToken((t) => t + 1) : undefined}
        tag={conflict ? <ConflictTag kind={conflictKind} /> : undefined}
        {...(committed ? { mode: cardMode, onMode: (m: CardMode) => setCardMode(id, m) } : {})}
      />
      {body}
    </article>
  );
}
