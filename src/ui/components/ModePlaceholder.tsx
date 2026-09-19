import type { LucideIcon } from "lucide-react";
import { CenteredColumn } from "./CenteredColumn";

/**
 * The body of a mode whose page has not been built yet (T11.1 only; T11.5 / T11.7 / T11.12 replace
 * each view with the real page). Styled as the EmptyState of Design §7.8 — no new look.
 */
export function ModePlaceholder({
  icon: Icon,
  title,
  description,
  task,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  task: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <CenteredColumn as="section" label={title}>
        <Icon size={28} className="text-muted" aria-hidden="true" />
        <h1 className="text-xl font-semibold leading-7">{title}</h1>
        <p className="text-muted">{description}</p>
        <p className="font-mono text-xs text-muted">coming in {task}</p>
      </CenteredColumn>
    </div>
  );
}
