/**
 * T11.4 — every string the Hidden group and the WhyHidden popover show (Design §14.3 "Why hidden",
 * §14.4, atlas tab 08). Pure: no React, no store, so the wording is unit-tested on its own and the
 * components only lay it out.
 */
import type { HiddenEntry, PathExplanation } from "../engine/types";

export type HiddenKind = HiddenEntry["kind"];
export type Reason = PathExplanation["reasons"][number];
export type ReasonKind = Reason["kind"];

/**
 * `IgnoreRules.BUILTIN_SOURCE` (`src/engine/git/ignoreRules.ts`) as `explainPath` spells it. Copied
 * rather than imported: the engine module pulls the `ignore` package and `FsaFs` into the page
 * bundle for one string. `hidden.test.ts` asserts the recorded fixture still uses this spelling.
 */
export const BUILTIN_SOURCE = "(built-in excludes)";

/** Design §14.4: the small `ref`-style tag every Hidden row wears. */
export const HIDDEN_TAG: Record<HiddenKind, string> = {
  "ignored-dir": "ignored",
  ignored: "ignored",
  "skip-worktree": "skip-worktree",
  "assume-unchanged": "assume-unchanged",
  "too-large": "> 10 MB",
  sparse: "sparse",
};

/** The sentence behind the tag, used as the row's tooltip and in its accessible name. */
export const HIDDEN_SENTENCE: Record<HiddenKind, string> = {
  "ignored-dir": "Ignored directory, not descended into",
  ignored: "Ignored by a rule",
  "skip-worktree": "Index flag skip-worktree is set",
  "assume-unchanged": "Index flag assume-unchanged is set",
  "too-large": "Over 10 MB, so diffgit does not diff it",
  sparse: "Outside the sparse checkout",
};

/** Accessible name of one Hidden row: path, kind, and the child count of an ignored directory. */
export function hiddenRowLabel(entry: HiddenEntry): string {
  const count =
    entry.kind === "ignored-dir" && entry.count !== undefined
      ? `, ${entry.count} ${entry.count === 1 ? "entry" : "entries"}`
      : "";
  return `${entry.path}${count} — ${HIDDEN_SENTENCE[entry.kind]}`;
}

/** Heading of the popover (atlas tab 08: two spellings, tracked-but-not-shown and not-in-the-diff). */
export function explanationTitle(explanation: PathExplanation): string {
  const { path, reasons, shown } = explanation;
  if (shown) return `${path} is in the diff`;
  if (reasons.some((r) => r.kind === "skip-worktree" || r.kind === "assume-unchanged"))
    return `${path} is tracked but its edits are not shown`;
  return `${path} is not in the diff`;
}

export interface ReasonCopy {
  /** Left column of the popover's term/detail grid. */
  term: string;
  /** Right column. `code` is appended to it in monospace when it is not null. */
  detail: string;
  /** Verbatim rule / pattern, rendered in monospace after `detail`. */
  code: string | null;
  /** Muted line under the detail: where the flag comes from, or what to do about it. */
  note: string | null;
  /** The copyable command the engine supplied for this reason, if any. */
  command: string | null;
}

/** One reason of a `PathExplanation`, as the popover words it. */
export function describeReason(reason: Reason): ReasonCopy {
  const command = reason.command ?? null;
  switch (reason.kind) {
    case "ignored": {
      const builtin = reason.source === BUILTIN_SOURCE;
      const rule =
        reason.source === undefined
          ? null
          : builtin
            ? (reason.pattern ?? null)
            : `${reason.source} line ${reason.line ?? 0}: ${reason.pattern ?? ""}`;
      return {
        term: "Reason",
        detail: builtin ? "Ignored by diffgit's built-in excludes" : "Ignored by",
        code: rule,
        note: builtin
          ? "Turn off “Apply built-in excludes” in the shortcuts dialog to see it as untracked."
          : "Rule attribution follows git: the last matching rule in the nearest file wins.",
        command,
      };
    }
    case "skip-worktree":
      return {
        term: "Reason",
        detail: "Index flag skip-worktree is set, so git itself ignores working-tree changes to it",
        code: null,
        note: "Usually set by git update-index --skip-worktree, or by a sparse checkout.",
        command,
      };
    case "assume-unchanged":
      return {
        term: "Reason",
        detail: "Index flag assume-unchanged is set, so git never looks at the working-tree copy",
        code: null,
        note: "Usually a local performance hint: git update-index --assume-unchanged.",
        command,
      };
    case "sparse":
      return {
        term: "Reason",
        detail: "Outside the sparse checkout, so git does not populate it",
        code: null,
        note: "The patterns live in .git/info/sparse-checkout.",
        command,
      };
    case "too-large":
      return {
        term: "Reason",
        detail: "Over 10 MB, so diffgit does not read it",
        code: null,
        note: "The gate keeps the tab responsive; the file itself is untouched.",
        command,
      };
    case "generated":
      return {
        term: "Also",
        detail: "Marked linguist-generated, so its card starts collapsed",
        code: reason.source ?? null,
        note: null,
        command,
      };
    case "clean":
      return {
        term: "Reason",
        detail: "Tracked and unchanged between these two sides, so there is nothing to show",
        code: null,
        note: null,
        command,
      };
    default: {
      // Exhaustive over `ReasonKind`; a new kind must add its copy here rather than fall through.
      const never: never = reason.kind;
      throw new Error(`unknown reason kind ${String(never)}`);
    }
  }
}

/** The known gap of atlas tab 08, shown only when the engine actually reported it. */
export const GLOBAL_EXCLUDES_NOTE = {
  term: "Global excludes",
  detail:
    "core.excludesFile is outside the folder you granted, so diffgit cannot read it; those rules are not applied here.",
} as const;

/** Muted footer of the popover: diffgit is read-only (D16), the command is the authority. */
export const AUTHORITY_NOTE = "diffgit never runs these; copy one into your terminal.";
