/** The three spike cases (T5.0): 200-line TS with 6 hunks, 3000-line file, ~60 % rename. */
export interface SpikeCase {
  id: "ts200" | "big3000" | "rename60";
  oldName: string;
  newName: string;
  lang: string;
  oldText: string;
  newText: string;
}

function tsFile(variant: "old" | "new"): string {
  const out: string[] = [];
  for (let i = 0; i < 40; i++) {
    const changed = variant === "new" && [3, 9, 15, 22, 28, 35].includes(i);
    out.push(`export function fn${i}(a: number, b: string): string {`);
    out.push(
      changed
        ? `  const total = a * 2 + b.length; // revised in hunk`
        : `  const total = a + b.length;`,
    );
    out.push(`  if (total > ${i * 10}) {`);
    out.push(`    return \`over-${i}: \${total}\`;`);
    out.push(`  }`);
    if (changed) out.push(`  console.debug("fn${i}", total);`);
    out.push(`}`);
    if (i % 8 === 7) out.push("");
  }
  return `${out.join("\n")}\n`;
}

function bigFile(variant: "old" | "new"): string {
  const out: string[] = [];
  for (let i = 1; i <= 3000; i++) {
    out.push(
      variant === "new" && i > 100 && i <= 2900
        ? `changed line ${i}: value = ${i * 7}`
        : `line ${i}: value = ${i * 3}`,
    );
  }
  return `${out.join("\n")}\n`;
}

function renameFile(variant: "old" | "new"): string {
  const out: string[] = [];
  for (let i = 1; i <= 60; i++) {
    out.push(variant === "new" && i > 36 ? `moved line ${i} with new content` : `stable line ${i}`);
  }
  return `${out.join("\n")}\n`;
}

export const CASES: SpikeCase[] = [
  {
    id: "ts200",
    oldName: "src/module.ts",
    newName: "src/module.ts",
    lang: "typescript",
    oldText: tsFile("old"),
    newText: tsFile("new"),
  },
  {
    id: "big3000",
    oldName: "data/big.txt",
    newName: "data/big.txt",
    lang: "txt",
    oldText: bigFile("old"),
    newText: bigFile("new"),
  },
  {
    id: "rename60",
    oldName: "old/dir/file.txt",
    newName: "new/dir/file.txt",
    lang: "txt",
    oldText: renameFile("old"),
    newText: renameFile("new"),
  },
];

export interface Measurement {
  case: string;
  computeMs: number; // diff computation (main thread or worker round-trip)
  renderMs: number; // first paint after data is ready
  rows: number; // DOM rows rendered
}

declare global {
  interface Window {
    __s1: { measurements: Measurement[]; requests: string[]; done: boolean; error?: string };
  }
}

export function initMeasure(): void {
  window.__s1 = { measurements: [], requests: [], done: false };
}

export function afterPaint(): Promise<number> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
  );
}
