import { CircleX } from "lucide-react";
import { Component, type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { FileDiffPayload } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { hasCollapsedContext } from "../diff/toHunkData";
import { isViewed, selectFileDiff, useStore } from "../store";
import { filePathOf } from "../treeModel";
import { DiffBody } from "./DiffBody";
import { FileHeader } from "./FileHeader";
import { LoadingSkeleton } from "./LoadingSkeleton";

export interface FileCardProps {
  file: FileDiff;
  index: number;
  /** Virtualiser measurement ref (DiffPane). */
  measureRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
}

/** Centred body notice (Design §7.5 / §7.7). */
export function Notice({
  tone = "muted",
  icon,
  children,
}: {
  tone?: "muted" | "danger";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 p-7 text-center text-[13px] leading-5 ${
        tone === "danger" ? "text-danger" : "text-muted"
      }`}
    >
      {icon}
      {children}
    </div>
  );
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
      <Notice tone="danger" icon={<CircleX size={16} aria-hidden />}>
        Couldn't render this diff
        <span className="flex gap-2">
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
        </span>
        {this.state.showRaw && this.props.raw !== null && (
          <pre className="max-h-96 w-full overflow-auto text-left font-mono text-xs text-ink">
            {this.props.raw}
          </pre>
        )}
      </Notice>
    );
  }
}

const shortOid = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "—");

function changedLines(stats: FileDiff["stats"]): string {
  if (!stats) return "";
  const n = stats.additions + stats.deletions;
  return ` · ${n.toLocaleString()} ${n === 1 ? "line" : "lines"} changed`;
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
    if (c.huge) return <Notice>Diff too large to display{changedLines(stats)}</Notice>;
    if (c.submodule) {
      return (
        <Notice>
          Submodule{" "}
          <span className="font-mono">
            {shortOid(p.submodule?.oldOid)} → {shortOid(p.submodule?.newOid)}
          </span>
        </Notice>
      );
    }
    if (c.binary || c.image) return <Notice>Binary file not shown</Notice>;
    if (c.tooLarge && p.hunks === null) {
      return (
        <Notice>
          Large diff{changedLines(stats)}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void loadFileDiff(id, { loadLarge: true })}
          >
            Load diff
          </button>
        </Notice>
      );
    }
    if (ignoreWhitespace && c.whitespaceOnly) {
      return (
        <Notice>
          Whitespace changes only ·{" "}
          <button
            type="button"
            className="text-accent underline-offset-2 hover:underline"
            onClick={() => setPref("ignoreWhitespace", false)}
          >
            Show them
          </button>
        </Notice>
      );
    }
    if (!p.hunks || p.hunks.hunks.length === 0) {
      const modeOnly = p.oldMode !== null && p.newMode !== null && p.oldMode !== p.newMode;
      return <Notice>{modeOnly ? "Mode change only" : "No content changes"}</Notice>;
    }
    return (
      <CardErrorBoundary resetKey={p} raw={p.newText ?? p.oldText}>
        <DiffBody
          file={file}
          payload={{ ...p, hunks: p.hunks }}
          viewType={viewMode}
          expandAllToken={expandAllToken}
        />
      </CardErrorBoundary>
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
        <Notice tone="danger" icon={<CircleX size={16} aria-hidden />}>
          Couldn't load this diff
          <span className="text-xs text-muted">{entry.error.message}</span>
          <button type="button" className="btn btn-sm" onClick={() => void loadFileDiff(id)}>
            Retry
          </button>
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
