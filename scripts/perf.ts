/**
 * T7.2 structural perf budgets, run by `bun run perf` (and CI). Times every engine phase on the
 * `perf-5k` fixture and asserts what is stable across machines: message counts per recompute, the
 * DiffResult payload size, handle-cache churn per refresh, and the 3000-line hunk model. Absolute
 * timings are printed always and asserted only with PERF_STRICT=1 (GitHub runners are noise).
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Progress, ProgressSink, StatsBatch } from "../src/engine/api";
import { defaultDiffSource } from "../src/engine/diffSource";
import { NodeDirHandle } from "../src/engine/fs/nodeDirHandle";
import { RepoSession } from "../src/engine/session";
import type { RepoWarning } from "../src/engine/types";
import { fixturePath, hasFixture } from "../src/test/fixtures";

const STRICT = process.env.PERF_STRICT === "1";
const failures: string[] = [];
function budget(name: string, value: number, limit: number, unit = "", strictOnly = false) {
  const ok = value <= limit;
  const tag = strictOnly && !STRICT ? (ok ? "ok  " : "info") : ok ? "ok  " : "FAIL";
  console.log(
    `${tag}  ${name}: ${Number.isInteger(value) ? value : value.toFixed(1)}${unit} (budget ≤ ${limit}${unit})`,
  );
  if (!ok && !(strictOnly && !STRICT)) failures.push(name);
}

if (!hasFixture("perf-5k")) {
  console.error("perf-5k fixture missing: FIXTURES_PERF=1 bun run fixtures");
  process.exit(1);
}
// work on a copy so the recompute-after-edit step never touches the fixture
const work = mkdtempSync(join(tmpdir(), "diffgit-perf-"));
cpSync(fixturePath("perf-5k"), work, { recursive: true });

const progress: Progress[] = [];
const batches: StatsBatch[] = [];
const warnings: RepoWarning[] = [];
const sink: ProgressSink = {
  onProgress: (p) => void progress.push(p),
  onStats: (b) => void batches.push(b),
  onWarning: (w) => void warnings.push(w),
};
const waitStats = async (files: number, timeoutMs = 60_000) => {
  const t0 = performance.now();
  for (;;) {
    const got = new Set(batches.flatMap((b) => Object.keys(b.stats))).size;
    if (got >= files) return performance.now() - t0;
    if (performance.now() - t0 > timeoutMs) throw new Error(`stats stalled at ${got}/${files}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

try {
  const tOpen = performance.now();
  const session = await RepoSession.open(await NodeDirHandle.open(work), sink, { id: "perf" });
  const info = await session.info();
  const openMs = performance.now() - tOpen;
  const phases = Object.fromEntries(
    progress
      .filter((p) => p.durationMs !== undefined)
      .map((p) => [p.phase, Math.round(p.durationMs as number)]),
  );
  console.log(`open: ${openMs.toFixed(0)} ms`, phases);

  // ---- history walk (T10.5) -------------------------------------------------------------------
  // First page on the 5,000-file repository (atlas tab 03: "< 100 ms first page"), then the whole
  // `history` fixture with and without its commit-graph — the file tab 20 exists to justify.
  const t4 = performance.now();
  const firstPage = await session.walkCommits({ from: ["HEAD"], firstParent: false, limit: 50 });
  const firstPageMs = performance.now() - t4;
  console.log(
    `perf-5k first page: ${firstPage.commits.length} commits in ${firstPageMs.toFixed(1)} ms (commit-graph ${firstPage.graphAvailable})`,
  );
  budget("history first page of 50 (perf-5k)", firstPageMs, 100, " ms", true);

  // first compute (cold caches) → file list visible
  progress.length = 0;
  const t1 = performance.now();
  const result = await session.computeDiff(defaultDiffSource(info));
  const computeMs = performance.now() - t1;
  const statsMs = await waitStats(result.files.length);
  const progressPerCompute = progress.filter((p) => p.phase !== "stats").length;
  const payload = JSON.stringify(result).length;
  console.log(
    `first compute: ${computeMs.toFixed(0)} ms for ${result.files.length} files; stats ${statsMs.toFixed(0)} ms in ${batches.length} batches; payload ${(payload / 1024).toFixed(0)} kB`,
  );
  budget("progress messages per compute (excl. stats)", progressPerCompute, 4);
  budget("stats batches per compute", batches.length, Math.ceil(result.files.length / 32) + 2);
  budget("DiffResult payload per file", payload / Math.max(1, result.files.length), 400, " B");
  budget("open → file list (cold)", openMs + computeMs, 3000, " ms", true);
  budget("stats for all files", statsMs, 4000, " ms", true);

  // recompute after one edit (warm caches): the stat cache makes this cheap
  batches.length = 0;
  progress.length = 0;
  const editPath = result.files[0]?.newPath ?? "src/f0001.txt";
  const before = session.fs.cacheSize();
  writeFileSync(join(work, editPath), `edited at ${Date.now()}\nline 2\n`);
  await session.invalidate("worktree", [editPath]);
  const afterInvalidate = session.fs.cacheSize();
  const t2 = performance.now();
  const second = await session.computeDiff(defaultDiffSource(info));
  const recomputeMs = performance.now() - t2;
  console.log(
    `recompute after 1 edit: ${recomputeMs.toFixed(0)} ms (${second.files.length} files); handle cache ${before} → ${afterInvalidate}`,
  );
  budget("handle-cache evictions per single-path refresh", before - afterInvalidate, 1);
  budget("recompute after single edit", recomputeMs, 500, " ms", true);
  await waitStats(second.files.length);

  // per-file: hunk model for a 3000-changed-line file (large fixture) via the same path the UI uses
  const large = await RepoSession.open(await NodeDirHandle.open(fixturePath("large")), sink, {
    id: "large",
  });
  const lres = await large.computeDiff(defaultDiffSource(await large.info()));
  const t3 = performance.now();
  const payloadBig = await large.fileDiff(lres.generation, "big-change.txt", {
    ignoreWhitespace: false,
    loadLarge: true,
  });
  const hunkMs = performance.now() - t3;
  console.log(
    `3000-line file: hunks ${payloadBig.hunks?.hunks[0]?.lines.length} lines in ${hunkMs.toFixed(0)} ms, payload ${(JSON.stringify(payloadBig).length / 1024).toFixed(0)} kB`,
  );
  budget("3000-line hunk model", hunkMs, 300, " ms", true);
  await large.close();

  const fullWalk = async (dir: string, id: string) => {
    const s = await RepoSession.open(await NodeDirHandle.open(dir), sink, { id });
    const t = performance.now();
    let cursor: string | null = null;
    let n = 0;
    let graph = false;
    do {
      const page = await s.walkCommits({
        from: [],
        firstParent: false,
        all: true,
        limit: 50,
        ...(cursor === null ? {} : { cursor }),
      });
      n += page.commits.length;
      graph = page.graphAvailable;
      cursor = page.cursor;
    } while (cursor !== null);
    const ms = performance.now() - t;
    await s.close();
    return { ms, n, graph };
  };

  const withGraph = await fullWalk(fixturePath("history"), "history-graph");
  const noGraphDir = mkdtempSync(join(tmpdir(), "diffgit-nograph-"));
  let withoutGraph: { ms: number; n: number; graph: boolean };
  try {
    cpSync(fixturePath("history"), noGraphDir, { recursive: true });
    rmSync(join(noGraphDir, ".git/objects/info/commit-graph"), { force: true });
    withoutGraph = await fullWalk(noGraphDir, "history-nograph");
  } finally {
    rmSync(noGraphDir, { recursive: true, force: true });
  }
  console.log(
    `history full walk --all (${withGraph.n} commits, pages of 50): ` +
      `${withGraph.ms.toFixed(0)} ms with the commit-graph (graphAvailable ${withGraph.graph}), ` +
      `${withoutGraph.ms.toFixed(0)} ms without it (graphAvailable ${withoutGraph.graph})`,
  );
  if (withGraph.n !== withoutGraph.n)
    failures.push("history walk length differs without the graph");

  const m = await session.metrics();
  console.log("metrics:", { ...m, lastCompute: m.lastCompute });
  console.log(
    `memory estimate (pack bytes read): ${(m.memoryEstimate / 1024).toFixed(0)} kB; warnings: ${warnings.map((w) => w.code).join(",") || "none"}`,
  );
  await session.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nperf budgets FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nperf budgets ok");
