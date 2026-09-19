/**
 * The secret scan itself (T10.7, atlas tab 14): the added lines of the uncommitted layers, the
 * compiled rule table, an entropy second signal, two allowlists and a redacted preview.
 *
 * Everything in this module is pure — no I/O, no clock, no network (D15). `RepoSession.scanSecrets`
 * supplies the added lines (from `describeFile`, the same hunks the diff pane renders) and turns
 * the result into `SecretFinding[]` plus the `SECRETS_FOUND` warning.
 *
 * Why only added lines of `staged`/`unstaged`: the moment before a commit is the cheapest place to
 * catch a leaked key, and those lines are exactly what the user is about to publish. Cost tracks
 * the size of the change, not the repository.
 */
import ignore from "ignore";
import type { HunkModel } from "../api";
import type { RepoWarning, SecretFinding } from "../types";
import { shannonEntropy } from "./entropy";
import {
  hasAllowComment,
  isHexDigest,
  looksLikeReference,
  maskSecret,
  SECRET_RULES,
  type SecretRule,
} from "./secretRules";

/**
 * How many findings cross the worker boundary. A change that trips the scanner 500 times is a
 * dump, not a leak; the banner says how many were found either way (`SECRETS_FOUND`).
 */
export const SECRET_FINDING_CAP = 500;

/** One added line, numbered on the new side (what the diff pane shows in the gutter). */
export interface AddedLine {
  line: number;
  text: string;
}

/** One file to scan: its diff row identity, its layer, and the lines it added. */
export interface ScanTarget {
  fileId: string;
  path: string;
  layer: SecretFinding["layer"];
  lines: AddedLine[];
}

/** The added lines of a hunk model, in file order. */
export function addedLines(hunks: HunkModel | null): AddedLine[] {
  const out: AddedLine[] = [];
  if (!hunks) return out;
  for (const h of hunks.hunks) {
    for (const l of h.lines) {
      if (l.type === "add" && l.new !== undefined) out.push({ line: l.new, text: l.text });
    }
  }
  return out;
}

interface Match {
  ruleIndex: number;
  rule: SecretRule;
  start: number;
  end: number;
  value: string;
}

/** Every rule match on one line, with the captured span each finding will report. */
function matchLine(text: string, rules: readonly SecretRule[]): Match[] {
  const out: Match[] = [];
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex] as SecretRule;
    rule.regex.lastIndex = 0;
    let m = rule.regex.exec(text);
    while (m !== null) {
      const group = rule.group ?? 0;
      const value = m[group];
      // A rule whose capture group did not participate has nothing to report.
      if (value !== undefined && value.length > 0) {
        const offset = group === 0 ? 0 : m[0].indexOf(value);
        const start = m.index + (offset < 0 ? 0 : offset);
        out.push({ ruleIndex, rule, start, end: start + value.length, value });
      }
      if (rule.regex.lastIndex === m.index) rule.regex.lastIndex++; // zero-width guard
      m = rule.regex.exec(text);
    }
    rule.regex.lastIndex = 0;
  }
  return out;
}

/**
 * One finding per secret, not one per rule that recognised it. `github_token = ghp_…` matches both
 * `github-personal-access-token` and `generic-token-assignment` over the *same* characters; the
 * more specific rule (earlier in the table) wins and the generic one is dropped. Two genuinely
 * separate secrets on one line keep two findings because their spans do not overlap.
 */
function dedupeMatches(matches: Match[]): Match[] {
  const sorted = [...matches].sort(
    (a, b) => a.start - b.start || a.ruleIndex - b.ruleIndex || b.end - a.end,
  );
  const kept: Match[] = [];
  for (const m of sorted) {
    if (kept.some((k) => m.start < k.end && k.start < m.end)) continue;
    kept.push(m);
  }
  return kept;
}

/** Findings on one added line. Returns `[]` for an allowlisted line. */
export function scanLine(
  file: Pick<ScanTarget, "fileId" | "path" | "layer">,
  line: AddedLine,
  rules: readonly SecretRule[] = SECRET_RULES,
): SecretFinding[] {
  if (hasAllowComment(line.text)) return [];
  const out: SecretFinding[] = [];
  for (const m of dedupeMatches(matchLine(line.text, rules))) {
    // A bare sha1/sha256 is an object name, not a credential — and it clears any entropy floor.
    if (isHexDigest(m.value)) continue;
    // `process.env.API_KEY` / `${TOKEN}` name a secret rather than being one.
    if (looksLikeReference(m.value)) continue;
    const entropy = shannonEntropy(m.value);
    if (m.rule.entropyMin !== undefined && entropy < m.rule.entropyMin) continue;
    out.push({
      fileId: file.fileId,
      path: file.path,
      line: line.line,
      rule: m.rule.id,
      entropy: Math.round(entropy * 100) / 100,
      masked: maskSecret(m.value),
      full: m.value,
      layer: file.layer,
    });
  }
  return out;
}

/** Findings in one file's added lines, in line order. */
export function scanTarget(
  target: ScanTarget,
  rules: readonly SecretRule[] = SECRET_RULES,
): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const line of target.lines) out.push(...scanLine(target, line, rules));
  return out;
}

/** Deterministic order: path, then line, then rule id, then the masked value. */
export function sortFindings(findings: SecretFinding[]): SecretFinding[] {
  return [...findings].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.masked < b.masked ? -1 : a.masked > b.masked ? 1 : 0),
  );
}

/**
 * `.diffgitignore-secrets` (gitignore syntax, repository root) as a predicate. A missing file
 * allows nothing, so every path is scanned.
 */
export function secretAllowlist(text: string | null): (path: string) => boolean {
  if (text === null || text.trim().length === 0) return () => false;
  const ig = ignore({ allowRelativePaths: false }).add(text);
  return (path: string) => {
    if (path.length === 0 || path.startsWith("/")) return false;
    return ig.ignores(path);
  };
}

/**
 * The banner (`SECRETS_FOUND`). `total` is what the scan found, `findings` what crossed the
 * boundary after `SECRET_FINDING_CAP` — the wording tells the user when the list was cut so
 * "5 shown" is never read as "5 found".
 */
export function secretsWarning(total: number, shown: number): RepoWarning {
  const subject = total === 1 ? "1 possible secret" : `${total} possible secrets`;
  const capped = shown < total ? ` Showing the first ${shown}.` : "";
  return {
    code: "SECRETS_FOUND",
    message: `${subject} in uncommitted changes. Fix it before you commit; rotating the credential is safer than deleting the line.${capped}`,
    detail: String(total),
  };
}
