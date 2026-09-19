import { CircleHelp } from "lucide-react";
import { sourceLabels, sourceRefs } from "../../engine/diffSource";
import { JJ_TAG, JJ_TITLE } from "../jj";
import { selectCanIncludeWorktree, useStore } from "../store";
import { WORKTREES_ACTION } from "../worktrees";
import { BranchPicker } from "./BranchPicker";
import { PaletteButton } from "./CommandPalette";
import { IncludeWorktreeToggle } from "./IncludeWorktreeToggle";
import { Logo } from "./Logo";
import { ModeSwitch } from "./ModeSwitch";
import { RefreshControl } from "./RefreshControl";
import { StatsRow } from "./StatsRow";
import { SwapButton } from "./SwapButton";
import { ThemeToggle } from "./ThemeToggle";

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />;
}

/**
 * Row 1's repo name (Design §14.1). Nothing is *added* to the row: the name itself is the button
 * that opens the Worktrees dialog (T11.16, atlas tab 19), and the `jj colocated` tag — the only
 * thing a colocated jujutsu workspace changes about the chrome — sits inside the same element,
 * which is where Design §14 puts it.
 */
function RepoName({ name, jj }: { name: string; jj: boolean }) {
  const setWorktreesOpen = useStore((s) => s.setWorktreesOpen);
  const open = useStore((s) => s.worktreesOpen);
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-[5px] text-sm font-semibold hover:underline"
      aria-haspopup="dialog"
      aria-expanded={open}
      title={WORKTREES_ACTION}
      onClick={() => setWorktreesOpen(true)}
    >
      <Logo size={20} className="rounded-[5px]" />
      {name}
      {jj && (
        <span
          className="inline-flex h-4 shrink-0 items-center rounded-full border border-chip-generated-fg/40 bg-chip-generated-bg px-1.5 font-sans text-[11px] leading-4 font-medium text-chip-generated-fg"
          title={JJ_TITLE}
        >
          {JJ_TAG}
        </span>
      )}
    </button>
  );
}

/** Two-row control strip (Design §7.1 + §7.2, Plan §6.1 screen 4). Wraps on narrow widths. */
export function TopBar({ onHelp }: { onHelp?: () => void } = {}) {
  const repo = useStore((s) => s.repo);
  const diffSource = useStore((s) => s.diffSource);
  const canIncludeWorktree = useStore(selectCanIncludeWorktree);
  const refresh = useStore((s) => s.refresh);
  const swapBranches = useStore((s) => s.swapBranches);
  const setIncludeWorktree = useStore((s) => s.setIncludeWorktree);
  const requestRefresh = useStore((s) => s.requestRefresh);
  const setRevision = useStore((s) => s.setRevision);
  const setSpecialSource = useStore((s) => s.setSpecialSource);
  const resolveRevision = useStore((s) => s.resolveRevision);
  const loadPickerSources = useStore((s) => s.loadPickerSources);
  const setTwoDot = useStore((s) => s.setTwoDot);
  // The footer states what *this* comparison is, not what the pref last was: a `BranchesSource` is
  // always three-dot, so a stale `twoDot` pref can never light the wrong segment.
  const twoDot = useStore((s) =>
    s.diffSource ? s.diffSource.kind === "range" && !s.diffSource.threeDot : s.prefs.twoDot,
  );
  // Design §14.1: in Branches and Insights the StatsRow is replaced by the page's own header —
  // same height, same border — so row 2 is not drawn twice (T11.7, T11.12).
  const ownHeader = useStore((s) => s.mode === "branches" || s.mode === "insights");
  const tags = useStore((s) => s.tags);
  const stashes = useStore((s) => s.stashes);
  // T11.15 / Design §14.6: snapshot mode cannot refresh itself, so the Live dot is not drawn.
  const snapshotMode = useStore((s) => s.snapshotMode);
  const patchOnly = useStore((s) => s.patchOnly);

  // T11.14 / Design §14.6: a patch file has no refs, no working tree and nothing to refresh, so
  // row 1 keeps only what still means something — the ModeSwitch (with three modes disabled), the
  // help, the palette and the theme. What is open is named by the StatsRow's `Patch · <name>` tag,
  // in place of the pickers.
  if (patchOnly) {
    return (
      <header className="shrink-0 border-b border-line text-[13px] leading-5 text-ink">
        <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line-subtle bg-surface-raised px-3 py-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Logo size={20} className="rounded-[5px]" />
            diffgit
          </span>
          <ModeSwitch />
          <span className="flex-1" />
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => onHelp?.()}
          >
            <CircleHelp size={16} aria-hidden />
          </button>
          <PaletteButton />
          <ThemeToggle />
        </div>
        <StatsRow />
      </header>
    );
  }

  if (!repo || !diffSource) return null;

  // T10.1/T11.2: either DiffSource kind names its two sides through these two helpers.
  const refs = sourceRefs(diffSource);
  const labels = sourceLabels(diffSource);
  const shared = {
    refs: repo.refs,
    tags,
    stashes,
    twoDot,
    onTwoDot: setTwoDot,
    onOpen: () => void loadPickerSources(),
    onResolve: resolveRevision,
  };

  return (
    <header
      className={`shrink-0 text-[13px] leading-5 text-ink ${ownHeader ? "" : "border-b border-line"}`}
    >
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line-subtle bg-surface-raised px-3 py-1">
        <RepoName name={repo.name} jj={repo.jj} />
        <ModeSwitch />
        <span className="text-xs text-muted">base:</span>
        <BranchPicker
          label="base"
          value={refs.targetRef}
          display={labels.target}
          onSelect={(rev) => setRevision(rev, "target")}
          {...shared}
        />
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
          display={labels.source}
          special
          onSelect={(rev) => setRevision(rev, "source")}
          onSpecial={setSpecialSource}
          {...shared}
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
          hideMode={snapshotMode}
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
        <PaletteButton />
        <ThemeToggle />
      </div>
      {!ownHeader && <StatsRow />}
    </header>
  );
}
