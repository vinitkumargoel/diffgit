/**
 * Access to the git fixtures built by `bun run fixtures` (T0.3). Node/Bun only (test helper).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = resolve(here, "../../fixtures");

const MISSING =
  "fixtures/ is missing or incomplete — run `bun run fixtures` (scripts/make-fixtures.sh + fixture-expectations.sh) first.";

/** Absolute path of a fixture repository. Throws with a clear message if fixtures are not built. */
export function fixturePath(name: string): string {
  const p = join(FIXTURES_ROOT, name);
  if (!existsSync(p)) throw new Error(`${MISSING} (looked for ${p})`);
  return p;
}

/** True when the fixture exists (for fixtures that are optional, like `perf-5k`). */
export function hasFixture(name: string): boolean {
  return existsSync(join(FIXTURES_ROOT, name));
}

/** Parses `fixtures/<name>/expected/<file>` (file may omit the `.json` suffix). */
export function loadExpected<T = unknown>(name: string, file: string): T {
  const f = file.endsWith(".json") ? file : `${file}.json`;
  const p = join(fixturePath(name), "expected", f);
  if (!existsSync(p)) throw new Error(`${MISSING} (expected file ${p} not found)`);
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/**
 * Reads `fixtures/<name>/expected/<file>` verbatim (file may omit the `.txt` suffix). These are the
 * plain-text recordings of git's own output added by T10.0 — `git blame --porcelain`,
 * `git reflog`, `git tag -l`, `git stash list`, and so on.
 */
export function loadExpectedText(name: string, file: string): string {
  const f = file.endsWith(".txt") ? file : `${file}.txt`;
  const p = join(fixturePath(name), "expected", f);
  if (!existsSync(p)) throw new Error(`${MISSING} (expected file ${p} not found)`);
  return readFileSync(p, "utf8");
}

/** True when `fixtures/<name>/expected/<file>` was recorded (not every fixture gets every dump). */
export function hasExpected(name: string, file: string): boolean {
  const f = file.includes(".") ? file : `${file}.txt`;
  return existsSync(join(FIXTURES_ROOT, name, "expected", f));
}

/** `loadExpectedText` split into lines, with the trailing newline and blank lines dropped. */
export function loadExpectedLines(name: string, file: string): string[] {
  return loadExpectedText(name, file)
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---- v2 fixtures (T10.0); see docs/v2-contracts.md § "Fixtures to add" ----

/** Fixture repositories added for the phase-10 engine. */
export const V2_FIXTURES = [
  "tags",
  "stash",
  "rebase-conflict",
  "merge-conflict",
  "cherry-pick-conflict",
  "reflog-orphan",
  "history",
  "secrets",
  "hidden",
  "octopus",
] as const;
export type V2Fixture = (typeof V2_FIXTURES)[number];

/** Names inside the `history` fixture that the walker/blame/insights/preflight tests address. */
export const HISTORY_FIXTURE = {
  name: "history",
  defaultBranch: "main",
  topicBranch: "topic",
  /** Branched off an older point; three commits that T10.11 predicts a rebase outcome for. */
  preflightBranch: "preflight/a",
  /** The commit `preflight/a` was branched from, kept as a ref for convenience. */
  preflightBase: "preflight/base",
  lightweightTags: ["v0.1.0", "v0.2.0", "v0.3.0"],
  annotatedTag: "v1.0.0",
  renamedFrom: "src/renamed-from.txt",
  renamedTo: "src/renamed-to.txt",
  /** Edited by several commits on both `main` and `preflight/a`. */
  hotPath: "src/hot.txt",
  /** Re-indented by exactly one whitespace-only commit. */
  indentPath: "src/indent.txt",
  manifestPath: "package.json",
  /** Two addresses in `.mailmap`, both mapped to the first. */
  mailmapAuthor: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    alias: "ada.lovelace@corp.example.com",
  },
  botAuthor: "renovate[bot]",
} as const;

/** Paths planted in the `hidden` fixture, by the reason each one is not shown (T10.4). */
export const HIDDEN_FIXTURE = {
  name: "hidden",
  ignoredDir: "dist",
  ignoredDirCount: 3,
  ignoredFile: ".env.local",
  builtinExcluded: ".DS_Store",
  skipWorktree: "src/skipped.txt",
  assumeUnchanged: "src/assumed.txt",
  tooLarge: "big.txt",
} as const;

// ---- Shapes written by scripts/fixture-expectations.sh ----

export interface ExpectedMeta {
  name: string;
  default: string | null;
  headBranch: string | null;
  unborn: boolean;
  hasFeature: boolean;
  mergeBase: string | null;
  diffRange: string | null;
}
export interface ExpectedNameStatus {
  status: string; // A M D R T C U
  similarity: number | null;
  oldPath: string | null;
  newPath: string | null;
}
export interface ExpectedNumstat {
  additions: number | null; // null = binary
  deletions: number | null;
  path: string;
  oldPath: string | null;
}
export interface ExpectedRefs {
  refs: Record<string, string>;
  head: string | null; // "refs/heads/x" or a bare oid when detached
  headOid: string | null;
  originHead: string | null;
}
export interface ExpectedTreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  path: string;
}
export interface ExpectedLsTree {
  base: string | null;
  default: string;
  defaultOid: string;
  featureOid: string;
  trees: Record<string, ExpectedTreeEntry[]>;
}
export interface ExpectedIndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}
export type ExpectedStatusEntry =
  | {
      type: "1";
      xy: string;
      sub: string;
      mH: string;
      mI: string;
      mW: string;
      hH: string;
      hI: string;
      path: string;
    }
  | {
      type: "2";
      xy: string;
      sub: string;
      mH: string;
      mI: string;
      mW: string;
      hH: string;
      hI: string;
      score: string;
      path: string;
      origPath: string;
    }
  | {
      type: "u";
      xy: string;
      sub: string;
      m1: string;
      m2: string;
      m3: string;
      mW: string;
      h1: string;
      h2: string;
      h3: string;
      path: string;
    }
  | { type: "?"; path: string }
  | { type: "!"; path: string }
  | { type: "#"; raw: string };
export interface ExpectedWorktreeLayer {
  base: string;
  changes: ExpectedNameStatus[];
  untracked: string[];
}
export interface ExpectedCheckIgnore {
  path: string;
  source: string | null;
  line: number | null;
  pattern: string | null;
  ignored: boolean;
}
export type ExpectedMergeBase = { feature: string | null };
export type ExpectedHashObject = Record<string, string>;
