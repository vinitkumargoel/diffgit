import { Scale } from "lucide-react";
import type { FileDiff } from "../../engine/types";
import { formatBytes, formatLines } from "../format";
import { Notice } from "./Notice";

export interface LargeFileGateProps {
  file: FileDiff;
  stats: FileDiff["stats"];
  oldSize: number;
  newSize: number;
  /** > 10 MB (Plan §6.7): never rendered, no button. */
  huge: boolean;
  onLoad: () => void;
}

/** "Old 13.9 MB · new 14.2 MB" — a single side for added / deleted files (mockup E6). */
export function hugeSizes(oldSize: number, newSize: number, status: FileDiff["status"]): string {
  if (status === "added") return `New ${formatBytes(newSize)}`;
  if (status === "deleted") return `Old ${formatBytes(oldSize)}`;
  return `Old ${formatBytes(oldSize)} · new ${formatBytes(newSize)}`;
}

/** `tooLarge` gate ("Large diff (3,412 lines changed). [Load diff]") and the `huge` refusal. */
export function LargeFileGate({ file, stats, oldSize, newSize, huge, onLoad }: LargeFileGateProps) {
  if (huge) {
    return (
      <Notice
        icon={<Scale size={22} aria-hidden />}
        detail={`${hugeSizes(oldSize, newSize, file.status)}. Files over 10 MB per side are not compared in the browser.`}
        code="TOO_LARGE"
      >
        Diff too large to display
      </Notice>
    );
  }
  const lines = stats ? ` (${formatLines(stats.additions + stats.deletions)})` : "";
  return (
    <Notice
      action={
        <button type="button" className="btn btn-sm" onClick={onLoad}>
          Load diff
        </button>
      }
    >
      Large diff{lines}.
    </Notice>
  );
}
