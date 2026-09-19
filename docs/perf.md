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

## History walk (T10.5, same machine, 2026-09-19)

`walkCommits` pages by 50 and reads parents + commit times from `.git/objects/info/commit-graph`
when there is one, falling back to `ObjectDb.readCommit` per commit when there is not (atlas tab 20).
The emitted rows always cost one `readCommit` each, for the author and subject.

| Metric | Budget | Measured | Where asserted |
|---|---|---|---|
| First page (`limit: 50`) on `perf-5k`, straight after open | < 100 ms | 8 ms (2 commits; the fixture's HEAD is two deep, so this is the fixed cost: parse + verify the commit-graph, build the refs-by-commit index, one `readCommit` per row on a 5,000-file repository) | `scripts/perf.ts`, strict only |
| Full `--all` walk of `history` (63 commits, pages of 50) **with** the commit-graph | – | 13 ms | `scripts/perf.ts` (printed) |
| Full `--all` walk of `history` **without** it (the file removed from a copy) | – | 25 ms | `scripts/perf.ts` (printed) |
| Commit-graph speed-up on that walk | – | **1.9×** (the atlas estimated 2–5× on bigger histories, where the per-commit object inflation dominates rather than the 63 `readCommit` calls both paths still pay for the rows) | – |

`markReachable` is one walk from every ref, cached per refs snapshot, so the reflog panel's
`unreachable` badges cost one traversal for the whole list. `aheadBehind` builds both reachability
sets (capped at 10,000 each) rather than pruning at the merge base, because a commit reachable from
the base can also be reached on a path that never passes through it.

Earlier per-phase engine numbers (T1–T3, same machine): `flattenTree` on perf-5k 30–150 ms,
index parse 28 ms, worktree scan ≈ 0.5 s cold, probes git 0.2 ms / index 6 ms / untracked 24 ms.
Rename detection on the `renames` fixture 50–75 ms.

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
