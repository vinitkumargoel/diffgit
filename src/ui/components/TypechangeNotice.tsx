import { ArrowRight } from "lucide-react";
import { describeMode, sentenceCase } from "../format";

/** One-line `--accent-subtle` row above the body: "Symlink → regular file" (Design §7.7). */
export function TypechangeNotice({
  oldMode,
  newMode,
}: {
  oldMode: number | null;
  newMode: number | null;
}) {
  return (
    <div
      className="flex items-center gap-1.5 border-b border-line bg-accent-subtle px-3 py-1.5 text-xs text-ink"
      role="note"
    >
      {sentenceCase(describeMode(oldMode))}{" "}
      <ArrowRight size={12} aria-hidden className="text-muted" />
      <span className="sr-only">to</span> {describeMode(newMode)}
    </div>
  );
}
