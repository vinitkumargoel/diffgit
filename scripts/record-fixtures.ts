/**
 * Records RepoInfo + DiffResult (with stats) for the UI mock (T3.5 AC): bun run scripts/record-fixtures.ts
 * Output: src/test/recorded/<fixture>.{repoinfo,diffresult}.json — deterministic (fixed id/timestamps).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { defaultDiffSource } from "../src/engine/diffSource";
import { NodeDirHandle } from "../src/engine/fs/nodeDirHandle";
import { RepoSession } from "../src/engine/session";
import { fixturePath } from "../src/test/fixtures";

const OUT = new URL("../src/test/recorded/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

for (const name of ["basic", "worktree"]) {
  const session = await RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    { onProgress() {}, onStats() {}, onWarning() {} },
    { id: `recorded-${name}` },
  );
  const info = await session.info();
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
  result.computedAt = 1704067200000; // 2024-01-01T00:00:00Z
  result.durationMs = 0;
  writeFileSync(`${OUT}${name}.repoinfo.json`, `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(`${OUT}${name}.diffresult.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${name}: ${result.files.length} files, +${additions} -${deletions}`);
  await session.close();
}
