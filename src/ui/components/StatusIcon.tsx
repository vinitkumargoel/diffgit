import type { FileStatus } from "../../engine/types";

const META: Record<FileStatus, { letter: string; label: string; cls: string }> = {
  added: { letter: "A", label: "Added", cls: "bg-status-a-bg text-status-a-fg" },
  modified: { letter: "M", label: "Modified", cls: "bg-status-m-bg text-status-m-fg" },
  deleted: { letter: "D", label: "Deleted", cls: "bg-status-d-bg text-status-d-fg" },
  renamed: { letter: "R", label: "Renamed", cls: "bg-status-r-bg text-status-r-fg" },
  copied: { letter: "C", label: "Copied", cls: "bg-status-r-bg text-status-r-fg" },
  typechange: { letter: "T", label: "Type changed", cls: "bg-status-t-bg text-status-t-fg" },
};

export function statusLabel(status: FileStatus): string {
  return META[status].label;
}

/** 16 px status square with a letter (Design §3.3 / §7.4). Shared primitive (Design §11). */
export function StatusIcon({ status, title }: { status: FileStatus; title?: string }) {
  const m = META[status];
  return (
    <span
      role="img"
      aria-label={m.label}
      title={title ?? m.label}
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] leading-none font-bold ${m.cls}`}
    >
      {m.letter}
    </span>
  );
}
