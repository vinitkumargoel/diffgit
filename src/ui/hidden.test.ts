/**
 * T11.4 — the wording of the Hidden group and the WhyHidden popover (Design §14.3, §14.4,
 * atlas tab 08). The `ignored` / `skip-worktree` / `assume-unchanged` / `too-large` / `clean` cases
 * run on the real `hidden` recording; `sparse` and `generated` have no fixture yet, so their copy is
 * checked directly — `describeReason` is exhaustive over `PathExplanation`'s reason kinds.
 */
import { describe, expect, it } from "vitest";
import type { HiddenEntry, PathExplanation } from "../engine/types";
import hiddenV2 from "../test/recorded/hidden.v2.json";
import {
  BUILTIN_SOURCE,
  describeReason,
  explanationTitle,
  HIDDEN_SENTENCE,
  HIDDEN_TAG,
  hiddenRowLabel,
} from "./hidden";

const entries = hiddenV2.hidden as HiddenEntry[];
const explanations = hiddenV2.explanations as unknown as Record<string, PathExplanation>;
const explain = (path: string): PathExplanation => {
  const e = explanations[path];
  if (!e) throw new Error(`no recorded explanation for ${path}`);
  return e;
};
const reasonOf = (path: string) => {
  const r = explain(path).reasons[0];
  if (!r) throw new Error(`${path} has no reason`);
  return describeReason(r);
};

describe("hidden: row tags (Design §14.4)", () => {
  it("names every kind the recording produced", () => {
    expect(entries.map((e) => `${e.path}=${HIDDEN_TAG[e.kind]}`)).toEqual([
      ".DS_Store=ignored",
      ".env.local=ignored",
      "big.txt=> 10 MB",
      "dist=ignored",
      "expected=ignored",
      "src/assumed.txt=assume-unchanged",
      "src/skipped.txt=skip-worktree",
    ]);
  });

  it("covers the five tags Design §14.4 lists, including `sparse`", () => {
    expect(new Set(Object.values(HIDDEN_TAG))).toEqual(
      new Set(["ignored", "skip-worktree", "assume-unchanged", "> 10 MB", "sparse"]),
    );
    expect(Object.keys(HIDDEN_SENTENCE).sort()).toEqual(Object.keys(HIDDEN_TAG).sort());
  });

  it("puts the child count of an ignored directory in the row's accessible name", () => {
    const dir = entries.find((e) => e.path === "dist");
    if (!dir) throw new Error("no recorded dist row");
    expect(hiddenRowLabel(dir)).toBe("dist, 3 entries — Ignored directory, not descended into");
    expect(hiddenRowLabel({ path: "x", kind: "ignored-dir", count: 1 })).toContain("1 entry");
    expect(hiddenRowLabel({ path: ".env.local", kind: "ignored" })).toBe(
      ".env.local — Ignored by a rule",
    );
  });
});

describe("hidden: popover headings", () => {
  it("says tracked-but-not-shown for an index flag and not-in-the-diff otherwise", () => {
    expect(explanationTitle(explain("src/skipped.txt"))).toBe(
      "src/skipped.txt is tracked but its edits are not shown",
    );
    expect(explanationTitle(explain("src/assumed.txt"))).toBe(
      "src/assumed.txt is tracked but its edits are not shown",
    );
    expect(explanationTitle(explain("dist/bundle.js"))).toBe("dist/bundle.js is not in the diff");
    expect(explanationTitle(explain("notes.txt"))).toBe("notes.txt is in the diff");
  });
});

describe("hidden: one copy block per reason kind", () => {
  it("ignored: names the file, the line and the pattern, with git's own command", () => {
    const copy = reasonOf("dist/bundle.js");
    expect(copy).toMatchObject({
      term: "Reason",
      detail: "Ignored by",
      code: ".gitignore line 1: dist/",
      command: "git check-ignore -v dist/bundle.js",
    });
  });

  it("ignored by the built-in excludes: points at the setting instead of a rule file", () => {
    // Guards the one documented divergence from `git check-ignore -v` (T10.4).
    expect(explain(".DS_Store").reasons[0]?.source).toBe(BUILTIN_SOURCE);
    const copy = reasonOf(".DS_Store");
    expect(copy.detail).toBe("Ignored by diffgit's built-in excludes");
    expect(copy.code).toBe(".DS_Store");
    expect(copy.note).toContain("Apply built-in excludes");
  });

  it("skip-worktree and assume-unchanged: the flag, where it comes from, how to undo it", () => {
    const skip = reasonOf("src/skipped.txt");
    expect(skip.detail).toContain("skip-worktree");
    expect(skip.note).toContain("git update-index --skip-worktree");
    expect(skip.command).toBe("git update-index --no-skip-worktree src/skipped.txt");
    const assume = reasonOf("src/assumed.txt");
    expect(assume.detail).toContain("assume-unchanged");
    expect(assume.command).toBe("git update-index --no-assume-unchanged src/assumed.txt");
  });

  it("too-large and clean: explanatory, with no command to copy", () => {
    const big = reasonOf("big.txt");
    expect(big.detail).toContain("Over 10 MB");
    expect(big.command).toBeNull();
    const clean = reasonOf("README.md");
    expect(clean.detail).toContain("nothing to show");
    expect(clean.command).toBeNull();
  });

  it("sparse and generated (no fixture yet) still have their own copy", () => {
    expect(describeReason({ kind: "sparse" }).detail).toContain("sparse checkout");
    expect(describeReason({ kind: "generated", source: ".gitattributes" })).toMatchObject({
      term: "Also",
      code: ".gitattributes",
    });
  });
});
