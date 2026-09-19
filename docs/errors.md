# Error and warning taxonomy (T7.3)

The registry is `src/engine/errors.ts`. Three tiers:

- **fs-tier** (`ENOENT`, `EISDIR`, `ENOTDIR`, `EINVAL`, `EROFS`, `EACCES`, `EIO`): Node-shaped so
  isomorphic-git can branch on them; they never leave the engine. `toPublicError` in
  `src/engine/session.ts` maps them at the worker boundary: `EACCES → PERMISSION`, `ENOENT → IO_ERROR`
  (a vanished root is detected earlier by `RepoSession.withRootCheck` → `HANDLE_GONE`),
  `EIO/EISDIR/ENOTDIR/EINVAL → IO_ERROR`,
  `EROFS → INTERNAL` (a write was attempted: a bug, D16).
- **internal** (`SPLIT_INDEX`, `INDEX_TOO_LARGE`): thrown by `WorktreeScanner`, caught by `DiffEngine`
  and converted into the warning of the same name.
- **public** codes cross the worker boundary as `PublicError` and are the only codes `describeError`
  (`src/ui/errors.ts`) knows. **Warning** codes travel through `ProgressSink.onWarning` /
  `RepoInfo.warnings` / `DiffResult.warnings` and are rendered by `WarningBanners` with the copy in
  `src/ui/warnings.ts`.

`src/ui/errors.docs.test.ts` fails when the code sets, the two tables below, `describeError` or
`WARNING_COPY` drift apart (the *User copy* column must equal the title / banner subject).

## Public error codes

| Code | Thrown by | User copy | Action |
|---|---|---|---|
| `NOT_A_REPO` | `layoutChecks.checkLayout` (no `.git`, or `.git/HEAD` unreadable) | Not a git repository | choose-folder |
| `WORKTREE_GITDIR` | `layoutChecks.checkLayout` (`.git` is a `gitdir:` file) | Linked worktree | choose-folder |
| `BARE_REPO` | `layoutChecks.checkLayout` (`core.bare = true`) | Bare repository | choose-folder |
| `REFTABLE` | `layoutChecks.checkLayout` (`extensions.refStorage = reftable` or `.git/reftable`) | Reftable refs are not supported | choose-folder |
| `OBJECT_FORMAT_SHA256` | `layoutChecks.checkLayout` (`extensions.objectFormat = sha256`) | SHA-256 repository | choose-folder |
| `ALTERNATES` | `layoutChecks.checkLayout` (`.git/objects/info/alternates` present) | Objects live outside this folder | choose-folder |
| `PARTIAL_CLONE` | `layoutChecks.checkLayout` (`*.promisor` pack or `remote.*.promisor`) | Partial clone | choose-folder |
| `PACK_TOO_LARGE` | `layoutChecks.checkLayout` (packs on disk > 1 GB) | Repository too large | choose-folder |
| `INDEX_UNSUPPORTED` | `indexReader.parseIndex` (version other than 2–4, bad signature, unknown mandatory extension) | Unsupported index format | retry |
| `PERMISSION` | `layoutChecks` probes on `EACCES`; `toPublicError` for `EACCES` / `NotAllowedError` / `SecurityError`; `observer.ts` when `FileSystemObserver.observe` is refused; the store when `ensurePermission` is denied | Permission needed | reopen-permission |
| `HANDLE_GONE` | `RepoSession.withRootCheck` (any compute failure while `.git` is unreachable); `observer.ts` on a `disappeared`/`errored` record for the root | Folder not found | choose-folder |
| `IO_ERROR` | `toPublicError` for `EIO`, `EISDIR`, `ENOTDIR`, `EINVAL`, `ENOENT` (root still present), `NotReadableError`, `TypeMismatchError`, `InvalidStateError` | Read error | retry |
| `REF_NOT_FOUND` | `ObjectDb.resolveRef` (`NotFoundError` from isomorphic-git); `DiffEngine.compute` when the source or target ref vanished | Branch not found | retry |
| `CANCELLED` | `RepoSession.computeDiff` / `fileDiff` when superseded or aborted; `util/concurrency.throwIfAborted`; `WorkerClient.terminate` for in-flight calls | Cancelled | – |
| `STALE` | `RepoSession.requireGeneration` (call for an older `generation`) | Outdated result | retry |
| `TOO_LARGE` | `RepoSession.fileBytes` when a side exceeds 10 MB (`HUGE_FILE_BYTES`) | Too large | – |
| `WORKER_CRASHED` | `WorkerClient.onCrash` (worker `error` / `messageerror`), rejects every in-flight call | Engine restarted | retry |
| `STORAGE_UNAVAILABLE` | `persistence/index.ts` (`reportStorageError`, once per session) | Storage unavailable | – |
| `INTERNAL` | `workerApi.need()` (no session); `toPublicError` fallback; `WorkerClient` after `terminate()`; `observer.ts` on an unexpected exception; `EROFS` (D16 violation) | Something went wrong | retry |
| `REV_NOT_FOUND` | `revisions.resolveRevision` (T10.1: an expression did not resolve) | Revision not found | – |
| `REV_AMBIGUOUS` | `revisions.resolveRevision` (T10.1: a short SHA matched several objects; `detail` lists them) | Ambiguous revision | – |
| `NOT_A_PATCH` | `parsePatch` (T10.12: the text is not a unified diff) | Not a patch file | – |

## Warning codes

| Code | Emitted by | User copy | Level |
|---|---|---|---|
| `MULTI_PACK_INDEX` | `layoutChecks` (`.git/objects/pack/multi-pack-index`) | Multi-pack index | warning |
| `SHALLOW` | `layoutChecks` (`.git/shallow`); `DiffEngine` when the merge base hit the shallow boundary; `RepoSession.open` | Shallow clone | warning |
| `LFS_PRESENT` | `layoutChecks` (`filter.lfs` in config or `.gitattributes` `filter=lfs`) | Git LFS | warning |
| `AUTOCRLF` | `layoutChecks` (`core.autocrlf = true/input`); `WorktreeScanner` when it affects hashing | Line endings | warning |
| `PACK_LARGE` | `layoutChecks` (packs on disk > 300 MB); `RepoSession.checkMemory` (pack bytes read > 300 MB, `detail: "memory"`) | Large pack files | warning |
| `INDEX_CHECKSUM` | `RepoSession.open`, `WorktreeScanner` (`readIndex` returned `checksumOk = false` after the retry) | Index checksum mismatch | warning |
| `SPLIT_INDEX` | `WorktreeScanner` throws the internal code; `DiffEngine` converts it | Split index | error |
| `SPARSE_INDEX` | `WorktreeScanner` (sparse directory entries) | Sparse checkout | warning |
| `INDEX_TOO_LARGE` | `WorktreeScanner` throws the internal code (> `MAX_INDEX_ENTRIES`); `DiffEngine` converts it | Index too large | error |
| `UNTRACKED_CAPPED` | `WorktreeScanner` (more untracked files than the cap) | Untracked files capped | warning |
| `RENAME_LIMIT` | `renames.detectRenames` (`limit²` rule, `detail: "maxSideBytes"` for oversized sides) | Rename detection limited | warning |
| `FILE_TOO_LARGE` | `textDiff.describeFile` (> 1 MB side or > 3000 changed lines); `RepoSession` stats pump when a stats read fails | Large file skipped | warning |
| `EMBEDDED_REPO` | `WorktreeScanner` (nested `.git` that is not a gitlink) | Embedded repository | warning |
| `UNRELATED_HISTORIES` | `DiffEngine` (no merge base) | Unrelated histories | warning |
| `MULTIPLE_MERGE_BASES` | `DiffEngine` (`findMergeBase` returned several) | Multiple merge bases | warning |
| `WORKTREE_NOT_APPLICABLE` | `DiffEngine` (`includeWorktree` while the source is not `HEAD`) | Uncommitted changes hidden | info |
| `GLOBAL_EXCLUDES_UNAVAILABLE` | `IgnoreRules.load` (`core.excludesFile` outside the folder) | Global ignores unavailable | warning |
| `CONFIG_INCLUDE_SKIPPED` | `config.parseGitConfig` (`include.path` / `includeIf`) | Config include skipped | warning |
| `STALE_PACK_RETRIED` | `ObjectDb.withStalePackRetry`, `RepoSession.withStaleRetry` | Repository changed while reading | warning |
| `REFRESH_DEGRADED` | `refresh/scheduler.ts` (ladder live → polling → manual) | Live refresh unavailable | warning |
| `PATH_TYPE_CHANGED` | `WorktreeScanner` (file ↔ directory at the same path) | Path type changed | warning |
| `HISTORY_CAPPED` | `walkCommits` (T10.5: the page limit was reached) | History capped | warning |
| `NO_REFLOG` | `reflog` (T10.2: no `.git/logs`) | No reflog | warning |
| `SEARCH_CAPPED` | `search` (T10.8: the scan limit was reached) | Search capped | warning |
| `BLAME_CAPPED` | `blame` (T10.6: `maxRevisions` reached) | Blame capped | warning |
| `INSIGHTS_CAPPED` | `insights` (T10.9: the walk limit was reached) | Insights capped | warning |
| `HIDDEN_CAPPED` | `listHidden` (T10.4: more than 2,000 paths) | Hidden files capped | warning |
| `COMMIT_GRAPH_STALE` | `walkCommits` (T10.5: the commit-graph predates the refs) | Commit graph out of date | warning |
| `SECRETS_FOUND` | `scanSecrets` (T10.7: a rule matched an added line) | Possible secret | error |
| `OPERATION_IN_PROGRESS` | `operation` (T10.2: MERGE_HEAD / rebase-merge / CHERRY_PICK_HEAD / BISECT_LOG) | Operation in progress | info |
| `SNAPSHOT_MODE` | `browserGate` (T11.15: Firefox/Safari read-once mode) | Snapshot mode | warning |
| `JJ_COLOCATED` | `layoutChecks` (T10.12: `.jj` beside `.git`) | Colocated jj repository | info |
| `PATCH_ONLY` | `parsePatch` (T10.12: patch-only mode, no repository) | Patch only | info |

## Silent-failure review (every `catch` in `src/**`, 2026-09-17)

Rule: a catch rethrows, converts to a typed error, or emits a warning/UI state. Comment-only bodies
are allowed only where the failure is genuinely unobservable and the comment says why. A guard in
`scripts/check-guards.sh` fails `bun run check` on any empty catch body.

Changed in this pass:

- `BinaryNotice` "View as text" showed an empty pane when `fileBytes` failed → shows the
  `describeError` copy in the notice (STALE/CANCELLED leave the notice unchanged).
- `FileHeader` copy-path swallowed clipboard failures → the button shows "Copy failed" for 1.5 s.
- `layoutChecks.kindOf` / `readTextOrNull` / pack listing treated `EIO` (and any unknown error) as
  "absent", which could turn a read failure into `NOT_A_REPO` → they now rethrow anything that is
  not ENOENT/ENOTDIR/EISDIR/EINVAL or EACCES, surfacing as `IO_ERROR`.
- `RepoSession.fileBytes` returned unbounded buffers → `TOO_LARGE` above 10 MB (the code was in the
  registry and `describeError` but never thrown).

Accepted as-is (with the reason recorded next to each catch):

- **Superseded work**: the store's `recompute` / `loadFileDiff` drop `CANCELLED` and `STALE`
  (a newer compute owns the screen; the scheduler is the only other place that ignores `CANCELLED`);
  `ignoreStale` logs anything else with `console.warn`. `BinaryNotice` follows the same rule.
- **Dead sink**: `RepoSession.emit` / `emitWarning` / stats `flush` ignore a throwing sink — the sink
  is the page; if it is gone there is nobody to tell, and the engine must not abort a compute over it.
- **Best-effort highlighting**: `highlight.worker.ts` grammar load failure → plain tokens for that
  language (`failed` set, no retry storm); `highlightClient` → `inlineTokenize` fallback; `DiffBody`
  → unhighlighted render. Highlighting is decoration, never data.
- **Probes**: `statSig`, `probeGit`, `probeIndex`, `probeUntracked` treat ENOENT/ENOTDIR as "absent"
  (that is the signal) and rethrow everything else to the poller, which reports through `onError`.
- **Optional files**: `config.loadGitConfig`, `ignoreRules.readOrNull`, `attributes.readOptional`,
  `objectDb.readSymref`, `indexReader.readIndex` treat a missing file as empty and rethrow the rest.
- **Scan races**: `WorktreeScanner` ignores a file that vanished between `readdir` and `open`
  (ENOENT/EISDIR) — the next refresh sees the final state; `nodeDirHandle.entries` skips a dirent
  whose `stat` fails (test adapter only).
- **Persistence**: `storage.guarded`, `prefs.*` report once through `STORAGE_UNAVAILABLE`;
  `repos.isSameEntry` failure → "not the same"; `ensurePermission` failure → "denied".
- **Diagnostics**: `store.debugMetrics` shows dashes when the engine is not open; `approxBytes`
  returns 0 for unserialisable results; `closeRepo` logs a failing `close()` (the session is being
  discarded).
- **Observer**: `disconnect()` after the handle vanished may throw; nothing is left to release.
- **Merge base**: `ObjectDb.mergeBase` maps isomorphic-git's `NotFoundError` to "no merge base"
  (→ `UNRELATED_HISTORIES`). A missing *object* in a corrupt repository would look the same; listed
  in `docs/backlog.md`.

`STALE` flow: `requireGeneration` throws it for any call carrying an older generation; the client
maps it unchanged; the store drops it without a toast. `WORKER_CRASHED` flow: `onCrash` runs at most
once per crash (`dead` latch: a second `error`/`messageerror` event for the same worker is ignored),
terminates the old worker, rejects in-flight calls, boots one new worker and re-opens the retained
handle; the store shows "Engine restarted, refreshing" and recomputes the last source.

## Torn reads (R2)

- `readIndex`: checksum verified; on mismatch or a truncated file it waits `INDEX_RETRY_MS` and reads
  once more; still bad → `checksumOk = false` and an `INDEX_CHECKSUM` warning, never a throw
  (`indexReader.test.ts` "torn index"). `WorktreeScanner` keeps the last good snapshot.
- Refs: isomorphic-git reads the loose file first and falls back to `packed-refs`, so a ref that git
  has just packed (loose file gone, `.lock` present) still resolves (`objectDb.test.ts` "packed-refs
  lock window"). A ref that is gone from both is `REF_NOT_FOUND`; the scheduler then falls back to
  the default branches (D5).
- Packs: `ObjectDb.withStalePackRetry` / `RepoSession.withStaleRetry` drop caches and retry once on
  ENOENT / IO_ERROR, emitting `STALE_PACK_RETRIED`.
