# Privacy & security model

diffgit is a static page. Everything it does with your repository happens inside your browser.

## What never leaves the browser

- **Repository content.** Files, git objects, branch names and paths are read through the File
  System Access API into a Web Worker and rendered on the page. Nothing is uploaded, logged or
  sent to any server. The Content-Security-Policy served with the page (`public/_headers`) has
  `connect-src 'none'`: the browser itself blocks `fetch`, `XMLHttpRequest`, WebSockets and
  beacons from the page and its workers, even if a bug tried to use them. After the page loads its
  own scripts, styles and fonts from the same origin, the network is not used again
  (`e2e/errors-and-privacy.spec.ts` asserts zero requests while a repository is open).
- **Analytics.** None. `scripts/check-prod.sh` verifies the served HTML contains no injected
  analytics or Cloudflare add-ons; `scripts/check-dist.sh` verifies the bundle contains no inline
  script, no `eval`, no WebAssembly and no remote script URLs before every deploy.

## What the page stores locally

| Where | What | Why |
|---|---|---|
| IndexedDB `diffgit-repos` | Up to 20 recent repositories: the directory **handle** (an opaque browser token, not a path), the folder name, the last source/target branch names, last-opened time | The "Recent" list on the home screen. The browser re-asks for read permission the next time you open one. |
| IndexedDB `diffgit-viewed` | Keys marking files you ticked as "viewed": repository id, refs, file id and blob hashes → timestamp, pruned to 5,000 | Viewed marks survive a reload and reset automatically when the file changes. |
| `localStorage` `diffgit:prefs` | View preferences: split/unified, ignore whitespace, theme, sidebar width and similar | Remember your layout. |
| IndexedDB `diffgit-derived` | Results diffgit computed from your repository and can reuse: blame and file history per `(repository, commit, path)`, insights per `(repository, tip, period)`, one summary card per repository, and the good/bad marks of a bisect | Blame and insights are expensive walks; keying them on a commit id means they are never stale. They contain file *attributions* and counts, not file contents, and the help dialog shows the total with a **Clear** button (also the palette's *Clear cached data*). |
| Cache Storage `diffgit-<build>` | Copies of diffgit's **own** built files (scripts, styles, the page), as the browser loads them | The installed app opens with the network off (T11.14). No repository content is ever cached; an old build's cache is deleted when a new one activates. |

No file contents, diffs, or hashes of file contents other than the git blob ids inside viewed keys are
ever stored. Every storage operation is optional: if storage is blocked or full, the app shows one
"Storage unavailable" notice and keeps working without memory.

## Read-only by construction (D16)

- The folder picker is always called with `mode: "read"`. The browser never offers write access.
- The engine's filesystem adapter has no working write path: every write-capable method throws
  `EROFS` before touching a handle (`src/engine/fs/fsaFs.test.ts` "INVARIANT"). A grep guard in
  `bun run check` fails on `createWritable`, `removeEntry`, `.move(`, `create: true` or
  `"readwrite"` anywhere in `src/`.
- Proof on real repositories: `bun scripts/spike-s2.ts <repo>` runs the engine through a
  call-logging handle and checks `find .git -newer marker`, `git status` and `git fsck` before and
  after. On 2026-09-17 (this repository plus three fixture copies): 0 write-capable calls,
  0 `.git` files newer than the marker, status and fsck identical.

## Rendering untrusted repository content

- File text, paths and branch names are rendered as React text nodes; there is no `innerHTML`,
  `dangerouslySetInnerHTML` or `eval` in the source (grep guard) or the bundle (`check-dist.sh`).
- Syntax colours come from our own tokenizer (Shiki grammars with the JavaScript regex engine) run
  over the text; the output is our token structure, never markup from the file. The CSP has no
  `wasm-unsafe-eval` because no WebAssembly is used.
- Images are shown with `<img src="blob:...">` only. SVG files are never inlined, so scripts
  embedded in them cannot run; the object URL is revoked when the card unmounts.
- `.gitignore`, `.gitattributes` and `.git/config` are parsed with hand-written, linear-time parsers;
  `include.path` entries pointing outside the folder are skipped (`CONFIG_INCLUDE_SKIPPED`).

## Installing diffgit, offline use and patch files (T11.14)

- **The page's CSP does not change.** `connect-src 'none'` stays exactly as it was: the page, and
  every worker it starts, still cannot open a connection to anything, anywhere. What changed is one
  file. A service worker's policy comes from the headers of **its own script**, and under
  `connect-src 'none'` a service worker cannot fetch at all — not even to hand the page its own
  scripts — so `public/_headers` gives `/sw.js` a block of its own with `connect-src 'self'`
  (verified in Chromium; `scripts/check-dist.sh` and `scripts/check-prod.sh` both assert the two
  policies). That policy governs nothing but `sw.js`, and `sw.js` drops every request whose origin
  is not this one before doing anything with it — the file contains no URL at all, which the build
  gate greps for. If the header ever fails to arrive, the worker notices at install time that it
  cannot read its own assets and **unregisters itself**, so the app falls back to working exactly
  as it did before, online.
- **What is cached** is the list of files this build produced, and nothing else; `scripts/check-dist.sh`
  asserts that list against `dist/` and fails the deploy on a remote URL anywhere in the worker. A
  new build is a new worker with a new cache name, and it waits until you reload.
- **The manifest** registers diffgit as a handler for `.patch` and `.diff` files. Opening one hands
  the page a file the operating system chose; it is parsed in the worker and rendered, and it is
  never uploaded or written back. A patch opened this way runs with **no repository**: no folder
  handle, no File System Access API call, no refresh.
- **Installing changes one thing for you**: Chrome remembers folder permissions for an installed
  app, so it stops asking on every visit. It grants diffgit nothing it does not already have.

## Exports: the only bytes that leave the page, and where they go (T11.10)

- **There is no upload path.** `connect-src 'none'` makes one impossible. Every export is written by
  the browser itself, from a `blob:` URL on a detached `<a download>`; you choose the folder in the
  browser's own dialog. Nothing is written into your repository — it cannot be: writing through a
  File System Access handle needs the write-capable call `scripts/check-guards.sh` fails the build
  on (D16), which is also why `showSaveFilePicker()` is not used.
- **What each export contains.** *Copy as unified diff* / *Save as `.patch`* are the patch text
  `git apply` accepts, rendered from the comparison you are looking at. *Save review snapshot* is a
  single self-contained HTML file: the design tokens, the patch as diff bodies, the file list, the
  viewed ticks and a theme toggle in `localStorage`. It loads no script, no font and no image from
  anywhere — `scripts/check-guards.sh` greps the generator for a network call and
  `export.test.tsx` greps the generated page for one — so a snapshot opened from `file://` is as
  offline as diffgit is. *Copy file list as Markdown* and *Copy stats line* are paths and counts.
- **The secret gate runs before the write.** The uncommitted changes are scanned for credentials
  (locally, on the added lines only); if anything is found, every export that carries file content
  is replaced by a list of the findings — masked — and an explicit *Export anyway*. A snapshot
  written past the gate records that it was. "Not scanned yet" is treated as unknown, never as
  clean. The patch itself is **not** masked: it is your own lines, and a masked patch is one git
  refuses to apply — the gate is the protection, not redaction.

## Snapshot mode, on Firefox and Safari (T11.15)

- Those browsers have no File System Access API, so there is no handle to keep. The folder is read
  **once**, through `<input type="file" webkitdirectory>`, which is a browser-native file chooser:
  the page receives `File` objects, hands them to the same Web Worker, and the engine reads bytes
  out of them only when a diff actually needs them — a file the comparison does not touch is never
  read at all.
- Because there is no handle: **nothing is remembered**. Snapshot mode writes no Recent entry,
  starts no refresh scheduler and grants no lasting access; when the tab closes, the page has
  nothing left to open. A `Snapshot mode · read at 14:02 · Re-open to refresh` tag says exactly
  what you are looking at and how old it is.
- The same read-only guarantees apply: `File` objects carry no write path, the CSP is the same one,
  and a folder above 100,000 entries is refused with advice rather than read.

## How to clear everything

Chrome: click the tune/lock icon in the address bar → **Site settings** → **Delete data**
(or DevTools → Application → Storage → **Clear site data**). This removes the recent-repository
handles, viewed marks and preferences. Permissions to folders you opened are revoked automatically
when the tab closes; "Recent" only keeps a token that asks again.

## Reporting

Security or privacy issues: open an issue at the repository or write to the address in
`README.md`. Please include the browser version; no repository content is needed.
