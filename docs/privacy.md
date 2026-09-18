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

## How to clear everything

Chrome: click the tune/lock icon in the address bar → **Site settings** → **Delete data**
(or DevTools → Application → Storage → **Clear site data**). This removes the recent-repository
handles, viewed marks and preferences. Permissions to folders you opened are revoked automatically
when the tab closes; "Recent" only keeps a token that asks again.

## Reporting

Security or privacy issues: open an issue at the repository or write to the address in
`README.md`. Please include the browser version; no repository content is needed.
