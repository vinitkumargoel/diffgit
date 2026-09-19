/**
 * In-progress operation detector (T10.2, docs/v2-contracts.md; atlas tab 07, Design §14.3).
 *
 * "Am I in the middle of a rebase?" is answered by a handful of plain-text files in `.git/` that no
 * browser GUI surfaces. Everything here is a small read; the polling probe's `git` tier hashes the
 * same paths (`OPERATION_FILES`) so the banner updates live.
 *
 * Layouts handled:
 *   - `rebase-merge/`  — the merge backend and every interactive rebase: `msgnum`, `end`, `onto`,
 *     `head-name`, `git-rebase-todo` (remaining), `done`, `stopped-sha`, `interactive`.
 *   - `rebase-apply/`  — the am backend (`git rebase --apply`, `git am`): `next`, `last`, `onto`,
 *     `head-name`; no todo files.
 *   - `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` / `BISECT_START`.
 *
 * A layout that is recognised but incomplete degrades to `{kind, conflicts}` rather than to
 * nothing: "a rebase is in progress" is still the answer the user came for (atlas tab 07, "Risks").
 */

import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, RepoOperation, RepoRef } from "../types";
import { readIndex } from "./indexReader";
import type { ObjectDb } from "./objectDb";

/**
 * Every path under `.git/` whose appearance, disappearance or content marks an operation changing
 * state. `RepoSession.probeGit` stats all of them so the banner follows git in real time.
 */
export const OPERATION_FILES = [
  "MERGE_HEAD",
  "MERGE_MODE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_LOG",
  "BISECT_START",
  "BISECT_EXPECTED_REV",
  "rebase-merge/msgnum",
  "rebase-merge/end",
  "rebase-merge/done",
  "rebase-merge/git-rebase-todo",
  "rebase-merge/stopped-sha",
  "rebase-apply/next",
  "rebase-apply/last",
] as const;

const OID_RE = /^[0-9a-f]{40}$/;
const ABBREV_RE = /^[0-9a-f]{4,40}$/;

/** A todo line that names a commit; `exec`/`break`/`label`/`merge` lines name none. */
const TODO_RE = /^\s*(?:p|pick|r|reword|e|edit|s|squash|f|fixup|d|drop)\s+([0-9a-f]{4,40})\b/;

/** Trimmed text of `.git/<path>`, or null when it is not there. */
async function readState(fs: FsaFs, path: string): Promise<string | null> {
  try {
    return (await fs.readText(`.git/${path}`)).trim();
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw e;
  }
}

/** True when `.git/<path>` exists at all (git uses empty marker files, e.g. `interactive`). */
async function hasState(fs: FsaFs, path: string): Promise<boolean> {
  return fs.exists(`.git/${path}`);
}

/** mtime of `.git/<path>` in epoch ms; undefined when it cannot be stat'ed. */
async function startedAt(fs: FsaFs, path: string): Promise<number | undefined> {
  try {
    return (await fs.stat(`.git/${path}`)).mtimeMs;
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw e;
  }
}

/** A positive integer from a one-line state file (`msgnum`, `end`, `next`, `last`). */
function readCount(text: string | null): number | undefined {
  if (text === null) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Expands an abbreviated oid from a todo file. Git abbreviates unless `core.abbrev` says otherwise,
 * and an object a later `git gc` pruned cannot be expanded at all — in that case the abbreviation is
 * kept, so the banner can still show a short SHA instead of dropping the step (atlas tab 07, "Risks").
 */
async function resolveOid(db: ObjectDb, token: string): Promise<Oid> {
  if (OID_RE.test(token)) return token;
  try {
    const matches = await db.expandOid(token);
    return matches.length === 1 ? (matches[0] as Oid) : token;
  } catch {
    return token; // a missing pack must never fail the detector
  }
}

/** The commits a `git-rebase-todo` / `done` file names, in file order. */
async function readTodo(fs: FsaFs, db: ObjectDb, path: string): Promise<Oid[] | undefined> {
  const text = await readState(fs, path);
  if (text === null) return undefined;
  const out: Oid[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = TODO_RE.exec(line);
    if (m) out.push(await resolveOid(db, m[1] as string));
  }
  return out;
}

/** A ref name pointing at `oid` (branches before remotes before tags), else its short oid. */
function displayFor(oid: Oid, refs: readonly RepoRef[]): string {
  const hit = refs.find((r) => r.oid === oid && !r.synthetic);
  return hit ? hit.name : oid.slice(0, 7);
}

/** Paths with a stage 1/2/3 entry in the index — the `UU`/`AA`/`UD` rows of `git status`. */
async function countConflicts(fs: FsaFs): Promise<number> {
  try {
    const index = await readIndex(fs);
    return Object.keys(index.conflicts).length;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return 0; // an unborn repository has no index
    throw e;
  }
}

/** Reads `onto` / `head-name` / the step counters shared by both rebase backends. */
async function rebaseCommon(
  fs: FsaFs,
  dir: string,
  refs: readonly RepoRef[],
  op: RepoOperation,
): Promise<void> {
  const onto = await readState(fs, `${dir}/onto`);
  if (onto !== null && ABBREV_RE.test(onto)) {
    op.onto = onto;
    op.ontoDisplay = displayFor(onto, refs);
  }
  const headName = await readState(fs, `${dir}/head-name`);
  if (headName !== null && headName !== "detached HEAD") op.headName = headName;
  const started = await startedAt(fs, `${dir}/onto`);
  if (started !== undefined) op.startedAt = started;
}

async function detectRebaseMerge(
  fs: FsaFs,
  db: ObjectDb,
  refs: readonly RepoRef[],
  conflicts: number,
): Promise<RepoOperation> {
  const op: RepoOperation = { kind: "rebase", conflicts };
  const step = readCount(await readState(fs, "rebase-merge/msgnum"));
  const total = readCount(await readState(fs, "rebase-merge/end"));
  if (step !== undefined) op.step = step;
  if (total !== undefined) op.total = total;
  await rebaseCommon(fs, "rebase-merge", refs, op);
  if (await hasState(fs, "rebase-merge/interactive")) op.interactive = true;
  const stopped = await readState(fs, "rebase-merge/stopped-sha");
  if (stopped !== null && ABBREV_RE.test(stopped)) op.current = await resolveOid(db, stopped);
  const remaining = await readTodo(fs, db, "rebase-merge/git-rebase-todo");
  if (remaining !== undefined) op.remaining = remaining;
  const done = await readTodo(fs, db, "rebase-merge/done");
  if (done !== undefined) op.done = done;
  return op;
}

async function detectRebaseApply(
  fs: FsaFs,
  _db: ObjectDb,
  refs: readonly RepoRef[],
  conflicts: number,
): Promise<RepoOperation> {
  const op: RepoOperation = { kind: "rebase", conflicts };
  const step = readCount(await readState(fs, "rebase-apply/next"));
  const total = readCount(await readState(fs, "rebase-apply/last"));
  if (step !== undefined) op.step = step;
  if (total !== undefined) op.total = total;
  await rebaseCommon(fs, "rebase-apply", refs, op);
  return op;
}

/** A single-commit operation named by one state file holding that commit's oid. */
async function detectHeadFile(
  fs: FsaFs,
  kind: RepoOperation["kind"],
  file: string,
  conflicts: number,
): Promise<RepoOperation> {
  const op: RepoOperation = { kind, conflicts };
  const oid = await readState(fs, file);
  // MERGE_HEAD holds one line per commit being merged; an octopus merge lists several.
  const first = oid === null ? null : (oid.split("\n")[0] as string).trim();
  if (first !== null && ABBREV_RE.test(first)) op.current = first;
  const started = await startedAt(fs, file);
  if (started !== undefined) op.startedAt = started;
  return op;
}

/**
 * What git is in the middle of, or null when the working tree is idle.
 *
 * Precedence is most-specific first: a rebase that stopped on a conflict writes `REBASE_HEAD` and
 * (for the merge backend) `MERGE_MODE`, so checking the rebase directories before `MERGE_HEAD`
 * keeps it reported as a rebase, which is what `git status` says too.
 *
 * `refs` is optional: with it, `ontoDisplay` is the branch name the rebase is replaying onto
 * ("main"); without it, the short oid. `RepoSession` passes the refs it already loaded.
 */
export async function detectOperation(
  fs: FsaFs,
  db: ObjectDb,
  refs: readonly RepoRef[] = [],
): Promise<RepoOperation | null> {
  const [rebaseMerge, rebaseApply] = await Promise.all([
    hasState(fs, "rebase-merge"),
    hasState(fs, "rebase-apply"),
  ]);
  if (rebaseMerge) return detectRebaseMerge(fs, db, refs, await countConflicts(fs));
  if (rebaseApply) return detectRebaseApply(fs, db, refs, await countConflicts(fs));
  if (await hasState(fs, "CHERRY_PICK_HEAD"))
    return detectHeadFile(fs, "cherry-pick", "CHERRY_PICK_HEAD", await countConflicts(fs));
  if (await hasState(fs, "REVERT_HEAD"))
    return detectHeadFile(fs, "revert", "REVERT_HEAD", await countConflicts(fs));
  if (await hasState(fs, "MERGE_HEAD"))
    return detectHeadFile(fs, "merge", "MERGE_HEAD", await countConflicts(fs));
  const bisectLog = await hasState(fs, "BISECT_LOG");
  if (bisectLog || (await hasState(fs, "BISECT_START"))) {
    const op: RepoOperation = { kind: "bisect", conflicts: await countConflicts(fs) };
    // BISECT_START holds the branch (or oid) to return to when the bisect ends.
    const start = await readState(fs, "BISECT_START");
    if (start !== null && start !== "") op.headName = start;
    const started = await startedAt(fs, bisectLog ? "BISECT_LOG" : "BISECT_START");
    if (started !== undefined) op.startedAt = started;
    return op;
  }
  return null;
}
