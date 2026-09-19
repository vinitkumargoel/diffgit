/** Shared engine wiring for Phase 3 tests (Node/Bun only). */

import { DiffEngine } from "../engine/diff/diffEngine";
import type { DirHandleLike } from "../engine/fs/dirHandleLike";
import { createFsaFs, type FsaFs } from "../engine/fs/fsaFs";
import { NodeDirHandle } from "../engine/fs/nodeDirHandle";
import { type GitConfig, loadGitConfig } from "../engine/git/config";
import { IgnoreRules } from "../engine/git/ignoreRules";
import { type IndexSnapshot, readIndex } from "../engine/git/indexReader";
import { ObjectDb } from "../engine/git/objectDb";
import { loadRefs } from "../engine/git/refStore";
import { WorktreeScanner } from "../engine/git/worktree";
import type { BranchesSource, RefSnapshot } from "../engine/types";
import { fixturePath } from "./fixtures";

export interface EngineRig {
  fs: FsaFs;
  db: ObjectDb;
  cfg: GitConfig;
  refs: RefSnapshot;
  ignore: IgnoreRules;
  scanner: WorktreeScanner;
  engine: DiffEngine;
  readIndex: () => Promise<IndexSnapshot>;
  /** DiffSource for `<source> vs <target>` by display name ("feature", "main", "origin/main", "HEAD"). */
  source(source: string, target: string, includeWorktree?: boolean): BranchesSource;
}

export async function openEngine(
  rootOrFixture: string | DirHandleLike,
  opts: { shallow?: boolean; readIndex?: () => Promise<IndexSnapshot> } = {},
): Promise<EngineRig> {
  const root =
    typeof rootOrFixture === "string"
      ? await NodeDirHandle.open(fixturePath(rootOrFixture))
      : rootOrFixture;
  const fs = createFsaFs(root);
  const cfg = await loadGitConfig(fs);
  const db = new ObjectDb(fs);
  const refs = await loadRefs(db, cfg);
  const ignore = await IgnoreRules.load(fs, { builtinExcludes: false, config: cfg });
  const scanner = new WorktreeScanner(fs, db, cfg, ignore);
  const read = opts.readIndex ?? (() => readIndex(fs));
  const engine = new DiffEngine(db, refs, scanner, read, { shallow: opts.shallow ?? false });
  const fullName = (name: string): string => {
    if (name === "HEAD") return "HEAD";
    const r = refs.refs.find((x) => x.name === name && !x.synthetic);
    if (!r) throw new Error(`no ref named ${name} in fixture`);
    return r.fullName;
  };
  return {
    fs,
    db,
    cfg,
    refs,
    ignore,
    scanner,
    engine,
    readIndex: read,
    source: (source, target, includeWorktree = true) => ({
      kind: "branches",
      source,
      target,
      sourceRef: fullName(source),
      targetRef: fullName(target),
      includeWorktree,
    }),
  };
}
