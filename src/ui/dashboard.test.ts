/**
 * T11.11 — the Home dashboard's copy and maths, on the recorded summaries `bun run record` wrote
 * into `<fixture>.v2.json` (T10.10). Every string a card shows is asserted here rather than
 * through the DOM; `components/dashboard.test.tsx` drives the cards and the summariser.
 */
import { describe, expect, it } from "vitest";
import type { RepoSummary } from "../engine/types";
import hiddenV2 from "../test/recorded/hidden.v2.json";
import historyV2 from "../test/recorded/history.v2.json";
import mergeV2 from "../test/recorded/merge-conflict.v2.json";
import rebaseV2 from "../test/recorded/rebase-conflict.v2.json";
import secretsV2 from "../test/recorded/secrets.v2.json";
import { layerCountLabel } from "./components/LayerChip";
import {
  COUNT_ORDER,
  countChips,
  indexMtimeOf,
  isStale,
  lastCommitLine,
  lastSeenLine,
  operationTag,
  SUMMARY_CONCURRENCY,
} from "./dashboard";
import { timeAgo } from "./timeAgo";

const history = historyV2.summary as unknown as RepoSummary;
const hidden = hiddenV2.summary as unknown as RepoSummary;
const secrets = secretsV2.summary as unknown as RepoSummary;
const rebase = rebaseV2.summary as unknown as RepoSummary;
const merge = mergeV2.summary as unknown as RepoSummary;

describe("dashboard counts (Design §14.6)", () => {
  it("lists the non-zero layers in the card's order and nothing else", () => {
    expect(countChips(secrets.counts)).toEqual([
      { kind: "staged", count: 2 },
      { kind: "unstaged", count: 1 },
    ]);
    expect(countChips(hidden.counts)).toEqual([
      { kind: "unstaged", count: 1 },
      { kind: "untracked", count: 1 },
    ]);
    expect(countChips(rebase.counts)).toEqual([{ kind: "conflict", count: 2 }]);
    // a repository with nothing uncommitted has no chips at all — the card says `clean` instead
    expect(countChips(history.counts)).toEqual([]);
    expect(COUNT_ORDER).toEqual(["staged", "unstaged", "untracked", "conflict"]);
  });

  it("counts read as the atlas prints them, and only `conflict` pluralises", () => {
    expect(layerCountLabel("staged", 2)).toBe("2 staged");
    expect(layerCountLabel("unstaged", 1)).toBe("1 unstaged");
    expect(layerCountLabel("untracked", 12)).toBe("12 untracked");
    expect(layerCountLabel("conflict", 1)).toBe("1 conflict");
    expect(layerCountLabel("conflict", 2)).toBe("2 conflicts");
  });

  it("summarises one repository at a time (the atlas's CPU/battery mitigation)", () => {
    expect(SUMMARY_CONCURRENCY).toBe(1);
  });
});

describe("dashboard tags and lines", () => {
  it("names the operation and its step, and says nothing when there is none", () => {
    expect(operationTag(rebase.operation)).toBe("rebase 2/3");
    // a merge has no step counter of its own, so the tag is the kind alone
    expect(operationTag(merge.operation)).toBe("merge");
    expect(operationTag(history.operation)).toBeNull();
  });

  it("dates the last commit, and prints nothing rather than a claim it cannot make", () => {
    const now = (history.lastCommit?.timestamp ?? 0) + 3 * 3600_000;
    expect(lastCommitLine(history, (t) => timeAgo(t, now))).toBe("last commit 3 h ago");
    expect(lastCommitLine({ lastCommit: null }, (t) => timeAgo(t, now))).toBeNull();
  });

  it("a card with no summary yet says what it was last compared against", () => {
    expect(lastSeenLine("feat/tokens")).toBe("last seen on feat/tokens");
  });
});

describe("staleness (atlas tab 11: 'older than its index mtime')", () => {
  const at = (indexMtimeMs: number): RepoSummary => ({ ...history, indexMtimeMs });

  it("is the disagreement between the summary and the last stat, and nothing else", () => {
    expect(isStale({ summary: at(5), mtime: 9 })).toBe(true);
    expect(isStale({ summary: at(5), mtime: 5 })).toBe(false);
    // no summary, or an index that could not be stat-ed: nothing to compare, so nothing is claimed
    expect(isStale({ summary: null, mtime: 9 })).toBe(false);
    expect(isStale({ summary: at(5), mtime: null })).toBe(false);
  });
});

describe("indexMtimeOf: the cheap stat of .git/index", () => {
  const handle = (lastModified: number) => ({
    getDirectoryHandle: async (name: string) => {
      expect(name).toBe(".git");
      return {
        getFileHandle: async (file: string) => {
          expect(file).toBe("index");
          return { getFile: async () => ({ lastModified }) };
        },
      };
    },
  });

  it("reads `lastModified`, which is what the engine keys `indexMtimeMs` on", async () => {
    expect(await indexMtimeOf(handle(4242))).toBe(4242);
  });

  it("answers null — 'cannot tell', never an error — for anything it cannot read", async () => {
    expect(await indexMtimeOf({})).toBeNull();
    expect(await indexMtimeOf(null)).toBeNull();
    expect(await indexMtimeOf({ name: "marker" })).toBeNull();
    expect(
      await indexMtimeOf({
        getDirectoryHandle: async () => {
          throw new DOMException("no .git", "NotFoundError");
        },
      }),
    ).toBeNull();
    // a `.git` that is a file (worktree gitdir layout) has no `getFileHandle` to offer
    expect(await indexMtimeOf({ getDirectoryHandle: async () => ({}) })).toBeNull();
  });
});
