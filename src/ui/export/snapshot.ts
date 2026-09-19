/**
 * The review snapshot (T11.10, Design §14.6, atlas tab 12): one self-contained `.html` file a
 * reviewer opens with no git, no server and no network.
 *
 * It is built here, as a string, from two things the app already has: the `DiffResult` rows and the
 * patch text the engine's own `patchText()` renderer produced for them. Nothing is fetched (the CSP
 * is `connect-src 'none'`), nothing is evaluated, and no colour is written down — the `:root` and
 * `.dark` token blocks are lifted out of `src/index.css` by `./tokens.ts`, so the page is themed by
 * exactly the Design §3 palette the app was showing.
 *
 * The body is the unified diff, sectioned per file. Splitting the patch is safe because we wrote
 * it: `patchText()` emits the rows in `DiffResult` order, one `diff --git` header each, optionally
 * preceded by the `# diffgit:` note of a file over 10 MB.
 */
import type { FileStats } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { filePathOf } from "../treeModel";
import { designTokens, type ThemeTokens } from "./tokens";

/** The status square's letter, as the sidebar and the StatsRow spell it (Design §3.3). */
const LETTER: Record<FileDiff["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
};

/** Five entities, so nothing in a diff line can close a tag or an attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The patch cut into one array of lines per file, in the order `patchText()` wrote them. A
 * `# diffgit:` note belongs to the section whose `diff --git` header follows it.
 */
export function splitPatch(patch: string): string[][] {
  if (patch === "") return [];
  const lines = patch.replace(/\n$/, "").split("\n");
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const note = line.startsWith("# diffgit: ");
    const header = line.startsWith("diff --git ");
    const continues =
      cur !== null && cur.length === 1 && (cur[0] as string).startsWith("# diffgit: ");
    if (note || (header && !continues)) {
      cur = [];
      out.push(cur);
    }
    if (cur === null) {
      cur = [];
      out.push(cur);
    }
    cur.push(line);
  }
  return out;
}

/** What the snapshot says about one file. */
export interface SnapshotFile {
  id: string;
  path: string;
  /** `M`, `A`, `D`, `R`, `C`, `T` — the same letter the sidebar shows. */
  letter: string;
  status: FileDiff["status"];
  stats: FileStats | null;
  viewed: boolean;
  /** The lines of this file's patch section. */
  lines: readonly string[];
}

export interface SnapshotInput {
  repo: string;
  /** `main … feature` / `v1 .. v2` — what `labelOf(diffSource)` says. */
  label: string;
  /** `Date.now()` when the snapshot was written. */
  at: number;
  files: readonly SnapshotFile[];
  tokens: ThemeTokens;
  /** The Design §14.3 warning, when the user exported past the secret gate. */
  warning?: string;
}

const LINE_CLASS: Record<string, string> = { "+": "add", "-": "del" };

/** One patch line → its row class. */
function classOf(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("# diffgit: "))
    return "meta";
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "meta";
  if (
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("\\ No newline")
  )
    return "meta";
  return LINE_CLASS[line.charAt(0)] ?? "ctx";
}

function counts(stats: FileStats | null): string {
  if (!stats) return "";
  return `<span class="plus">+${stats.additions}</span> <span class="minus">−${stats.deletions}</span>`;
}

/**
 * The snapshot's own behaviour: a theme toggle and the viewed ticks, both remembered in
 * `localStorage` under a key that carries the repository and the comparison. Plain DOM, no
 * dependencies, no `eval` — `scripts/check-dist.sh` greps the bundle for those and must stay green.
 */
const SCRIPT = `
(function () {
  var root = document.documentElement;
  var key = root.getAttribute("data-key");
  function read(name, fallback) {
    try { var v = localStorage.getItem(key + ":" + name); return v === null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function write(name, value) {
    try { localStorage.setItem(key + ":" + name, value); } catch (e) { /* private window: the page still works */ }
  }
  var stored = read("theme", null);
  var dark = stored === null
    ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
    : stored === "dark";
  function paint() {
    root.classList.toggle("dark", dark);
    var b = document.getElementById("theme");
    if (b) { b.setAttribute("aria-pressed", String(dark)); b.textContent = dark ? "Light theme" : "Dark theme"; }
  }
  paint();
  var toggle = document.getElementById("theme");
  if (toggle) toggle.addEventListener("click", function () { dark = !dark; write("theme", dark ? "dark" : "light"); paint(); });

  var viewed = {};
  try { viewed = JSON.parse(read("viewed", "{}")) || {}; } catch (e) { viewed = {}; }
  var boxes = document.querySelectorAll("input[data-file]");
  var done = document.getElementById("viewed-count");
  function tally() {
    var n = 0;
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) n++;
    if (done) done.textContent = n + " / " + boxes.length + " viewed";
  }
  for (var i = 0; i < boxes.length; i++) {
    (function (box) {
      var id = box.getAttribute("data-file");
      if (Object.prototype.hasOwnProperty.call(viewed, id)) box.checked = viewed[id] === true;
      var section = document.getElementById(box.getAttribute("data-section"));
      function apply() {
        if (section) section.classList.toggle("is-viewed", box.checked);
        viewed[id] = box.checked;
        write("viewed", JSON.stringify(viewed));
        tally();
      }
      box.addEventListener("change", apply);
      if (section) section.classList.toggle("is-viewed", box.checked);
    })(boxes[i]);
  }
  tally();
})();
`;

/** Layout and type. Every colour is a token; the values come from `src/index.css`. */
const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header.top { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 12px;
  align-items: center; padding: 10px 16px; background: var(--surface);
  border-bottom: 1px solid var(--line); }
header.top b { font-size: 14px; }
.compare { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.spacer { flex: 1; }
button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--surface-raised); color: var(--ink); cursor: pointer; }
main { display: flex; align-items: flex-start; gap: 16px; padding: 16px; }
nav { position: sticky; top: 56px; flex: 0 0 280px; max-height: calc(100vh - 80px); overflow: auto;
  border: 1px solid var(--line); border-radius: 6px; background: var(--surface-sunken); padding: 6px; }
nav a { display: flex; gap: 6px; align-items: baseline; padding: 3px 6px; border-radius: 4px;
  text-decoration: none; color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; }
nav a:hover { background: var(--surface-raised); }
nav .st { flex: 0 0 auto; width: 15px; height: 15px; border-radius: 4px; text-align: center;
  font-size: 9.5px; font-weight: 700; line-height: 15px; }
nav .p { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
section.file { border: 1px solid var(--line); border-radius: 6px; overflow: hidden;
  background: var(--surface); }
section.file > h2 { display: flex; gap: 10px; align-items: center; margin: 0; padding: 8px 12px;
  font-size: 12px; background: var(--surface-raised); border-bottom: 1px solid var(--line); }
section.file.is-viewed > pre { display: none; }
section.file.is-viewed > h2 { opacity: 0.6; }
h2 .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
h2 label { margin-left: auto; display: inline-flex; gap: 5px; align-items: center;
  color: var(--muted); font-weight: 400; }
pre { margin: 0; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 20px; tab-size: 2; }
pre .row { display: block; padding: 0 12px; white-space: pre; }
pre .add { background: var(--diff-add-bg); }
pre .del { background: var(--diff-del-bg); }
pre .hunk { background: var(--diff-hunk-bg); color: var(--diff-hunk-ink); }
pre .meta { color: var(--muted); }
.plus { color: var(--success); }
.minus { color: var(--danger); }
.notice { margin: 0 16px 16px; padding: 8px 12px; border-radius: 6px; font-size: 12.5px;
  border: 1px solid var(--danger); color: var(--danger); background: var(--surface); }
footer { padding: 12px 16px; color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--line); }
.M { background: var(--status-m-bg); color: var(--status-m-fg); }
.A { background: var(--status-a-bg); color: var(--status-a-fg); }
.D { background: var(--status-d-bg); color: var(--status-d-fg); }
.R, .C { background: var(--status-r-bg); color: var(--status-r-fg); }
.T { background: var(--status-t-bg); color: var(--status-t-fg); }
@media (max-width: 900px) { main { display: block; } nav { position: static; width: auto; margin-bottom: 16px; } }
`;

/** The whole document, ready to be handed to `downloadText`. */
export function buildSnapshot(input: SnapshotInput): string {
  const title = `${input.repo} · ${input.label}`;
  const key = `diffgit-snapshot:${input.repo}:${input.label}`;
  const nav = input.files
    .map(
      (f, i) =>
        `<a href="#file-${i}"><span class="st ${f.letter}">${f.letter}</span><span class="p">${escapeHtml(f.path)}</span>${counts(f.stats)}</a>`,
    )
    .join("\n      ");
  const sections = input.files
    .map((f, i) => {
      const body = f.lines
        .map((l) => `<span class="row ${classOf(l)}">${escapeHtml(l) || " "}</span>`)
        .join("");
      return `<section class="file" id="file-${i}">
        <h2><span class="st ${f.letter}">${f.letter}</span><span class="path">${escapeHtml(f.path)}</span>${counts(f.stats)}
          <label><input type="checkbox" data-file="${escapeHtml(f.id)}" data-section="file-${i}"${f.viewed ? " checked" : ""}> Viewed</label></h2>
        <pre>${body}</pre>
      </section>`;
    })
    .join("\n      ");
  const warning = input.warning ? `<p class="notice">${escapeHtml(input.warning)}</p>` : "";
  const written = new Date(input.at).toISOString().replace("T", " ").slice(0, 16);
  return `<!doctype html>
<html lang="en" data-key="${escapeHtml(key)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="diffgit review snapshot" />
    <title>${escapeHtml(title)}</title>
    <style>
:root { ${input.tokens.light} }
.dark { ${input.tokens.dark} }
${STYLE}</style>
  </head>
  <body>
    <header class="top">
      <b>${escapeHtml(input.repo)}</b>
      <span class="compare">${escapeHtml(input.label)}</span>
      <span class="spacer"></span>
      <span id="viewed-count"></span>
      <button type="button" id="theme" aria-pressed="false">Dark theme</button>
    </header>
    ${warning}
    <main>
      <nav aria-label="Files">
      ${nav}
      </nav>
      <div class="files">
      ${sections}
      </div>
    </main>
    <footer>Review snapshot written by diffgit on ${written} UTC. Read-only; nothing here talks to a network.</footer>
    <script>${SCRIPT}</script>
  </body>
</html>
`;
}

/**
 * The snapshot of one comparison: the rows of `files` with the sections of `patch`, paired by
 * position (both are in `DiffResult` order — contracts `<!-- T10.10 -->`). The caller owns the
 * engine call; this function is pure so a test can hand it a recorded diff and a recorded patch.
 */
export function snapshotFor(opts: {
  repo: string;
  label: string;
  at: number;
  patch: string;
  files: readonly FileDiff[];
  statsOf: (f: FileDiff) => FileStats | null;
  viewedOf: (f: FileDiff) => boolean;
  warning?: string;
  tokens?: ThemeTokens;
}): string {
  const sections = splitPatch(opts.patch);
  const files: SnapshotFile[] = opts.files.map((f, i) => ({
    id: f.id,
    path: filePathOf(f),
    letter: LETTER[f.status],
    status: f.status,
    stats: opts.statsOf(f),
    viewed: opts.viewedOf(f),
    lines: sections[i] ?? [],
  }));
  return buildSnapshot({
    repo: opts.repo,
    label: opts.label,
    at: opts.at,
    files,
    tokens: opts.tokens ?? designTokens(),
    ...(opts.warning === undefined ? {} : { warning: opts.warning }),
  });
}
