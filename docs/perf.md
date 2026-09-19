# Performance (T7.2)

Budgets from `tasks/phase-7-hardening/T7.2-perf.md`. Structural budgets are enforced in CI by
`bun run perf` (`scripts/perf.ts`); absolute timings are printed always and asserted only with
`PERF_STRICT=1` on a developer machine. Browser-side numbers come from the hidden `/#debug` panel
(append `#debug` to the URL): engine phase durations, compute → committed wall time, worker call
and sink message counts, DiffResult payload size, handle-cache size and pack bytes read.

## Engine measurements (bun 1.3.13, Apple Silicon laptop, quiet machine, 2026-09-17)

`perf-5k`: 5,000 tracked files, 50 changed between `main` and `feature`, 480 kB of packed objects
(the fixture is small on disk; the file count is what exercises the index, scanner and payload).

| Metric | Budget | Measured | Where asserted |
|---|---|---|---|
| Open (config + layout + refs + index) | – | 18 ms | `scripts/perf.ts` (printed) |
| Open → file list (cold caches) | < 3 s | 175 ms | strict only |
| Recompute after a single file edit (warm stat cache) | < 500 ms | 29 ms | strict only |
| Stats for every changed file | < 4 s, progressive | 37 ms in 2 batches | strict only |
| 3000-changed-line hunk model (`large/big-change.txt`, 6,006 hunk lines) | < 300 ms | 207 ms (payload 345 kB) | strict only |
| Progress messages per compute (excl. stats) | ≤ 4 | 2 | always |
| Stats batches per compute | ≤ ⌈files/32⌉ + 2 | 2 | always |
| DiffResult payload | ≤ 400 B per file (≈ 2 MB at 5k rows) | 376 B per file | always |
| Handle-cache evictions per single-path refresh | ≤ paths reported | 1 for 1 path | always |
| Pack bytes held (R3 guard) | warn > 300 MB | 480 kB, no warning | `RepoSession.checkMemory` |

## History walk (T10.5, re-measured for T10.5b, same machine, 2026-09-19)

`walkCommits` pages by 50 and reads parents + commit times from `.git/objects/info/commit-graph`
when there is one, falling back to `ObjectDb.readCommit` per commit when there is not (atlas tab 20).
The emitted rows always cost one `readCommit` each, for the author and subject.

T10.5b changed three things that show up here. The release is windowed (`LOOKAHEAD = 512` commits
discovered ahead of the emission point) so the first page pays for ~560 `CommitReader.meta` lookups
rather than ~50 — off the commit-graph that is a binary search per commit, and the numbers below are
the whole cost. The cursor is an opaque token into session-held state instead of a serialised
frontier, so it is **13 bytes** on every page rather than ≈ 47 B per commit walked (≈ 2.3 MB at the
50,000-commit cap, and ≈ 1 GB of cumulative transfer over a full paging run). And `aheadBehind` is
git's single painted queue, so it walks the divergence rather than both full histories.

`perf-log`: 2,000 linear commits, 50 branches, a commit-graph, built only under `FIXTURES_PERF=1`.
The old first-page number came from `perf-5k`, whose HEAD is two commits deep — it measured the
fixed cost and nothing else (T10.5b nit 8), and is kept below only as that fixed cost.

| Metric | Budget | Measured | Where asserted |
|---|---|---|---|
| First page (`limit: 50`) on `perf-log`, straight after open (2,000 commits) | < 100 ms | **10 ms** (open is a further 101 ms: 51 refs, `packed-refs`, the commit-graph) | `scripts/perf.ts`, strict only |
| `--all` first page of 50 on `perf-log` (51 seeds + the refs-by-commit index) | < 100 ms | **6 ms** | strict only |
| `--all` **second** page of 50 on `perf-log` (resumed from the token) | < 50 ms | **6 ms** | strict only |
| Full `--all` walk of `perf-log` (2,000 rows, pages of 250) | – | 185 ms (≈ 0.09 ms per row, including one `readCommit` each) | `scripts/perf.ts` (printed) |
| Walk cursor size, any page | – | 13 B (`w<8 hex>.<n>`), against ≈ 47 B × commits walked before T10.5b | – |
| First page on `perf-5k` (HEAD is 2 deep: the fixed cost of parse + verify + refs index) | – | 8.5 ms | `scripts/perf.ts` (printed) |
| Full `--all` walk of `history` (63 commits, pages of 50) **with** the commit-graph | – | 12 ms | `scripts/perf.ts` (printed) |
| Full `--all` walk of `history` **without** it (the file removed from a copy) | – | 25 ms | `scripts/perf.ts` (printed) |
| Commit-graph speed-up on that walk | – | **2.1×** (the atlas estimated 2–5× on bigger histories, where the per-commit object inflation dominates rather than the 63 `readCommit` calls both paths still pay for the rows) | – |

## Blame and file history (T10.6, same machine, 2026-09-19)

`blame` resolves the path history first (`pathHistory({ follow: true })`, one `flattenTree` per
first-parent commit, memoised for the session) and then reverse-diffs consecutive revisions with the
same `lineDiff` the diff pane uses, stopping as soon as no line is unassigned. Only two revisions are
decoded at a time.

| Metric | Budget | Measured | Where asserted |
|---|---|---|---|
| `blame src/hot.txt` (60 lines, 3 revisions) — first call on a cold session | < 200 ms | 21 ms (the first call pays for the whole first-parent tree walk; the memoised trees make every later blame on the same session ~2 ms) | `scripts/perf.ts`, strict only |
| `blame src/hot.txt -w` (warm) | < 200 ms | 2.4 ms | strict only |
| `blame src/indent.txt` / `-w` (12 lines, 1–2 revisions) | < 200 ms | 1.5 ms / 1.3 ms | strict only |
| `blame src/renamed-to.txt` / `-w` (21 lines, 4 revisions, one rename hop) | < 200 ms | 2.7 ms / 2.2 ms | strict only |
| `pathHistory --follow src/renamed-to.txt` (4 entries, one `detectRenames` step) | – | 1.8 ms | `scripts/perf.ts` (printed) |

The atlas estimated ≈ 0.2 s for a typical file (30 revisions × ≈ 5 ms Myers on 400 lines) and ≈ 2.5 s
for a 500-revision hot file; the fixture files are far smaller, so what these numbers pin down is the
fixed cost — the tree walk and the per-revision blob reads — rather than the Myers time. The
`maxRevisions` cap (default 500, `BLAME_CAPPED`) is what bounds the second case, and the early
termination means a file whose lines were all rewritten recently never walks to its root.

`markReachable` is one walk from every ref, cached per refs snapshot, so the reflog panel's
`unreachable` badges cost one traversal for the whole list. `aheadBehind` (T10.5b S3) is git's own
`rev-list --left-right --count`: one date-ordered queue seeded LEFT/RIGHT, painting COMMON where the
two meet and stopping as soon as nothing but COMMON is left (`still_interesting`). Two branches five
commits apart on a 2,000-commit trunk therefore walk six commits, not 2,000 — which is also why the
10,000 cap no longer produces arbitrary numbers when it does bite. `branchCells` memoises the result
per `(a, b)` pair for the current refs snapshot, so a 50-row table walks each pair once.

Earlier per-phase engine numbers (T1–T3, same machine): `flattenTree` on perf-5k 30–150 ms,
index parse 28 ms, worktree scan ≈ 0.5 s cold, probes git 0.2 ms / index 6 ms / untracked 24 ms.
Rename detection on the `renames` fixture 50–75 ms.

## Search (T10.8, same machine, 2026-09-19)

The three palette scopes on `fixtures/history` (63 commits, 13 tracked files). `scripts/perf.ts`
prefers `perf-log` (2,000 commits, built by `FIXTURES_PERF=1`) when it exists and falls back to
`history`, so the numbers below are the small-repo floor — the fixed cost of the walk, the index
read and the working-tree scan — rather than the atlas's 5k-file estimates.

| Metric | Budget | Measured (`history`) | Where asserted |
|---|---|---|---|
| `commits` scope, 60 commits walked, 21 hits | < 2,000 ms | 11–13 ms | `scripts/perf.ts`, strict only |
| `worktree` scope, 13 files read, 200 hits (limit) | < 3,000 ms | 1–2 ms | strict only |
| `pickaxe` scope, 48 first-parent commits, 33 hits | < 5,000 ms | 24–26 ms | strict only |
| `(a+)+$` over 8 files of 200 pathological lines | < 1,000 ms | ≈ 430–480 ms (50 ms per file, then abandoned) | `src/engine/search/search.test.ts` |

The pickaxe dominates because it is the only scope that reads blobs: two per changed file per
commit, which is why the range size (default 200) and the path filter are mandatory and why the
scope reports `scanned` so the UI can offer to widen. Commit search pays one `readCommit` for the
commits whose subject and author did not already match — the body is the only field that needs an
object read. The working-tree scope pays one `WorktreeScanner.scan` for its file list (the stat
cache makes a second search on the same session ~free) and then reads at most 1 MB per file.

Regex mode's residual risk is catastrophic backtracking, which no pattern inspection can rule out.
It is bounded the way atlas tab 05 prescribes — matching runs in the worker, every scope checks its
`AbortSignal`, the pattern is capped at 200 characters, and each file gets 50 ms before it is
abandoned and the answer reported as `capped`. A single pathological *line* is bounded only by the
1 MB file gate; if that ever bites, the fix is a streaming matcher, not a longer budget.
## Insights (T10.9, same machine, 2026-09-19)

`insights` is one first-parent `walkCommits` plus a **path-level** tree diff per in-window commit —
`ObjectDb.flattenTree` on the commit and on its first parent, no blob reads — and then one
`readBlob` per hotspot candidate, for the current size the score needs (`HOTSPOT_SIZE_READS` = 2,000
blobs at most). The whole pass is bounded by the walker's own 50,000-commit cap (`INSIGHTS_CAPPED`).

| Metric | Budget | Measured | Where asserted |
|---|---|---|---|
| `history` (48 first-parent commits, a commit-graph), cold session | – | **28 ms** (0.6 ms per commit) | `scripts/perf.ts` (printed) |
| `history`, second call on the same session (trees cached) | – | 6 ms | `scripts/perf.ts` (printed) |
| `perf-log` (2,000 linear commits, a commit-graph), cold session | – | **557 ms** (0.28 ms per commit) | `scripts/perf.ts` (printed) |
| `perf-log`, second call (trees cached) | – | 194 ms (0.10 ms per commit) | `scripts/perf.ts` (printed) |
| Cold cost per first-parent commit, either fixture | < 2 ms | 0.6 / 0.3 ms | `scripts/perf.ts`, strict only |

The atlas estimated "1,000 commits ≈ 1 s, path-level tree diff ≈ 1 ms per commit on cached trees";
the measured 0.28 ms per commit cold on `perf-log` is inside that. What dominates is
`flattenTree` — two per commit, memoised by `ObjectDb`, so a linear first-parent walk pays for each
tree once. Changed-path Bloom filters from the commit-graph (atlas tab 20) would remove the tree
reads for commits that touch nothing the ranking cares about; they are **not** implemented here,
because the hotspot tally needs the actual changed-path set of every commit, not a membership test
for one path. The one thing they would buy is the `sinceMs` case, where commits outside the window
are already skipped without any tree read at all.

At the 50,000-commit cap that extrapolates to ≈ 14 s, which is why the result is meant to be cached
in `diffgit-derived` under `insights:<repoId>:<tipOid>:<period>` (T11.1) and why the walk reports
`{ phase: "insights", done }` every 500 commits.

## v2 re-measurement (T11.16, same machine, 2026-09-19, whole `bun run perf` run)

The final pass re-ran every budget above on the complete v2 engine. Nothing regressed; the numbers
below are that run, and they are what `bun run perf` prints today.

| Metric | Budget | Measured |
|---|---|---|
| Open (`perf-5k`) | – | 14 ms (config 2 · layout 2 · refs 3 · index 5) |
| Open → file list, cold (`perf-5k`, 50 changed of 5,000) | < 3 s | **121 ms** |
| Recompute after one edit | < 500 ms | 28 ms (1 handle-cache eviction for 1 path) |
| Stats for every changed file | < 4 s | 26 ms in 2 batches |
| 3,000-changed-line hunk model | < 300 ms | 120 ms (payload 345 kB) |
| `DiffResult` payload per file | ≤ 400 B | 376.5 B |
| **History first page of 50** (`perf-log`, 2,000 commits) | < 100 ms | **10.2 ms** (open a further 100 ms) |
| `--all` first page of 50 | < 100 ms | 7.4 ms |
| `--all` second page of 50 (resumed from the token) | < 50 ms | 5.4 ms |
| Full `--all` walk of `perf-log` (2,000 rows) | – | 189 ms |
| Commit-graph speed-up on the `history` walk | – | 12 ms with it, 27 ms without — **2.3×** |
| **Blame** `src/hot.txt` (60 lines, 3 revisions), cold session | < 200 ms | **20.2 ms** (1.9 ms warm, `-w`) |
| Blame `src/indent.txt` / `src/renamed-to.txt` | < 200 ms | 1.5 / 2.8 ms |
| `pathHistory --follow src/renamed-to.txt` | – | 2.0 ms |
| **Insights** `history` (48 first-parent commits), cold | < 2 ms/commit | **25 ms** (0.52 ms/commit); 5 ms warm |
| Insights `perf-log` (2,000 commits), cold | < 2 ms/commit | **511 ms** (0.26 ms/commit); 181 ms warm |
| **Search** `commits` (`perf-log`, 2,000 scanned) | < 2,000 ms | **356 ms** |
| Search `worktree` (`perf-log`) | < 3,000 ms | 1.2 ms |
| Search `pickaxe` (`perf-log`, 200 commits) | < 5,000 ms | 65 ms |
| Pack bytes held after the whole run | warn > 300 MB | 479 kB |

The one number worth reading twice is `search commits` at 356 ms for 2,000 commits: it is the only
scope that walks the whole range and then reads the body of every commit whose subject and author
did not already match, which is why the UI debounces it (200 ms) and prints `scanned` under the
results. Everything else on this list is under 200 ms, and the two that are not (`insights` on
`perf-log`, the full walk) are cached — insights in `diffgit-derived` keyed by tip, the walk by the
session's own walk state.

## Browser-side (Chromium, production build)

| Metric | Budget | Status |
|---|---|---|
| 3000-line diff render | < 500 ms | 88 ms paint after the payload lands (T5.3 measurement, `react-diff-view` + Shiki worker) |
| Main-thread long tasks during compute | none > 50 ms | Compute, rename detection, stats and highlighting all run in workers; the main thread only receives structured clones (≤ 2 MB for 5k rows, 18 kB for perf-5k's 50 rows). Not yet measured with a real repo — record from DevTools Performance during the T8.2 smoke test. |
| Idle CPU in polling mode | < 3 % | Worker time per visible minute ≈ 0.1–0.3 s from the probe costs above (T6.3); browser-level confirmation pending the T8.2 smoke test. |
| Open → file list on a real 5k-file repo in Chrome | < 3 s | Pending T8.2 (the engine side is 175 ms in bun; FSA handle I/O in Chrome is the unknown). |

## Decisions

- **Full `DiffResult` per recompute is kept.** At ≤ 400 B per row the structured clone of a 5k-row
  result is ≈ 2 MB, a few milliseconds; a delta protocol would add a second code path for a cost
  the budgets do not show. Revisit if the T8.2 numbers disagree.
- **Stats batches**: 32 files or 100 ms per `onStats` message; 5k rows → ≤ 158 messages, each a
  small record. `prioritise()` keeps the visible rows first.
- **Memory guard (R3)**: `FsaFs.ioStats().packBytes` counts every distinct pack/idx read (an upper
  bound of isomorphic-git's cache). Above 300 MB the session emits `PACK_LARGE` (detail `memory`)
  once; the layout check already warns about > 300 MB and refuses > 1 GB of packs on disk.
- Shiki grammars are loaded lazily per language in the highlight worker (T5.3); the virtualised
  diff pane renders only cards in view (T5.3), which is why collapsed bodies unmount (Design §8 follow-up).
