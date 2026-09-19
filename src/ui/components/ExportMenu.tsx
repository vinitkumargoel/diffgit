import { Download, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { byteLength } from "../export/download";
import {
  carriesLines,
  EXPORT_LABELS,
  type ExportKind,
  GATE_CANCEL,
  GATE_CONFIRM,
  gateQuestion,
  gateSummary,
  MENU_KINDS,
  MENU_TITLE,
  NOTHING_TO_EXPORT,
  PREPARING,
  SNAPSHOT_NOTE,
  scopeLabel,
  statsLine,
} from "../export/exportModel";
import { formatBytes } from "../format";
import { useShortcuts } from "../hooks/useShortcuts";
import { locationLabel } from "../secrets";
import { selectSecretGate, selectVisibleFiles, useStore } from "../store";

/**
 * Design §14.6 / atlas tab 12: the one export surface. A 28 × 28 `lucide:download` button at the end
 * of the StatsRow (Design §14.1 adds nothing else to the bars) opening a menu with the five rows,
 * their sizes, and the secret gate in front of the three that reproduce the changed lines.
 *
 * Sizes are real, not estimates: opening the menu renders `patchText()` once and builds the
 * snapshot from those same bytes, so every row is disabled until both exist and every size printed
 * is the size of the file that would be written.
 *
 * The gate is the contract's `selectSecretGate`: clear means *scanned and nothing found*. A scan
 * that has not answered yet is unknown, not clean, and is gated with wording that says so.
 */
export function ExportMenu() {
  const open = useStore((s) => s.export.open);
  const status = useStore((s) => s.export.status);
  const error = useStore((s) => s.export.error);
  const pending = useStore((s) => s.export.pending);
  const busy = useStore((s) => s.export.busy);
  const confirmed = useStore((s) => s.export.confirmed);
  const patch = useStore((s) => s.export.patch);
  const snapshot = useStore((s) => s.export.snapshot);
  const generation = useStore((s) => s.diff?.generation ?? null);
  const total = useStore((s) => s.diff?.files.length ?? 0);
  const visible = useStore(useShallow(selectVisibleFiles));
  const gate = useStore(useShallow(selectSecretGate));
  const setExportOpen = useStore((s) => s.setExportOpen);
  const requestExport = useStore((s) => s.requestExport);
  const confirmExport = useStore((s) => s.confirmExport);
  const cancelExport = useStore((s) => s.cancelExport);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useShortcuts({ e: () => setExportOpen(!open) });

  // A recompute or a change of filter invalidates the prepared bytes; re-preparing is a no-op when
  // the scope is unchanged, so this cannot loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-running on them is the point.
  useEffect(() => {
    if (open) setExportOpen(true);
  }, [open, generation, visible, setExportOpen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExportOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setExportOpen]);

  const statsOf = (f: (typeof visible)[number]) =>
    useStore.getState().stats[f.id] ?? f.stats ?? null;
  const ready = status === "ready";
  const empty = visible.length === 0;
  const clear = gate.scanned && gate.count === 0;
  const blocked = !clear && confirmed !== generation;

  /** The right-hand hint of each row: a size, a line count, or the line itself. */
  const hintOf = (kind: ExportKind): string => {
    switch (kind) {
      case "copy-patch":
      case "save-patch":
        return ready ? formatBytes(byteLength(patch)) : "";
      case "snapshot":
        return ready ? formatBytes(byteLength(snapshot)) : "";
      case "copy-list":
        return `${visible.length} ${visible.length === 1 ? "line" : "lines"}`;
      default:
        return statsLine(visible, statsOf);
    }
  };

  const row = (kind: ExportKind) => {
    const needsPatch = kind !== "copy-list" && kind !== "copy-stats";
    const disabled = empty || busy !== null || (needsPatch && !ready);
    return (
      <button
        key={kind}
        type="button"
        role="menuitem"
        disabled={disabled}
        title={empty ? NOTHING_TO_EXPORT : status === "failed" ? (error ?? undefined) : undefined}
        className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-[12.5px] leading-5 text-ink not-disabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void requestExport({ kind })}
      >
        <span className="flex-1 truncate">{EXPORT_LABELS[kind]}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{hintOf(kind)}</span>
      </button>
    );
  };

  const findingList = (
    <ul className="max-h-32 overflow-y-auto px-3 pb-1 font-mono text-[11px] leading-[18px] text-muted">
      {gate.findings.slice(0, 8).map((f) => (
        <li key={`${f.fileId}:${f.line}:${f.rule}`} className="truncate">
          {locationLabel(f)}
        </li>
      ))}
    </ul>
  );

  const confirmButtons = () => (
    <div className="flex items-center gap-2 px-3 pt-1 pb-2">
      <button type="button" className="btn btn-sm text-danger" onClick={() => void confirmExport()}>
        {GATE_CONFIRM}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          cancelExport();
          if (!pending) setExportOpen(false);
        }}
      >
        {GATE_CANCEL}
      </button>
    </div>
  );

  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
        type="button"
        className="btn btn-icon"
        aria-label={MENU_TITLE}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${MENU_TITLE} (e)`}
        onClick={() => setExportOpen(!open)}
      >
        <Download size={14} aria-hidden />
      </button>
      {open && (
        <div
          data-testid="export-menu"
          className="absolute top-full right-0 z-20 mt-1 w-80 rounded-[6px] border border-line bg-surface py-1 shadow-popover"
        >
          <p className="px-3 py-1 text-[11px] leading-4 text-muted">
            {scopeLabel(total, visible.length)}
          </p>
          {(pending !== null || blocked) && (
            <>
              <p className="flex items-start gap-2 px-3 py-1 text-[12.5px] leading-5 text-danger">
                <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
                <span>{pending === null ? gateSummary(gate) : gateQuestion(gate)}</span>
              </p>
              {gate.count > 0 && findingList}
              {confirmButtons()}
            </>
          )}
          {pending === null && (
            <div role="menu" aria-label={MENU_TITLE}>
              {!blocked && MENU_KINDS.filter(carriesLines).map(row)}
              {!blocked && <hr className="my-1 h-px border-0 bg-line" />}
              {MENU_KINDS.filter((k) => !carriesLines(k)).map(row)}
            </div>
          )}
          {pending === null && !blocked && (
            <p className="px-3 pt-1 pb-1 text-[11px] leading-4 text-muted">{SNAPSHOT_NOTE}</p>
          )}
          {status === "preparing" && (
            <p className="px-3 py-1 text-[11px] leading-4 text-muted">{PREPARING}</p>
          )}
          {status === "failed" && error !== null && (
            <p className="px-3 py-1 text-[11px] leading-4 text-danger">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
