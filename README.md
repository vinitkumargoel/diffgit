# diffgit

**A GitHub-style branch diff for the repository on your disk, including the work you have not
committed yet, running entirely in your browser.** Open a local git repository, pick a base and a
compare branch, and read the three-dot diff (`base...compare`) the way a pull request shows it:
file tree with status letters and layer chips (staged / unstaged / untracked), unified or split
hunks with syntax colours and word-level marks, rename detection, "viewed" ticks that survive a
reload, and live refresh as you edit. Nothing is uploaded and nothing is written: the page reads the
folder through the File System Access API and the Content-Security-Policy forbids every network
request after the page has loaded.

<p align="center">
  <img src="docs/screenshots/light.png" alt="diffgit showing the worktree fixture in light mode: file tree with staged, unstaged and untracked chips, unified hunks with additions and deletions, a mode-change card" width="49%">
  <img src="docs/screenshots/dark.png" alt="The same diff in dark mode" width="49%">
</p>

Live at **https://diffgit.com**.

## How to use

1. **Open** — click *Open repository* (or press `o`) and pick the folder that contains `.git`.
   Chrome asks for read access to that folder; grant it. Recently opened repositories appear on the
   home screen and only need a click to re-authorise.
2. **Choose branches** — *base* defaults to the default branch (`origin/HEAD`, `main` or `master`),
   *compare* to the checked-out branch. Either picker lists local and remote branches with search;
   the ⇄ button swaps them. The diff is `merge-base(base, compare)` → `compare`, exactly like a pull
   request.
3. **Read and work** — *Include uncommitted changes* (on by default when *compare* is the checked-out
   branch) layers the index and the working tree on top of the commits, with chips telling you which
   layer each change comes from. Tick *Viewed* as you go, `j`/`k` to move between files, `s` to
   switch split/unified, `/` to filter, `?` for every shortcut. The diff refreshes itself when files
   change (Live), falls back to polling if the browser cannot watch the folder, and `Shift+R`
   forces a full re-read.

## Privacy model

- **Nothing leaves the browser.** Repository content is read into a Web Worker and rendered on the
  page. The served CSP has `connect-src 'none'`, so the browser itself blocks any request from the
  page or its workers; an end-to-end test asserts zero network requests while a repository is open.
- **Nothing is written.** The folder is opened in read-only mode and the engine's filesystem
  adapter has no working write path (every write method throws). A mtime-based proof on real
  repositories is part of the release checklist.
- **Stored locally, only:** the directory handles and names of up to 20 recent repositories, the
  last branch pair per repository, "viewed" marks (keyed by repository, refs, path and blob ids),
  and view preferences. No file contents. Clear with the browser's *Delete site data*.
- No analytics, no cookies, no third-party scripts. Details: [docs/privacy.md](docs/privacy.md).

## Supported browsers

Desktop **Chromium** browsers: Chrome, Edge, Brave, Arc (Chrome 86 or newer). The app needs
`showDirectoryPicker()` from the File System Access API, which Firefox and Safari do not ship; on
those browsers the home screen explains this instead of failing later. Live change detection uses
`FileSystemObserver` where available (Chrome 129+) and otherwise polls `.git` and the index.

## Limitations

Every item below is either refused with an explanation, shown as a banner, or documented here
because git behaves the same way. Error and warning codes are listed in
[docs/errors.md](docs/errors.md).

| Area | Behaviour |
|---|---|
| Linked worktrees (`.git` is a `gitdir:` file), bare repositories, reftable, SHA-256 object format, `objects/info/alternates`, partial (promisor) clones, packs over 1 GB | Refused on open with a message naming the reason (`WORKTREE_GITDIR`, `BARE_REPO`, `REFTABLE`, `OBJECT_FORMAT_SHA256`, `ALTERNATES`, `PARTIAL_CLONE`, `PACK_TOO_LARGE`). Open the main checkout or a full clone. |
| Split index (`core.splitIndex`) | Not supported: the diff shows committed changes only, with a banner (`SPLIT_INDEX`). |
| Sparse index / sparse checkout | Tracked changes are correct; untracked-file detection inside sparse directories is partial (`SPARSE_INDEX`). |
| Index over 200,000 entries | Working-tree scan disabled, committed-only mode with a banner (`INDEX_TOO_LARGE`). |
| More than 5,000 untracked files | The list is cut off with a banner (`UNTRACKED_CAPPED`). |
| Mode changes | Staged mode changes (e.g. `100644 → 100755`) are shown. A `chmod` that is not yet staged is **not** detected: the working-tree scan compares content, not modes. |
| Symlinks and submodules | Compared at the committed/staged level (a symlink by its target path, a submodule by its commit id). Edits to them in the working tree are not detected. |
| `core.autocrlf` | No normalisation is applied; line-ending-only changes may appear, flagged by an `AUTOCRLF` banner. |
| Global ignores (`core.excludesFile`, `~/.config/git/ignore`) | Not readable from the folder, so not applied: some globally ignored files may appear as untracked (`GLOBAL_EXCLUDES_UNAVAILABLE`). Built-in excludes (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) are applied by default; there is no UI toggle yet (backlog B10). |
| `include` / `includeIf` in `.git/config` | Includes pointing outside the folder are skipped (`CONFIG_INCLUDE_SKIPPED`). |
| Renames and copies | Renames are detected like `git diff -M` (exact, then 50 % similarity, up to 1,000 × 1,000 candidate pairs; `RENAME_LIMIT` when exceeded). Copies (`-C`) are not detected. |
| Git LFS | Pointer files are compared as text; the large objects are not fetched (`LFS_PRESENT`). |
| Shallow clones | The merge base may differ from git's on a full clone (`SHALLOW`). |
| Racy edits | Edits within the same millisecond as the index write are detected with git's own racy-git rule; `Shift+R` re-hashes every file as belt-and-braces. |
| Encodings | Text is decoded as UTF-8 with replacement characters, as `git diff` shows it; no `working-tree-encoding` support (backlog B8). |

Size limits (surfaced as banners or gates, never silently):

| Limit | Behaviour |
|---|---|
| File over 1 MB on either side, or over 3,000 changed lines | Collapsed behind *Load diff*; counted in the totals. |
| File over 10 MB | Never rendered ("Diff too large"); raw bytes are never transferred (`TOO_LARGE`). |
| Binary files | "Binary file not shown" with sizes; *View as text* below 1 MB; images shown side by side. |
| More than 300 changed files | Sidebar and diff pane are virtualised; per-file stats stream in with the visible rows first. |
| Packs over 300 MB on disk or read | `PACK_LARGE` warning; over 1 GB refused. |

## Development

```
bun install
bun run dev                 # real engine in a worker; VITE_MOCK_ENGINE=1 bun run dev for the recorded mock
bun run check               # biome + tsc + engine tests (bun) + UI tests (vitest) + layering guards
bun run e2e                 # Playwright against vite preview with the production CSP
bun run perf                # perf budgets on the perf-5k fixture
bun run fixtures            # rebuild fixtures/ and git's own expected output (needs git + jq)
bun run deploy              # build → scripts/check-dist.sh → Cloudflare Pages
```

Layout, guards and conventions: [docs/contributing.md](docs/contributing.md). Design and decisions:
[Plan.md](Plan.md) (§0 decisions are final), [Design.md](Design.md), [docs/](docs/README.md).
Task board: [START.md](START.md).

## License

MIT.
