/**
 * Spike S2 (T1.6): run the Phase 1 stack against real repositories through a call-logging handle
 * and prove zero writes. Usage: `bun scripts/spike-s2.ts <repo-dir> [<repo-dir> ...]`
 * Exit code 1 if any write-capable call was observed or the mtime proof finds modified .git files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFsaFs } from "../src/engine/fs/fsaFs";
import { NodeDirHandle } from "../src/engine/fs/nodeDirHandle";
import { loadGitConfig } from "../src/engine/git/config";
import { checkLayout } from "../src/engine/git/layoutChecks";
import { ObjectDb } from "../src/engine/git/objectDb";
import { loadRefs } from "../src/engine/git/refStore";
import { spyHandle } from "../src/test/spyHandle";

function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    return `ERROR: ${(e as { stderr?: string }).stderr ?? String(e)}`;
  }
}

function fmt(ms: number): string {
  return `${ms.toFixed(0)} ms`;
}

interface Row {
  repo: string;
  gitDirKb: number;
  packs: number;
  packMb: number;
  indexEntries: number;
  timings: Record<string, number>;
  calls: Record<string, number>;
  refused?: string;
  warnings: string[];
  failure?: string;
  writes: number;
  changedFiles: string[];
  statusSame: boolean;
  fsckSame: boolean;
}

async function run(dir: string): Promise<Row> {
  const repo = resolve(dir);
  const scratch = mkdtempSync(join(tmpdir(), "spike-s2-"));
  const marker = join(scratch, "marker");
  const statusBefore = git(repo, ["status", "--porcelain=v2", "--untracked-files=all"]);
  const fsckBefore = git(repo, ["fsck", "--no-progress", "--connectivity-only"]);
  writeFileSync(marker, "");
  await new Promise((r) => setTimeout(r, 1100)); // mtime resolution guard

  const row: Row = {
    repo,
    gitDirKb:
      Number(git(repo, ["count-objects", "-v"]).match(/size-pack: (\d+)/)?.[1] ?? 0) +
      Number(git(repo, ["count-objects", "-v"]).match(/^size: (\d+)/m)?.[1] ?? 0),
    packs: Number(git(repo, ["count-objects", "-v"]).match(/packs: (\d+)/)?.[1] ?? 0),
    packMb: Math.round(
      Number(git(repo, ["count-objects", "-v"]).match(/size-pack: (\d+)/)?.[1] ?? 0) / 1024,
    ),
    indexEntries: git(repo, ["ls-files"]).split("\n").filter(Boolean).length,
    timings: {},
    calls: {},
    warnings: [],
    writes: 0,
    changedFiles: [],
    statusSame: false,
    fsckSame: false,
  };

  const spy = spyHandle(await NodeDirHandle.open(repo));
  const fs = createFsaFs(spy);
  const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      row.timings[name] = performance.now() - t0;
    }
  };

  try {
    const config = await time("config", () => loadGitConfig(fs));
    const layout = await time("layout", () => checkLayout(fs, config));
    row.warnings.push(...layout.warnings.map((w) => w.code));
    if (!layout.ok) {
      row.refused = layout.fatal?.code;
    } else {
      const db = new ObjectDb(fs, (w) => row.warnings.push(w.code));
      const refs = await time("refs", () => loadRefs(db, config));
      const head = refs.headOid;
      const def = refs.defaultRef?.oid ?? head;
      if (head && def) {
        const mb = await time("merge-base", () => db.findMergeBase(def, head));
        const trees = await time("flattenTree x2", async () => [
          await db.flattenTree(head),
          await db.flattenTree(mb.oid ?? def),
        ]);
        const entries = Object.entries(
          trees[0] as Record<string, { oid: string; mode: number }>,
        ).filter(([, e]) => e.mode !== 0o160000);
        const picks = entries
          .filter((_, i) => i % Math.max(1, Math.floor(entries.length / 20)) === 0)
          .slice(0, 20);
        let bytes = 0;
        await time("readBlob x20", async () => {
          for (const [, e] of picks) bytes += (await db.readBlob(e.oid)).byteLength;
        });
        row.timings["blob bytes"] = bytes;
        row.calls.treeEntries = entries.length;
        row.calls.branches = refs.refs.length;
      } else {
        row.failure = "no HEAD commit (unborn)";
      }
    }
  } catch (e) {
    row.failure = `${(e as { code?: string }).code ?? ""} ${(e as Error).message}`;
  }

  row.calls = {
    ...row.calls,
    ...spy.counts,
    unknownAccess: spy.counts.unknownAccess.length,
  } as Record<string, number>;
  row.writes = spy.counts.optionsPassed + spy.counts.unknownAccess.length;

  // zero-write proofs
  const changed = existsSync(join(repo, ".git"))
    ? execFileSync("find", [join(repo, ".git"), "-newer", marker, "-type", "f"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean)
    : [];
  row.changedFiles = changed;
  row.statusSame =
    statusBefore === git(repo, ["status", "--porcelain=v2", "--untracked-files=all"]);
  row.fsckSame = fsckBefore === git(repo, ["fsck", "--no-progress", "--connectivity-only"]);
  return row;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun scripts/spike-s2.ts <repo-dir> [...]");
  process.exit(2);
}
let failed = false;
for (const dir of dirs) {
  const row = await run(dir);
  console.log(`\n== ${row.repo}`);
  console.log(
    `   .git objects: ${(row.gitDirKb / 1024).toFixed(1)} MB in ${row.packs} pack(s) (${row.packMb} MB packed); index entries: ${row.indexEntries}`,
  );
  if (row.refused) console.log(`   REFUSED by layout check: ${row.refused}`);
  if (row.failure) console.log(`   FAILURE: ${row.failure}`);
  for (const [k, v] of Object.entries(row.timings))
    console.log(`   ${k.padEnd(16)} ${k === "blob bytes" ? `${v} B` : fmt(v)}`);
  console.log(`   calls: ${JSON.stringify(row.calls)}`);
  if (row.warnings.length) console.log(`   warnings: ${row.warnings.join(", ")}`);
  console.log(
    `   write-capable calls: ${row.writes}   .git files newer than marker: ${row.changedFiles.length}   status identical: ${row.statusSame}   fsck identical: ${row.fsckSame}`,
  );
  if (row.changedFiles.length) console.log(`   changed: ${row.changedFiles.join(", ")}`);
  if (row.writes > 0 || row.changedFiles.length > 0 || !row.statusSame || !row.fsckSame)
    failed = true;
}
process.exit(failed ? 1 : 0);
