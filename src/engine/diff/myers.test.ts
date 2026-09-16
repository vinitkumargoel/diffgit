import { describe, expect, test } from "bun:test";
import { myersDiff } from "./myers";
import { lineDiff, statsFromOps } from "./textDiff";

/** Reference LCS length (DP) to verify minimality of the edit script. */
function lcs(a: number[], b: number[]): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

function applyOps(a: number[], b: number[], ops: ReturnType<typeof myersDiff>): number[] {
  const out: number[] = [];
  for (const op of ops) {
    if (op.type === "eq") for (let k = 0; k < op.count; k++) out.push(a[op.oldStart + k] as number);
    else if (op.type === "add")
      for (let k = 0; k < op.count; k++) out.push(b[op.newStart + k] as number);
  }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("myersDiff", () => {
  test("random arrays: script reproduces b from a and is minimal (matches LCS)", () => {
    const rand = rng(42);
    for (let iter = 0; iter < 300; iter++) {
      const n = Math.floor(rand() * 40);
      const m = Math.floor(rand() * 40);
      const alphabet = 1 + Math.floor(rand() * 6);
      const a = Array.from({ length: n }, () => Math.floor(rand() * alphabet));
      const b = Array.from({ length: m }, () => Math.floor(rand() * alphabet));
      const ops = myersDiff(Int32Array.from(a), Int32Array.from(b));
      expect(applyOps(a, b, ops)).toEqual(b);
      // ops must also consume a fully, in order
      let o = 0;
      let nn = 0;
      for (const op of ops) {
        expect(op.oldStart).toBe(o);
        expect(op.newStart).toBe(nn);
        if (op.type !== "add") o += op.count;
        if (op.type !== "del") nn += op.count;
      }
      expect(o).toBe(n);
      expect(nn).toBe(m);
      const { additions, deletions } = statsFromOps(ops);
      const l = lcs(a, b);
      expect(deletions).toBe(n - l);
      expect(additions).toBe(m - l);
    }
  });

  test("budget exhaustion degrades to replace-all but stays correct", () => {
    const a = Array.from({ length: 500 }, (_, i) => i);
    const b = Array.from({ length: 500 }, (_, i) => (i * 7) % 500);
    const ops = myersDiff(Int32Array.from(a), Int32Array.from(b), 10);
    expect(applyOps(a, b, ops)).toEqual(b);
    const s = statsFromOps(ops);
    expect(s.additions + s.deletions).toBeGreaterThanOrEqual(2 * (500 - lcs(a, b)));
  });

  test("3000 fully changed lines diff in well under 300 ms", () => {
    const a = Array.from({ length: 3200 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i >= 100 && i < 3100 ? `changed ${i}` : l));
    const t0 = performance.now();
    const ops = lineDiff(a, b);
    const ms = performance.now() - t0;
    console.log(`lineDiff 3000 changed lines: ${ms.toFixed(1)} ms`);
    expect(statsFromOps(ops)).toEqual({ additions: 3000, deletions: 3000 });
    if (process.env.PERF_STRICT === "1") expect(ms).toBeLessThan(300);
  });
});
