/** `84 B`, `18.2 KB`, `3.1 MB` (binary units, one decimal above bytes). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `3,412 lines changed` / `1 line changed`. */
export function formatLines(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "line" : "lines"} changed`;
}

/** Human name for a git tree-entry mode (Design §7.7 TypechangeNotice). */
export function describeMode(mode: number | null): string {
  if (mode === null) return "absent";
  switch (mode) {
    case 0o120000:
      return "symlink";
    case 0o160000:
      return "submodule";
    case 0o040000:
      return "directory";
    case 0o100755:
      return "executable file";
    case 0o100644:
      return "regular file";
    default:
      return `mode ${mode.toString(8)}`;
  }
}

/** Capitalise the first letter ("symlink" → "Symlink"). */
export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
