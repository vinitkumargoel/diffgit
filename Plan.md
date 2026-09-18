# diffgit — Browser-only Git Diff Portal

**Status:** Planning complete. Per-task briefs for implementation agents live in [`tasks/`](tasks/README.md) (one file per task, 43 tasks).
**Target URL:** https://diffgit.com (Cloudflare Pages, static)
**One-line:** Open a local git repo folder in Chrome, pick a source branch and a target branch, and read a GitHub-style diff (including uncommitted work) — nothing leaves the browser, nothing on disk is ever modified.

---

## 0. Decision log (settled with the owner, do not re-open)

| # | Decision | Choice |
|---|----------|--------|
| D1 | App shape | Browser-only static web app. No backend, no local daemon. Git objects read in-browser. |
| D2 | Hosting | Cloudflare Pages, custom domain `diffgit.com` (zone already on Cloudflare NS `elsa/max.ns.cloudflare.com`). |
| D3 | Folder access | File System Access API (`showDirectoryPicker`). **Chromium-only for v1** (Chrome/Edge/Arc/Brave). Firefox/Safari get a clear "unsupported browser" page. |
| D4 | Repos | Single active repo at a time + "recent repos" list (handles persisted in IndexedDB). |
| D5 | Comparison | Source branch (default: checked-out branch) vs target branch (default: repo default branch). **Merge-base / three-dot semantics** like GitHub Compare: diff from `merge-base(target, source)` → `source`. |
| D6 | Working tree | Uncommitted changes (staged / unstaged / untracked) are layered on top **only when source == checked-out branch**. Toggle "Include uncommitted changes" (default on). Per-file badge shows which layer(s) changed. |
| D7 | Same branch, clean tree | Explicit "No changes" empty state. |
| D8 | Default branch resolution | `refs/remotes/origin/HEAD` → local `main` → local `master` → current HEAD. Last-picked target remembered per repo. |
| D9 | Branch picker | Local + remote-tracking branches, grouped. |
| D10 | Auto-refresh | `FileSystemObserver` (Chrome 133+ desktop) when available, cheap polling fallback, plus manual refresh button. |
| D11 | Repo size | Optimised for ordinary repos. All git work in a Web Worker. Documented soft limits, not monorepo engineering. |
| D12 | v1 features | File list with +/- counts, unified + split view, syntax highlighting, collapse/expand, "viewed" checkboxes, file filter, whitespace-ignore toggle, rename detection, binary/image handling, large-file guard. |
| D13 | Explicitly out of v1 | Commit history browsing, inline comments, ref-to-ref by arbitrary commit SHA, multi-repo side-by-side, any write operation. |
| D14 | Stack | Bun (package manager + scripts + unit tests), Vite + React 19 + TypeScript, Tailwind v4. |
| D15 | Privacy | Zero network calls after page load (enforced by CSP `connect-src 'none'`). No analytics. |
| D16 | Disk safety | Folder opened with `mode: "read"`. The fs adapter's write methods throw. This is a hard invariant. |

---

## 1. Research findings that shape the design (verified 2026-09-16)

1. **isomorphic-git 1.42.2** (actively maintained) is a pure-JS git. It reads loose objects, packfiles (+deltas), `packed-refs`, symrefs. It has **no** support for index format v3/v4 (throws), split index, sparse index, multi-pack-index, reftable. It ships no File System Access adapter; we write our own.
2. **`statusMatrix` writes to `.git/index`** (stat-cache refresh) and its WORKDIR walker **descends into ignored dirs like `node_modules`** before filtering. Therefore: **we do not use isomorphic-git for working-tree status at all.** We use it only as the object database + ref reader (all pure reads). We write our own index parser (v2/v3/v4) and gitignore-pruning workdir walker.
3. **`FileSystemDirectoryHandle` is structured-cloneable**: storable in IndexedDB and **postable to a Web Worker**. After reload the permission state is `"prompt"`; one `requestPermission({mode:"read"})` click restores it (must be triggered from a user gesture).
4. **`FileSystemObserver`** shipped in Chrome 133 desktop for local directories (`observe(handle, {recursive:true})`). Not on Android, not in other engines. Feature-detect.
5. **`@git-diff-view/react` 0.1.7** computes a diff directly from two content strings (`generateDiffFile(oldName, oldContent, newName, newContent, oldLang, newLang)`), renders split/unified, highlights via Shiki/Lowlight, and supports running in a Web Worker. Expand-context behaviour is not confirmed in its README → **Spike S1** verifies it before the UI phase commits to the library. Fallback: `react-diff-view` + `diff` (jsdiff) with our own hunk model.
6. Precedent exists: **`chigichan24/duff`** (React + isomorphic-git + hand-rolled `fsaAdapter.ts` + diff2html). Implementation agents should read its `fsaAdapter.ts` for FSA edge cases, but we intentionally diverge: read-only permission, own status engine, three-dot branch compare.
7. `crypto.subtle.digest("SHA-1", ...)` is available in browsers and workers; used for blob hashing.

---

## 2. Goals and non-goals

**Goals**
- Open a local repo in ≤ 2 clicks; reopen a recent repo in 1 click.
- Show a diff that matches `git diff -M <merge-base>...<source>` (plus working tree) in file set, status, and hunks for ordinary repos.
- Feel like GitHub's PR "Files changed" tab.
- Keep the UI responsive: all git work off the main thread.
- Never modify the repo. Never send data anywhere.

**Non-goals (v1)**
- Any git write (stage, commit, checkout, stash).
- Commit history / log UI. (Data layer must not preclude it — see `DiffSource` abstraction.)
- Firefox/Safari support.
- Huge monorepos (>200k index entries or >500 MB of packs).
- Submodule contents, git-lfs pointer resolution (show pointer text as-is), symlink targets.

---

## 3. Architecture

```
┌────────────────────────────── Browser tab (diffgit.com) ──────────────────────────────┐
│                                                                                            │
│  Main thread (React)                              Web Worker (git engine)                  │
│  ┌──────────────────────────┐    comlink RPC    ┌──────────────────────────────────────┐   │
│  │ UI components            │ ◄───────────────► │ RepoSession                          │   │
│  │ zustand store            │  (structured      │  ├─ FsaFs  (read-only fs adapter)    │   │
│  │ IndexedDB (idb-keyval)   │   clone of        │  ├─ ObjectDb (isomorphic-git, cache) │   │
│  │ FileSystemObserver /     │   handles +       │  ├─ RefStore (branches, default)     │   │
│  │   polling scheduler      │   results)        │  ├─ IndexReader (own parser)         │   │
│  └──────────────────────────┘                   │  ├─ WorktreeScanner (own walker)     │   │
│                                                 │  ├─ DiffEngine (layers → FileDiff[]) │   │
│                                                 │  └─ ContentLoader (blobs, images)    │   │
│                                                 └──────────────────────────────────────┘   │
│                                                              │                             │
│                                                   File System Access API                   │
│                                                              ▼                             │
│                                                   /path/to/repo  (.git + worktree)         │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Layering rules**
- `engine/` has zero React imports and zero DOM imports except FSA types. It runs in a worker and in Bun tests (through a `DirHandleLike` interface with a Node-fs test implementation).
- `ui/` never touches FSA handles except to obtain them (picker, IndexedDB) and to hand them to the worker.
- One `RepoSession` per open repo, living in the worker; recreated on repo switch.
- All heavy results are plain JSON-able objects (no class instances across the worker boundary).

---

## 4. Domain model (TypeScript, `src/engine/types.ts`)

```ts
type Oid = string;                       // 40-hex SHA-1
type RepoId = string;                    // uuid stored with the handle in IndexedDB

interface RepoRef {
  name: string;                          // "main", "origin/main"
  fullName: string;                      // "refs/heads/main", "refs/remotes/origin/main"
  kind: "local" | "remote";
  oid: Oid;
  isDefault: boolean;                    // resolved per D8
  isCheckedOut: boolean;                 // == HEAD's branch
}

interface RepoInfo {
  id: RepoId;
  name: string;                          // folder name
  headBranch: string | null;             // null when detached
  headOid: Oid | null;                   // null for unborn repo
  refs: RepoRef[];
  defaultRef: RepoRef | null;
  capabilities: { indexVersion: 2|3|4; hasSplitIndex: boolean; hasSparseIndex: boolean; isWorktreeGitdir: boolean; hasReftable: boolean; };
  warnings: RepoWarning[];               // non-fatal: e.g. "sparse index: untracked detection disabled"
}

// What are we comparing? Designed so v2 can add {kind:"commit"} and {kind:"range"}.
type DiffSource =
  | { kind: "branches"; source: string; target: string; includeWorktree: boolean };

type ChangeLayer = "committed" | "staged" | "unstaged" | "untracked" | "conflict";
type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

interface FileDiff {
  id: string;                            // stable key: newPath ?? oldPath
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  layers: ChangeLayer[];                 // which layers contributed (D6 badges)
  similarity?: number;                   // renames, 0..100
  oldOid: Oid | null;                    // null = absent
  newOid: Oid | null;                    // null = absent or worktree content not hashed yet
  oldMode: number | null; newMode: number | null;
  binary: boolean;
  image: boolean;                        // by extension
  oldSize: number; newSize: number;
  stats: { additions: number; deletions: number } | null;   // null until content diffed
  tooLarge: boolean;                     // guard, see §6.7
}

interface DiffResult {
  source: DiffSource;
  mergeBase: Oid | null;                 // null when no common ancestor
  files: FileDiff[];                     // sorted by path
  totals: { files: number; additions: number; deletions: number };
  computedAt: number;
  durationMs: number;
}

interface FileContents { old: Uint8Array | null; new: Uint8Array | null; }   // fetched lazily per file
```

---

## 5. Engine design

### 5.1 `FsaFs` — read-only fs adapter for isomorphic-git (`src/engine/fs/fsaFs.ts`)

- Implements the promise API isomorphic-git requires: `readFile`, `readdir`, `stat`, `lstat`, `readlink`, and **throwing** `writeFile`, `unlink`, `mkdir`, `rmdir`, `symlink`, `chmod` (`Error` with `code: "EROFS"`). The throw is the safety invariant (D16). Tests assert it.
- Path → handle resolution with an LRU `Map<string, FileSystemHandle>` cache, invalidated on refresh.
- Errors must carry Node-style `code`: `ENOENT` for `NotFoundError`, `ENOTDIR`/`EISDIR` for type mismatches, `EACCES` for `NotAllowedError`. isomorphic-git branches on `code`.
- `stat` maps `File.lastModified` → `mtimeMs`, `File.size` → `size`; `mode` synthesised (`0o100644` files, `0o40000` dirs); `ino`/`dev`/`ctime` = 0.
- `readlink`: FSA cannot see symlinks; throw `EINVAL`. (Symlink index entries are diffed by their blob content only.)
- Depends on a tiny `DirHandleLike` / `FileHandleLike` interface (`kind`, `name`, `getDirectoryHandle`, `getFileHandle`, `entries`, `getFile`) so Bun tests can back it with Node `fs` (`src/engine/fs/nodeDirHandle.ts`, test-only).

### 5.2 `ObjectDb` (`src/engine/git/objectDb.ts`)

Thin wrapper over isomorphic-git with a shared `cache` object per session:
- `resolveRef(ref)`, `listRefs()` (local via `listBranches`, remote via `listBranches({remote})` for every remote in `.git/config`), `readCommit`, `readTree`, `readBlob`, `findMergeBase(a,b)`.
- `flattenTree(oid): Map<path, {oid, mode}>` via `git.walk` with a single `TREE` — this is a pure read. Memoised per commit oid for the session.
- Detect and surface unsupported layouts before any call: `.git` is a file (`gitdir:` — worktree/submodule) → error "worktrees not supported, open the main repo"; `.git/reftable` exists → error; `.git/objects/pack/multi-pack-index` present → warning (isomorphic-git ignores it and reads packs directly; verify in Spike S2 that this still works).

### 5.3 `RefStore` (`src/engine/git/refStore.ts`)

- HEAD parsing: `ref: refs/heads/x` → branch; bare oid → detached; unborn branch (ref exists in HEAD but not resolvable) → `headOid = null`.
- Default branch per D8. `origin/HEAD` is always the loose symref file `.git/refs/remotes/origin/HEAD` (`packed-refs` cannot hold symrefs); read it raw (`readSymref`) — isomorphic-git's `resolveRef` with `depth` returns a ref name, not an oid.
- Sort: checked-out first, default second, then local alphabetically, then remotes grouped by remote name.

### 5.4 `IndexReader` — own `.git/index` parser (`src/engine/git/indexReader.ts`)

- Header `DIRC`, version 2/3/4, entry count.
- Entry: ctime(s,ns) mtime(s,ns) dev ino mode uid gid size sha[20] flags[16]; v3+: if `extended` flag, +16 bits extended flags (skip-worktree, intent-to-add); name (NUL-terminated, 8-byte padded in v2/v3; **v4 prefix-compressed**: varint "strip N bytes from previous name" + NUL-terminated suffix, no padding).
- Stage bits (`flags >> 12 & 3`) > 0 → conflict entries; group by path, mark `layers: ["conflict"]`.
- Extensions: parse names only. `link` → `hasSplitIndex = true` → **fatal for status** (index incomplete); `sdir` → `hasSparseIndex = true` → treat `0o40000` entries as opaque dirs, warn that untracked detection is partial; `TREE`, `REUC`, `UNTR`, `FSMN`, `EOIE`, `IEOT` → ignored.
- Trailer SHA-1 checksum verified (cheap, catches torn reads during a concurrent `git` write → retry once after 150 ms).
- Output: `IndexSnapshot { version, entries: IndexEntry[], byPath: Map<string, IndexEntry>, flags }`.

### 5.5 `WorktreeScanner` — own status engine (`src/engine/git/worktree.ts`)

Inputs: root handle, `IndexSnapshot`, `headTree` (flattened). Output: `WorktreeStatus { staged: Map<path, Change>, unstaged: Map<path, Change>, untracked: string[] }`.

1. **Staged = index vs HEAD tree**: path in both with different oid/mode → modified; in index only → added; in HEAD only → deleted.
2. **Unstaged = worktree vs index**, for each index entry:
   - `getFileHandle` → missing → deleted.
   - Stat check: `file.size === entry.size && Math.floor(entry.mtimeSec*1000 + entry.mtimeNsec/1e6) === file.lastModified` → assume clean (git's own racy-git heuristic; documented limitation: a same-millisecond same-size edit is missed until the next mtime change).
   - Otherwise read bytes, hash `blob <len>\0<bytes>` with SHA-1, compare to entry oid. Cache `{size,lastModified} → oid` per path for the session so re-scans stay cheap.
   - Respect `skip-worktree` and `assume-valid` flags: treat as clean.
   - CRLF: **no autocrlf conversion in v1** (documented limitation; Windows users may see spurious modifications if `core.autocrlf=true`). Read `core.autocrlf` from `.git/config` and surface a warning if set.
3. **Untracked = workdir walk**:
   - Recursive walk from root, skipping `.git`. Prune directories that are ignored **before descending** (the whole reason we own this walker).
   - Ignore rules via the `ignore` npm package: `.git/info/exclude` + every `.gitignore` encountered, evaluated relative to its directory, with git precedence (deeper file wins, negations honoured). Global excludes (`core.excludesFile`) are inaccessible → documented limitation.
   - A directory containing no index entries and no un-ignored files is skipped from output (mirrors `git status` collapsing). We report **files**, not directories, because the diff view needs files.
   - Untracked files count toward untracked layer; nested `.git` directories (embedded repos) are skipped and reported as a warning.
   - Hard cap: stop after `MAX_UNTRACKED = 5000` files and show a warning.

Concurrency: file reads batched with a concurrency limit of 32 to keep FSA responsive.

### 5.6 `DiffEngine` (`src/engine/diff/diffEngine.ts`)

Given `DiffSource {source, target, includeWorktree}`:

1. Resolve `sourceOid`, `targetOid`. If `source === target` and no worktree layer → empty result "no changes".
2. `mergeBase = findMergeBase(sourceOid, targetOid)`; if none (unrelated histories) → fall back to two-dot with a warning banner.
3. `baseTree = flattenTree(mergeBase)`, `sourceTree = flattenTree(sourceOid)`.
4. **Committed layer**: `treeDiff(baseTree, sourceTree)` → `Map<path, Change{oldOid,newOid,oldMode,newMode}>`.
5. If `includeWorktree && source is checked-out branch`:
   - `headTree = sourceTree` (they're the same commit).
   - Read `IndexSnapshot`, run `WorktreeScanner`.
   - **Final "new side" per path** = worktree content (unstaged) if present, else index blob (staged), else source tree blob. **Old side** = merge-base blob. Layers = union of layers where the path changed. A path changed in committed but reverted in worktree back to base content → dropped (compare final oids).
   - Untracked → `added`, layer `untracked`, new side = worktree file.
6. **Rename detection** (`src/engine/diff/renames.ts`), on the final set:
   - Candidates: `deleted` × `added` pairs.
   - Pass 1 exact: same oid (worktree files hashed during status) → `renamed`, similarity 100.
   - Pass 2 similar: for each remaining pair, similarity = 1 − (jsdiff `diffLines` changed lines / max lines), computed on decoded text, only for non-binary files within 4× size of each other; threshold 50 (git's default). Bound work: at most 1000 pairs; beyond that skip pass 2 with a warning (mirrors `diff.renameLimit`).
   - Copies (`copied`) not detected in v1.
7. **Binary detection**: NUL byte in first 8000 bytes of either side (git's heuristic) or extension in a known binary list. `image` if extension ∈ {png,jpg,jpeg,gif,webp,svg,bmp,ico,avif}.
8. Output `FileDiff[]` without contents. Stats (`+/-`) are computed lazily per file in the worker when the UI first needs them (all files' stats for the sidebar are computed in a background pass after the list is shown, in path order, batches of 20, so the sidebar fills progressively).
9. `getFileContents(id)` returns both sides as `Uint8Array`; text decoding + diff happens in the worker via `@git-diff-view/core` (or jsdiff fallback) and returns the serialised diff model to the UI.

### 5.7 Refresh (`src/ui/refresh/`)

- **Observer mode** (Chrome 133+): `new FileSystemObserver(cb).observe(rootHandle, {recursive:true})`. Coalesce events 300 ms. Classify: any path under `.git/` → `refs`/`HEAD`/`index`/`packed-refs`/`ORIG_HEAD` changes → full recompute; `.git/objects/**` alone → ignore (objects are immutable); worktree path → mark paths dirty → recompute (v1 recomputes the full diff; the stat cache makes it cheap; per-path incremental is a v2 optimisation).
- **Polling mode**: every 3 s (backs off to 10 s when tab hidden via `visibilitychange`): read `lastModified` of `.git/HEAD`, `.git/index`, `.git/packed-refs`, the resolved source/target ref files, and stat every index entry (size + mtime only; no reads). Any change → recompute. For untracked files, poll only every 10 s (directory walk is the expensive part).
- Manual refresh button + `R` keyboard shortcut always available; shows "last refreshed N s ago".
- Recompute is cancellable: a new request supersedes an in-flight one (generation counter in the worker).

### 5.8 Persistence (`src/ui/persistence/`)

- IndexedDB (via `idb-keyval`): `repos: {id, name, handle, lastOpenedAt, lastTarget?: string, lastSource?: string, viewedFiles: Record<diffKey, string[]>}`.
- `localStorage`: view prefs (split/unified, whitespace, theme, sidebar width).
- Viewed-file checkboxes keyed by `repoId + source + target + newOid|oldOid` so they clear when the file's content changes (GitHub behaviour).

---

## 6. UI design (GitHub "Files changed" look)

> **Visual spec:** the owner approved direction A "Classic" on 2026-09-16. [`Design.md`](Design.md) holds the tokens, type, layout and per-component rendering rules and wins over this section on any question of appearance. This section remains the list of *what* the UI contains.

### 6.1 Screens / states

1. **Unsupported browser** — full-page message with browser list. Detect `"showDirectoryPicker" in window`.
2. **Home / Open** — big "Open repository" button + Recent repos list (name, path hint = folder name, last opened, remove ×). Clicking a recent repo calls `requestPermission` (user gesture) then loads.
3. **Loading** — progress steps: "Reading refs → Parsing index → Scanning working tree → Computing diff" with counts.
4. **Repo view** (main):
   - **Top bar**: repo name, `[source ▾]` → `[target ▾]` branch pickers (searchable dropdown, grouped local/remote, badges "HEAD"/"default"), swap button, "Include uncommitted" toggle (disabled with tooltip when source ≠ HEAD), refresh button with status dot (live / polling / manual), view toggles (Unified | Split), whitespace toggle, "Viewed x/y", file filter input, settings (theme).
   - **Banner** area for warnings (unrelated histories, split index, sparse, autocrlf, cap hit).
   - **Left sidebar**: file tree (collapsible folders) or flat list toggle; each row: status icon (A/M/D/R), path (dir dimmed, basename bold), `+n −m`, layer badge chips (`staged`, `unstaged`, `untracked`, `conflict`; committed has no chip), viewed checkmark. Click scrolls to file; keyboard `j/k` navigate.
   - **Main column**: file cards in path order, virtualised (only cards near viewport are mounted; each card has an estimated height until measured). Card header: sticky, path (old → new for renames, similarity %), mode change, stats, "Viewed" checkbox, collapse chevron, copy path, "expand all context". Body: diff view (split/unified), syntax highlighting, expand-context buttons at hunk boundaries, "Load diff" button for large files, image side-by-side for images, "Binary file not shown" for binary.
5. **Empty** — "No changes between X and Y" (and "Working tree clean" when applicable) with the branch names, suggestion to change target.
6. **Error** — repo not found / permission denied / unsupported layout with a "Choose another folder" action.

### 6.2 Component tree (`src/ui/`)

```
App
├─ BrowserGate
├─ HomeScreen { OpenRepoButton, RecentRepoList }
└─ RepoScreen
   ├─ TopBar { BranchPicker×2, SwapButton, IncludeWorktreeToggle, RefreshControl, ViewControls, FileFilter }
   ├─ WarningBanners
   ├─ Sidebar { FileTree | FileList, FileRow }
   └─ DiffPane (virtualised)
      └─ FileCard { FileHeader, DiffBody | ImageDiff | BinaryNotice | LargeFileGate, LoadingSkeleton }
```

### 6.3 State (`zustand`, `src/ui/store.ts`)

`{ repo: RepoInfo | null, session: WorkerHandle | null, diffSource, diffResult, loading: {phase, progress}, warnings, prefs: {viewMode, ignoreWhitespace, theme, layout}, viewed: Set<fileId>, filter, activeFileId, refresh: {mode, lastAt, busy} }`. Actions are thin wrappers over worker RPC.

### 6.4 Styling
Tailwind v4, GitHub-like neutral palette, light + dark (prefers-color-scheme + toggle). Diff colours: added `#dafbe1`/dark `#12261e`, removed `#ffebe9`/dark `#25171c`, word-level highlights one shade stronger. Monospace font stack: `ui-monospace, SFMono-Regular, Menlo, monospace`. The full token set (neutrals, accent, status/chip palettes, banner levels, gutter colours) and the typography scale are in `Design.md` §3–§4; components use tokens only.

### 6.5 Keyboard
`o` open repo, `r` refresh, `j/k` next/prev file, `v` toggle viewed, `[`/`]` collapse/expand file, `/` focus filter, `s` split/unified, `?` help.

### 6.6 Accessibility
Diff table uses semantic `<table>` with row/col headers hidden visually; status icons have `aria-label`; all controls keyboard reachable; focus ring visible; colour is never the only status signal (icons + letters).

### 6.7 Limits (surface as banners, never silent)
- File > 1 MB or > 3000 changed lines → collapsed with "Load diff" (still counted in totals via a cheap line count).
- File > 10 MB → never rendered, "Diff too large".
- > 1000 changed files → sidebar virtualised, stats computed on demand only.
- Index > 200k entries → status scan disabled, committed-only mode with warning.
- Untracked > 5000 → capped with warning.

---

## 7. Tech stack (pin on bootstrap; agents must record exact versions in `package.json`)

| Area | Choice |
|------|--------|
| Runtime/tools | Bun ≥ 1.3 (install, scripts, `bun test` for engine), Node 24 available for tools needing it |
| Build | Vite (latest 7.x), `@vitejs/plugin-react`, TypeScript strict, `vite-plugin-checker` optional |
| UI | React 19, Tailwind v4, `lucide-react`, `@tanstack/react-virtual`, `cmdk` (branch picker), `zustand` |
| Worker RPC | `comlink` |
| Git | `isomorphic-git` 1.42.x, `ignore`, `diff` (jsdiff) for renames/fallback |
| Diff render | `@git-diff-view/react` + `@git-diff-view/core` + `@git-diff-view/shiki` (subject to Spike S1); fallback `react-diff-view` |
| Persistence | `idb-keyval` |
| Tests | `bun test` for engine (Node-backed handles), `vitest` + `happy-dom` for UI units, Playwright (Chromium) E2E with in-memory FSA mock |
| Lint/format | Biome |
| Deploy | Cloudflare Pages via `bunx wrangler pages deploy dist --project-name diffgit`; later GitHub Actions |

---

## 8. Repository layout

```
diffgit/
├─ Plan.md
├─ README.md
├─ package.json  bunfig.toml  tsconfig.json  vite.config.ts  biome.json  playwright.config.ts
├─ wrangler.toml                 # pages project config
├─ public/  _headers  _redirects  favicon.svg
├─ scripts/
│  ├─ make-fixtures.sh           # builds test repos with the real git CLI
│  └─ fixture-expectations.sh    # dumps `git diff --name-status -M` etc. to JSON for parity tests
├─ fixtures/                     # generated, git-ignored, rebuilt in CI
├─ src/
│  ├─ main.tsx  App.tsx  index.css
│  ├─ engine/
│  │  ├─ types.ts
│  │  ├─ fs/ { dirHandleLike.ts, fsaFs.ts, nodeDirHandle.ts(test), memoryDirHandle.ts(test/e2e) }
│  │  ├─ git/ { objectDb.ts, refStore.ts, indexReader.ts, worktree.ts, ignoreRules.ts, hash.ts, config.ts, layoutChecks.ts }
│  │  ├─ diff/ { diffEngine.ts, treeDiff.ts, renames.ts, binary.ts, textDiff.ts }
│  │  ├─ session.ts              # RepoSession orchestrator
│  │  └─ worker.ts               # comlink expose
│  ├─ ui/
│  │  ├─ store.ts  workerClient.ts
│  │  ├─ persistence/ { repos.ts, prefs.ts }
│  │  ├─ refresh/ { observer.ts, poller.ts, scheduler.ts }
│  │  ├─ components/ ... (per §6.2)
│  │  └─ hooks/
│  └─ test/ { helpers, fixtures loader }
└─ e2e/
```

---

## 9. Testing strategy

- **Fixture repos** built by `scripts/make-fixtures.sh` with the real git CLI (git 2.50 available), covering: basic branch divergence; renames (exact + 60% similar + below threshold); binary and image changes; staged/unstaged/untracked/conflict states; packed refs (`git gc`); `origin/HEAD` set via a local bare "remote"; index v4 (`git update-index --index-version 4`); nested `.gitignore` with negation; detached HEAD; unborn repo; unrelated histories; CRLF file; mode change (`chmod +x`); 3000-line file; nested embedded repo.
- **Parity tests**: for each fixture and branch pair, `scripts/fixture-expectations.sh` records `git diff -M --name-status base...source`, `git status --porcelain=v2`, `git merge-base`, `git symbolic-ref refs/remotes/origin/HEAD`. Engine tests assert equality. This is the definition of "matches git".
- **Unit**: index parser (hand-built byte buffers for v2/v3/v4 + extensions), ignore rules, binary detection, rename scoring, FsaFs write-throw invariant, error code mapping.
- **UI unit**: branch picker default selection, badge rendering, viewed persistence keying, large-file gate.
- **E2E (Playwright, Chromium)**: deliberately small — three smoke specs (open-and-diff, worktree-and-refresh, errors-and-privacy) using an in-memory directory handle injected through a cloneable marker. Everything else is unit/engine tested. See `tasks/README.md` "E2E policy".
- **Perf check** (manual + one automated budget): open a 5k-file, 30 MB-pack fixture in < 3 s to first file list on a laptop; recompute after a single file edit in < 500 ms.

---

## 10. Security & privacy

- Permission requested with `{ mode: "read" }` only. `FsaFs` write methods throw. Test-enforced.
- CSP in `public/_headers`: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'none'; worker-src 'self' blob:; frame-ancestors 'none'`. Shiki grammars must be bundled, not fetched.
- No third-party scripts, no analytics, no fonts from CDNs.
- Blob URLs for image previews revoked on unmount.
- README states the privacy model in one paragraph.

---

## 11. Risks and spikes (do these first, they gate later phases)

| ID | Risk | Spike / mitigation | Gate |
|----|------|--------------------|------|
| S1 | `@git-diff-view/react` lacks expand-context or is heavy in worker mode | 1-day spike: render a 2-file diff from strings in split + unified, expand context, in a worker. If it fails, switch to `react-diff-view` + jsdiff and own hunk model. | Phase 5 |
| S2 | isomorphic-git read paths fail on real repos (packed refs after `gc`, multi-pack-index, big packs, `FsaFs` semantics) | Spike against fixtures + 3 real local repos with write-throwing fs; log every fs call to confirm zero writes. | Phase 1 |
| S3 | `FileSystemObserver` event shape/ordering on `.git/index` rewrite (git writes `index.lock` then renames) | Spike: observe a fixture while running `git add`; record event sequence; tune classifier. | Phase 6 |
| R1 | Racy-git false "clean" after same-ms same-size edit | Documented; hashing forced on manual refresh (`refresh({force:true})` re-hashes all). | — |
| R2 | Torn reads during concurrent `git` operations | Index checksum verify + single retry; ref resolve retry on ENOENT of `*.lock` windows. | — |
| R3 | Memory on big packs (isomorphic-git loads pack into memory) | Session cache with size accounting; drop cache and show warning above 300 MB (`performance.memory` where available). | — |
| R4 | Chrome permission prompt fatigue | Persist handle; one click per session is the floor imposed by Chrome. Explain in UI. | — |

---

## 12. Implementation plan — phases and tasks

Conventions for every task: owner = one implementation agent; **done** means code + tests + `bun run check` (typecheck, lint, tests) green + a short note in `docs/CHANGELOG.md`. Task IDs are stable; dependencies are listed. Estimates are relative (S/M/L).

### Phase 0 — Bootstrap (S, no deps)

**T0.1 Repo & toolchain**
- `git init`, Bun project, Vite + React 19 + TS strict, Tailwind v4, Biome, `bun run dev|build|check|test`.
- Files: `package.json`, `vite.config.ts`, `tsconfig.json`, `biome.json`, `src/main.tsx`, `src/App.tsx`, `index.html`.
- AC: `bun run build` produces `dist/`; `bun run check` passes on the hello-world.

**T0.2 Cloudflare Pages pipeline**
- `wrangler.toml` (pages project `diffgit`), `public/_headers` with CSP from §10, `public/_redirects` SPA rule.
- `bunx wrangler login` (owner runs interactively), `bunx wrangler pages project create diffgit`, deploy, attach custom domain `diffgit.com` (Pages → Custom domains; CNAME auto-created in the zone).
- AC: hello-world reachable at https://diffgit.com with CSP headers visible in DevTools.

**T0.3 Fixture builder**
- `scripts/make-fixtures.sh` creating every fixture in §9 under `fixtures/`; `scripts/fixture-expectations.sh` writing `fixtures/<name>/expected/*.json`.
- AC: script is idempotent; fixtures git-ignored; CI job builds them.

**T0.4 Test harness**
- `bun test` config; `nodeDirHandle.ts` implementing `DirHandleLike` over Node fs; `memoryDirHandle.ts` (snapshot-able, mutable) for E2E; Playwright config (Chromium only) with `addInitScript` shim for `showDirectoryPicker`.
- AC: a smoke test opens a fixture via `nodeDirHandle` and lists `.git` entries.

### Phase 1 — Object database & refs (deps: Phase 0; runs Spike S2)

**T1.1 `FsaFs` adapter** — per §5.1. Tests: read/readdir/stat mapping, error codes, every write method throws `EROFS`, handle cache invalidation.

**T1.2 `layoutChecks`** — detect `gitdir:` file, reftable, split/sparse markers, multi-pack-index; produce `capabilities` + errors/warnings. Tests on fixtures.

**T1.3 `ObjectDb`** — wrappers with session `cache`; `flattenTree` memoised; `findMergeBase`. Tests: parity with `git merge-base`, `git ls-tree -r` for fixtures incl. packed repo.

**T1.4 `RefStore`** — HEAD states, branch listing incl. remotes from `.git/config`, default branch (D8), sorting. Tests: each HEAD state fixture, `origin/HEAD` present/absent.

**T1.5 `config.ts`** — minimal `.git/config` INI parser (remotes, `core.autocrlf`, `diff.renameLimit`). Tests.

**T1.6 Spike S2 report** — run T1.1–T1.4 against 3 real repos through the worker with an fs-call log; document any isomorphic-git limitation found in `docs/engine-notes.md`.

### Phase 2 — Working tree (deps: Phase 1)

**T2.1 `IndexReader`** — v2/v3/v4, extensions, checksum, conflict stages, sparse dirs. Tests: byte-level unit tests + fixtures (v2 default, v4 fixture, conflict fixture).

**T2.2 `hash.ts`** — SHA-1 git blob hashing with `crypto.subtle`, streaming for > 8 MB. Tests vs `git hash-object`.

**T2.3 `ignoreRules.ts`** — layered `.gitignore` + `info/exclude` using `ignore`, directory-pruning API (`isDirIgnored(path)` and `isFileIgnored(path)`). Tests vs `git check-ignore` output from fixtures.

**T2.4 `WorktreeScanner`** — per §5.5 incl. stat-cache heuristic, skip-worktree/assume-valid, caps, embedded repo skip, concurrency limiter. Tests: parity with `git status --porcelain=v2` on fixtures (staged/unstaged/untracked/deleted/conflict/mode change).

### Phase 3 — Diff engine (deps: Phase 2)

**T3.1 `treeDiff.ts`** — flattened tree A vs B → changes with mode/typechange. Tests vs `git diff --name-status --no-renames`.

**T3.2 `DiffEngine` layering** — §5.6 steps 1–5, 7, 8; unrelated-histories fallback; same-branch handling; layer badges; revert-to-base elimination. Tests: parity with `git diff --name-status --no-renames base...source` plus worktree fixtures (expected generated by `git diff --no-renames base` in the worktree).

**T3.3 `renames.ts`** — exact + similarity passes, limits. Tests vs `git diff -M --name-status` including similarity percentages within ±5.

**T3.4 `binary.ts` + `textDiff.ts`** — binary/image detection; per-file stats; content loading API; whitespace-ignore variant; large-file gate flags. Tests vs `git diff --numstat` (numstat marks binary as `-`).

**T3.5 `RepoSession` + `worker.ts`** — orchestrates open → info → diff → contents; generation counter for cancellation; progress callbacks; error typing. Tests: session-level integration on fixtures; cancellation test.

### Phase 4 — App shell & state (deps: Phase 0; can run in parallel with 1–3 using a mocked worker)

**T4.1 `workerClient.ts`** — comlink proxy, typed API, progress events, error mapping to UI-friendly messages.

**T4.2 `store.ts`** — zustand shape from §6.3; selectors; actions.

**T4.3 Persistence** — `repos.ts` (IndexedDB handles, recents, last branches), `prefs.ts`. Tests with fake-indexeddb.

**T4.4 `BrowserGate` + `HomeScreen`** — open button (`showDirectoryPicker({mode:"read"})`), recent list with permission re-request on click, remove entry, unsupported browser page.

### Phase 5 — Diff UI (deps: Phase 4, Spike S1; engine can be mocked with recorded `DiffResult` JSON from fixtures)

**T5.0 Spike S1** — decide diff renderer; write `docs/adr-001-diff-renderer.md`.

**T5.1 `TopBar` + `BranchPicker`** — searchable grouped picker (`cmdk`), HEAD/default badges, swap, include-uncommitted toggle rules, refresh control states.

**T5.2 `Sidebar`** — tree/flat toggle, rows with status icon, stats, layer chips, viewed tick, filter (substring + glob), keyboard nav, virtualised for > 300 files.

**T5.3 `DiffPane` + `FileCard`** — virtualised cards, sticky headers, collapse, viewed, copy path, lazy content load, loading skeleton, split/unified, syntax highlighting (bundled grammars for top ~40 languages, lazy-loaded chunks), expand context, whitespace toggle, word-level highlight.

**T5.4 `ImageDiff`, `BinaryNotice`, `LargeFileGate`** — side-by-side images with size, "Load diff" flow, "too large" state.

**T5.5 Empty / error / loading / warning banner states** — all copy from §6.1.

**T5.6 Theme, keyboard shortcuts, help dialog, a11y pass.**

### Phase 6 — Refresh (deps: Phases 3 & 5; Spike S3)

**T6.1 `scheduler.ts`** — single entry point `requestRefresh(reason)`, coalescing, generation handling, "last refreshed" state.

**T6.2 `observer.ts`** — `FileSystemObserver` wiring + event classifier from S3 findings; feature detection.

**T6.3 `poller.ts`** — stat polling per §5.7 with visibility back-off; index-entry stat sweep.

**T6.4 Force refresh** — `R` key / button re-hashes everything (R1 mitigation).

### Phase 7 — Hardening (deps: all above)

**T7.1 E2E suite** — flows from §9 with `MemoryDirectoryHandle`.
**T7.2 Perf pass** — budgets from §9; profile worker; batch sizes; memory warning (R3).
**T7.3 Error taxonomy review** — every thrown error in engine maps to a user message + action; no silent catch (run `silent-failure-hunter` review).
**T7.4 Security review** — CSP verified in production, no network requests in DevTools during a full session, write-throw invariant tests present.
**T7.5 Code review + simplification passes** on `engine/` and `ui/`.

### Phase 8 — Release

**T8.1 README** — what it is, privacy model, supported browsers, limitations list (§5.5, §6.7, §11).
**T8.2 Deploy v1** to diffgit.com; smoke test on 3 real repos; tag `v1.0.0`.
**T8.3 v2 backlog** file — commit history & single-commit diff, arbitrary ref/SHA input, per-path incremental refresh, copy detection, autocrlf normalisation, LFS pointer rendering, Firefox fallback investigation.

### Parallelisation map

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──┐
   │                                          ├──► Phase 6 ──► Phase 7 ──► Phase 8
   └──► Phase 4 ──► Phase 5 (S1) ─────────────┘
```
Phases 1–3 (engine) and 4–5 (UI on mocked data) run as two independent agent tracks after Phase 0.

---

## 13. Acceptance criteria for v1 (owner sign-off checklist)

- [ ] Open a repo in Chrome; recents reopen with one permission click.
- [ ] Source defaults to checked-out branch, target to `origin/HEAD`/`main`/`master`.
- [ ] File list, statuses, rename pairing and `numstat` match `git diff -M base...source` on the parity fixtures and on 3 real repos (hunk boundaries are not asserted against git).
- [ ] Staged / unstaged / untracked edits appear with correct badges; toggling "include uncommitted" removes them.
- [ ] Editing a file in an editor updates the diff within ~1 s (observer) or ≤ 3 s (polling) without clicking.
- [ ] Same branch + clean tree shows "No changes".
- [ ] Split/unified, syntax highlight, expand context, viewed, filter, whitespace toggle all work.
- [ ] Images show side by side; binaries show a notice; huge files are gated.
- [ ] DevTools Network shows zero requests after load; folder was opened read-only; `git status` in the repo is unchanged after a session.
- [ ] Deployed at https://diffgit.com with CSP headers.

---

## 14. Review round 1 — amendments

An independent review of the task briefs found 28 issues and several in-scope additions. All are folded into `tasks/README.md` ("Review round 1 amendments") and into "Amendments" sections of the affected task files, which supersede the text above where they differ. Summary of what changed in the design:

- **Errors**: one canonical registry (`src/engine/errors.ts`, created in T0.1) with fs-tier and public-tier codes plus warning codes.
- **E2E transport**: the picker shim returns a cloneable marker; the worker rehydrates an in-memory handle and test mutations travel over a test-only channel (T0.4).
- **CSP in preview**: `vite preview` serves `public/_headers`; Shiki must use the JavaScript regex engine or inlined WASM (T0.1, T5.0).
- **Worktree scanner**: split index and >200k-entry indexes skip the worktree layer with warnings; symlinks and gitlinks are treated as clean in the unstaged pass; conflicted and sparse paths are excluded from the staged pass; git's racy-clean rule (entry mtime ≥ index mtime → hash) replaces the documented R1 limitation; cache consulted before the stat heuristic so force refresh sticks; untracked files ≤ 1 MB are hashed (T2.4).
- **Renames**: git's `renameLimit²` rule and spanhash scoring (T3.3).
- **Whitespace and binary**: `-w` semantics and `.gitattributes`-driven binary/generated classification (T3.4).
- **Sessions**: `generation` on results with `STALE` rejection; worker-owned background stats with LIFO priority; `probe(tier)` lives in T3.5; stale-pack retry after `gc`; single progress channel; worker crash recovery (T3.5, T4.1).
- **Refs**: `readSymref` for `origin/HEAD`; synthetic `HEAD` entry for detached/unborn; shared `diffSource.ts` helper; `DiffSource` carries full ref names; multiple merge bases warned (T1.3, T1.4, T3.2).
- **Layout refusals**: SHA-256 object format, alternates, partial clones, reftable via config, pack-size guard (T1.2).
- **Refresh lifecycle**: owned by the scheduler with an observer → polling → manual ladder, max-wait debounce, config/ignore invalidation, per-path handle-cache invalidation, tiered polling intervals (T6.1–T6.3).
- **UI**: `base ← compare` labelling, viewed key includes file id, `fileDiffs` LRU, per-card error boundary, whitespace-only body, generated-file collapse, axe replaces the table-structure a11y criterion (T4.2, T5.1, T5.3, T5.6).
- **Verification**: parity restricted to file set/status/renames/numstat; CI perf budgets structural only; Cloudflare edge-injection check; mtime-based zero-write proof; torn-state E2E specs (T1.6, T7.x, T8.2).

## 15. Design approval (2026-09-16)

Three mocked directions of the repo screen (A "Classic" GitHub-style, B "Workbench" dark editor, C "Focus" one-file-at-a-time) were published as artifact `36d3fa56-a90f-4e69-8646-d8e6ddfa3974` v1. The owner chose **A**. `Design.md` records that direction as the implementation contract; the UI task files (T4.4, T5.0–T5.6) were updated with Design refs and amendments. B and C are not to be revisited in v1.
