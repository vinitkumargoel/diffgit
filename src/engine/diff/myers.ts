/**
 * Linear-space Myers diff over integer token arrays (the "middle snake" bisection used by
 * diff-match-patch), producing a minimal edit script. Common prefix/suffix are stripped at every
 * level. A step budget bounds pathological inputs: when it runs out, the remaining range is emitted
 * as delete-all + insert-all (non-minimal but still correct), like git's own heuristics cut-off.
 */
import type { LineOp } from "./textDiff";

const DEFAULT_STEP_BUDGET = 60_000_000;

export function myersDiff(a: Int32Array, b: Int32Array, budget = DEFAULT_STEP_BUDGET): LineOp[] {
  const out: LineOp[] = [];
  const state = { steps: 0, budget };
  diffRange(a, b, 0, a.length, 0, b.length, out, state);
  return mergeOps(out);
}

function push(
  out: LineOp[],
  type: LineOp["type"],
  oldStart: number,
  newStart: number,
  count: number,
) {
  if (count > 0) out.push({ type, oldStart, newStart, count });
}

function mergeOps(ops: LineOp[]): LineOp[] {
  const merged: LineOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.count += op.count;
    else merged.push({ ...op });
  }
  return merged;
}

function diffRange(
  a: Int32Array,
  b: Int32Array,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  out: LineOp[],
  state: { steps: number; budget: number },
): void {
  // common prefix
  let as = aStart;
  let bs = bStart;
  while (as < aEnd && bs < bEnd && a[as] === b[bs]) {
    as++;
    bs++;
  }
  push(out, "eq", aStart, bStart, as - aStart);
  // common suffix
  let ae = aEnd;
  let be = bEnd;
  while (ae > as && be > bs && a[ae - 1] === b[be - 1]) {
    ae--;
    be--;
  }
  const suffix = aEnd - ae;
  const n = ae - as;
  const m = be - bs;
  if (n === 0) push(out, "add", as, bs, m);
  else if (m === 0) push(out, "del", as, bs, n);
  else bisect(a, b, as, ae, bs, be, out, state);
  push(out, "eq", ae, be, suffix);
}

function bisect(
  a: Int32Array,
  b: Int32Array,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  out: LineOp[],
  state: { steps: number; budget: number },
): void {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const maxD = Math.ceil((n + m) / 2);
  const vOffset = maxD;
  const vLength = 2 * maxD + 2;
  const v1 = new Int32Array(vLength).fill(-1);
  const v2 = new Int32Array(vLength).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    state.steps += 2 * d + 2;
    if (state.steps > state.budget) break; // give up on minimality for this range
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = vOffset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && (v1[k1Offset - 1] as number) < (v1[k1Offset + 1] as number)))
        x1 = v1[k1Offset + 1] as number;
      else x1 = (v1[k1Offset - 1] as number) + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aStart + x1] === b[bStart + y1]) {
        x1++;
        y1++;
      }
      v1[k1Offset] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2Offset = vOffset + delta - k1;
        if (k2Offset >= 0 && k2Offset < vLength && (v2[k2Offset] as number) !== -1) {
          const x2 = n - (v2[k2Offset] as number);
          if (x1 >= x2) {
            diffRange(a, b, aStart, aStart + x1, bStart, bStart + y1, out, state);
            diffRange(a, b, aStart + x1, aEnd, bStart + y1, bEnd, out, state);
            return;
          }
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = vOffset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && (v2[k2Offset - 1] as number) < (v2[k2Offset + 1] as number)))
        x2 = v2[k2Offset + 1] as number;
      else x2 = (v2[k2Offset - 1] as number) + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aEnd - x2 - 1] === b[bEnd - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2Offset] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1Offset = vOffset + delta - k2;
        if (k1Offset >= 0 && k1Offset < vLength && (v1[k1Offset] as number) !== -1) {
          const x1 = v1[k1Offset] as number;
          const y1 = vOffset + x1 - k1Offset;
          const x2m = n - x2;
          if (x1 >= x2m) {
            diffRange(a, b, aStart, aStart + x1, bStart, bStart + y1, out, state);
            diffRange(a, b, aStart + x1, aEnd, bStart + y1, bEnd, out, state);
            return;
          }
        }
      }
    }
  }
  // No common tokens (or budget exhausted): replace the whole range.
  push(out, "del", aStart, bStart, n);
  push(out, "add", aEnd, bStart, m);
}
