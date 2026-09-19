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

<!-- T10.5, amended by T10.5b --> `walkCommits` reproduces `git log --date-order`, which is git's
*topological* order with a commit-date tie-break (revision.c sets `topo_order` for `--date-order`): a
commit is queued only once every discovered commit that names it as a parent has been emitted (git's
indegree), and among those the newest wins, ties going to whichever became eligible first —
`prio_queue`'s insertion counter. See the T10.5b paragraph below for the exact guarantee the walk
gives against git's whole-list pass. `WalkRequest.from` holds revision expressions (`resolveRevision`); `all`
seeds from every ref, tag and stash sorted by ref name and then `HEAD`, the order `git log --all`
seeds its own walk in. `path` applies git's default history simplification (a commit TREESAME to a
parent is not shown and only that parent is followed); rename following is T10.6, and a path-filtered
page carries no `lane`/`laneCount`/`edges` because a lane reserved for a commit the filter skips
would never close. `WalkPage.cursor` is an opaque token (T10.5b S4 replaced the self-contained JSON blob).
`CommitSummary.refs` are display names, `HEAD` first, then branch and remote names in
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

<!-- T10.6 --> `pathHistory` is a **first-parent** walk: git's own `--follow` is first-parent by
construction (`try_to_follow_renames` runs on a one-parent tree diff) and the default simplification
already collapses a merge that is TREESAME to its mainline, so the two agree on every history git
writes — `expected/log-path-hot.txt`, `log-path-renamed.txt` and `log-follow-renamed.txt` are
asserted oid for oid. `PathHistoryEntry.path` is the name the file had **at that commit** and
`renamedFrom` the name at its first parent, found by running `detectRenames` between the two trees
with only the followed path on the added side and only the paths the commit removed on the deleted
side. `whitespaceOnly` is `computeStats({ ignoreWhitespace: true })` reporting no change.
`pathHistory`'s cursor is a JSON blob carrying the next commit **and** the path at it, so a page
boundary may fall in the middle of a rename chain. `src/engine/api.ts` gains `PathHistoryOptions`
(`{ follow; limit; cursor? }`) and `BlameRequest` (`{ ignoreWhitespace; includeWorktree;
maxRevisions }`) beside `FileDiffOptions`; `ProgressPhase` gains `"blame"`.

`blame` starts from the newest content — the working-tree file when `includeWorktree` is set and it
differs from the blob at `ref`, in which case the lines that diff introduces carry `oid: null` — and
reverse-diffs the path history newest → oldest with `lineDiff`, attributing every added line to the
revision that added it with the line number and path **that** revision had, and carrying the rest
back to their position on the older side. It stops as soon as nothing is unassigned; the oldest
revision it reaches keeps whatever is left, so every line always has an origin. `ignoreWhitespace`
compares `-w` keys throughout (git's `-w`), which is why a whitespace-only revision attributes
nothing and `blame-src-indent-w.txt` falls through to the root commit. `maxRevisions` is enforced by
asking the history for `maxRevisions + 1` entries: more means the list was cut, the last entry
examined keeps the remaining lines, `capped` is true and a `BLAME_CAPPED` warning goes to the sink.
`BlamePayload.commits` holds only the commits a line actually points at. A file over 10 MB is
`TOO_LARGE`; a path that is not in the ref is `REF_NOT_FOUND`. `RepoSession.single()` now hands its
callback an `AbortSignal` that fires when a newer call of the same method supersedes it, so both
methods stop reading objects instead of running to completion. `bun run record` writes
`pathHistories` (follow-renames, per path) and `blames` (per path, `w:`-prefixed for the `-w`
recording) into `<fixture>.v2.json` for the three `history` files the blame oracles cover.

<!-- T10.5b --> Five corrections to the T10.5 walker, from an independent review of 59d121a.

**Ordering — what the walk actually guarantees.** git computes `--date-order` in two passes: the
whole candidate list (`limit_list`), then an indegree over that list and a date-priority release
(`sort_in_topological_order`). `walkCommits` does the same two passes over a **window**: before any
commit is released, `limit + LOOKAHEAD` (512) further commits have been discovered and their
indegrees counted. The guarantee is therefore: **the page equals `git log --date-order` unless a
commit is older than one of its own parents by more than `limit + 512` commits of history.** Under
that much committer-date skew the order can differ from git's and the extra child edge is dropped
rather than drawn (`placeCommit` never reserves a lane for an already-emitted oid and never emits an
edge into one, so no lane leaks and no line is left dangling). The earlier claim that a streaming
indegree "agrees whenever commit dates do not increase towards the parents" was too weak: a parent
newer than its child could be emitted first and leak a lane — `fixtures/skew` is that case, built
with `git commit-tree` and explicit `GIT_COMMITTER_DATE`s.

**`WalkPage.cursor` is an opaque token.** It is `w<8 hex>.<n>` (13 bytes), a key into walk state the
session holds; the walk state itself never crosses the worker boundary. A token the session does not
hold — a worker restart, a `reloadRefs()`, more than eight pages ago — and a token whose request key
no longer matches the request (`from`, `firstParent`, `all`, `path`) both reject with **`STALE`**:
**the UI must drop the list it has and restart from page 1 when `walkCommits` answers `STALE`**;
silently restarting inside the engine duplicated rows while refs moved. A cursor string that is not
a token this engine issues at all is a caller bug and answers `INTERNAL` with the text as `detail`.
A `limit` that is not a positive integer is likewise `INTERNAL`.

**`WalkPage.laneOverflow: boolean`** is true when a row in that page needed more than `MAX_LANES`
(12) lanes: the extra lanes are folded into the last one and `laneCount` is capped at 12, so the
graph column stays drawable but is no longer faithful — the UI offers `first-parent` when it is set.

**`aheadBehind` is exact under its cap.** It is git's own algorithm: one date-ordered priority queue
seeded `LEFT`/`RIGHT`, a commit carrying both flags is COMMON and counted for neither side, and the
walk stops as soon as nothing but COMMON is left (`still_interesting`). Two branches five commits
apart on a 10,000-commit trunk walk six commits. `capped` therefore means the *divergence* exceeded
the cap, not that two independently truncated reachability sets were subtracted; the counts are
lower bounds only then. `branchCells` memoises the result per `(a, b)` pair for the current refs
snapshot. `TagInfo` gains `targetType: "commit" | "tree" | "blob"` — a tag can name a blob (git.git
ships `refs/tags/junio-gpg-pub`) and everything that seeds a walk skips anything but `"commit"`,
exactly as `git log --all` does; `CommitReader.meta` answers null for a non-commit.

**Cancellation.** `RepoSession.single()`'s `AbortSignal` now reaches `WalkDeps`, `reachableFrom`,
`aheadBehind` and `CommitStatsDeps`, and every loop checks it, so a superseded call stops reading
objects instead of running to completion. `walkCommits` reports `{ phase: "history", done }` every
500 commits discovered rather than once at the end.

`WARNING_CODES` gains **`HISTORY_DEGRADED`**: an object read that history fell back from instead of
failing the page (an unreadable commit-graph, a ref whose commit cannot be read, a commit whose
stats could not be computed). `detail` is `IO_ERROR: <what>`. `bun run record` writes
`WalkPage.laneOverflow` into `walks`; the `tags` fixture gains a blob tag and a tree tag, `octopus`
gains a commit-graph (so the EDGE chunk is exercised), and `FIXTURES_PERF=1` also builds `perf-log`
(2,000 linear commits + 50 branches) for `docs/perf.md`.
<!-- T10.7 --> `scanSecrets(generation)` reuses `describeFile` on every row of the current diff
whose `layers` include `staged` or `unstaged`, and reads the **added** lines of its hunks — so the
scan costs what the change costs, not what the repository costs, and never looks at committed
history. Skipped without reading a byte: rows with no uncommitted layer, `generated` rows and paths
matched by `.diffgitignore-secrets` (gitignore syntax, repository root, re-read on every scan);
skipped after loading: binary and `tooLarge` rows. `SecretFinding.layer` is `unstaged` whenever the
row has unstaged work, because that is where the line is now. `SecretFinding.masked` is the
redaction the UI shows by default — first 8 characters, `…`, last 4, or `•` per character for a
value of 12 or fewer — and `SecretFinding.full` is the matched value itself, which only the card's
explicit **Reveal** click renders (atlas tab 14); nothing else in the payload carries it and the
engine never logs it. `SecretFinding.entropy` is `shannonEntropy` of the matched value in bits/char,
rounded to two decimals, reported for every finding even when its rule did not gate on entropy.
The rule table is `src/engine/scan/secretRules.ts` — `{ id, description, regex, group?, entropyMin? }`
plus `RULESET_DATE`, `ALLOW_COMMENT`, `SECRET_ALLOWLIST_FILE`, `ENTROPY_FLOOR = 3.8` — ordered by
precedence, vendor shapes first and the four generic assignment rules last, so a value matched by
two rules produces **one** finding under the more specific rule (overlapping spans are deduped).
Dropped before reporting: allowlisted lines (`# diffgit:allow-secret` / `// …` / `-- …` / `<!-- … -->`
at the end of the line), bare 40/64-hex digests, and values that merely *name* a secret
(`process.env.API_KEY`, `${TOKEN}`, `{{ vault_x }}`, `<your-token>`). A documentation key such as
`AKIAIOSFODNN7EXAMPLE` **is** reported: the shape is unambiguous and the two allowlists are the
escape hatch. Findings are sorted by path, line, rule, masked and capped at `SECRET_FINDING_CAP`
(500); one `SECRETS_FOUND` warning carries the total in `detail` and says when the list was cut.
`ProgressPhase` gains `"secrets"` (`done`/`total` = files scanned). `bun run record` records the
`secrets` fixture and writes `secrets` (the whole finding list) into `<fixture>.v2.json`.
`commitStats` now keys its record in the caller's order rather than the order the batch finished
in, which is what made `bun run record` drift between runs.

<!-- T10.8 --> `search(req)` is one method for the palette's three scopes, each its own module
under `src/engine/search/`. `SearchRequest.query` is a **literal substring** unless `regex` is set:
exact mode builds no regular expression at all (`indexOf` on a case-folded copy), so a query full of
metacharacters is text and there is nothing to inject into. Regex mode is capped at
`REGEX_MAX_LENGTH` (200), compiled with the `u` flag inside a `try`/`catch`, and given a
`REGEX_FILE_BUDGET_MS` (50 ms) budget per file in the `worktree` scope — a file that outruns it is
abandoned and counted as skipped. Matching is **case-insensitive in both modes**, which is why the
`git grep` oracle is `-in` and the case-sensitive `-n` answer is asserted only as a subset. An
empty, over-long or uncompilable query is refused with `INTERNAL` plus a hint (phase 10 spells bad
input that way; there is no public code for "you typed something we cannot use").
`SearchResult.capped` means the answer is **incomplete** for any reason — the hit limit, the commit
cap, or a skipped file — and is exactly when `SEARCH_CAPPED` is raised, with the reason in `detail`.
`scanned` counts commits for `commits`/`pickaxe` and files read for `worktree`.

The `commits` scope asks T10.5's `walkCommits` for **one** capped page (`req.commits`, default
1,000) and matches, in this order, an object-name prefix (4–40 hex, exact mode only), the subject,
the author's name and email, and only then `%B` — the one step that costs an object read. It is
therefore `git log --grep` ∪ `--author` ∪ a SHA lookup in one box, and it reads the **raw** author
header: `git log`'s own `--author` applies `.mailmap` by default, so the parity oracle passes
`--no-use-mailmap`; folding the two addresses together is T10.9's, which owns `.mailmap`.
The `worktree` scope greps the stage-0 index entries that exist on disk plus the untracked files the
scanner's ignore rules let through (so it is a superset of `git grep`, which only looks at tracked
files), skipping `generated` rows, binary files and anything over 1 MB; files are read in path order
in batches of `GREP_BATCH` through the session's stats limiter, so the hit list is already sorted by
(path, line) and a `limit` keeps the head git would have printed first.
The `pickaxe` scope walks the **first-parent** chain (`req.commits`, default 200, mandatory in the
UI), tree-diffs each commit against its first parent restricted to `path`, and reports a commit when
the occurrence count differs for **at least one** changed file — git's own `diffcore-pickaxe` rule —
with `delta` as the total change for the row. Under `--first-parent` git diffs a merge against its
mainline and can report it, and so does this. Two documented divergences from `git log -S`: rename
detection is not run before the count (a `git mv` is a delete plus an add, which differs only for a
rename that leaves the count untouched), and binary or over-1-MB blobs are skipped rather than
byte-counted (each skip sets `capped`). The working tree is one extra hit with **no** `oid` and
`subject: "Uncommitted changes"` when the uncommitted work changes the count.
`ProgressPhase` gains `"search"`. `bun run record` writes `searches` (the `worktree` and `pickaxe`
answers for a few queries per fixture, keyed by `searchKey`, `durationMs` pinned to 0) into
`<fixture>.v2.json`; the mock runs the `commits` scope live against the recorded walk instead, so
T11.8 can type anything into the palette.
<!-- T10.9 --> `insights(req)` is **one first-parent walk from `HEAD`** (`walkCommits({ firstParent:
true })`, so it shares the commit-graph reader, the 50,000-commit cap and `single()`'s abort signal)
plus a **path-level** tree diff of every in-window commit against its first parent — no blob reads,
which is what makes a whole-history pass affordable (atlas tab 13). Exactly what each field means,
and the `fixture-expectations.sh` oracle that pins it:

| field | definition | oracle on `history` |
|---|---|---|
| `walked` | first-parent commits visited, before `sinceMs` | `git rev-list --count --first-parent main` = 48 |
| `commits` | of those, the ones with **author date** ≥ `sinceMs` | the same, `--since` applied |
| `authors` | commits per author **name** after `.mailmap`, bots removed, commits desc then name | `git log --first-parent --format='%aN <%aE>'`, folded by name |
| `bots` | in-window commits by a bot; `authors.commits + bots === commits` | the same list, filtered |
| `hotspots` | per-path commit counts scored `commits × log2(max(size, 2))`, rounded to 3 decimals | `git log --first-parent --no-renames --format= --name-only` + `git ls-tree -r -l main` |
| `activity` | commits per **local** day, in weeks of 7 | `git log --first-parent --date=format-local:'%Y-%m-%d' --format=%ad` |

`sinceMs` and `activity` both use the **author** date — the brief fixes it for `activity`, and one
clock for both is what makes `activity` sum to `commits`. A merge counts, and its first-parent tree
diff is everything it brought in, exactly as `git log --first-parent --name-only` prints it. The
per-commit diff runs **without rename detection** (pairing a rename costs blob reads per commit,
the one cost this walk exists to avoid), so a `git mv` counts against both names. `activity` is at
most 52 weeks ending at the week of the **newest commit in range**, not at the wall clock: the
engine has no clock input here and a result keyed on `Date.now()` could not be asserted against git;
an idle repository shows its last 52 active weeks instead of 52 empty ones. `weekStart` is the local
midnight of that week's **Sunday** and `days[0]` is that Sunday. `hotspots` is the top `limit` real
files followed by the top `limit` **manifests** (`isManifestPath`: `package.json`, lockfiles,
`go.sum`, `Cargo.lock`, … matched on the basename) — manifests are excluded from the ranking, not
from the answer, so the UI can grey them out. `size` is the blob size at the walk tip (0 for a path
that is no longer there, which scores its commit count); sizes are read for at most
`HOTSPOT_SIZE_READS` (2,000) paths, in commit-count order. `isBotIdentity` is `/\[bot\]$/i` or
`/^(?:dependabot|renovate)/i` against the mapped name **and** the email's local part — the brief's
`/^dependabot|renovate/i` is read as an anchored alternation, which is plainly what it meant.
`src/engine/git/mailmap.ts` follows **`mailmap.c`**, not the prose of `gitmailmap(5)`: all four line
forms, case-insensitive email and commit-name lookup, field-by-field override by later lines, and a
comment only when `#` is the **first** character of the line (`Mid # hash <a@b>` really does define
a name containing a `#` — verified with `git check-mailmap`). `ProgressPhase` gains `"insights"`
(`done` = first-parent commits processed, every 500). `bun run record` writes `insights` (the
whole-history pass, `limit: 25`) into `<fixture>.v2.json` and now runs under **`TZ=UTC`**, because
`activity` buckets at local midnight and the recording has to be the same on every machine; the
`insights-days.txt` oracle is recorded under `TZ=UTC` for the same reason (`bun test` pins its
process to UTC). `summarise()` / `RepoSummary` stay with T10.10, as the EngineApi table says.

```ts
export interface ResolvedRevision {
  expr: string; oid: Oid | null;                     // null only for "<root>^" → empty tree
  kind: "branch" | "remote" | "tag" | "stash" | "commit" | "head" | "empty-tree";
  display: string;                                    // "main", "v2.3.0", "stash@{0}", "a1b2c3d"
  fullRef?: string;                                   // refs/heads/main, refs/tags/v2.3.0
  peeledFrom?: Oid;                                   // annotated tag object oid
}
export interface TagInfo { name: string; fullName: string; oid: Oid; targetOid: Oid;
  targetType: "commit" | "tree" | "blob"; annotated: boolean;                       // targetType: T10.5b
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
  capped: boolean; laneOverflow: boolean }                                          // laneOverflow: T10.5b
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

<!-- T10.10 --> `patchText(generation, ids)` renders the rows of the **current** `DiffResult` with
`src/engine/diff/patchText.ts` (pure; the session loads the sides and runs `describeFile` with
`loadLarge: true`, so a `tooLarge` row still carries real hunks). Output is deterministic: rows come
out in `DiffResult` order whatever order `ids` lists them in, an empty `ids` array is `""`, and an id
the generation does not hold is `INTERNAL`. Object names are written **in full** (git's
`--full-index`): `git apply` refuses a binary row "without full index line", and a binary row is how
both a binary file and a `huge` (> 10 MB) one are carried — git rebuilds the postimage by reading the
blob out of the object database, so the row applies whenever that blob exists. A `huge` row is
preceded by a `# diffgit: …` note, which `git apply`'s header scan skips. Header forms follow git
exactly: `new file mode` / `deleted file mode` / `old mode` + `new mode` (before `similarity index`,
as `fill_metainfo` emits them), `similarity index N%` + `rename from`/`rename to` (`copy from`/`copy
to` for a copy), no `index`/`---`/`+++`/hunks at all for a pure rename or a pure mode change, the
mode suffix on `index` only when both modes are equal, `/dev/null` for an absent side, `@@ -a,b +c,d
@@` with git's `,1` elision, `\ No newline at end of file` after the last line of whichever side
lacks it, and `quote_c_style` path quoting (non-ASCII as `\ooo`, `core.quotepath`'s default).
**Hunk boundaries are not git's** — `tasks/README.md` "Parity scope" already excludes them — so the
patch is asserted by `git apply --check` plus a full replay on a temp copy of the fixture, never by
byte-equality with `git diff`.

`summarise()` is the dashboard card and is deliberately **generation-free**: it calls no
`computeDiff`, changes no generation and never reassigns `RepoSession.refs`, so an open diff keeps
resolving its ids while it runs. It re-reads refs with `loadRefs`, re-runs `detectOperation`, re-reads
`.git/index`, and runs `WorktreeScanner.scan` with the new fourth argument `ScanOptions`
(`{ hashes: false }`), which drops the untracked hashing budget to nothing — the unstaged pass still
hashes what git's own racy-clean stat check cannot settle, or the counts would be wrong.
`RepoSummary.counts` are per layer and a path that is both staged and unstaged counts in both, which
is what `git status --porcelain=v2`'s two columns say. `vsUpstream` is `aheadBehind(HEAD,
upstreamOf(headBranch))` through the same memo `branchCells` uses, null when HEAD is detached or the
branch tracks nothing; `lastCommit.timestamp` is the **committer** date in ms, like
`BranchRow.lastCommit`. `indexMtimeMs` is the cache key atlas tab 11 asks for. `bun run record`
writes `summary` into `<fixture>.v2.json` with `indexMtimeMs` and the operation's `startedAt` pinned;
the patch is not recorded — the mock renders it with this same writer off the recorded rows, so a
subset by id works there too.

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
| `walkCommits(req: WalkRequest): Promise<WalkPage>` | T10.5 | cursor = opaque session token (T10.5b); `STALE` when it is no longer valid — the UI restarts the list. Lanes assigned per page continuously. |
| `commitDetails(oid: Oid): Promise<CommitDetails>` | T10.5 | |
| `commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>>` | T10.5 | vs first parent, path-level + numstat, batched. |
| `aheadBehind(a: string, b: string): Promise<AheadBehind>` | T10.5 | git's painted queue; cap 10,000 commits **walked** (T10.5b), exact below it. |
| `branchOverview(): Promise<BranchRow[]>` | T10.5 | lazily computed cells are `null` until `branchCells(names)` fills them. |
| `branchCells(fullNames: string[]): Promise<Record<string, Pick<BranchRow, "vsUpstream" \| "vsDefault" \| "merged">>>` | T10.5 | |
| `pathHistory(ref: string, path: string, opts: { follow: boolean; limit: number; cursor?: string }): Promise<{ entries: PathHistoryEntry[]; cursor: string \| null }>` | T10.6 | |
| `blame(ref: string, path: string, opts: { ignoreWhitespace: boolean; includeWorktree: boolean; maxRevisions: number }): Promise<BlamePayload>` | T10.6 | progress phase `"blame"`. |
| `scanSecrets(generation: number): Promise<SecretFinding[]>` | T10.7 | added lines of staged+unstaged hunks only. |
| `search(req: SearchRequest): Promise<SearchResult>` | T10.8 | three scopes, literal by default, `SEARCH_CAPPED` when partial; progress phase `"search"`. |
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

<!-- T11.1 --> The fields exist in `src/ui/store.ts` now. Those whose engine type a later phase-10
task still has to add (`RepoOperation`, `SecretFinding`, `HiddenEntry`, `CommitSummary`,
`BisectState & BisectStep`) are annotated with the local alias `PendingEngineType = never`, so the
field is present and empty until the task that owns the type widens that one annotation. `mode`
lives in both `Prefs` (validated, defaulted) and `StoreState`; the live value is the store's and it
always starts at `"files"` — the pref is never written back, per the contract's comment. The store
also gained `setMode(mode)` (closes the palette) and `setPalette(open)`; `closeRepo` resets every
v2 field.

<!-- T11.2 --> `StoreState` gained `tags: TagInfo[] | null` and `stashes: StashInfo[] | null` (null
= not listed; filled once per open by `loadPickerSources()`, which the picker calls the first time
it is opened) plus `setRevision(rev: ResolvedRevision, side: "source" | "target")`,
`setSpecialSource("worktree" | "staged")`, `setTwoDot(on)`, `resolveRevision(expr)` and
`applyCompare({ from, to, threeDot })`. `setSource`/`setTarget` keep their `RepoRef | string`
signature and delegate to `setRevision`, so nothing else had to change. The selector is
`selectSourceLabel(s)` → `"v2.3.0 … stash@{0}"` (`…` three-dot, `..` two-dot).
New pure module `src/ui/compareSource.ts` (`SideRev`, `sideOf`, `revToSide`, `buildSource`,
`labelOf`, `isRefExpr`) owns the single rule **two plain ref sides (`refs/heads/…`,
`refs/remotes/…`, `HEAD`) compared three-dot stay a `BranchesSource`; anything else — a tag, a
stash, a SHA, or two-dot — becomes a `RangeSource`**, so a `RangeSource` is never used where v1's
shape still fits and `lastSource`/`lastTarget` keep their meaning. A range is not persisted as the
remembered pair; `src/ui/compareHash.ts` (`compareSpecOf`, `formatCompareHash`, `parseCompareHash`,
`installCompareHash`) is the only deep link: `#compare=<from>...<to>` (`..` = two-dot), written with
`history.replaceState` on every source change and read once per page load, then applied to the first
repository opened afterwards.

<!-- T11.3 --> `StoreState.operation` is now the real `RepoOperation | null` (the `PendingEngineType`
annotation T11.1 left is gone) and is a **mirror of `RepoInfo.operation`**: it is written wherever
`repo` is, i.e. `openRepo`, the worker-restart listener and the scheduler's `reloadRefs()`, which a
git-side refresh tick always runs (`OPERATION_FILES` is stat-ed by `probe("git")`), so the Design
§14.3 banner follows git live and disappears with the operation. `StoreState` also gained
`reflog: ReflogEntry[] | null` (null = not read; `loadReflog()` fills it and then calls
`markReachable` in batches of 50 **only if the client exposes it** — T10.5 owns that method, so until
it ships every row keeps `reachable: null` and the `unreachable` badge is not rendered) and
`conflicts: Record<string, ConflictEntry>` (`loading | ready | error`, keyed by file id, cleared on
every compute). `recompute()` pre-loads `conflict(generation, id)` for every file in the `conflict`
layer, capped at `CONFLICT_PRELOAD_LIMIT` (100), because only `ConflictPayload.kind` can tell git's
`UD` from `DU` and the sidebar prints that code. Selectors: `selectConflictKind(s, id)` and
`selectConflictKinds(s)`. New pure module `src/ui/operation.ts` (`describeOperation`,
`operationSteps`, `describeConflictKind`, `conflictCommand`, `short`) owns every string the banner
and the conflict card show.

<!-- T11.4 --> `StoreState.hidden` is now the real `HiddenEntry[] | null` (the `PendingEngineType`
annotation is gone) and is **lazy**: `setPref("showHidden", true)` calls the new `loadHidden()` once,
`recompute()` refreshes it after every commit while the toggle is on (so the group follows the
working tree like every other group), and turning the toggle off sets it back to `null` — nothing
walks for a listing nobody is looking at. `StoreState` also gained `explainPath(path)` (a thin pass
through to the engine; the popover keeps its own loading/error state) and `reopenSession()`, which
re-opens the current handle on the same compare pair. `openRepo` now passes
`{ builtinExcludes: prefs.builtinExcludes }` to `client().open`, and `setPref("builtinExcludes", …)`
calls `reopenSession()`, closing backlog **B10** — the excludes are baked into `IgnoreRules` at open
time, so the preference cannot be applied any other way. Selector `selectHiddenEntries(s)` returns
the group's rows (null while it is not up) narrowed by the **path part** of the file filter only;
`status:` / `layer:` tokens are meaningless for a hidden path and leave it alone. New pure module
`src/ui/hidden.ts` (`HIDDEN_TAG`, `HIDDEN_SENTENCE`, `hiddenRowLabel`, `explanationTitle`,
`describeReason`, `BUILTIN_SOURCE`, `GLOBAL_EXCLUDES_NOTE`, `AUTHORITY_NOTE`) owns every string the
group and the popover show. `treeModel` gained `SidebarSectionId = SidebarGroupId | "hidden"`:
`Hidden` is a sidebar *section*, never a group of the diff, so `groupOf` / `GROUP_ORDER` /
`selectGroupTotals` are untouched.

<!-- T11.5 --> `HistoryState.commits` is now the real `CommitSummary[]` (the `PendingEngineType`
annotation is gone) and the slice gained `laneOverflow: boolean`, which reads
`WalkPage.laneOverflow` forward-compatibly — T10.5b adds the field and the list header then offers
the `first-parent` toggle. `StoreState` also gained `commitDetails: Record<Oid, CommitDetailsEntry>`
(`loading | ready | error`, cached per oid for the session), `commitStats: Record<Oid,
CommitDetails["stats"]>`, `stack: StackState` (`commits`, `base`, `tip`, `label`, `loading`,
`ready`, `capped`) and `compareBase: { expr; display } | null` — the base picker's side while it is
a plain ref, so `Compare with base…` means the branch the user chose rather than the parent the
last commit click put on the base side. Actions: `setHistoryTab`, `loadHistory(reset?)`,
`setHistoryQuery`, `setHistoryOption("firstParent" | "all", on)`, `showCommit(oid, { extend })`,
`loadCommitDetails`, `requestCommitStats`, `searchCommits` (null until T10.8 ships `search`),
`loadStack` and `compareCommitWithBase`. Selector `selectHistoryRows(s)`.
Selecting a commit builds `RangeSource{ commit, fromRef: "<oid>^", fromOid: firstParent ?? null,
toOid: oid, threeDot: false }` and a shift-selected pair builds `older…newer` (two-dot, no
`commit`); both are applied through an internal `applyRange` that, unlike `applySides`, neither
remembers a branch pair nor invalidates the stack. `walkCommits` is asked for `HISTORY_PAGE` (50)
commits from the compare side while that side is a plain ref and from `HEAD` once a commit
selection has turned the source into a range. `commitStats` and `walkCommits` are single-in-flight
in the engine, so the visible rows queue in the store and one drain loop serialises the batches; a
`STALE` answer to a *cursored* page discards the list and walks again from the tip (T10.5b), never
appends. New pure module `src/ui/history.ts` (`laneX`, `laneColor`, `LANE_TOKENS`, `edgePath`,
`incomingPath`, `incomingLanes`, `commitRange`, `spanRange`, `matchesCommit`, `refChipKind`,
`formatCommitDate`, `formatSignature`, `cherryPickCommand`, `shortOid`, the page sizes) owns the
lane geometry and every string the list and the card show.

<!-- T11.6 --> `StoreState.cardModes` is now live and gained `setCardMode(id, mode)`; the card
control is rendered only when `hasCommittedSide(file)` (`FileCard`) — `oldOid !== null` or the
`committed` layer — so an untracked-only file and a conflicted file (whose card is the three-way
view) do not get it, per Design §14.1. `StoreState` also gained `blames: Record<string, BlameEntry>`
(`loading | ready | error`, `ready` carrying the `maxRevisions` it was asked for) and
`pathHistories: Record<string, PathHistoryState>` (`entries`, `cursor`, `loading`, `error`), keyed
by the new pure helpers `blameCacheKey(oid, path, ignoreWhitespace)` and
`pathHistoryCacheKey(oid, path, follow)` in `src/ui/blame.ts`. Actions `loadBlame(path, { at,
ignoreWhitespace, maxRevisions? })` and `loadPathHistory(path, { at, follow, more? })`; both resolve
what to ask at through the exported selector `blameTarget(s, at)` → `{ ref, oid, includeWorktree }`
— the compare side of the current source (`RangeSource.toRef`/`toOid`, else `sourceRef` and its
oid), or the given commit, in which case `includeWorktree` is false. `includeWorktree` is therefore
**not** a control: it is the diff's own `includeWorktree` guarded by `isWorktreeSource`, so blame
shows exactly the text the card shows. `ignoreWhitespace` **is** a control, the card-local
`Ignore whitespace-only commits` checkbox (default on, Design §14.1), independent of the StatsRow's
`prefs.ignoreWhitespace`, which is about the *diff*.
`derivedKey.blame` gained a fourth argument and is now `blame:<repoId>:<oid>:<path>:<w|x>`; a blame
is written there **only when it does not contain the working tree**, because the derived cache is
keyed by a commit oid and only a commit fully determines such an answer. `BLAME_CAPPED` is filtered
out of `WarningBanners` (like T11.3's `OPERATION_IN_PROGRESS`): the card prints it as one inline
line with `Continue`, which re-asks with `maxRevisions + BLAME_REVISION_STEP` (400). Design gained
**§3.6**, the five-step `--heat1..5` age ramp the atlas used but `src/index.css` had not defined;
`blame.ts`'s `heatOf` spreads a revision's **age rank** across the five steps (oldest = `--heat1`,
newest = `--heat5`), which is its age quintile from five revisions up. New pure module
`src/ui/blame.ts` (`BLAME_REVISIONS`, `BLAME_REVISION_STEP`, `PATH_HISTORY_PAGE`, `HEAT_CLASS`,
`heatClass`, `ageOrder`, `heatOf`, `blameRows`, `revisionsLabel`, `cappedLine`, `renamedFromLabel`,
`splitLines`, the two key builders and every label) owns the maths and the copy.

<!-- T11.7 --> `StoreState` gained `branches: BranchesState` (`rows` = `branchOverview()` with
the expensive cells still null, `cells` = what `branchCells()` has filled since, keyed by full ref
name, plus `loading`, `error`, `filter` and `query`) and the actions `loadBranches()` (once per
repository), `requestBranchCells(fullNames)`, `setBranchFilter`, `setBranchQuery`,
`showBranchHistory(fullName)`, `compareBranchWithBase(fullName)` and `compareTags(previous, tag)`.
`requestBranchCells` is the `requestCommitStats` rule again: `branchCells` is single-in-flight in
the engine, so the table's rows queue in the store and one drain loop asks in batches of
`BRANCH_CELL_BATCH` (50). A name the engine does not answer for is written back as
`{ vsUpstream: null, vsDefault: null, merged: null }`, so a ref that vanished stops being asked for.
`closeRepo` resets the slice to `INITIAL_BRANCHES` and clears the queue.

**The base branch** is not a preference of its own. The new selector `selectBranchBase(s)` reads
the base side of the pickers while that side is a plain ref (T11.5's `compareBase`, which `openRepo`
seeds from the remembered `lastTarget` and every `Set as base` updates) and otherwise the
repository's own default branch — `RepoRef.isDefault`, resolved by the engine per D8
(`refs/remotes/<remote>/HEAD`, then `main`, then `master`). It is therefore chosen once and
remembered per repository by the mechanism that already remembers the compare pair; no second
source of truth. `compareBranchWithBase` and `compareTags` both go through `applySides`, so a row
action sets the source exactly as the picker does, including `lastSource`/`lastTarget` and the
`#compare=` hash.

The **`vs base` column is `branchCells.vsDefault`** and its header prints the default branch's own
name (`vs main`), because `BranchRow` carries exactly two comparisons and `branchCells` computes the
second one against `RefSnapshot.defaultRef`. When `Set as base` has moved the base elsewhere, the
column still says `vs <default>` and the row menu says `Compare with <base>`: each label names the
branch it really used, and no number is printed that was not computed. `AheadBehind.capped` is
rendered as a `≥` prefix on **both** counts (`≥4 ↑ ≥0 ↓`) with `CAPPED_TITLE` as the explanation —
T10.5b makes both counts lower bounds once the divergence walk hits its cap.

New pure module `src/ui/branches.ts` (`STALE_DAYS`/`STALE_MS`, `BRANCH_CELL_BATCH`, `BAR_W`,
`BranchFilter`, `BRANCH_FILTERS`, `BranchCells`, `isStale`, `matchesBranch`, `sortBranches`,
`filterBranches`, `countLabel`, `aheadBehindLabel`, `CAPPED_TITLE`, `barWidths`, `syncHint`,
`SYNC_TITLE`, `NO_UPSTREAM`, `MERGED_TITLE`, `tagKindLabel`, `tagMessageLine`, `sortTags`,
`previousTag`, `matchesTag`, `filterTags`, `overviewCounts` and the empty-state copy) owns the
filters, the order and every string. Tags are ordered by **name**, numerically aware, newest first:
git gives a lightweight tag no date of its own, so a date sort would order half the list by nothing;
the Age column shows a tagger date for an annotated tag and `—` for a lightweight one. The tags
table reads `StoreState.tags`, which `loadPickerSources()` already narrows to `targetType ===
"commit"` (T10.5b), so a blob or tree tag is listed no more than `git log --all` walks it.

Design §14.1's "in Branches and Insights the row is replaced by the page's own header" is now real:
`TopBar` renders `StatsRow` only outside Branches mode and moves its own `border-b` with it, and
`BranchesView`'s header is the same height, the same border and the same surface. `HISTORY_DEGRADED`
is shown as one inline line above the table, driven by the rows themselves (`branchOverview` hands
back a row with `lastCommit: null` for a tip it could not read) rather than by the warning, which
`recompute()` replaces on the next diff. `MenuItem` moved out of `CommitCard.tsx` into
`components/MenuItem.tsx` and gained a `disabled` + `title` pair, so both `…` menus share one row.
<!-- T11.9 --> `StoreState.secrets` is now the real `SecretFinding[] | null` (the
`PendingEngineType` annotation T11.1 left is gone). `null` means "this diff has not been scanned",
`[]` is a real answer, and the two are different things: an export (T11.10) must treat `null` as
unknown, not as clean. Every `recompute()` resets it to `null` and arms the scan for that
generation; the scan fires from the **stats sink** once that generation's stats have settled — the
scan and the stats pump both read file content in the engine, so the banner waits for the counts
instead of racing them — and immediately when the result already carried every `FileStats`.
"Settled" is `statsSettled(files, stats)`: every row has an answer (a number, or the explicit
`null` the engine streams for a file it could not count) or is one that never gets a `+n −m`
(binary, over the gate), so one unreadable file cannot hold a safety check back forever. A diff with no `staged`/`unstaged` row never reaches the engine at all: the new action
`scanSecrets(opts?: { announce?: boolean })` answers `[]` itself, which is the "not called for
committed-only diffs" rule. `announce` is the palette's `Re-scan for secrets`, which toasts all
three outcomes (found / nothing to scan / `NO_FINDINGS_NOTE`); `STALE` and `CANCELLED` go through
`ignoreStale` and leave the banner alone. Selectors: `selectSecrets`, `selectSecretCounts`
(file id → count, the sidebar chip), `selectFileSecrets(s, id)` (one card, memoised on the list)
and **`selectSecretGate`** → `{ scanned, findings, count, total }`, which is the gate T11.10's
export flow calls before it writes anything; `total` reads `SECRETS_FOUND.detail`, so it counts
past the 500-finding cap. `SECRETS_FOUND` is filtered out of `WarningBanners` (like
`OPERATION_IN_PROGRESS` and `BLAME_CAPPED`): the `SecretBanner` is the surface, and the cap
sentence is printed inside its finding list. `src/ui/scrollBus.ts` gained an optional new-side
line: `requestScrollTo(id, line?)` plus `takePendingLine(id)`, which the card claims when it mounts
after the jump (the pane is virtualised, so the target card is usually not mounted yet). New pure
module `src/ui/secrets.ts` (`SECRET_TAG`, `ALLOW_LINE_COMMENT`, `ALLOWLIST_FILE`, `RULESET_DATE`,
`hasUncommittedLayer`, `bannerCopy`, `cappedLine`, `byLine`, `entropyLabel`, `whereLine`,
`whyFlagged`, `findingLabel`, `locationLabel`, `displayValue`, `rotateChecklist`, `RULES_HELP`,
`NO_FINDINGS_NOTE`, `NOTHING_TO_SCAN_NOTE`, `foundNote`, `redactFindings`) owns every string; it
imports `ALLOW_COMMENT` / `SECRET_ALLOWLIST_FILE` / `RULESET_DATE` from
`src/engine/scan/secretRules.ts` (pure data, no imports of its own) so the spellings cannot drift.

<!-- T11.12 --> `StoreState` gained `insights: InsightsState` (`result`, `loading`, `error`, the
`tip` + `period` the result answers, `cached` = it came from `diffgit-derived`, and `walked` = the
live count the skeleton shows) with `loadInsights({ force })`, `setInsightsPeriod(period)` and
`showHotspot(path)`; `closeRepo` resets the slice to `INITIAL_INSIGHTS`. `loadInsights` is a no-op
while the slice already holds this tip and period, so the page may call it from an effect; it reads
`derivedKey.insights(repoId, tipOid, period)` first and writes the engine's answer back there, and
a repository with no commits (`RepoInfo.headOid === null`) is answered with `EMPTY_RESULT` without
touching the engine. `STALE` / `CANCELLED` go through `ignoreStale`.

**`sinceMs` is computed in the UI**, by the pure `sinceMsFor(period, anchor)` (`90d` → 90 days,
`1y` → 365, `all` → `undefined`, i.e. send no `sinceMs`), where `anchor` is the new exported
selector **`selectInsightsAnchor(s)`**: the newest commit date the store already knows (the commit
list's tip, or the newest `BranchRow.lastCommit`) and `Date.now()` only when it knows none. The
engine has no clock in this call — `activity` ends at the week of the newest commit, not at today
(`<!-- T10.9 -->`) — and the derived key carries only tip + period, so anchoring on a commit keeps
`90 d` meaning the same window for as long as that cache entry is valid, and a repository whose
last commit is a year old shows its last 90 active days instead of an empty page.

`INSIGHTS_CAPPED` is printed by the page as **one inline line** under the footer (Design §14, rule
2, as T11.6 did with `BLAME_CAPPED`), driven by `InsightsResult.capped` rather than by the warning;
`loadInsights` therefore calls `dismissWarning("INSIGHTS_CAPPED")` when the answer is capped, so the
same fact never also takes a banner — `WarningBanners` itself was not touched. New pure module
`src/ui/insights.ts` (`INSIGHTS_LIMIT` = 12 hotspots per group, `INSIGHTS_PERIODS`, `sinceMsFor`,
`countOrder`/`heatOfCount`/`heatFill` (the §3.6 ramp by rank, `blame.ts`'s rule for age),
`CELL`/`GAP`/`GUTTER`/`gridWidth`/`gridHeight`, `dayMs`/`formatDay`/`dayLabel`/`weekLabel`,
`hotspotGroups`/`barPercent`/`maxScore`/`hotspotValue`/`hotspotTitle`, `sharePercent`/`botsLine`,
`summaryLine`/`walkedLine`/`cappedLine`/`emptyPeriodLine`, `EMPTY_RESULT` and every string) owns the
maths and the copy. `TopBar` now hides the `StatsRow` in Insights as well as Branches, which is
§14.1's "in Branches and Insights the row is replaced by the page's own header"; `ModePlaceholder`
was deleted with the last placeholder mode it existed for.

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
`skip-worktree` file, `assume-unchanged` file, 11 MB file), `octopus` (three-parent merge, plus a commit-graph from T10.5b), `skew` (T10.5b: committer dates
that do not decrease toward the parents), and under `FIXTURES_PERF=1` `perf-log` (T10.5b: 2,000
linear commits + 50 branches). Each with
`fixture-expectations.sh` output from the real git CLI (`git tag -l --format`, `git stash list`,
`git reflog`, `git log --graph --oneline`, `git blame --porcelain`, `git check-ignore -v`,
`git rev-list --left-right --count`, `git log -S`, `git shortlog -sn`).
