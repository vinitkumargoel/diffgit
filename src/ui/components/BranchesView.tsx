import { GitBranch } from "lucide-react";
import { ModePlaceholder } from "./ModePlaceholder";

/** Branches mode (Design §14.6). Placeholder until T11.7 builds the table and the tags list. */
export function BranchesView() {
  return (
    <ModePlaceholder
      icon={GitBranch}
      title="Branches"
      task="T11.7"
      description="Every branch and tag with ahead/behind against its upstream and the base branch."
    />
  );
}
