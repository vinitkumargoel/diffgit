// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: the `<table role="grid">`
// table below is a real ARIA grid — its rows are focusable, walked with `j` / `k` and opened
// with Enter (T11.7 / Design §14.6). Biome's alternative, a `div` tree, would lose table layout
// and demand a focusable wrapper per cell without making anything more accessible.
import type { TagInfo } from "../../engine/types";
import { previousTag, tagKindLabel, tagMessageLine } from "../branches";
import { useStore } from "../store";
import { timeAgo } from "../timeAgo";
import { NoValue } from "./AheadBehindCell";
import { useRowNavigation } from "./BranchTable";
import { GRID_CLASS, TD_CLASS, TH_CLASS } from "./branches.styles";

/** The tags table of Design §14.6: name, kind, message, tagger, age, `Compare with previous tag`. */
export function TagTable({ tags, now }: { tags: TagInfo[]; now: number }) {
  const compareTags = useStore((s) => s.compareTags);
  const { focusIndex, setFocusIndex } = useRowNavigation(tags.length);
  const compare = (i: number) => {
    const tag = tags[i];
    const prev = previousTag(tags, i);
    if (tag && prev) compareTags(prev, tag);
  };
  return (
    <table role="grid" aria-label="Tags" className={GRID_CLASS}>
      <thead>
        <tr>
          {["Tag", "Kind", "Message", "Tagger", "Age"].map((label) => (
            <th key={label} scope="col" className={TH_CLASS}>
              {label}
            </th>
          ))}
          <th scope="col" className={TH_CLASS}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody data-rows>
        {tags.map((tag, i) => {
          const prev = previousTag(tags, i);
          return (
            <tr
              key={tag.fullName}
              data-row-index={i}
              data-tag={tag.name}
              tabIndex={i === focusIndex ? 0 : -1}
              className="hover:bg-surface-raised focus-visible:bg-accent-subtle"
              onFocus={() => setFocusIndex(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  compare(i);
                }
              }}
            >
              <td className={TD_CLASS}>
                <span className="font-mono text-[12px] font-semibold text-ink">{tag.name}</span>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>{tagKindLabel(tag)}</td>
              <td className={`${TD_CLASS} max-w-[26rem]`}>
                {tagMessageLine(tag) === "" ? (
                  <NoValue title="A lightweight tag carries no message." />
                ) : (
                  <span className="truncate text-ink">{tagMessageLine(tag)}</span>
                )}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>
                {tag.tagger?.name ?? "—"}
              </td>
              <div className={`${TD_CLASS} whitespace-nowrap text-muted tabular-nums`}>
                {tag.timestamp === undefined ? (
                  <NoValue title="A lightweight tag has no date of its own; git reads the commit's." />
                ) : (
                  timeAgo(tag.timestamp, now)
                )}
              </div>
              <td className={TD_CLASS}>
                <button
                  type="button"
                  className="btn btn-sm whitespace-nowrap"
                  disabled={prev === null}
                  title={
                    prev === null
                      ? "This is the oldest tag in the list."
                      : `Compare ${prev.name} with ${tag.name}`
                  }
                  onClick={() => compare(i)}
                >
                  {prev === null ? "Compare with previous tag" : `Compare with ${prev.name}`}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export { TagTable as TagsTable };
