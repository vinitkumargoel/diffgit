# v2 contracts — engine API, types, store and codes (2026-09-19)

Single source of truth for every name shared between the phase-10 engine tasks and the phase-11 UI
tasks. A task may add to this file (with its id in a comment) but must not rename anything here. All
shapes are structured-cloneable (tasks/README.md conventions). Product rules: `Design.md` §14.

## Codes (added to `src/engine/errors.ts` by T10.1, then used by everyone)

Warning codes (append to `WARNING_CODES`): `HISTORY_CAPPED`, `NO_REFLOG`, `SEARCH_CAPPED`,
`BLAME_CAPPED`, `INSIGHTS_CAPPED`, `HIDDEN_CAPPED`, `COMMIT_GRAPH_STALE`, `SECRETS_FOUND`,
`OPERATION_IN_PROGRESS`, `SNAPSHOT_MODE`, `JJ_COLOCATED`, `PATCH_ONLY`.
Public error codes (append to `PUBLIC_CODES`): `REV_NOT_FOUND` (an expression did not resolve),
`REV_AMBIGUOUS` (short SHA matched several objects; `detail` lists candidates), `NOT_A_PATCH`.
`src/ui/warnings.ts` and `docs/errors.md` gain a row per code (T11.1 for the UI copy).
<!-- T10.1 --> `EngineError`, `EngineErrorJSON`, `PublicError` and `UiError` gain `detail?: string`
so `REV_AMBIGUOUS` can carry its candidates across the worker boundary; it is the comma-separated
list of full oids. T10.1 added all the codes above and placeholder copy for them in
`src/ui/errors.ts` / `src/ui/warnings.ts` / `docs/errors.md` (the parity test in
`src/ui/errors.docs.test.ts` requires a row per code); T11.1 owns the final wording.

## Constants

`EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"` (`src/engine/git/hash.ts`, T10.1).

## `src/engine/types.ts` additions

```ts
export interface BranchesSource { kind: "branches"; /* unchanged fields */ }
export interface RangeSource {
  kind: "range";
  from: string; to: string;          // display names ("v2.3.0", "stash@{0}", "a1b2c3d", "main")
  fromRef: string; toRef: string;    // resolvable expressions (see resolveRevision)
  fromOid: Oid | null; toOid: Oid;   // resolved by the UI before compute (null = empty tree)
  threeDot: boolean;                 // true → merge-base(from,to)…to ; false → from..to (plain tree diff)
  includeWorktree: boolean;          // honoured only when toOid === HEAD oid (isWorktreeSource)
  commit?: Oid;                      // set when this range is "show one commit" (from = first parent)
}
export type DiffSource = BranchesSource | RangeSource;
```
`diffSource.ts`: `isWorktreeSource` returns true for a `RangeSource` whose `toOid` equals `headOid`
and `includeWorktree`; `defaultDiffSource` unchanged. `DiffResult.mergeBase` is null for two-dot.
<!-- T10.1 --> `diffSource.ts` also exports `sourceLabels(src)` → `{ source, target }` (display
names) and `sourceRefs(src)` → `{ sourceRef, targetRef }` (resolvable expressions); a `RangeSource`
maps `to`/`toRef` to `source`/`sourceRef` and `from`/`fromRef` to `target`/`targetRef`. Everything
that only names or keys the two sides (`viewedKey`, `TopBar`, the scheduler's toast, the probe) uses
these instead of narrowing the union. `defaultDiffSource` is declared as returning `BranchesSource`.
A `RangeSource` whose `to` is a stash commit is layered like the working tree it came from: the
second parent's tree is `staged`, the stash's own tree is `unstaged`, the third parent's tree is
`untracked`. `fromOid: null` and `fromOid: EMPTY_TREE_OID` both mean the empty tree.

<!-- T10.1 --> Every timestamp in these shapes (`Signature.timestamp`, `TagInfo.timestamp`,
`StashInfo.timestamp`, and the ones later tasks add) is epoch **milliseconds**, like
`DiffResult.computedAt`. `Signature.tzOffsetMin` is isomorphic-git's `timezoneOffset`
(`Date.getTimezoneOffset()` convention). `StashInfo.files` counts the base→stash tree diff plus the
untracked files the stash kept; `RepoSession.listStashes()` fills it for the first 50 stashes.
`resolveRevision` additionally accepts `^{}` and `^{commit}` (no-ops once a tag has been peeled) and
requires at least 7 hex characters for a SHA prefix.

<!-- T10.2 --> `ReflogEntry.message` is git's `%gs` **verbatim** (`"rebase (pick): t1: clean"`), so a
list of entries is byte-equal to `git reflog --format='%H %gs'`; `action` is the same string up to
its first `:` (the whole message when it has none). `ReflogEntry.expr` is built from the text the
caller passed (`reflog("HEAD")` → `HEAD@{0}`, `reflog("main")` → `main@{0}`), and `oldOid` is null
for the entry that created the ref (git writes 40 zeroes). `reflog()` resolves a short name as
branch → remote → tag, and `"stash"` as `logs/refs/stash`; a ref with no log file answers `[]` plus
one `NO_REFLOG` warning on the sink instead of throwing. `RepoOperation.remaining` / `.done` keep a
todo file's abbreviated oid when the object cannot be expanded (`git gc` pruned it), so a step is
never silently dropped; `RepoOperation.startedAt` is the mtime of the state file that named the
operation. `detectOperation(fs, db, refs?)` takes the already-loaded refs so `ontoDisplay` can be a
branch name; without them it is the short oid. Detection precedence is rebase (either backend) →
cherry-pick → revert → merge → bisect, because a rebase that stopped on a conflict also leaves
`MERGE_HEAD`/`MERGE_MODE` behind. `operation.ts` exports `OPERATION_FILES`, the paths under `.git/`
that `probe("git")` stats so the banner follows git live. `bun run record` writes `reflog` and
`operation` into `src/test/recorded/<fixture>.v2.json` and now records `rebase-conflict` and
`merge-conflict` as well.

<!-- T10.3 --> `src/engine/api.ts` gains the conflict shapes (they are payloads, not domain types,
so they live beside `FileDiffPayload`):

```ts
export interface SideBlob { oid: Oid; text: string | null; size: number; binary: boolean }
export type ConflictKind = "both-modified" | "both-added" | "deleted-by-us" | "deleted-by-them" | "both-deleted";
export interface ConflictMarker { start: number; end: number; oursEnd: number; baseEnd?: number }
export interface ConflictPayload {
  id: string; generation: number;
  base: SideBlob | null; ours: SideBlob | null; theirs: SideBlob | null;
  oursHunks: HunkModel | null; theirsHunks: HunkModel | null;
  worktree: { text: string; markers: ConflictMarker[] } | null;
  resolvedInWorktree: boolean; kind: ConflictKind; labels: { ours: string; theirs: string };
}
```

`ConflictKind` is derived structurally from which of the index stages 1/2/3 exist, so git's rarer
`AU` (stage 2 only) reads as `deleted-by-them` and `UA` (stage 3 only) as `deleted-by-us` — in both
the side with no blob is the deleted one. `FileDiff.status` for a row in the `conflict` layer follows
the kind (`both-added` → `added`, `deleted-by-*` → `deleted`, otherwise `modified`); its
`oldPath`/`newPath` still describe where content can be loaded from, so a `both-added` row keeps an
old side and a `deleted-by-them` row keeps the marked-up working-tree file. `ConflictMarker` numbers
are **1-based line numbers of the marker lines themselves**: `oursEnd` is the `|||||||` line in
`diff3`/`zdiff3` style and the `=======` line otherwise, and `baseEnd` (the `=======` line) is only
set when a `|||||||` was found — so ours is `(start, oursEnd)`, base is `(oursEnd, baseEnd)` and
theirs is `(baseEnd ?? oursEnd, end)`. `SideBlob.text` and `ConflictPayload.worktree` are null for a
binary side or one over 1 MB (`LARGE_FILE_BYTES`), and the corresponding `*Hunks` are null too;
`resolvedInWorktree` is only true when the file was actually read and decoded and holds no markers,
so an absent, binary or > 10 MB file is never called resolved. `labels.ours` is the checked-out
branch, or what a rebase is replaying onto while HEAD is detached; `labels.theirs` is
`RepoOperation.current` (`MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / the rebase's
`stopped-sha`) shown as a ref name when one points at it and as a short oid otherwise — git's own two
spellings for the `>>>>>>>` marker. `conflict()` re-reads `.git/index` on every call so the card
follows the file while the user resolves it elsewhere. `bun run record` also records
`cherry-pick-conflict` and writes `conflicts` (file id → `ConflictPayload`) into
`<fixture>.v2.json`; the mock rewrites `generation` on serve.

<!-- T10.4 --> `src/engine/api.ts` gains `OpenOptions` — what the page may set when it opens a
repository, as a third argument to `EngineApi.open` / `WorkerClient.open`:

```ts
export interface OpenOptions { builtinExcludes?: boolean }   // default true; backlog B10
```

`SessionOptions.builtinExcludes` carries it to `IgnoreRules`. `IgnoreRules` gains
`explain(path, isDir)` → `IgnoreMatch | null` (`{ source; line; pattern; negated }`) and the async
`explainPath(path, kind)` that loads the ancestors first; `isIgnored` is unchanged. `source` is
spelled as `git check-ignore -v` spells it (`.gitignore`, `src/.gitignore`, `.git/info/exclude`) plus
`BUILTIN_SOURCE = "(built-in excludes)"` for diffgit's own defaults — git prints `::` for those, the
one documented divergence, and `builtinExcludes: false` removes it. `pattern` is the rule verbatim
including a leading `!`, and a negated last match is *reported* (`negated: true`, the path is not
ignored) rather than swallowed. Attribution matches the last rule in the file, the nearest
`.gitignore` first, and — like git — a path under an ignored directory reports the rule that
excluded the outermost such directory. `PathExplanation.shown` is true only when the path has a row
in the current diff *and* no hiding reason (`ignored`, `skip-worktree`, `assume-unchanged`, `sparse`,
`too-large`) applies, so everything `listHidden` returns answers `shown: false`; `generated` and
`clean` are explanatory, and `clean` is only added when nothing else applies. `listHidden()` is its
own opt-in walk in `WorktreeScanner` (`HIDDEN_LIMIT = 2000`) — the normal scan is untouched; a
tracked path is never reported as `ignored`, an ignored directory is one `ignored-dir` row with the
count of its direct children and is never descended, and `too-large` comes from the rows of the
current diff. `bun run record` records the `hidden` fixture and writes `hidden` (the whole group)
and `explanations` (path → `PathExplanation`) into `<fixture>.v2.json`.

<!-- T10.5 --> `walkCommits` reproduces `git log --date-order`, which is git's *topological* order with
a commit-date tie-break (revision.c sets `topo_order` for `--date-order`): a commit is queued only
once every discovered commit that names it as a parent has been emitted (git's indegree), and among
those the newest wins, ties going to whichever became eligible first — `prio_queue`'s insertion
counter. The walk streams, so the indegree is over the commits discovered so far rather than a whole
pre-walk; the two agree whenever commit dates do not increase towards the parents, which is every
history git itself writes. `WalkRequest.from` holds revision expressions (`resolveRevision`); `all`
seeds from every ref, tag and stash sorted by ref name and then `HEAD`, the order `git log --all`
seeds its own walk in. `path` applies git's default history simplification (a commit TREESAME to a
parent is not shown and only that parent is followed); rename following is T10.6, and a path-filtered
page carries no `lane`/`laneCount`/`edges` because a lane reserved for a commit the filter skips
would never close. `WalkPage.cursor` is a JSON blob carrying the eligible queue, the indegree map,
the oids discovered so far and the lane table, so a page is self-contained and survives a worker
restart. `CommitSummary.refs` are display names, `HEAD` first, then branch and remote names in
`RefSnapshot` order, then tags, then stash selectors. `CommitSummary.edges` describes the band
**below** the node: `from` is a lane index at this row, `to` a lane index at the next, `straight` is
a line that stays in its lane (a pass-through, or the commit continuing into its first parent),
`merge` a line moving into a lane another commit already reserved for that parent, and `fork` a new
lane opened for a second or later parent. A lane a `merge` edge lands in still carries its own
`straight` pass-through, so the SVG never has to look at a third row. `commitStats` is the tree diff
against the first parent (a root against the empty tree) with the repository's rename settings
applied, so it equals `git show --numstat --first-parent`; a side over 10 MB is left out of the
counts. `aheadBehind(a, b)` returns the left count as `ahead` and the right one as `behind`;
`branchCells` marks a branch `merged` when `vsDefault.ahead === 0`, and the default branch itself
`merged: true` with a null `vsDefault`. `bun run record` records `walks` (the whole history per
variant — default, first-parent, all, per path — which the mock pages itself), `commits`,
`commitStats`, `branches`, `aheadBehind` and `reachable`, and now records the `octopus` fixture too.

```ts
export interface ResolvedRevision {
  expr: string; oid: Oid | null;                     // null only for "<root>^" → empty tree
  kind: "branch" | "remote" | "tag" | "stash" | "commit" | "head" | "empty-tree";
  display: string;                                    // "main", "v2.3.0", "stash@{0}", "a1b2c3d"
  fullRef?: string;                                   // refs/heads/main, refs/tags/v2.3.0
  peeledFrom?: Oid;                                   // annotated tag object oid
}
export interface TagInfo { name: string; fullName: string; oid: Oid; targetOid: Oid; annotated: boolean;
  message?: string; tagger?: Signature; timestamp?: number }
export interface Signature { name: string; email: string; timestamp: number; tzOffsetMin: number }
export interface StashInfo { index: number; expr: string; oid: Oid; message: string; timestamp: number;
  baseOid: Oid; indexOid: Oid; untrackedOid: Oid | null; files: number | null }
export interface ReflogEntry { index: number; expr: string; oldOid: Oid | null; newOid: Oid; action: string;
  message: string; who: Signature; reachable: boolean | null }         // null = not computed yet
export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
export interface RepoOperation { kind: OperationKind; step?: number; total?: number; onto?: Oid;
  ontoDisplay?: string; headName?: string; current?: Oid; remaining?: Oid[]; done?: Oid[];
  conflicts: number; startedAt?: number; interactive?: boolean }
export interface CommitSummary { oid: Oid; parents: Oid[]; author: Signature; committer: Signature;
  subject: string; refs: string[]; lane?: number; laneCount?: number;
  edges?: { from: number; to: number; kind: "straight" | "merge" | "fork" }[] }
export interface CommitDetails extends CommitSummary { body: string; tree: Oid; signed: boolean;
  note: string | null; stats: { files: number; additions: number; deletions: number } | null }
export interface WalkRequest { from: string[]; firstParent: boolean; cursor?: string; limit: number;
  path?: string; all?: boolean }
export interface WalkPage { commits: CommitSummary[]; cursor: string | null; graphAvailable: boolean;
  capped: boolean }
export interface AheadBehind { ahead: number; behind: number; mergeBase: Oid | null; capped: boolean }
export interface BranchRow { ref: RepoRef; upstream: string | null; lastCommit: { oid: Oid; subject: string;
  author: string; timestamp: number } | null; vsUpstream: AheadBehind | null; vsDefault: AheadBehind | null;
  merged: boolean | null; tags: string[] }
export interface PathHistoryEntry { oid: Oid; subject: string; author: Signature; path: string;
  renamedFrom: string | null; whitespaceOnly: boolean; status: FileStatus }
export interface BlameLine { line: number; oid: Oid | null; origLine: number; origPath: string }   // oid null = uncommitted
export interface BlamePayload { path: string; ref: string; lines: BlameLine[];
  commits: Record<Oid, { author: Signature; subject: string }>; revisions: number; capped: boolean }
export interface SecretFinding { fileId: string; path: string; line: number; rule: string; entropy: number;
  masked: string; full: string; layer: "staged" | "unstaged" }
export interface SearchRequest { scope: "commits" | "worktree" | "pickaxe"; query: string; regex?: boolean;
  path?: string; limit: number; commits?: number }                       // pickaxe: commits = range size
export interface SearchHit { kind: "commit" | "file"; oid?: Oid; subject?: string; path?: string; line?: number;
  text?: string; delta?: number }
export interface SearchResult { hits: SearchHit[]; scanned: number; capped: boolean; durationMs: number }
export interface InsightsRequest { sinceMs?: number; limit: number }
export interface InsightsResult { commits: number; authors: { name: string; commits: number }[];
  hotspots: { path: string; commits: number; size: number; score: number; manifest: boolean }[];
  activity: { weekStart: number; days: number[] }[]; walked: number; capped: boolean; bots: number }
export interface RepoSummary { headBranch: string | null; headDisplay: string;
  counts: { staged: number; unstaged: number; untracked: number; conflict: number };
  vsUpstream: AheadBehind | null; lastCommit: { oid: Oid; subject: string; timestamp: number } | null;
  operation: RepoOperation | null; indexMtimeMs: number }
export interface BisectState { good: Oid[]; bad: Oid; skipped: Oid[] }
export interface BisectStep { candidate: Oid | null; remaining: number; steps: number; firstBad: Oid | null }
export interface PreflightRow { oid: Oid; subject: string; files: number; merge: boolean; signed: boolean;
  overlaps: { path: string; prediction: "likely" | "possible"; theirs: Oid }[];
  prediction: "clean" | "possible" | "likely" }
export interface PreflightResult { branch: string; onto: string; mergeBase: Oid | null; ontoAdvanced: number;
  rows: PreflightRow[]; command: string; todo: string }
export interface PathExplanation { path: string; shown: boolean;
  reasons: { kind: "ignored" | "skip-worktree" | "assume-unchanged" | "sparse" | "too-large" | "generated" | "clean";
    source?: string; line?: number; pattern?: string; command?: string }[] }
export interface HiddenEntry { path: string; kind: "ignored-dir" | "ignored" | "skip-worktree" | "assume-unchanged" | "too-large" | "sparse"; count?: number }
export interface SubmoduleInfo { path: string; url: string | null; recorded: Oid | null; checkedOut: Oid | null; dirty: boolean | null }
export interface WorktreeInfo { name: string; path: string | null; head: Oid | null; branch: string | null; prunable: boolean; isThis: boolean }
```

## `src/engine/api.ts` additions (`EngineApi`)

| Method | Task | Notes |
|---|---|---|
| `resolveRevision(expr: string): Promise<ResolvedRevision>` | T10.1 | full refs, `HEAD`, short names (branch → tag order like git), SHA ≥ 7 hex (`REV_AMBIGUOUS`), `~n`, `^`, `^n`, `stash@{n}`, tag peel. Anything else → `REV_NOT_FOUND`. |
| `listTags(): Promise<TagInfo[]>` | T10.1 | packed + loose, annotated peeled via `readTag`. |
| `listStashes(): Promise<StashInfo[]>` | T10.1 | from `.git/logs/refs/stash` (newest first); `untrackedOid` = third parent's tree commit. |
| `reflog(expr: "HEAD" \| string, limit: number): Promise<ReflogEntry[]>` | T10.2 | `.git/logs/HEAD` or `.git/logs/<fullRef>`; `reachable` filled lazily by `markReachable`. |
| `markReachable(oids: Oid[]): Promise<Record<Oid, boolean>>` | T10.5 | reachable from any ref. |
| `operation(): Promise<RepoOperation \| null>` | T10.2 | also emitted as `RepoInfo.operation` on open/reloadRefs. |
| `conflict(generation: number, id: string): Promise<ConflictPayload>` | T10.3 | see task for shape. |
| `explainPath(path: string): Promise<PathExplanation>` | T10.4 | |
| `listHidden(): Promise<HiddenEntry[]>` | T10.4 | capped at 2,000 (`HIDDEN_CAPPED`). |
| `walkCommits(req: WalkRequest): Promise<WalkPage>` | T10.5 | cursor = opaque string; lanes assigned per page continuously. |
| `commitDetails(oid: Oid): Promise<CommitDetails>` | T10.5 | |
| `commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>>` | T10.5 | vs first parent, path-level + numstat, batched. |
| `aheadBehind(a: string, b: string): Promise<AheadBehind>` | T10.5 | cap 10,000 each side. |
| `branchOverview(): Promise<BranchRow[]>` | T10.5 | lazily computed cells are `null` until `branchCells(names)` fills them. |
| `branchCells(fullNames: string[]): Promise<Record<string, Pick<BranchRow, "vsUpstream" \| "vsDefault" \| "merged">>>` | T10.5 | |
| `pathHistory(ref: string, path: string, opts: { follow: boolean; limit: number; cursor?: string }): Promise<{ entries: PathHistoryEntry[]; cursor: string \| null }>` | T10.6 | |
| `blame(ref: string, path: string, opts: { ignoreWhitespace: boolean; includeWorktree: boolean; maxRevisions: number }): Promise<BlamePayload>` | T10.6 | progress phase `"blame"`. |
| `scanSecrets(generation: number): Promise<SecretFinding[]>` | T10.7 | added lines of staged+unstaged hunks only. |
| `search(req: SearchRequest): Promise<SearchResult>` | T10.8 | |
| `insights(req: InsightsRequest): Promise<InsightsResult>` | T10.9 | progress phase `"insights"`. |
| `patchText(generation: number, ids: string[] \| null): Promise<string>` | T10.10 | git-apply-compatible unified diff. |
| `summarise(): Promise<RepoSummary>` | T10.10 | cheap: refs + index + counts-only scan. |
| `bisectStep(state: BisectState): Promise<BisectStep>` | T10.11 | |
| `rebasePreflight(branchRef: string, ontoRef: string): Promise<PreflightResult>` | T10.11 | |
| `listSubmodules(): Promise<SubmoduleInfo[]>`, `listWorktrees(): Promise<WorktreeInfo[]>` | T10.12 | |
| `parsePatch(text: string): Promise<PatchResult>` | T10.12 | unified diff → `FileDiff[]` + `HunkModel`s (patch-only mode). |

`ProgressPhase` gains `"blame" | "history" | "insights" | "search" | "secrets"`.
`RepoInfo` gains `operation: RepoOperation | null`, `jj: boolean`, `hasCommitGraph: boolean`.
Every new method rejects with `STALE` when it takes a `generation` that is not current, and with
`CANCELLED` when a newer call of the same method supersedes it (one in-flight per method, like `computeDiff`).

## Store (`src/ui/store.ts`) additions — T11.1 creates the fields, later tasks fill behaviour

```ts
export type AppMode = "files" | "history" | "branches" | "insights";
export type CardMode = "diff" | "blame" | "history";
export type HistoryTab = "commits" | "stack" | "reflog";
Prefs += { mode: AppMode /* not persisted per repo; session default "files" */; showHidden: boolean;
  builtinExcludes: boolean; insightsPeriod: "90d" | "1y" | "all"; twoDot: boolean }
StoreState += {
  mode: AppMode; historyTab: HistoryTab; cardModes: Record<string, CardMode>;
  operation: RepoOperation | null; secrets: SecretFinding[] | null; hidden: HiddenEntry[] | null;
  history: { commits: CommitSummary[]; cursor: string | null; loading: boolean; selected: Oid | null; rangeStart: Oid | null; query: string; firstParent: boolean; all: boolean; capped: boolean };
  bisect: (BisectState & BisectStep) | null; palette: boolean; snapshotMode: boolean; patchOnly: boolean;
}
```

## Persistence additions

- `diffgit.prefs.v1` gains the new `Prefs` keys with validation (T11.1).
- New IndexedDB store `diffgit-derived` (`idb-keyval` custom store): keys `blame:<repoId>:<oid>:<path>`,
  `history:<repoId>:<oid>:<path>`, `insights:<repoId>:<tipOid>:<period>`, `summary:<repoId>`,
  `bisect:<repoId>`; every write through `guarded()`; a `Clear cache` control in the HelpDialog footer
  shows the total and clears (T11.1 creates the module `src/ui/persistence/derived.ts`).

## Fixtures to add (`scripts/make-fixtures.sh`, T10.0)

`tags` (2 lightweight, 2 annotated, one on a commit that is also a branch tip), `stash` (two stashes,
one with `-u`), `rebase-conflict` (interactive rebase stopped at step 2 of 3 with one `UU` and one `AA`
file), `merge-conflict` (merge stopped, `MERGE_HEAD` present, one deleted-by-them), `reflog-orphan`
(a reset that orphaned a commit), `history` (60 commits on two branches with a merge, a root, a
rename, a whitespace-only commit, a `.mailmap`, one `[bot]` author, `git commit-graph write`),
`secrets` (planted fake keys in unstaged hunks, one allowlisted), `hidden` (ignored dir, ignored file,
`skip-worktree` file, `assume-unchanged` file, 11 MB file), `octopus` (three-parent merge). Each with
`fixture-expectations.sh` output from the real git CLI (`git tag -l --format`, `git stash list`,
`git reflog`, `git log --graph --oneline`, `git blame --porcelain`, `git check-ignore -v`,
`git rev-list --left-right --count`, `git log -S`, `git shortlog -sn`).
