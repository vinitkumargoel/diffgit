# Changelog

Entries are per task (3–6 lines: what, notable decisions, follow-ups). Newest first.

## Follow-ups

_(none yet)_

---

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
