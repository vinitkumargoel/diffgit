import { EyeOff } from "lucide-react";
import { useSidebarResize } from "../hooks/useSidebarResize";
import {
  type SidebarGroup,
  type SidebarLayout,
  selectGroupTotals,
  selectHasLayers,
  selectVisibleFiles,
  useStore,
} from "../store";
import { FileTree } from "./FileTree";

const LAYOUTS: { value: SidebarLayout; label: string }[] = [
  { value: "tree", label: "Tree" },
  { value: "flat", label: "Flat" },
];

/** D9: the second header row's mini segmented control. */
const GROUPINGS: { value: SidebarGroup; label: string }[] = [
  { value: "layer", label: "Layer" },
  { value: "path", label: "Path" },
];

const SEGMENT_CLASS = "rounded-[6px] px-[7px] py-[2px] text-[11px] leading-4 font-medium";

/**
 * Left file navigator (Design §6, §7.4): 36 px header with count and `Tree | Flat`, a 30 px second
 * row with `Layer | Path` and the uncommitted count when the diff has more than one layer (D9),
 * the file tree, and a 4 px resize handle (220–480 px, persisted in prefs; ← → keys move it 10 px).
 */
export function Sidebar({ initialRect }: { initialRect?: { width: number; height: number } }) {
  const width = useStore((s) => s.prefs.sidebarWidth);
  const layout = useStore((s) => s.prefs.sidebarLayout);
  const grouping = useStore((s) => s.prefs.sidebarGroup);
  const hasLayers = useStore(selectHasLayers);
  const committed = useStore(selectGroupTotals).committed;
  const setPref = useStore((s) => s.setPref);
  const total = useStore((s) => s.diff?.files.length ?? 0);
  const visible = useStore(selectVisibleFiles).length;
  const filtering = useStore((s) => s.filter.trim() !== "");
  const showHidden = useStore((s) => s.prefs.showHidden);

  const { shown, handleProps } = useSidebarResize(width, (w) => setPref("sidebarWidth", w));

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface-sunken text-ink"
      style={{ width: shown }}
      aria-label="Changed files"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-xs font-semibold">
          {filtering ? (
            <>
              {visible} <span className="font-normal text-muted">of {total} files</span>
            </>
          ) : (
            <>
              Files changed <span className="font-normal text-muted">({total})</span>
            </>
          )}
        </span>
        <fieldset className="ml-auto inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
          <legend className="sr-only">Sidebar layout</legend>
          {LAYOUTS.map((l) => (
            <button
              key={l.value}
              type="button"
              aria-pressed={layout === l.value}
              className={`${SEGMENT_CLASS} ${
                layout === l.value ? "pressed" : "text-muted hover:text-ink"
              }`}
              onClick={() => setPref("sidebarLayout", l.value)}
            >
              {l.label}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          aria-pressed={showHidden}
          aria-label="Show hidden files"
          title="Show hidden files (Shift+H)"
          className={`inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] ${
            showHidden ? "pressed" : "text-muted hover:text-ink"
          }`}
          onClick={() => setPref("showHidden", !showHidden)}
        >
          <EyeOff size={13} aria-hidden />
        </button>
      </div>
      {hasLayers && (
        <div className="flex h-[30px] shrink-0 items-center justify-between border-b border-line px-3">
          <fieldset className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
            <legend className="sr-only">Group files</legend>
            {GROUPINGS.map((g) => (
              <button
                key={g.value}
                type="button"
                aria-pressed={grouping === g.value}
                className={`${SEGMENT_CLASS} ${
                  grouping === g.value ? "pressed" : "text-muted hover:text-ink"
                }`}
                onClick={() => setPref("sidebarGroup", g.value)}
              >
                {g.label}
              </button>
            ))}
          </fieldset>
          <span className="text-[11px] text-muted">{total - committed} uncommitted</span>
        </div>
      )}
      <FileTree layout={layout} initialRect={initialRect} />
      <hr {...handleProps} />
    </aside>
  );
}
