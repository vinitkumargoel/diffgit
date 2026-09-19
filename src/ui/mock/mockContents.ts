/**
 * Deterministic file contents and a small line diff for the recorded-JSON mock engine (T4.1).
 * UI-only test/demo code; the real engine computes hunks in the worker (T3.4).
 */

import type {
  FileClassification,
  FileDiffPayload,
  Hunk,
  HunkLine,
  HunkModel,
} from "../../engine/api";
import { languageFor } from "../../engine/diff/language";

import type { FileDiff } from "../../engine/types";

function lines(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${prefix} ${i}`);
  return out;
}

const TS_OLD = `export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  const message = "Hello, " + name;
  return message;
}

export const VERSION = "1.0.0";
`;
const TS_NEW = `export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string, punctuation = "!"): string {
  const message = \`Hello, \${name}\${punctuation}\`;
  return message;
}

export const VERSION = "1.1.0";
`;

/** Returns [oldText, newText] for a recorded file id; null side = absent. */
export function mockTexts(file: FileDiff): [string | null, string | null] {
  switch (file.id) {
    case "docs/guide.md":
      return [
        "# Guide\nStep one.\nStep two.\n",
        "# Guide\nStep one.\nStep two, revised.\nStep three.\n",
      ];
    case "generated/bundle.js":
      return [
        "var a=1;var b=2;\nfunction f(){return a+b}\nmodule.exports=f;\n",
        "var a=1;var b=2;var c=3;\nfunction f(){return a+b+c}\nfunction g(){return c}\nmodule.exports={f:f,g:g};\n",
      ];
    case "lib/util.ts":
      return [TS_OLD, TS_NEW];
    case "scripts/build.sh":
      return ["#!/bin/sh\nbun run build\n", "#!/bin/sh\nbun run build\n"];
    case "src/a.txt":
      return [
        `${lines("alpha", 1, 8).join("\n")}\nalpha 9 edited\nalpha 10\n`,
        `${lines("alpha", 1, 8).join("\n")}\nalpha 9 edited\nalpha 10\nalpha 11 feature\n`,
      ];
    case "src/b.txt":
      return [`${lines("beta", 1, 5).join("\n")}\n`, null];
    case "src/big-change.txt":
      return [
        `${lines("line", 1, 3200).join("\n")}\n`,
        `${[...lines("line", 1, 100), ...lines("changed", 101, 3100), ...lines("line", 3101, 3200)].join("\n")}\n`,
      ];
    case "src/link":
      return ["target.txt", "now a regular file\n"];
    case "src/new.txt":
      return [null, "brand new on feature\n"];
    case "both.txt":
      return [
        `${lines("both", 1, 5).join("\n")}\n`,
        `${lines("both", 1, 5).join("\n")}\nstaged part\nunstaged part\n`,
      ];
    case "deleted-staged.txt":
      return ["will be git rm'd\n", null];
    case "deleted-unstaged.txt":
      return ["will be deleted without staging\n", null];
    case "feature-only.txt":
      return [null, "committed on feature\n"];
    case "newdir/untracked2.txt":
      return [null, "not tracked either\n"];
    case "script.sh":
      return ["#!/bin/sh\necho hi\n", "#!/bin/sh\necho hi\n"];
    case "staged-mod.txt":
      return [
        `${lines("staged", 1, 5).join("\n")}\n`,
        `${lines("staged", 1, 5).join("\n")}\nstaged extra\n`,
      ];
    case "staged-new.txt":
      return [null, "new and staged\n"];
    case "unstaged-mod.txt":
      return [
        `${lines("unstaged", 1, 5).join("\n")}\n`,
        `${lines("unstaged", 1, 4).join("\n")}\nunstaged 5 changed\n`,
      ];
    case "untracked.txt":
      return [null, "not tracked\n"];
    // T11.9: the `secrets` fixture verbatim (`scripts/make-fixtures.sh` `build_secrets`), so the
    // mock's line numbers are the ones the recorded `SecretFinding`s point at (3 · 1 · 4 and 5).
    case "config/deploy.sh":
      return [
        "#!/bin/sh\necho deploying\n",
        "#!/bin/sh\necho deploying\nexport ANTHROPIC_API_KEY=sk-ant-api03-7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3vN0bM8kH5lP2zD7wG4jF1sR6tY3uI9oA-QwErTyB\n",
      ];
    case "config/id_rsa":
      return [
        null,
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAJ9y7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3\nvN0bM8kH5lP2zD7wG4jF1sR6tY3uI9oAQwErTyBhZ0kCAwEAAQJATl1vZmFrZWtl\n-----END RSA PRIVATE KEY-----\n",
      ];
    case "config/settings.ini":
      return [
        "[app]\nname = diffgit\ndebug = false\n",
        "[app]\nname = diffgit\ndebug = false\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\ngithub_token = ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0\nrelease_commit = 9f2c0a1b7d4e6c8a3b5d7f9e1c2a4b6d8e0f2a4c\nlegacy_token = ghp_1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX # diffgit:allow-secret\n",
      ];
    case "file.txt":
      return [
        "line1\nline2\nline3\n",
        "line1\n<<<<<<< HEAD\nline2 from main\n=======\nline2 from feature\n>>>>>>> feature\nline3\n",
      ];
    default:
      return file.binary
        ? [null, null]
        : [`old content of ${file.id}\n`, `new content of ${file.id}\n`];
  }
}

function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Minimal LCS line diff (mock only). O(n·m) memory — capped for the 3200-line case by a fast path. */
export function mockHunks(oldText: string | null, newText: string | null, context = 3): HunkModel {
  const a = oldText === null ? [] : splitLines(oldText);
  const b = newText === null ? [] : splitLines(newText);
  const ops: HunkLine[] = [];
  if (a.length * b.length > 4_000_000) {
    // fast path: common prefix/suffix, replace the middle
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    for (let i = 0; i < p; i++) ops.push({ type: "ctx", old: i + 1, new: i + 1, text: a[i] ?? "" });
    for (let i = p; i < a.length - s; i++) ops.push({ type: "del", old: i + 1, text: a[i] ?? "" });
    for (let j = p; j < b.length - s; j++) ops.push({ type: "add", new: j + 1, text: b[j] ?? "" });
    for (let k = 0; k < s; k++) {
      const i = a.length - s + k;
      const j = b.length - s + k;
      ops.push({ type: "ctx", old: i + 1, new: j + 1, text: a[i] ?? "" });
    }
  } else {
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ type: "ctx", old: i + 1, new: j + 1, text: a[i] ?? "" });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ type: "add", new: j + 1, text: b[j] ?? "" });
        j++;
      } else {
        ops.push({ type: "del", old: i + 1, text: a[i] ?? "" });
        i++;
      }
    }
  }
  // group into hunks with `context` lines
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]?.type === "ctx") {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    let lastChange = k;
    while (end < ops.length) {
      if (ops[end]?.type !== "ctx") lastChange = end;
      else if (end - lastChange > context * 2) break;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(start, end);
    const oldStart = slice.find((l) => l.old !== undefined)?.old ?? slice[0]?.new ?? 1;
    const newStart = slice.find((l) => l.new !== undefined)?.new ?? slice[0]?.old ?? 1;
    hunks.push({
      oldStart,
      oldCount: slice.filter((l) => l.type !== "add").length,
      newStart,
      newCount: slice.filter((l) => l.type !== "del").length,
      lines: slice,
    });
    k = end;
  }
  return { oldLines: a.length, newLines: b.length, hunks };
}

export function mockPayload(
  file: FileDiff,
  generation: number,
  ignoreWhitespace: boolean,
  loadLarge: boolean,
): FileDiffPayload {
  const [oldText, newText] = mockTexts(file);
  const submodule = file.oldMode === 0o160000 || file.newMode === 0o160000;
  const typechange = file.status === "typechange";
  const huge = file.oldSize > 10_000_000 || file.newSize > 10_000_000;
  const textual = !file.binary && !submodule && !huge;
  const hunks = textual && (!file.tooLarge || loadLarge) ? mockHunks(oldText, newText) : null;
  let whitespaceOnly = false;
  let stats = file.stats;
  if (hunks) {
    let adds = 0;
    let dels = 0;
    for (const h of hunks.hunks)
      for (const l of h.lines) {
        if (l.type === "add") adds++;
        else if (l.type === "del") dels++;
      }
    stats = { additions: adds, deletions: dels };
    if (ignoreWhitespace) {
      const norm = (t: string | null) => (t ?? "").replace(/\s+/g, "");
      whitespaceOnly = (adds > 0 || dels > 0) && norm(oldText) === norm(newText);
    }
  }
  const classification: FileClassification = {
    binary: file.binary,
    image: file.image,
    tooLarge: file.tooLarge,
    huge,
    typechange,
    submodule,
    generated: file.generated === true,
    whitespaceOnly,
    oldSize: file.oldSize,
    newSize: file.newSize,
    changedLines: stats ? stats.additions + stats.deletions : null,
  };
  const payload: FileDiffPayload = {
    id: file.id,
    generation,
    classification,
    hunks: whitespaceOnly
      ? { oldLines: hunks?.oldLines ?? 0, newLines: hunks?.newLines ?? 0, hunks: [] }
      : hunks,
    oldText: textual ? oldText : null,
    newText: textual ? newText : null,
    language: languageFor(file.newPath ?? file.oldPath ?? ""),
    stats: textual ? stats : null,
    oldMode: file.oldMode,
    newMode: file.newMode,
  };
  if (submodule) payload.submodule = { oldOid: file.oldOid, newOid: file.newOid };
  return payload;
}
