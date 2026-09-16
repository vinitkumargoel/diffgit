import { CircleX } from "lucide-react";
import { Component, type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { FileDiffPayload } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { hasCollapsedContext } from "../diff/toHunkData";
import { isViewed, selectFileDiff, useStore } from "../store";
import { filePathOf } from "../treeModel";
import { BinaryNotice } from "./BinaryNotice";
import { DiffBody } from "./DiffBody";
import { FileHeader } from "./FileHeader";
import { ImageDiff } from "./ImageDiff";
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
}
interface BoundaryState {
  error: Error | null;
  showRaw: boolean;
}

/** Per-card error boundary (T5.3 amendment): a renderer crash never unmounts the pane. */
export class CardErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, showRaw: false };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, showRaw: false });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <>
        <Notice
          tone="danger"
          icon={<CircleX size={16} aria-hidden />}
          action={
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => this.setState({ error: null, showRaw: false })}
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

function changedLines(stats: FileDiff["stats"]): string {
  if (!stats) return "";
  const n = stats.additions + stats.deletions;
  return ` · ${n.toLocaleString("en-US")} ${n === 1 ? "line" : "lines"} changed`;
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

  const [genOpen, setGenOpen] = useState(false);
  const gated = !!file.generated && !genOpen;
  const wantsBody = !collapsed && !gated;
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
      <CardErrorBoundary resetKey={p} raw={p.newText ?? p.oldText}>
        <DiffBody
          file={file}
          payload={{ ...p, hunks: p.hunks }}
          viewType={viewMode}
          expandAllToken={expandAllToken}
        />
      </CardErrorBoundary>,
    );
  };

  let body: ReactNode = null;
  if (!collapsed) {
    if (gated) {
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
      body = (
        <Notice
          tone="danger"
          icon={<CircleX size={16} aria-hidden />}
          detail={entry.error.message}
          action={
            <button type="button" className="btn btn-sm" onClick={() => void loadFileDiff(id)}>
              Retry
            </button>
          }
        >
          Couldn't load this diff
        </Notice>
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
      />
      {body}
    </article>
  );
}
