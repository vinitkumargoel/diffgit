# Changelog

Entries are per task (3–6 lines: what, notable decisions, follow-ups). Newest first.

## Follow-ups

_(none yet)_

---

## T6.0 — Spike S3 page (observation pending)

- `spikes/s3-observer/index.html`: vanilla page that picks a folder (read or readwrite mode), observes it recursively with `FileSystemObserver`, logs every record (relative ms, burst id at 300 ms gaps, type, path, handle kind, moved-from) and exposes `window.__s3` + Copy JSON for the write-up. Served by the Vite dev server (`vite preview` only serves `dist`).
- The live run needs a human gesture on a native folder dialog; the browser automation available to the agent timed out three times and driving the OS dialog on the owner's desktop unattended was not acceptable. `docs/engine-notes.md` "S3 results" holds the run script, the questions the spike must answer and the provisional answers T6.2 is built on. Board: T6.0 blocked on the owner run.

---

## T3.5 — RepoSession orchestrator + Web Worker entry

- `src/engine/session.ts`: `RepoSession.open(root, sink)` runs config → layout (fatal → public code) → refs → index capabilities, then owns ObjectDb / ignore / attributes / scanner / DiffEngine. `computeDiff` aborts the in-flight compute (superseded call → `CANCELLED`), runs rename detection (`diff.renames`, `diff.renameLimit`), stamps `generation`; `fileStats` / `fileDiff` / `fileBytes(generation, …)` reject `STALE`. Background stats: LIFO queue over 4 workers, `prioritise(ids)` moves visible rows to the front, batches (32 files / 100 ms) go to `sink.onStats`; FileDiff rows are refined in place (stats, binary, sizes, generated). `probe(git|index|untracked)` returns a per-tier signature (untracked tier walks the raw handles so polling sees new files without invalidation) and reports its duration via `Progress`.
- Error translation `toPublicError` (EACCES → PERMISSION, ENOENT → IO_ERROR or HANDLE_GONE when the root handle is unreachable, DOMException NotAllowed/NotFound, internal-tier → INTERNAL); every failure is re-checked against root reachability so a vanished folder never surfaces as REF_NOT_FOUND. ENOENT mid-compute → drop caches, `invalidate("all")`, retry once, `STALE_PACK_RETRIED`.
- `src/engine/workerApi.ts` (`createEngineApi`, plain-object rejections), `src/engine/worker.ts` (`import "./bufferPolyfill"` first — isomorphic-git needs a global `Buffer` — then `Comlink.expose`). Standalone Vite build of the worker entry: 341 kB / 110 kB gzip, no E2E marker, comlink + buffer included. Deps added (exact): `comlink 4.4.2`, `buffer 6.0.3`.
- `bun run record` (`scripts/record-fixtures.ts`) writes `src/test/recorded/{basic,worktree}.{repoinfo,diffresult}.json` with stats and fixed timestamps for the UI mock. Decision: `DiffResult.totals` additions/deletions are 0 at return time and accumulate from `onStats` batches (the recorded JSON carries the final totals).
- Tests (12): open/compute/stats/fileDiff/fileBytes/STALE on `worktree`, image/binary payloads on `binary`, renamed content, overlapping computes, layout fatals (`OBJECT_FORMAT_SHA256`, `NOT_A_REPO`), memory-repo mutations (invalidate → change seen, pack swap, forced ENOENT retry, root gone → HANDLE_GONE), probe tiers + `perf-5k` timings (git 2 ms / index 20 ms / untracked 85 ms logged; strict under `PERF_STRICT`), and comlink over a real `MessageChannel` (errors arrive as plain `{code}` objects).

---

## T3.4 — Binary/attributes, content loading, text diff & classification

- `src/engine/git/attributes.ts`: `.gitattributes` per directory + `.git/info/attributes` (git precedence), macros (`binary`, `[attr]`), quoted patterns, own gitignore-glob → RegExp (`**`, classes incl. POSIX, no negation, directory patterns never match contents). `isBinary` = `-diff`/`-text`; `isGenerated` = `linguist-generated` or `-diff`.
- `src/engine/diff/binary.ts` (NUL in first 8000 bytes, `isImagePath`), `contentLoader.ts` (`loadSides` via the T3.2 side table; gitlinks → `kind: "submodule"` with both oids), `language.ts` (~110 extensions/filenames → highlighter ids), `myers.ts` (linear-space Myers on interned line keys with a step budget; 3000 fully changed lines in ~60 ms vs 2.7 s with jsdiff, which is why jsdiff is not used for the hunk model), `textDiff.ts` (`computeStats`, `computeHunks`, `describeFile` → classification + hunks + texts + stats + `FILE_TOO_LARGE`, `toPayload`).
- `-w` = remove all ASCII whitespace per line (and ignore a missing final newline); `whitespaceOnly` computed by running both views when the exact diff is non-empty. Limits per §6.7: > 1 MB or > 3000 changed lines → `tooLarge` (hunks only with `loadLarge`), > 10 MB → `huge`, stats only when one-sided. Submodules render `Subproject commit <oid>` lines so numstat matches git (1/1).
- Parity: numstat and numstat -w on all 21 fixtures with a feature branch (attributes `-`, binary `-`, symlink typechange, crlf, large incl. 200000-line huge file). Hunk model unit-tested (context merge at ≤ 2×context, line numbers, empty sides); Myers verified minimal against an LCS oracle on 300 random cases.

---

## T3.3 — Rename detection

- `src/engine/diff/renames.ts`: `detectRenames(files, load, opts)` → `{ files, warnings, stats }`. Exact pass pairs identical oids (prefers an unused source with the same basename, then the nearest directory; non-regular modes must match, like git). Similarity pass is git's spanhash (`diffcore-delta.c`: chunks at `\n` or 64 bytes, git's rolling hash, byte counts, `score = copied*60000/max_size` then `*100/60000`), greedy best-first with git's tiebreaks; git's size pre-filter at the threshold; CR before LF ignored for text sides. `src/engine/diff/binary.ts` holds the NUL sniff (first 8000 bytes) that T3.4 extends with attributes.
- Limits follow the amendment: similarity pass only when `renameLimit² ≥ |D|×|A|` (default 1000, `diff.renameLimit` via `opts.limit`), otherwise `RENAME_LIMIT`; `opts.maxSideBytes` (8 MB) skips oversized sides with a `RENAME_LIMIT` warning (`detail: "maxSideBytes"`). Untracked sides without an oid are hashed lazily for the exact pass.
- Renamed entries: `id = newPath`, layers = union in canonical order; old content lives at `sides[oldPath]`, new at `sides[newPath]`.
- Decision: returns a result object instead of the spec's bare `FileDiff[]` so the warning can travel with the files. Parity: all 21 fixtures with a feature branch match `git diff -M --name-status`; the `renames` fixture's partial rename scores exactly R058 (no deviation); ~50–75 ms on that fixture (strict < 200 ms).

---

## T3.2 — Diff engine (merge-base compare + worktree layering)

- `src/engine/diff/diffEngine.ts`: `DiffEngine.compute(src, signal)` resolves refs ("HEAD" → headOid, `refs/heads/*`, `refs/remotes/*`), takes `merge-base --all` (first base wins; `MULTIPLE_MERGE_BASES` with all oids in `detail`), falls back to two-dot with `UNRELATED_HISTORIES` (or `SHALLOW` when the repo is shallow), diffs the flattened trees and layers staged/unstaged/untracked/conflict changes from `WorktreeScanner` when the source is the checked-out branch (`isWorktreeSource`); otherwise emits `WORKTREE_NOT_APPLICABLE` and stays committed-only.
- Elimination: a path whose final new side equals the base (oid + mode) is dropped, so committed changes reverted in the worktree disappear like git. Output also carries a `sides` table (old/new oid, mode, kind tree|index|worktree|untracked, size) so T3.4 knows where to load content from.
- `SPLIT_INDEX` / `INDEX_TOO_LARGE` from the index reader downgrade to a warning and a committed-only result instead of failing; `REF_NOT_FOUND` for unknown refs; aborted signal → `CANCELLED`.
- Tests (17): name-status parity on basic/packed/remote/unrelated/crisscross (crisscross verified against `git diff <all[0]> feature` at test time), full layer check on the `worktree` fixture (10 files, `reverted.txt` eliminated, `script.sh` mode change staged), unborn, detached, conflict, same-branch dirty tree, split index, cancellation. Shared rig in `src/test/engineRig.ts`.

---

## T3.1 — Tree diff

- `src/engine/diff/treeDiff.ts`: `treeDiff(a, b)` over flattened trees (null = empty) → `Record<path, Change>` in git's byte-wise order; added/deleted/modified where modified includes mode-only and type changes (symlink↔file, gitlink oid change) for T3.4 to label. `comparePaths` exported for reuse.
- Parity with `name-status-3dot-no-renames.json` on basic, renames, binary, symlink (git's `T` mapped to our modified + both modes), submodule (160000), attributes, large; pure-function edge cases and ordering (`a-b` < `a/b` < `a0`).

## T2.4 — WorktreeScanner

- `src/engine/git/worktree.ts`: `WorktreeScanner(fs, db, cfg, ignore, opts).scan(index, headTree, signal) → WorktreeStatus { staged, unstaged, untracked, untrackedInfo, conflicts, warnings, stats }`, `forgetStatCache()` (force refresh: clears cache + one-shot hash-all), `forgetPaths()`. Implements the amended algorithm: `SPLIT_INDEX`/`INDEX_TOO_LARGE` thrown first; staged pass over stage-0 ∪ HEAD minus conflicts/sparse subtrees (intent-to-add = not staged); unstaged pass with cache-first → git's racy-clean rule (`lastModified >= indexMtimeMs` → hash) → stat-clean → hash (stream > 8 MB), symlinks/gitlinks always clean, ENOENT → deleted, EISDIR → deleted + `PATH_TYPE_CHANGED`; untracked DFS with ignore pruning, `.git`-of-either-kind → `EMBEDDED_REPO`, gitlink/sparse dirs skipped, cap → `UNTRACKED_CAPPED`, files ≤ 1 MB hashed into `untrackedInfo`; warnings `INDEX_CHECKSUM`, `SPARSE_INDEX`, `AUTOCRLF`; `AbortSignal` → `CANCELLED`. `Change` gained optional `newSize`/`newLastModified` for viewed keys.
- Perf: the untracked walk runs first and `FsaFs.readdirWithKinds` now caches the child handles it iterates, so per-entry `openFile` skips a lookup; `NodeDirHandle.entries()` uses dirent types (stat only for symlinks). `perf-5k` clean scan: best 512 ms in bun (budget 800 ms), but 0.9–1.9 s while the UI-track agent was building on the same machine — asserted only under `PERF_STRICT=1`.
- Parity with `status-porcelain-v2.json` on worktree (all documented cases incl. mode change staged-only and the reverted file), index-v3 (intent-to-add → unstaged added), index-v4, symlink, basic, detached, attributes, conflict (no staged-deleted), unborn (headTree null), submodule (gitlink clean, dir not walked), embedded (pruned + warning), ignore (spy: `node_modules`/`build` never opened); plus stat-cache reuse, racy-clean detection, the documented R1 miss fixed by force refresh and sticking afterwards, cancellation, caps, checksum/sparse warnings, large-untracked oid null.
- Note for the Chrome run (T6.0/T7.2): the stat-clean check compares integer milliseconds; if `File.lastModified` rounds where git floors, the first scan hashes more and the cache absorbs it afterwards.

## T2.3 — Ignore rules

- `src/engine/git/ignoreRules.ts`: `IgnoreRules.load(fs, { builtinExcludes, config })`, `enterDir`, `ensureAncestors`, `isDirIgnored` (memoised, ancestors first → the walker prunes before descending), `isFileIgnored`, async `isPathIgnored`, `invalidate`/`reload`. One `ignore()` instance per `.gitignore`, evaluated on paths relative to its directory; deepest file with a verdict wins; `.git/info/exclude` below all files; built-ins (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) lowest and toggleable; a path under an ignored directory is never re-included. `core.ignorecase` respected (the `ignore` package defaults to case-insensitive, so it is passed explicitly). `core.excludesFile` → one `GLOBAL_EXCLUDES_UNAVAILABLE` warning.
- Tests: parity with `check-ignore.json` (13 probes incl. negation `!keep.log`, `info/exclude`, dir probes) with built-ins off; spy proves `node_modules` is never opened; unit tests for anchored vs unanchored re-rooting, `**`, dir-only patterns, escaped `#`, negation precedence, exclude/builtin ordering, ignorecase, warning, reload.

## T2.1 — IndexReader

- `src/engine/git/indexReader.ts`: `parseIndex(bytes, indexMtimeMs)` (pure) and `readIndex(fs)`. Formats 2/3/4 (v4 prefix compression via git's offset varint), extended flags (skip-worktree, intent-to-add), stage bits → `conflicts` grouped per path with `byPath` holding stage-0 only, sparse-dir entries (trailing `/` stripped, `isSparseDir`, sets `hasSparseIndex`), extension signatures recorded (`link` → `hasSplitIndex`, `sdir` → `hasSparseIndex`), trailer SHA-1 verified → `checksumOk`, `indexMtimeMs` captured, `tooLarge` above 200k entries. Unknown version / bad signature / truncated → `INDEX_UNSUPPORTED`.
- `readIndex`: missing file → empty snapshot (fresh `git init`); bad checksum, truncated or vanished (`index.lock` rename window) → one retry after 150 ms, then the last read is returned with `checksumOk=false` for the caller to warn (`INDEX_CHECKSUM`).
- Tests: byte-level builder for v2 (stages, assume-valid, padding, all modes), v3 (extended flags + TREE/REUC/UNTR), v4 (shared prefixes, `sdir`/`link`, sparse dirs), corrupt trailer, unsupported/truncated inputs, 200,001-entry `tooLarge`; fixture parity with `ls-files-s.json` on basic, worktree, index-v3 (intent-to-add), index-v4, conflict, unborn, symlink, submodule; torn-read retry with the memory fs; `perf-5k` parse = 28 ms (budget 50 ms).

## T2.2 — Blob hashing

- `src/engine/git/hash.ts`: `sha1`, `toHex`, `hashBlob` (crypto.subtle over `"blob <len>\0"+bytes`), `hashBlobStream(stream, size)` (incremental pure-JS `Sha1` class, ~90 lines, written here — `crypto.subtle.digest` cannot stream), `EMPTY_BLOB_OID`.
- Tests: `hash-object.json` parity on `basic` and `large` (incl. the 1.5 MB and 11 MB files), stream vs buffer equality on the 11 MB file, pure-JS vs subtle on awkward chunk boundaries and padding-edge lengths, subarray views, size mismatch rejection.

## T1.6 — Spike S2: read-only verification on real repos

- `scripts/spike-s2.ts` runs layout → config → refs → merge-base → flattenTree ×2 → readBlob ×20 through the read-only spy handle, times every step, counts fs calls, and applies three zero-write proofs (no write-capable call, `find .git -newer marker -type f` empty, `git status`/`git fsck --connectivity-only` identical before and after). Exit 1 on any violation.
- Ran on pinpoint (small), news-scrapper (13 packs, 72 MB, `node_modules`, 270 refs, has a multi-pack-index) and a scratchpad copy of opencode after `git gc` + `git multi-pack-index write` (shallow); plus the `sha256`/`alternates`/`partial` fixtures. All reads succeeded, zero writes everywhere, refusals fire before any object read. Full table in `docs/engine-notes.md` ("S2 results").
- Decision: multi-pack-index repos are supported (isomorphic-git reads the `.idx` files directly); `MULTI_PACK_INDEX` stays a warning. Note for T7.2: first-touch pack SHA-1 verification dominates (≈ 0.5 s for 72 MB across 13 packs).
- The owner did not pre-name repos (START.md §4), so the agent picked three on disk; only the copy was modified (in the scratchpad). No follow-up changes to T1.1–T1.4 were needed.

## T1.4 — RefStore

- `src/engine/git/refStore.ts`: `loadRefs(db, config) → RefSnapshot { headBranch, headOid, detached, unborn, headDisplay, refs, defaultRef }`. HEAD via `readSymref("HEAD")` (branch → resolve; unresolvable → unborn) or `resolveRef("HEAD")` (detached). Branches: local + every remote from config, `HEAD` pseudo-entry excluded, dangling refs skipped. Default per D8: `origin/HEAD` symref → `origin/<x>` or local `<x>` → `main` → `master` → checked-out branch → null. Sort: synthetic, checked-out, default, locals A→Z, remotes grouped by remote then A→Z.
- Synthetic entry `{ name: headDisplay, fullName: "HEAD", isCheckedOut: true, synthetic: true }` only when detached/unborn; `headDisplay` = `main` / `HEAD (detached @ ab12cd3)` / `HEAD (no commits)`.
- `src/engine/diffSource.ts` (landed in T0.1) is now covered: `defaultDiffSource` and the `isWorktreeSource` truth table, incl. detached/unborn/`rebase-detached` producing a usable `sourceRef: "HEAD"` default.
- Parity with `refs.json` on basic, packed, remote, remote-master, no-origin-head (`main` beats `master`), detached, unborn, rebase-detached, conflict; sort-order snapshot on `remote`.

## T1.3 — ObjectDb

- `src/engine/git/objectDb.ts`: isomorphic-git wrapper with one session `cache`; `resolveRef` (oids pass through; `REF_NOT_FOUND` otherwise), `tryResolveRef`, `readSymref` (raw loose-file read; `origin/HEAD` lives only there), `listLocalBranches`, `listRemoteBranches` (drops the `HEAD` pseudo-entry), `readCommit`, `readBlob`, `findMergeBase` → `{ oid: all[0], all }` (unrelated or missing ancestors → `{ null, [] }`, never throws), `flattenTree` (recursive `readTree`, concurrent per level, bytewise-sorted, memoised per oid), `dropCaches(includePacks)`.
- Stale-pack retry: object reads that fail with isomorphic-git's "Could not read packfile"/trailer-mismatch errors (or ENOENT/EIO naming a `.pack`/`.idx`) drop the pack cache + `.git/objects` handle cache, retry once and emit `STALE_PACK_RETRIED` through an optional `onWarning` sink.
- Parity: `refs.json` on basic/packed/remote, `merge-base.json` on basic/packed/remote, `unrelated` → null, `crisscross` → both bases from `merge-base-all.json` (we keep `all[0]`; git's single pick happened to match in this fixture), synthetic shallow (loose parent objects removed + `.git/shallow`), `ls-tree.json` on basic/packed/symlink/submodule (120000/160000/100755 modes), blob bytes vs disk from the delta pack, spy-based zero-write check.
- Measured: `flattenTree` of `perf-5k` tip (5,000 entries, packed) = 31–144 ms in bun (budget 400 ms) with recursive `readTree`; `git.walk(TREE)` was not needed.
- Fixture tooling fix: the expectations script now passes large `ls-tree` JSON through temp files (`--slurpfile`) — `--argjson` blew the argv limit on `perf-5k`.

## T1.2 — Layout checks

- `src/engine/git/layoutChecks.ts`: `checkLayout(fs, config, opts?) → LayoutReport { ok, fatal?, capabilities, warnings, packBytes }`. Fatal codes: `NOT_A_REPO`, `WORKTREE_GITDIR` (`.git` file with `gitdir:`), `BARE_REPO` (HEAD+objects+refs at root), `REFTABLE` (dir, `refs/heads` file, or `extensions.refStorage`), `OBJECT_FORMAT_SHA256`, `ALTERNATES`, `PARTIAL_CLONE` (`extensions.partialClone`, `remote.*.promisor`, or `*.promisor` packs), `PACK_TOO_LARGE` (> 1 GB). Warnings: `PACK_LARGE` (> 300 MB), `MULTI_PACK_INDEX`, `SHALLOW`, `LFS_PRESENT`, `AUTOCRLF`. Each fatal carries user copy + hint.
- Only `EACCES` escapes (as `EngineError("PERMISSION")`); every other I/O failure is treated as "absent". Thresholds are injectable for tests. `loadGitConfig` now tolerates `.git` being a file.
- Tests: fixtures `basic`/`packed` ok, `worktree-gitdir`, `sha256`, `alternates`, `partial`, `crlf`; synthetic bare / reftable / partial variants / pack thresholds / MIDX+shallow+LFS / permission escalation.
- Decision: `AUTOCRLF` is emitted here at repo level; `RepoSession` (T3.5) de-duplicates warnings by code so the scanner's copy does not double up.

## T1.5 — Git config parser

- `src/engine/git/config.ts`: `parseGitConfig(text)` / `loadGitConfig(fs)` → `GitConfig { remotes, remoteUrls, core, diff, extensions, raw, warnings, get() }`. Handles `[s]`, `[s "sub"]` (escapes), deprecated `[s.sub]`, bare keys (=true), `#`/`;` comments outside quotes, quoted values with `\" \\ \n \t \b`, `\` continuations; section/key names lower-cased, subsections case-sensitive. `include`/`includeIf` skipped with one `CONFIG_INCLUDE_SKIPPED` warning. Missing `.git/config` → empty config.
- Also exposes `extensions.{objectFormat,partialClone,refStorage}` and generic `get(section,key,sub)` for T1.2's promisor/partial-clone checks. Parser is ~120 lines of logic (182 with types/comments).
- Tests: every syntax rule, `crlf` → `autocrlf: "true"`, `remote` → `["origin"]`, `partial`/`sha256` fixtures, missing file.

## T1.1 — FsaFs read-only adapter

- `src/engine/fs/fsaFs.ts`: `createFsaFs(root)` → `{ promises, openFile, readdirWithKinds, getDirHandle, readFile, readText, stat, exists, invalidatePath, invalidateAll, cacheSize }`. `promises` covers everything isomorphic-git binds (`readFile/readdir/stat/lstat/readlink` + `writeFile/unlink/mkdir/rmdir/rm/symlink/chmod/rename`, the latter all throwing `EROFS` before any I/O). `dir` is always `"/"`; paths are normalised to repo-relative POSIX.
- Error mapping: NotFoundError→ENOENT, TypeMismatchError→ENOTDIR (dir expected or intermediate segment) / EISDIR, NotAllowedError/SecurityError→EACCES, TypeError→EINVAL, else EIO; `..`→EINVAL; `readlink`→EINVAL. Semantics follow Node (`readdir("file/x")` is ENOTDIR).
- Handle cache per path with in-flight de-duplication, cap 20k (clear-all beyond), `invalidatePath` drops the subtree; NotFound/TypeMismatch on a cached handle evicts and retries once (kind changes file↔dir are handled).
- Tests (`fsaFs.test.ts`, 16) incl. the D16 invariant with `src/test/spyHandle.ts` (a Proxy wrapper exposing only read methods, counting calls and any options argument) and isomorphic-git `resolveRef` on `basic` and `packed`. Note: isomorphic-git probes promise-fs support by calling `readFile()` with no args, so `readFile` must reject rather than throw synchronously.
- Finding for T3.5: isomorphic-git's ESM build uses a global `Buffer` (and `sha.js` → `safe-buffer` → `buffer`); the worker must install the `buffer` polyfill as `globalThis.Buffer`.

## T0.2 — Cloudflare Pages pipeline

- `wrangler.toml` (`pages_build_output_dir = "dist"`), `public/_headers` (CSP + nosniff, no-referrer, Permissions-Policy, COOP), `public/_redirects` SPA rule, `bun run deploy`, `scripts/check-prod.sh` (CSP identical to the file, security headers, no Cloudflare-injected scripts, deep link 200; GET with retries), `docs/deploy.md`.
- Project `diffgoel` created on classic Pages (`--force` was needed once because wrangler 4.132 delegates `pages project create` to Workers and fails without an entry point). Hello-world deployed: https://diffgoel.pages.dev — `scripts/check-prod.sh https://diffgoel.pages.dev` passes all six checks.
- Custom domain `diff.vinitk.dev` registered on the project via the Pages API (wrangler 4.x has no `pages domain` command). Status `pending: CNAME record not set` — the wrangler OAuth token only has `zone:read`, so the CNAME must be added by the owner (dashboard "Set up a custom domain" or a DNS record `diff → diffgoel.pages.dev`, proxied). Everything else in this task is done; the two domain ACs are ticked once DNS exists.
- Edge-injection settings (Web Analytics, Rocket Loader, Email Obfuscation, Auto Minify, Mirage/Polish, Zaraz) documented in `docs/deploy.md`; the served HTML currently contains none of their markers.

## T0.4 — Test harness

- `src/engine/fs/dirHandleLike.ts` (structural FSA view + `handleError`/`isHandleError` with browser error names), `nodeDirHandle.ts` (test-only; follows symlinks like Chrome, integer `lastModified`, dangling links invisible), `memoryDirHandle.ts` (`MemoryFs` + handles that see later mutations; `Mutation` ops write/remove/touch/rename/mkdir/dropRoot; base64 snapshots).
- Node-only snapshot helpers live in `src/test/memorySnapshot.ts` (`snapshotFromDisk`, `toInitScript`, `fromInitScript`) so the engine file stays free of `node:` imports; `src/test/torn.ts` (T0.3 amendment) provides `truncateIndex`/`restoreIndex`/`swapPack`/`dropRoot` mutations.
- E2E transport per amendment: `e2e/fsaShim.ts` (`installFsaShim` for `addInitScript`: marker-returning `showDirectoryPicker`, snapshot server, `window.__diffgoel.{mutate,listRoot,emitObserverRecords,setPick}`, `FileSystemObserver` stub); engine side `src/engine/e2e/{protocol,memoryChannel}.ts` and `src/engine/fs/resolveHandle.ts` behind `import.meta.env.VITE_E2E === "1"`. Verified the production bundle contains no `diffgoel-e2e` string (tree-shaken).
- `playwright.config.ts` (Chromium only, `VITE_E2E=1` build + `vite preview` web server, trace on first retry). Browsers are installed in T7.1. Per the E2E policy (only T7.1's three specs may exist), the shim/rehydration/mutation AC is proven here by `resolveHandle.test.ts` running the real `BroadcastChannel` RPC in Bun; the browser run happens inside T7.1 spec 2/3.
- Guards added to `scripts/check-guards.sh`: no `instanceof FileSystem*` in `src/engine`, D16 grep (`createWritable`, `removeEntry`, `.move(`, `create: true`, `"readwrite"`) over `src/`.

## T0.3 — Fixture builder

- `scripts/make-fixtures.sh` builds 27 fixtures (+ `perf-5k` with `FIXTURES_PERF=1`) with the real git CLI in ~6 s; idempotent (`rm -rf fixtures/` first) and deterministic (fixed identity/dates, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; the script compares `basic/feature` before/after and fails on drift). Verified twice: `d77b2f48…` both runs.
- `scripts/fixture-expectations.sh` dumps `expected/*.json` per fixture via `jq` (`-z` output parsed for name-status/numstat so paths are safe): refs, ls-files -s, status porcelain v2, merge-base (+ `--all`), name-status 3-dot (±renames), numstat (±`-w`), ls-tree for base/tips, worktree-layer, meta, hash-object (basic/packed/large), check-ignore (ignore). `jq` is required (present on macOS dev box and ubuntu runners) — no `.txt` fallback.
- `expected/` sits inside each worktree, so the script appends `expected/` to that repo's `info/exclude` (via `git rev-parse --git-path`, correct for the linked worktree too) — git and the engine both ignore it, keeping status parity intact.
- Decisions: `renames` similar pair scores R058 in git (spec said ~60 %; parity tests read git's number). `unrelated` records a two-dot `main feature` range in `meta.diffRange`, matching T3.2's fallback. `remote`/`remote-master` check out `feature`; `no-origin-head` checks out `main`. `_remotes/` holds local bare origins; `_worktree-main/` backs `worktree-gitdir`.
- `src/test/fixtures.ts`: `fixturePath`, `hasFixture`, `loadExpected<T>` + typed shapes of every expected file. `.github/workflows/ci.yml` runs `bun run fixtures` before `bun run check`. Biome config migrated to the 2.x `preset: "recommended"` form.

## T0.1 — Repo & toolchain

- Bun project with Vite 7.3.6, React 19.3.0, TypeScript 5.9.3, Tailwind 4.3.3 (`@tailwindcss/vite`), Biome 2.5.14, vitest 4.1.11 + happy-dom 20.14.5; all versions pinned exactly (no `^`).
- Solution-style tsconfig: `tsconfig.ui.json` (DOM), `tsconfig.engine.json` (WebWorker only, excludes tests and `nodeDirHandle.ts`), `tsconfig.node.json` (bun types; scripts, tests, vite/playwright config). Verified: `document` in `src/engine` fails `tsc -b`; `importScripts` in `src/ui` fails; `self.postMessage` passes in the engine (note: it also type-checks under DOM because `Window.postMessage` exists, so the UI-side guard is demonstrated with a worker-only global).
- `src/engine/errors.ts` canonical registry (`FS_CODES`, `PUBLIC_CODES`, `INTERNAL_CODES`, `WARNING_CODES`, `EngineError`, `fsError`), `src/engine/types.ts` from Plan §4 + amendments (`sourceRef/targetRef`, `generation`, `RefSnapshot`, `synthetic`, `generated`), `src/engine/diffSource.ts` implemented (pure, tiny) rather than stubbed so the UI track can use it before T1.4 tests it.
- `vite.config.ts` parses `public/_headers` into `preview.headers` (production CSP under `vite preview`); worker format `es`, build target `es2022`; vitest scoped to `src/ui/**`, `bun test` to `src/engine` + `src/test`.
- `scripts/check-guards.sh` starts the grep guards (engine must not import react/ui); later tasks append theirs. `PATH_TYPE_CHANGED` added to `WARNING_CODES` because T2.4 emits it.
- Decision: Vite 7 (per Plan §7) with `@vitejs/plugin-react` 5.2.0 (6.x requires Vite 8); vitest 4.1.11 (5.x targets Vite 8 too).
