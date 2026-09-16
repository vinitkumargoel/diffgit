import type { FileDiff } from "../../engine/types";
import { formatLines } from "../format";
import { sizesLabel } from "./BinaryNotice";
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

/** `tooLarge` gate ("Large diff (3,412 lines changed). [Load diff]") and the `huge` refusal. */
export function LargeFileGate({ file, stats, oldSize, newSize, huge, onLoad }: LargeFileGateProps) {
  if (huge) {
    return (
      <Notice detail={sizesLabel(oldSize, newSize, file.status)}>Diff too large to display</Notice>
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
