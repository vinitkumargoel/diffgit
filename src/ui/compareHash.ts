/**
 * `#compare=<from>...<to>` — the only deep link diffgit has (T11.2, atlas tab "Compare anything":
 * "URL state: `#compare=v2.3.0...stash@{0}` so a comparison can be bookmarked (no server, still)").
 *
 * `...` is three-dot (merge base), `..` is two-dot (plain tree diff), matching git's own spelling.
 * The hash is written with `history.replaceState` so it never grows the back stack, and it is read
 * **once per page load**: a reload lands on Home, and the spec is applied to the first repository
 * that opens afterwards (the folder handle cannot be restored without a user gesture, D4). An
 * expression that no longer resolves toasts and leaves the default source alone — never an error
 * screen, because a stale bookmark is not a broken repository.
 */
import type { DiffSource } from "../engine/types";
import { sideOf } from "./compareSource";
import { useStore } from "./store";

export interface CompareSpec {
  from: string;
  to: string;
  threeDot: boolean;
}

/** `refs/heads/main` → `main`, `refs/remotes/origin/x` → `origin/x`; `HEAD` and SHAs pass through. */
export function shortExpr(expr: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    if (expr.startsWith(prefix)) return expr.slice(prefix.length);
  }
  return expr;
}

/** The two sides of a source as the short, resolvable expressions the hash carries. */
export function compareSpecOf(src: DiffSource): CompareSpec {
  // `sideOf` only needs the refs to fill an oid the hash does not use.
  const refs = {
    headBranch: null,
    headOid: null,
    detached: false,
    unborn: false,
    headDisplay: "",
    refs: [],
    defaultRef: null,
  };
  return {
    from: shortExpr(sideOf(src, "target", refs).expr),
    to: shortExpr(sideOf(src, "source", refs).expr),
    threeDot: src.kind !== "range" || src.threeDot,
  };
}

/** `#compare=main...feature`. */
export function formatCompareHash(src: DiffSource): string {
  const spec = compareSpecOf(src);
  return `#compare=${spec.from}${spec.threeDot ? "..." : ".."}${spec.to}`;
}

/** Parses `#compare=a...b` / `#compare=a..b`; anything else (including `#debug`) is `null`. */
export function parseCompareHash(hash: string): CompareSpec | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("compare=")) return null;
  const body = decode(raw.slice("compare=".length));
  // `...` first: a tag like `v1.0.0` is full of single dots, so the longer separator must win.
  const three = body.indexOf("...");
  const at = three >= 0 ? three : body.indexOf("..");
  if (at < 0) return null;
  const width = three >= 0 ? 3 : 2;
  const from = body.slice(0, at);
  const to = body.slice(at + width);
  if (from === "" || to === "") return null;
  return { from, to, threeDot: three >= 0 };
}

/** Browsers percent-encode `{`/`}` in a hash; a hand-typed one may not. Both must parse. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray `%` is not an encoding, it is part of the expression
  }
}

function write(src: DiffSource): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  if (location.hash === "#debug") return; // the debug panel owns the hash while it is open (T7.2)
  const next = formatCompareHash(src);
  if (location.hash === next) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

/**
 * Keeps `location.hash` and the store's `diffSource` in step. Returns the unsubscribe.
 * The spec present at install time is applied to the first repository that reaches the repo screen;
 * from then on every source change is written back.
 */
export function installCompareHash(): () => void {
  let pending = typeof location === "undefined" ? null : parseCompareHash(location.hash);
  let appliedFor: string | null = null;
  return useStore.subscribe((s) => {
    if (s.screen !== "repo" || !s.diffSource || s.repoId === null) return;
    if (pending !== null && appliedFor !== s.repoId) {
      appliedFor = s.repoId;
      const spec = pending;
      pending = null;
      void useStore.getState().applyCompare(spec);
      return;
    }
    write(s.diffSource);
  });
}
