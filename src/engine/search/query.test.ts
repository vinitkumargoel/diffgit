/**
 * T10.8: the mode and escaping logic every scope shares.
 *
 * The point of these tests is the boundary between the two modes: exact mode must treat a query
 * full of regex metacharacters as text (no injection, no backtracking), and regex mode must reject
 * what it cannot safely run — an over-long pattern, and anything that does not compile under `u`.
 */
import { describe, expect, test } from "bun:test";
import { errorCode } from "../errors";
import {
  createMatcher,
  HIT_TEXT_MAX,
  isOidPrefix,
  QUERY_MAX_LENGTH,
  REGEX_MAX_LENGTH,
  searchKey,
  TimeBudget,
  trimHitText,
} from "./query";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    return errorCode(e) ?? "unknown";
  }
}

describe("exact mode is a literal substring", () => {
  test("metacharacters match themselves rather than compiling", () => {
    const m = createMatcher("chore(deps)");
    expect(m.regex).toBe(false);
    expect(m.test("c07: chore(deps): bump manifest")).toBe(true);
    // As a regex, `chore(deps)` would also match `choredeps`; as a literal it must not.
    expect(m.test("choredeps")).toBe(false);
  });

  test("a query of nothing but regex syntax is safe and matches only itself", () => {
    for (const q of ["(a+)+$", ".*", "[", "\\", "a{2,}", "(?<x>y)"]) {
      const m = createMatcher(q);
      expect(m.test(`prefix ${q} suffix`)).toBe(true);
      expect(m.test("prefix suffix")).toBe(false);
    }
  });

  test("matching is case-insensitive in both directions", () => {
    expect(createMatcher("GUIDE").test("# Guide")).toBe(true);
    expect(createMatcher("guide").test("# GUIDE")).toBe(true);
  });

  test("count is non-overlapping, which is the number `git log -S` compares", () => {
    expect(createMatcher("aa").count("aaaa")).toBe(2);
    expect(createMatcher("aa").count("aaa")).toBe(1);
    expect(createMatcher("module").count("module 1\nmodule 2\nMODULE 3")).toBe(3);
    expect(createMatcher("nope").count("module 1")).toBe(0);
  });
});

describe("regex mode is opt-in and bounded", () => {
  test("a valid pattern is case-insensitive and anchors per line", () => {
    const m = createMatcher("^c[0-9]+: extend mod[13]$", true);
    expect(m.regex).toBe(true);
    expect(m.test("c35: extend mod1")).toBe(true);
    expect(m.test("c36: extend mod2")).toBe(false);
    expect(m.test("C35: EXTEND MOD1")).toBe(true);
  });

  test("count walks the whole line and never loops on a zero-width match", () => {
    expect(createMatcher("mod[0-9]", true).count("mod1 mod2 mod3")).toBe(3);
    expect(createMatcher("x*", true).count("abc")).toBe(4); // one empty match per position + end
  });

  test("a pattern that does not compile is rejected, not run", () => {
    expect(codeOf(() => createMatcher("(unclosed", true))).toBe("INTERNAL");
    // The `u` flag is the third guard: this compiles without it and throws with it.
    expect(codeOf(() => createMatcher("\\-", true))).toBe("INTERNAL");
  });

  test(`a pattern longer than ${REGEX_MAX_LENGTH} characters is refused`, () => {
    const long = "a".repeat(REGEX_MAX_LENGTH + 1);
    expect(codeOf(() => createMatcher(long, true))).toBe("INTERNAL");
    // The same text is a perfectly good literal.
    expect(createMatcher(long).test(long)).toBe(true);
  });

  test("an empty query and an over-long literal are refused in both modes", () => {
    expect(codeOf(() => createMatcher(""))).toBe("INTERNAL");
    expect(codeOf(() => createMatcher("", true))).toBe("INTERNAL");
    expect(codeOf(() => createMatcher("x".repeat(QUERY_MAX_LENGTH + 1)))).toBe("INTERNAL");
  });

  test("a catastrophic pattern is bounded by the per-file budget, not by the pattern", () => {
    // `(a+)+$` on a run of `a` followed by anything else is the textbook exponential case. One
    // call cannot be interrupted, so the scopes check the budget *between* lines; this asserts the
    // shape of that loop: a handful of lines, then the budget is spent.
    const m = createMatcher("^(a+)+$", true);
    const line = `${"a".repeat(22)}b`;
    const budget = new TimeBudget(50);
    const t0 = performance.now();
    let examined = 0;
    for (let i = 0; i < 500 && !budget.expired; i++) {
      m.test(line);
      examined++;
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(examined).toBeGreaterThan(0);
    console.log(`catastrophic regex: ${examined} lines in ${ms.toFixed(1)} ms before the budget`);
  });
});

describe("helpers", () => {
  test("TimeBudget expires on its injected clock", () => {
    let now = 1000;
    const b = new TimeBudget(50, () => now);
    expect(b.expired).toBe(false);
    now = 1049;
    expect(b.expired).toBe(false);
    now = 1050;
    expect(b.expired).toBe(true);
  });

  test("trimHitText drops a CR and cuts at the preview length", () => {
    expect(trimHitText("hello\r")).toBe("hello");
    expect(trimHitText("x".repeat(HIT_TEXT_MAX + 10))).toBe("x".repeat(HIT_TEXT_MAX));
    expect(trimHitText("short")).toBe("short");
  });

  test("isOidPrefix accepts 4–40 hex characters and nothing else", () => {
    expect(isOidPrefix("abc")).toBe(false);
    expect(isOidPrefix("abcd")).toBe(true);
    expect(isOidPrefix("ABCDEF12")).toBe(true);
    expect(isOidPrefix("f".repeat(40))).toBe(true);
    expect(isOidPrefix("f".repeat(41))).toBe(false);
    expect(isOidPrefix("nothex")).toBe(false);
  });

  test("searchKey separates every field that changes the answer", () => {
    const base = { scope: "worktree", query: "a", limit: 10 } as const;
    expect(searchKey(base)).toBe("worktree|lit|||a");
    expect(searchKey({ ...base, regex: true })).not.toBe(searchKey(base));
    expect(searchKey({ ...base, path: "src" })).not.toBe(searchKey(base));
    expect(searchKey({ ...base, commits: 200 })).not.toBe(searchKey(base));
    expect(searchKey({ ...base, scope: "pickaxe" })).not.toBe(searchKey(base));
  });
});
