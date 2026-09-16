# Engine notes

Findings from the spikes that gate later phases. Keep this file factual: numbers, commands, decisions.

## S2 repos

Chosen on the dev machine (2026-09-16). The third is a **copy** in the session scratchpad so `git gc` and
`git multi-pack-index write` never touched a real checkout.

| Role | Path | Notes |
|---|---|---|
| small | `/Users/homepc/Official/work/personal/pinpoint` | 103 tracked files, 2 packs (1 MB) |
| medium, `node_modules` | `/Users/homepc/Official/work/antigravity/news-scrapper` | 3,840 tracked files, 13 packs (72 MB), 270 refs, already has a `multi-pack-index` |
| after `git gc` + MIDX | scratchpad `midx-copy` (copy of `/Users/homepc/Official/work/antigravity/opencode`) | 6,348 tracked files, 2 packs (76 MB), shallow clone, `multi-pack-index` written on the copy |

## S2 results (T1.6) — `bun scripts/spike-s2.ts <repo>...`

The script wraps `NodeDirHandle` in the read-only spy (`src/test/spyHandle.ts`), runs layout →
config → refs → merge-base(default, HEAD) → `flattenTree` of both → 20 `readBlob`s, and then checks
three zero-write proofs: no write-capable call reached a handle, `find .git -newer marker -type f`
prints nothing, and `git status --porcelain=v2` + `git fsck --connectivity-only` are byte-identical
before and after.

| Repo | .git objects | packs | index entries | config | layout | refs | merge-base | flattenTree ×2 | readBlob ×20 | fs calls (dir/file/entries/getFile) | warnings | writes | changed .git files | status/fsck identical |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pinpoint | 2.3 MB | 2 | 103 | 2 ms | 3 ms | 4 ms | 0 ms | 15 ms | 15 ms | 61 / 53 / 26 / 37 | — | 0 | 0 | yes / yes |
| news-scrapper | 73 MB | 13 | 3,840 | 1 ms | 2 ms | 72 ms | 0 ms | 578 ms | 20 ms | 472 / 1414 / 624 / 384 | `MULTI_PACK_INDEX` | 0 | 0 | yes / yes |
| midx-copy (gc + MIDX, shallow) | 76 MB | 2 | 6,348 | 0 ms | 1 ms | 2 ms | 0 ms | 185 ms | 9 ms | 1322 / 26 / 783 / 18 | `MULTI_PACK_INDEX`, `SHALLOW` | 0 | 0 | yes / yes |
| fixtures/sha256 | — | — | — | 0 ms | 0 ms | refused `OBJECT_FORMAT_SHA256` | | | | 1 / 2 / 0 / 2 (no object read) | | 0 | 0 | yes / yes |
| fixtures/alternates | — | — | — | 0 ms | 0 ms | refused `ALTERNATES` | | | | 5 / 8 / 0 / 3 (no object read) | | 0 | 0 | yes / yes |
| fixtures/partial | — | 2 | — | 0 ms | 1 ms | refused `PARTIAL_CLONE` | | | | 5 / 9 / 0 / 2 (no object read) | | 0 | 0 | yes / yes |

Observations and decisions:

- **Multi-pack-index**: isomorphic-git ignores `multi-pack-index` and reads every `.idx` directly; all
  reads succeeded on both MIDX repos. Decision: keep the `MULTI_PACK_INDEX` **warning** (informational),
  do not block. The `.mtimes`/`.rev` companions are ignored too.
- **Pack verification cost**: on first use of a pack isomorphic-git hashes the whole file (SHA-1 of the
  payload) — this is the bulk of the 578 ms `flattenTree` on news-scrapper (13 packs, 72 MB) and it
  happens once per session per pack. Acceptable for v1; noted for T7.2 (a `cache` that survives
  `dropCaches(false)` keeps the verified packs).
- **Refs**: 270 refs resolved in 72 ms; each `resolveRef` re-reads `packed-refs` through the FsaFs
  handle cache. Fine at this scale; if a repo has thousands of refs, T7.2 can memoise `packed-refs`
  per refresh generation.
- **Shallow clone** (midx-copy): `.git/shallow` present → `SHALLOW` warning; merge-base still resolved
  because default == HEAD here. `findMergeBase` returns `{ oid: null }` rather than throwing when
  history is cut (unit-tested with a synthetic shallow copy of `basic`).
- **Refusals fire before any object read**: for `sha256`, `alternates`, `partial` the only reads are
  `.git`, `.git/HEAD`, `.git/config`, and the marker files the check looks for.
- **Zero writes**: confirmed by three independent proofs on every repo. No isomorphic-git limitation
  required a workaround in T1.1–T1.4; no follow-up tasks filed.

## S3 results (T6.0)

**Status: spike page built; live observation not yet run.** `FileSystemObserver` needs a real
`showDirectoryPicker()` gesture in Chrome (a native folder dialog), which the agent cannot drive
unattended. Everything below the "How to run" block is to be filled in by the owner (or the agent once
a folder can be picked); the classifier in T6.2 ships with the provisional rules from its task file
until then.

### How to run (≈ 15 min, Chrome 133+ desktop; this machine has Chrome 153)

1. `cp -R fixtures/worktree /tmp/s3-repo && git -C /tmp/s3-repo remote add origin "$PWD/fixtures/_remotes/basic.git"`
2. `bunx vite --port 5199` and open `http://127.0.0.1:5199/spikes/s3-observer/index.html`
   (`vite preview` only serves `dist`; the dev server serves the spike page as-is).
3. Click **Pick folder (mode: read)** → choose `/tmp/s3-repo` → **View files**. The log shows
   `--- observing "s3-repo" (mode=read, observe() took N ms)`. If `observe()` throws in read mode,
   retry with the readwrite button and record it (AC 3).
4. For each scenario type its label in the box, click **Mark scenario**, run the commands, wait ~3 s:
   1. `echo more >> /tmp/s3-repo/both.txt` (in-place) and save `both.txt` in VS Code (atomic save).
   2. `git -C /tmp/s3-repo add both.txt`, `git commit -m x`, `git checkout main`, `git switch -`.
   3. `git -C /tmp/s3-repo fetch origin`.
   4. `touch /tmp/s3-repo/new-untracked.txt; rm /tmp/s3-repo/new-untracked.txt; mkdir -p /tmp/s3-repo/newdir2 && touch /tmp/s3-repo/newdir2/{a,b}.txt`
   5. `git -C /tmp/s3-repo gc`
   6. `rm -rf /tmp/s3-repo` (expect `disappeared` / `errored`).
5. Click **Copy JSON** and paste the result under "Raw log" below; summarise per scenario in the table.
   `window.__s3.records` / `window.__s3.marks` hold the same data.

### What the spike must answer

| Question | Why it matters | Provisional assumption (T6.2 ships with this) |
|---|---|---|
| Are records emitted for `.git/objects/**`? How many during `git gc`? | Storm avoidance | Yes, many; classifier ignores everything under `.git/objects/` |
| Event sequence for `.git/index` rewrite (`index.lock` appeared → moved/modified `index`) | Debounce window | `index.lock` appears then `index` modified/moved within < 50 ms; ignore `*.lock`, react to `index` |
| Does `git checkout` touch `HEAD`, `refs/heads/*`, `logs/*`, `packed-refs`? | git-tier reasons | `HEAD` + `logs/HEAD` + ref file; `packed-refs` only when packed |
| VS Code atomic save: `appeared` temp + `moved`, or `modified`? | worktree path list | temp file (e.g. `.both.txt.tmp123`) appears then `moved` onto `both.txt`; treat `moved` target as the path |
| Burst duration of `git gc`, `git fetch` | Debounce + max-wait | gc bursts up to ~1 s → 300 ms trailing debounce with 2 s max-wait collapses to one recompute |
| `disappeared` / `errored` record on folder removal | Degradation ladder | Both possible; either → downgrade to polling |
| Does `observe()` work on a `mode: "read"` handle? | D16 read-only | Yes |

### Per-scenario results

_To be filled by the owner run (record counts, burst count, duration, paths)._

### Raw log

_Paste the "Copy JSON" output here._
