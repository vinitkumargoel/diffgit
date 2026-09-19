import { History } from "lucide-react";
import { ModePlaceholder } from "./ModePlaceholder";

/** History mode (Design §14.5). Placeholder until T11.5 builds the commit list and CommitCard. */
export function HistoryView() {
  return (
    <ModePlaceholder
      icon={History}
      title="History"
      task="T11.5"
      description="Commits, the stack of the compare branch and the reflog, with the commit's diff in the pane."
    />
  );
}
