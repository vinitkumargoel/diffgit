/**
 * Revision resolver (T10.1, docs/v2-contracts.md; atlas tab "Compare anything").
 *
 * Supported, deliberately a subset of gitrevisions (the atlas risk row: "Support SHA prefix, refs,
 * tags, ~n, ^, stash@{n}. Anything else: not supported, paste a SHA"):
 *
 *   HEAD · refs/… (any full ref) · short names in git's own precedence · 7–40 hex SHA prefixes ·
 *   stash@{n} · the suffixes ~n, ^, ^n, ^0, ^{}, ^{commit} and any chain of them (`main~2^2`).
 *
 * Everything resolves to a **commit**: an annotated tag is peeled and the tag object is reported in
 * `peeledFrom`. `<root>^` (and `<root>~1`) resolve to `{ oid: null, kind: "empty-tree" }` so a root
 * commit can be compared against git's empty tree. Anything else → `REV_NOT_FOUND`; a short SHA that
 * matches several objects → `REV_AMBIGUOUS` with the candidates in `detail`.
 */
import { EngineError } from "../errors";
import type { Oid, RefSnapshot, ResolvedRevision } from "../types";
import type { ObjectDb } from "./objectDb";
import { parseStashLog, STASH_LOG_PATH } from "./stash";
import { peelTag } from "./tags";

/** Below this a prefix is too weak to be a SHA (atlas: "Require 7+ characters"). */
export const MIN_OID_PREFIX = 7;

const HEX_RE = /^[0-9a-f]+$/;
const STASH_RE = /^stash@\{(\d+)\}$/;

/** The short form the picker shows for a bare SHA. */
export function shortOid(oid: Oid): string {
  return oid.slice(0, 7);
}

function notFound(expr: string): EngineError {
  return new EngineError("REV_NOT_FOUND", `Cannot resolve "${expr}".`, {
    hint: "Use a branch, tag, stash or a SHA of at least 7 characters.",
  });
}

/** One `~n` / `^` / `^n` / `^{…}` step of an expression. */
type Step =
  | { op: "ancestor"; n: number } // ~n
  | { op: "parent"; n: number } // ^ , ^n , ^0
  | { op: "peel"; want: "any" | "commit" }; // ^{} , ^{commit}

interface Parsed {
  base: string;
  steps: Step[];
}

/**
 * Splits `main~2^2` into `"main"` + the steps. Braces are tracked so `stash@{0}` and `^{commit}`
 * survive; an unparseable tail throws `REV_NOT_FOUND` rather than being silently ignored.
 */
export function parseRevision(expr: string): Parsed {
  let depth = 0;
  let cut = expr.length;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] as string;
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && (c === "~" || c === "^")) {
      cut = i;
      break;
    }
  }
  const base = expr.slice(0, cut);
  const steps: Step[] = [];
  let i = cut;
  while (i < expr.length) {
    const c = expr[i] as string;
    if (c === "~") {
      const m = /^~(\d*)/.exec(expr.slice(i)) as RegExpExecArray;
      steps.push({ op: "ancestor", n: m[1] === "" ? 1 : Number.parseInt(m[1] as string, 10) });
      i += m[0].length;
    } else if (c === "^" && expr[i + 1] === "{") {
      const end = expr.indexOf("}", i);
      if (end === -1) throw notFound(expr);
      const want = expr.slice(i + 2, end);
      if (want !== "" && want !== "commit") throw notFound(expr);
      steps.push({ op: "peel", want: want === "" ? "any" : "commit" });
      i = end + 1;
    } else if (c === "^") {
      const m = /^\^(\d*)/.exec(expr.slice(i)) as RegExpExecArray;
      steps.push({ op: "parent", n: m[1] === "" ? 1 : Number.parseInt(m[1] as string, 10) });
      i += m[0].length;
    } else throw notFound(expr);
  }
  return { base, steps };
}

/** Git's own short-name search order (gitrevisions "Specifying revisions", rule 6). */
function candidateRefs(name: string): string[] {
  return [
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
}

interface Base {
  oid: Oid;
  kind: ResolvedRevision["kind"];
  display: string;
  fullRef?: string;
}

async function resolveStash(db: ObjectDb, index: number): Promise<Base | null> {
  const entries = parseStashLog(await db.readGitText(STASH_LOG_PATH));
  const entry = entries[index];
  if (!entry) return null;
  return { oid: entry.oid, kind: "stash", display: `stash@{${index}}` };
}

async function resolveBase(db: ObjectDb, refs: RefSnapshot, expr: string): Promise<Base> {
  if (expr === "") throw notFound(expr);

  if (expr === "HEAD") {
    if (refs.headOid === null) throw notFound(expr); // unborn branch: nothing to compare
    return { oid: refs.headOid, kind: "head", display: "HEAD", fullRef: "HEAD" };
  }

  const stash = STASH_RE.exec(expr);
  if (stash) {
    const found = await resolveStash(db, Number.parseInt(stash[1] as string, 10));
    if (!found) throw notFound(expr);
    return found;
  }

  if (expr.startsWith("refs/")) {
    const oid = await db.tryResolveRef(expr);
    if (oid === null) throw notFound(expr);
    return { oid, kind: kindOfRef(expr), display: displayOfRef(expr), fullRef: expr };
  }

  for (const ref of candidateRefs(expr)) {
    const oid = await db.tryResolveRef(ref);
    if (oid !== null) return { oid, kind: kindOfRef(ref), display: expr, fullRef: ref };
  }

  if (HEX_RE.test(expr) && expr.length >= MIN_OID_PREFIX && expr.length <= 40) {
    const matches = await db.expandOid(expr);
    if (matches.length > 1) {
      throw new EngineError("REV_AMBIGUOUS", `"${expr}" matches ${matches.length} objects.`, {
        hint: "Type more characters of the SHA.",
        detail: matches.join(","),
      });
    }
    const oid = matches[0];
    if (oid !== undefined) return { oid, kind: "commit", display: shortOid(oid) };
  }

  throw notFound(expr);
}

function kindOfRef(fullRef: string): ResolvedRevision["kind"] {
  if (fullRef.startsWith("refs/tags/")) return "tag";
  if (fullRef.startsWith("refs/remotes/")) return "remote";
  if (fullRef.startsWith("refs/heads/")) return "branch";
  return "commit";
}

function displayOfRef(fullRef: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    if (fullRef.startsWith(prefix)) return fullRef.slice(prefix.length);
  }
  return fullRef;
}

/**
 * Resolves one revision expression against the repository.
 * @throws EngineError `REV_NOT_FOUND` / `REV_AMBIGUOUS`.
 */
export async function resolveRevision(
  db: ObjectDb,
  refs: RefSnapshot,
  expr: string,
): Promise<ResolvedRevision> {
  const trimmed = expr.trim();
  const { base, steps } = parseRevision(trimmed);
  const found = await resolveBase(db, refs, base);

  // Everything downstream wants a commit, so an annotated tag is peeled first (git does the same
  // before applying ~ / ^).
  const peeled = await peelTag(db, found.oid);
  let oid: Oid | null = peeled.target;
  const peeledFrom = peeled.tagOid;

  for (const step of steps) {
    if (oid === null) throw notFound(trimmed); // nothing precedes the empty tree
    if (step.op === "peel") {
      continue; // already peeled to a commit above; ^{} and ^{commit} are a no-op here
    }
    const times = step.op === "ancestor" ? step.n : 1;
    for (let i = 0; i < times; i++) {
      if (oid === null) throw notFound(trimmed);
      const commit = await db.readCommit(oid);
      if (step.op === "parent" && step.n === 0) break; // `^0` = "this commit as a commit"
      const wanted = step.op === "ancestor" ? 1 : step.n;
      const parent = commit.parents[wanted - 1];
      if (parent === undefined) {
        // The first parent of a root commit is git's empty tree; any other parent does not exist.
        if (wanted === 1 && commit.parents.length === 0) {
          oid = null;
          continue;
        }
        throw notFound(trimmed);
      }
      oid = parent;
    }
  }

  const walked = steps.some((s) => s.op !== "peel");
  const out: ResolvedRevision = {
    expr: trimmed,
    oid,
    kind: oid === null ? "empty-tree" : walked ? "commit" : found.kind,
    display: walked ? trimmed : found.display,
  };
  if (!walked && found.fullRef !== undefined) out.fullRef = found.fullRef;
  if (peeledFrom !== null) out.peeledFrom = peeledFrom;
  return out;
}
