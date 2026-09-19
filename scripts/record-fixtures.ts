/**
 * Records RepoInfo + DiffResult (with stats) for the UI mock (T3.5 AC): bun run scripts/record-fixtures.ts
 * Output: src/test/recorded/<fixture>.{repoinfo,diffresult}.json — deterministic (fixed id/timestamps).
 *
 * T10.1 also records `<fixture>.v2.json` for the v2 fixtures: the tag list, the stash stack, every
 * revision expression `expected/rev-parse.txt` asks about, and a few range diffs (two-dot, three-dot,
 * a single commit, a stash). `workerClient.mock.ts` serves `resolveRevision` / `listTags` /
 * `listStashes` / range `computeDiff` straight out of it.
 *
 * T10.3 adds `conflicts`: the `ConflictPayload` of every file in the `conflict` layer, so the mock
 * can serve a real three-way card for `rebase-conflict`, `merge-conflict` and
 * `cherry-pick-conflict` without a repository on disk.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { ConflictPayload } from "../src/engine/api";
import { defaultDiffSource } from "../src/engine/diffSource";
import { NodeDirHandle } from "../src/engine/fs/nodeDirHandle";
import { RepoSession } from "../src/engine/session";
import type { DiffResult, RangeSource, RepoOperation, ResolvedRevision } from "../src/engine/types";
import { fixturePath, hasExpected, loadExpectedLines } from "../src/test/fixtures";

const OUT = new URL("../src/test/recorded/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const FIXED_COMPUTED_AT = 1704067200000; // 2024-01-01T00:00:00Z

/** Ranges worth having in the mock, by fixture. `from`/`to` are revision expressions. */
const RANGES: Record<string, { from: string; to: string; threeDot: boolean }[]> = {
  tags: [
    { from: "v0.1.0", to: "v1.0.0", threeDot: true },
    { from: "v0.1.0", to: "v1.0.0", threeDot: false },
  ],
  stash: [{ from: "HEAD", to: "stash@{0}", threeDot: false }],
  history: [
    { from: "main~5", to: "main", threeDot: true },
    { from: "main~1", to: "main", threeDot: false },
  ],
};

/** Replaces the operation's real mtime with the fixed clock so re-recording is a no-op. */
function pinStartedAt(op: RepoOperation | null): RepoOperation | null {
  return op && op.startedAt !== undefined ? { ...op, startedAt: FIXED_COMPUTED_AT } : op;
}

async function record(name: string, v2: boolean): Promise<void> {
  const session = await RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    { onProgress() {}, onStats() {}, onWarning() {} },
    { id: `recorded-${name}` },
  );
  const info = await session.info();
  info.operation = pinStartedAt(info.operation);
  const result = await session.computeDiff(defaultDiffSource(info));
  const stats = await session.fileStats(
    result.generation,
    result.files.map((f) => f.id),
  );
  let additions = 0;
  let deletions = 0;
  for (const f of result.files) {
    f.stats = stats[f.id] ?? null;
    additions += f.stats?.additions ?? 0;
    deletions += f.stats?.deletions ?? 0;
  }
  result.totals = { files: result.files.length, additions, deletions };
  result.computedAt = FIXED_COMPUTED_AT;
  result.durationMs = 0;
  writeFileSync(`${OUT}${name}.repoinfo.json`, `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(`${OUT}${name}.diffresult.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${name}: ${result.files.length} files, +${additions} -${deletions}`);

  if (v2) {
    // Recorded before any further computeDiff, while `result.generation` is still the current one.
    const conflicts: Record<string, ConflictPayload> = {};
    for (const f of result.files) {
      if (!f.layers.includes("conflict")) continue;
      conflicts[f.id] = await session.conflict(result.generation, f.id);
    }
    const revisions: Record<string, ResolvedRevision> = {};
    for (const line of hasExpected(name, "rev-parse") ? loadExpectedLines(name, "rev-parse") : []) {
      const expr = line.split("\t")[0] as string;
      try {
        revisions[expr] = await session.resolveRevision(expr);
      } catch {
        // git recorded `<unresolved>` for this expression; the mock answers REV_NOT_FOUND too.
      }
    }
    const ranges: { source: RangeSource; result: DiffResult }[] = [];
    for (const spec of RANGES[name] ?? []) {
      const from = await session.resolveRevision(spec.from);
      const to = await session.resolveRevision(spec.to);
      if (to.oid === null) continue;
      const source: RangeSource = {
        kind: "range",
        from: from.display,
        to: to.display,
        fromRef: spec.from,
        toRef: spec.to,
        fromOid: from.oid,
        toOid: to.oid,
        threeDot: spec.threeDot,
        includeWorktree: false,
      };
      const r = await session.computeDiff(source);
      const s = await session.fileStats(
        r.generation,
        r.files.map((f) => f.id),
      );
      let a = 0;
      let d = 0;
      for (const f of r.files) {
        f.stats = s[f.id] ?? null;
        a += f.stats?.additions ?? 0;
        d += f.stats?.deletions ?? 0;
      }
      r.totals = { files: r.files.length, additions: a, deletions: d };
      r.computedAt = FIXED_COMPUTED_AT;
      r.durationMs = 0;
      ranges.push({ source, result: r });
    }
    const payload = {
      tags: await session.listTags(),
      stashes: await session.listStashes(),
      // T10.2: the reflog panel and the operation banner replay these in the mock. `startedAt` is
      // the state file's mtime, so it is pinned here to keep the recording byte-stable.
      reflog: await session.reflog("HEAD", 200),
      operation: pinStartedAt(await session.operation()),
      // T10.3: the conflict card replays these; `generation` is rewritten by the mock on serve.
      conflicts,
      revisions,
      ranges,
    };
    writeFileSync(`${OUT}${name}.v2.json`, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(
      `${name}: ${payload.tags.length} tags, ${payload.stashes.length} stashes, ` +
        `${payload.reflog.length} reflog entries, operation ${payload.operation?.kind ?? "none"}, ` +
        `${Object.keys(revisions).length} revisions, ${ranges.length} ranges, ` +
        `${Object.keys(conflicts).length} conflicts`,
    );
  }
  await session.close();
}

for (const name of ["basic", "worktree"]) await record(name, false);
// T10.2 adds the interrupted-operation fixtures so the mock can serve a real banner + reflog;
// T10.3 adds `cherry-pick-conflict` and the conflict payloads for all three.
for (const name of [
  "tags",
  "stash",
  "history",
  "rebase-conflict",
  "merge-conflict",
  "cherry-pick-conflict",
])
  await record(name, true);
