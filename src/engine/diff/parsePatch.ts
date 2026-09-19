/**
 * Unified diff → `FileDiff[]` + `HunkModel`s (T10.12, atlas tab 17, Design §14.6 "patch-only").
 *
 * This is the inverse of `patchText.ts`: the renderer turns diff rows into git-format text, and
 * this turns text back into rows the existing `FileCard` can draw without a repository behind it.
 * The two are tested against each other — `parsePatch(patchText(rows))` must reproduce the file
 * set, the statuses, the rename similarities and the hunk line counts.
 *
 * What it accepts, because these are the patches that actually land in a bug report:
 *
 *  * **git format** — `diff --git a/x b/y` with `new file mode` / `deleted file mode` /
 *    `old mode` + `new mode`, `similarity index` + `rename from`/`rename to` (and the `copy`
 *    forms), `index <a>..<b>[ <mode>]`, `Binary files … differ`, `GIT binary patch`, and
 *    `quote_c_style` paths (`"src/caf\303\251.txt"`).
 *  * **plain unified** — a bare `--- old` / `+++ new` pair with no git header at all, as `diff -u`
 *    and most review tools emit, including the trailing timestamp after a tab.
 *  * `--- /dev/null` / `+++ /dev/null` for an added or deleted file.
 *  * `\ No newline at end of file` on either side.
 *  * CRLF terminators throughout, and preamble (a `format-patch` mail header, a diffstat, the
 *    `# diffgit:` note `patchText` writes before a huge row, a trailing `-- \n2.43.0` signature).
 *
 * Anything that is not a patch at all, and any hunk whose body does not match its `@@` header,
 * is `NOT_A_PATCH` with the **first** offending line number in `detail`.
 *
 * Two things a patch cannot tell us, spelled out here rather than guessed:
 *
 *  * **Sizes.** `FileDiff.oldSize`/`newSize` are 0. A patch carries changed lines, not file sizes,
 *    and inventing a number would make the UI's `tooLarge` gate lie.
 *  * **Layers.** Every row is `["committed"]`. There is no index and no working tree in patch-only
 *    mode, so the D6 layer badges have nothing to distinguish.
 */
import type { Hunk, HunkLine, HunkModel, PatchResult } from "../api";
import { EngineError } from "../errors";
import type { ChangeLayer, FileDiff, FileStatus, Oid, RepoWarning } from "../types";
import { isImagePath } from "./binary";

/** The info banner patch-only mode shows (Design §14.6); `PatchResult.warnings` always carries it. */
export const PATCH_ONLY_WARNING: RepoWarning = {
  code: "PATCH_ONLY",
  message: "A patch file is open; there is no repository to compare it against.",
};

const PATCH_LAYERS: ChangeLayer[] = ["committed"];
const DEV_NULL = "/dev/null";
const NULL_OID_RE = /^0+$/;

function notAPatch(lineNumber: number, line: string, why: string): never {
  throw new EngineError("NOT_A_PATCH", `This file is not a unified diff: ${why}.`, {
    hint: "Open a .patch or .diff produced by `git diff` or `git format-patch`.",
    detail: `line ${lineNumber}: ${JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}…` : line)}`,
  });
}

// ---- path quoting ------------------------------------------------------------------------------

const UNESCAPE: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};
const utf8 = new TextDecoder("utf-8");

/** The inverse of `patchText.quotePath`: `"a\303\251b"` → `aéb`; an unquoted path is returned as-is. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      // Already-decoded characters (a tool that did not octal-escape) re-encode as UTF-8.
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    const octal = /^[0-7]$/.test(n) ? body.slice(i, i + 3) : null;
    if (octal !== null && /^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 2;
      continue;
    }
    bytes.push(UNESCAPE[n] ?? n.charCodeAt(0));
  }
  return utf8.decode(new Uint8Array(bytes));
}

/**
 * Drop the `a/` / `b/` the patch prefixes paths with. A git-format patch always has one leading
 * component (git's `--src-prefix`, so not necessarily the letter `a`); a plain `diff -u` usually
 * has none, so only the literal `a/` and `b/` are stripped there.
 */
function stripPrefix(path: string, gitFormat: boolean): string {
  if (/^[ab]\//.test(path)) return path.slice(2);
  if (gitFormat) {
    const slash = path.indexOf("/");
    if (slash > 0) return path.slice(slash + 1);
  }
  return path;
}

/** One `---`/`+++` operand: the path, or null for `/dev/null`. A tab starts a timestamp. */
function sidePath(rest: string, gitFormat: boolean): string | null {
  const cut = rest.indexOf("\t");
  const token = (cut === -1 ? rest : rest.slice(0, cut)).trim();
  const path = unquotePath(token);
  if (path === DEV_NULL) return null;
  return stripPrefix(path, gitFormat);
}

/**
 * The two operands of `diff --git <a> <b>`. Unquoted paths may contain spaces, which makes the
 * line ambiguous — git resolves it the same way: try the split that gives two halves of equal
 * length (the overwhelmingly common `a/X b/X`), then the first space.
 */
function gitHeaderPaths(rest: string): { old: string | null; new: string | null } {
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end > 0 && rest[end + 1] === " ") {
      return {
        old: stripPrefix(unquotePath(rest.slice(0, end + 1)), true),
        new: stripPrefix(unquotePath(rest.slice(end + 2)), true),
      };
    }
  }
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    if (rest[half] === " ") {
      const a = rest.slice(0, half);
      const b = rest.slice(half + 1);
      if (a.includes("/") && b.includes("/"))
        return { old: stripPrefix(a, true), new: stripPrefix(b, true) };
    }
  }
  const sp = rest.indexOf(" ");
  if (sp <= 0) return { old: null, new: null };
  return {
    old: stripPrefix(unquotePath(rest.slice(0, sp)), true),
    new: stripPrefix(unquotePath(rest.slice(sp + 1)), true),
  };
}

function findQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

// ---- line normalisation ------------------------------------------------------------------------

const STRUCTURAL =
  /^(diff --git |diff -|index |--- |\+\+\+ |@@ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |Files |GIT binary patch|\\ )/;

/**
 * Split into lines, dropping the CR of CRLF terminators.
 *
 * A patch whose every line ends in CR was written with CRLF terminators, so every CR is a
 * terminator and none is content. A mixed file is a patch of a CRLF *file*, where a `\r` at the end
 * of a `+`/`-`/` ` line is part of the line and must survive — there only the structural lines are
 * trimmed.
 */
export function patchLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const body = lines.length > 0 ? lines : [];
  const allCr = body.length > 0 && body.every((l) => l.endsWith("\r"));
  return body.map((l) => ((allCr || STRUCTURAL.test(l)) && l.endsWith("\r") ? l.slice(0, -1) : l));
}

// ---- the parser ---------------------------------------------------------------------------------

interface Section {
  /** The section opened with `diff --git`, so its `---`/`+++` operands carry an `a/`/`b/` prefix. */
  git: boolean;
  /** A `---` line has been seen, so the next `---`/`+++` pair opens a new file. */
  sawMinus: boolean;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus | null;
  similarity: number | null;
  oldMode: number | null;
  newMode: number | null;
  oldOid: Oid | null;
  newOid: Oid | null;
  binary: boolean;
  hunks: Hunk[];
  maxOld: number;
  maxNew: number;
}

function newSection(git: boolean): Section {
  return {
    git,
    sawMinus: false,
    oldPath: null,
    newPath: null,
    status: null,
    similarity: null,
    oldMode: null,
    newMode: null,
    oldOid: null,
    newOid: null,
    binary: false,
    hunks: [],
    maxOld: 0,
    maxNew: 0,
  };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Does this line open a new file section? `diff --git` always does. A bare `---`/`+++` pair only
 * does when no section is open, or when the open one already had its own `---` — inside a git
 * section the `---` line is part of *that* file, not the start of the next.
 */
function isSectionStart(line: string, next: string | undefined, open: Section | null): boolean {
  if (line.startsWith("diff --git ")) return true;
  if (!line.startsWith("--- ") || next === undefined || !next.startsWith("+++ ")) return false;
  return open === null || open.sawMinus;
}

function oidOrNull(raw: string): Oid | null {
  const s = raw.trim();
  if (s === "" || NULL_OID_RE.test(s) || !/^[0-9a-f]+$/.test(s)) return null;
  return s;
}

/** Parse one `@@` hunk starting at `i`; returns the hunk and the index of the line after it. */
function parseHunk(lines: string[], i: number, section: Section): { hunk: Hunk; next: number } {
  const header = HUNK_HEADER.exec(lines[i] as string);
  if (!header) notAPatch(i + 1, lines[i] as string, "expected a @@ hunk header");
  const oldStart = Number(header[1]);
  const oldCount = header[2] === undefined ? 1 : Number(header[2]);
  const newStart = Number(header[3]);
  const newCount = header[4] === undefined ? 1 : Number(header[4]);
  const body: HunkLine[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  let j = i + 1;
  while (j < lines.length && (oldSeen < oldCount || newSeen < newCount)) {
    const line = lines[j] as string;
    const marker = line === "" ? " " : (line[0] as string);
    const text = line === "" ? "" : line.slice(1);
    if (marker === "\\") {
      // `\ No newline at end of file` belongs to the previous line and counts for nothing.
      j++;
      continue;
    }
    if (marker === " ") {
      if (oldSeen >= oldCount || newSeen >= newCount)
        notAPatch(j + 1, line, "more context lines than the @@ header allows");
      body.push({ type: "ctx", old: oldStart + oldSeen, new: newStart + newSeen, text });
      oldSeen++;
      newSeen++;
    } else if (marker === "-") {
      if (oldSeen >= oldCount)
        notAPatch(j + 1, line, "more removed lines than the @@ header allows");
      body.push({ type: "del", old: oldStart + oldSeen, text });
      oldSeen++;
    } else if (marker === "+") {
      if (newSeen >= newCount) notAPatch(j + 1, line, "more added lines than the @@ header allows");
      body.push({ type: "add", new: newStart + newSeen, text });
      newSeen++;
    } else {
      notAPatch(j + 1, line, "a hunk line must start with ' ', '+', '-' or '\\'");
    }
    j++;
  }
  if (oldSeen !== oldCount || newSeen !== newCount)
    notAPatch(
      i + 1,
      lines[i] as string,
      `the hunk ends after ${oldSeen}/${newSeen} lines but its header promises ${oldCount}/${newCount}`,
    );
  // A `\ No newline` marker may trail the last line of the hunk.
  while (j < lines.length && (lines[j] as string).startsWith("\\")) j++;
  section.maxOld = Math.max(section.maxOld, oldStart + Math.max(oldCount, 1) - 1);
  section.maxNew = Math.max(section.maxNew, newStart + Math.max(newCount, 1) - 1);
  return { hunk: { oldStart, oldCount, newStart, newCount, lines: body }, next: j };
}

function finish(section: Section): { file: FileDiff; model: HunkModel } | null {
  const newPath = section.newPath;
  const oldPath = section.oldPath;
  if (newPath === null && oldPath === null) return null;
  const path = (newPath ?? oldPath) as string;
  let status: FileStatus = section.status ?? "modified";
  if (section.status === null) {
    if (oldPath === null) status = "added";
    else if (newPath === null) status = "deleted";
  }
  // A mode change between two object *types* (`old mode 120000` / `new mode 100644`) is a
  // typechange to `describeFile`, but the diff engine still calls the row `modified` — the two
  // sides have content on both ends. The parser follows the engine so a round-trip is an identity.
  const additions = section.hunks.reduce(
    (n, h) => n + h.lines.filter((l) => l.type === "add").length,
    0,
  );
  const deletions = section.hunks.reduce(
    (n, h) => n + h.lines.filter((l) => l.type === "del").length,
    0,
  );
  const file: FileDiff = {
    id: path,
    oldPath,
    newPath,
    status,
    layers: [...PATCH_LAYERS],
    ...(section.similarity !== null ? { similarity: section.similarity } : {}),
    oldOid: section.oldOid,
    newOid: section.newOid,
    oldMode: section.oldMode,
    newMode: section.newMode,
    binary: section.binary,
    image: isImagePath(path),
    oldSize: 0,
    newSize: 0,
    stats: section.binary ? null : { additions, deletions },
    tooLarge: false,
  };
  return {
    file,
    model: { oldLines: section.maxOld, newLines: section.maxNew, hunks: section.hunks },
  };
}

/** Fold a `deleted` + `added` pair for one path into the single `typechange` row the engine emits. */
function mergeSections(before: FileDiff, next: FileDiff): FileDiff {
  const pair =
    (before.status === "deleted" && next.status === "added") ||
    (before.status === "added" && next.status === "deleted");
  if (!pair) return next; // a patch that simply lists the same path twice: the later one wins
  const del = before.status === "deleted" ? before : next;
  const add = before.status === "deleted" ? next : before;
  return {
    ...add,
    oldPath: del.oldPath,
    newPath: add.newPath,
    status: "typechange",
    oldOid: del.oldOid,
    newOid: add.newOid,
    oldMode: del.oldMode,
    newMode: add.newMode,
    binary: del.binary || add.binary,
    stats:
      del.stats === null || add.stats === null
        ? null
        : {
            additions: del.stats.additions + add.stats.additions,
            deletions: del.stats.deletions + add.stats.deletions,
          },
  };
}

function mergeModels(before: HunkModel, next: HunkModel): HunkModel {
  return {
    oldLines: Math.max(before.oldLines, next.oldLines),
    newLines: Math.max(before.newLines, next.newLines),
    hunks: [...before.hunks, ...next.hunks],
  };
}

/**
 * Parse one unified diff. Pure: no I/O, no repository, nothing but the text.
 * Throws `NOT_A_PATCH` when the text holds no file section at all, or when a hunk is malformed.
 */
export function parsePatch(text: string): PatchResult {
  const lines = patchLines(text);
  const files: FileDiff[] = [];
  const hunks: Record<string, HunkModel> = {};
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let firstUnknown = -1;

  const at = new Map<string, number>();
  const flush = (section: Section | null) => {
    if (section === null) return;
    const done = finish(section);
    if (done === null) return;
    additions += done.file.stats?.additions ?? 0;
    deletions += done.file.stats?.deletions ?? 0;
    const seen = at.get(done.file.id);
    if (seen === undefined) {
      at.set(done.file.id, files.length);
      files.push(done.file);
      hunks[done.file.id] = done.model;
      return;
    }
    // git writes a type change (symlink → regular file) as a `deleted file mode` section followed
    // by a `new file mode` one for the same path — two patches, because that is how it applies.
    // The diff engine has one row per path, so they are folded back into one `typechange` row.
    const merged = mergeSections(files[seen] as FileDiff, done.file);
    files[seen] = merged;
    hunks[merged.id] = mergeModels(hunks[merged.id] as HunkModel, done.model);
  };

  let section: Section | null = null;
  while (i < lines.length) {
    const line = lines[i] as string;
    const next = lines[i + 1];

    if (isSectionStart(line, next, section)) {
      flush(section);
      section = newSection(line.startsWith("diff --git "));
      if (line.startsWith("diff --git ")) {
        const paths = gitHeaderPaths(line.slice("diff --git ".length));
        section.oldPath = paths.old;
        section.newPath = paths.new;
        i++;
        continue;
      }
      // Plain unified diff: `--- old` / `+++ new`, handled by the header block below.
    }

    if (section === null) {
      if (firstUnknown === -1) firstUnknown = i;
      i++;
      continue;
    }

    if (line.startsWith("@@ ")) {
      const { hunk, next: after } = parseHunk(lines, i, section);
      section.hunks.push(hunk);
      i = after;
      continue;
    }

    if (line.startsWith("--- ")) {
      section.sawMinus = true;
      const p = sidePath(line.slice(4), section.git);
      if (p === null) {
        section.oldPath = null;
        section.status ??= "added";
      } else if (section.oldPath === null && section.status !== "added") section.oldPath = p;
      i++;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = sidePath(line.slice(4), section.git);
      if (p === null) {
        section.newPath = null;
        section.status ??= "deleted";
      } else if (section.newPath === null && section.status !== "deleted") section.newPath = p;
      i++;
      continue;
    }

    const consumed = headerLine(line, section);
    if (consumed) {
      i++;
      continue;
    }
    if (line === "GIT binary patch") {
      section.binary = true;
      // The literal/delta payload is base85 and is not rendered; skip to the next section.
      i++;
      while (i < lines.length && !isSectionStart(lines[i] as string, lines[i + 1], section)) i++;
      continue;
    }
    if (firstUnknown === -1) firstUnknown = i;
    i++;
  }
  flush(section);

  if (files.length === 0) {
    const at = firstUnknown === -1 ? 0 : firstUnknown;
    notAPatch(at + 1, lines[at] ?? "", "no `diff --git` or `---`/`+++` file header was found");
  }
  return {
    files,
    hunks,
    stats: { files: files.length, additions, deletions },
    warnings: [PATCH_ONLY_WARNING],
  };
}

/** One git extended-header line; true when it was recognised and consumed. */
function headerLine(line: string, s: Section): boolean {
  let m = /^old mode (\d+)$/.exec(line);
  if (m) {
    s.oldMode = Number.parseInt(m[1] as string, 8);
    return true;
  }
  m = /^new mode (\d+)$/.exec(line);
  if (m) {
    s.newMode = Number.parseInt(m[1] as string, 8);
    return true;
  }
  m = /^new file mode (\d+)$/.exec(line);
  if (m) {
    s.newMode = Number.parseInt(m[1] as string, 8);
    s.oldMode = null;
    s.status = "added";
    s.oldPath = null;
    return true;
  }
  m = /^deleted file mode (\d+)$/.exec(line);
  if (m) {
    s.oldMode = Number.parseInt(m[1] as string, 8);
    s.newMode = null;
    s.status = "deleted";
    s.newPath = null;
    return true;
  }
  m = /^similarity index (\d+)%$/.exec(line);
  if (m) {
    s.similarity = Number(m[1]);
    return true;
  }
  m = /^dissimilarity index (\d+)%$/.exec(line);
  if (m) {
    s.similarity = 100 - Number(m[1]);
    return true;
  }
  m = /^(rename|copy) from (.*)$/.exec(line);
  if (m) {
    s.oldPath = unquotePath(m[2] as string);
    s.status = m[1] === "copy" ? "copied" : "renamed";
    return true;
  }
  m = /^(rename|copy) to (.*)$/.exec(line);
  if (m) {
    s.newPath = unquotePath(m[2] as string);
    s.status = m[1] === "copy" ? "copied" : "renamed";
    return true;
  }
  m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(line);
  if (m) {
    s.oldOid = oidOrNull(m[1] as string);
    s.newOid = oidOrNull(m[2] as string);
    if (m[3] !== undefined && s.oldMode === null && s.newMode === null) {
      const mode = Number.parseInt(m[3] as string, 8);
      s.oldMode = mode;
      s.newMode = mode;
    }
    return true;
  }
  if (/^(Binary files|Files) .* differ$/.test(line)) {
    s.binary = true;
    return true;
  }
  return false;
}
