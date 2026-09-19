import { CircleHelp } from "lucide-react";
import { sourceRefs } from "../../engine/diffSource";
import { selectCanIncludeWorktree, useStore } from "../store";
import { BranchPicker } from "./BranchPicker";
import { IncludeWorktreeToggle } from "./IncludeWorktreeToggle";
import { Logo } from "./Logo";
import { RefreshControl } from "./RefreshControl";
import { StatsRow } from "./StatsRow";
import { SwapButton } from "./SwapButton";
import { ThemeToggle } from "./ThemeToggle";

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />;
}

/** Two-row control strip (Design §7.1 + §7.2, Plan §6.1 screen 4). Wraps on narrow widths. */
export function TopBar({ onHelp }: { onHelp?: () => void } = {}) {
  const repo = useStore((s) => s.repo);
  const diffSource = useStore((s) => s.diffSource);
  const canIncludeWorktree = useStore(selectCanIncludeWorktree);
  const refresh = useStore((s) => s.refresh);
  const setSource = useStore((s) => s.setSource);
  const setTarget = useStore((s) => s.setTarget);
  const swapBranches = useStore((s) => s.swapBranches);
  const setIncludeWorktree = useStore((s) => s.setIncludeWorktree);
  const requestRefresh = useStore((s) => s.requestRefresh);

  if (!repo || !diffSource) return null;

  // T10.1: the pickers still show refs; `sourceRefs` reads either DiffSource kind.
  const refs = sourceRefs(diffSource);

  return (
    <header className="shrink-0 border-b border-line text-[13px] leading-5 text-ink">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line-subtle bg-surface-raised px-3 py-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Logo size={20} className="rounded-[5px]" />
          {repo.name}
        </span>
        <span className="text-xs text-muted">base:</span>
        <BranchPicker label="base" value={refs.targetRef} refs={repo.refs} onSelect={setTarget} />
        <span
          role="img"
          aria-label="Shows what compare adds on top of base"
          title="Shows what compare adds on top of base"
          className="text-muted"
        >
          ←
        </span>
        <span className="text-xs text-muted">compare:</span>
        <BranchPicker
          label="compare"
          value={refs.sourceRef}
          refs={repo.refs}
          onSelect={setSource}
        />
        <SwapButton disabled={refs.sourceRef === refs.targetRef} onClick={swapBranches} />
        <Divider />
        <IncludeWorktreeToggle
          checked={diffSource.includeWorktree}
          enabled={canIncludeWorktree}
          headDisplay={repo.headDisplay}
          onChange={setIncludeWorktree}
        />
        <span className="flex-1" />
        <RefreshControl
          mode={refresh.mode}
          busy={refresh.busy}
          lastAt={refresh.lastAt}
          phase={refresh.phase ?? null}
          onRefresh={(force) => requestRefresh(force ? "force" : "manual")}
        />
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => onHelp?.()}
        >
          <CircleHelp size={16} aria-hidden />
        </button>
        <ThemeToggle />
      </div>
      <StatsRow />
    </header>
  );
}
