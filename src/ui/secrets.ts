/**
 * T11.9 — every string and every piece of maths the secret surfaces show (Design §14.3 "Secret
 * banner", atlas tab 14). Pure: no React, no store, so the wording is unit-tested on its own and
 * the components only lay it out — the same split `src/ui/hidden.ts` and `src/ui/operation.ts` use.
 *
 * `masked` / `full` come from the engine (`SecretFinding`, `docs/v2-contracts.md` `<!-- T10.7 -->`).
 * Nothing here ever prefers `full`: the caller has to pass the revealed flag, which lives in
 * component state only and is never persisted (atlas tab 14: "reveal is an explicit click").
 */
import { ALLOW_COMMENT, RULESET_DATE, SECRET_ALLOWLIST_FILE } from "../engine/scan/secretRules";
import type { FileDiff, SecretFinding } from "../engine/types";

/** Design §14.3: the sidebar row's chip, in the `--chip-conflict` palette. */
export const SECRET_TAG = "secret";

/** The allowlist escape hatches, spelled exactly as the engine matches them. */
export const ALLOW_LINE_COMMENT = `# ${ALLOW_COMMENT}`;
export const ALLOWLIST_FILE = SECRET_ALLOWLIST_FILE;
export { RULESET_DATE };

/** `scanSecrets` reads the added lines of staged and unstaged hunks only (T10.7). */
export function hasUncommittedLayer(file: Pick<FileDiff, "layers">): boolean {
  return file.layers.includes("staged") || file.layers.includes("unstaged");
}

/** Banner subject + message (Design §14.3, atlas tab 14's wording). */
export function bannerCopy(count: number): { subject: string; message: string } {
  return {
    subject: count === 1 ? "1 possible secret" : `${count} possible secrets`,
    message:
      count === 1
        ? "in uncommitted changes. It is in the working tree, not committed yet. Fix it before you commit; rotating the credential is safer than deleting the line."
        : "in uncommitted changes. They are in the working tree, not committed yet. Fix them before you commit; rotating a credential is safer than deleting the line.",
  };
}

/**
 * The `SECRETS_FOUND` cap, printed **inside** the secrets surface rather than as a second banner
 * (one surface per fact, Design §14 rule 1). `total` is the warning's `detail`; null when nothing
 * was cut.
 */
export function cappedLine(shown: number, total: number): string | null {
  if (total <= shown) return null;
  return `${total} findings in total; the first ${shown} are listed.`;
}

/** Findings of one file grouped by the added line they sit on, for the in-card markers. */
export function byLine(findings: readonly SecretFinding[]): Map<number, SecretFinding[]> {
  const out = new Map<number, SecretFinding[]>();
  for (const f of findings) {
    const bucket = out.get(f.line);
    if (bucket) bucket.push(f);
    else out.set(f.line, [f]);
  }
  return out;
}

/** `5.79 bits/char` — reported for every finding, even when its rule did not gate on entropy. */
export function entropyLabel(finding: SecretFinding): string {
  return `${finding.entropy.toFixed(2)} bits/char`;
}

/**
 * Where the value is right now. `SecretFinding.layer` is `unstaged` whenever the row has unstaged
 * work, "because that is where the line is now" (`docs/v2-contracts.md` `<!-- T10.7 -->`), so the
 * two sentences are the only two states a finding can be in — it is never in a commit.
 */
export function whereLine(finding: SecretFinding): string {
  return finding.layer === "staged"
    ? "staged in the index, not in any commit yet"
    : "in the working tree only — not staged, and not in any commit yet";
}

/** Why the scanner flagged it: shape first, entropy as the second signal (atlas tab 14). */
export function whyFlagged(finding: SecretFinding): string {
  return `the value matches the ${finding.rule} shape and its body is ${entropyLabel(finding)}`;
}

/** Accessible name of a finding row and of its in-card marker. */
export function findingLabel(finding: SecretFinding): string {
  return `Possible secret: ${finding.rule} in ${finding.path} line ${finding.line}, ${finding.masked}`;
}

/** `path:line` — the row's location, mono. */
export function locationLabel(finding: SecretFinding): string {
  return `${finding.path}:${finding.line}`;
}

/** What the popover shows for the value: masked unless this one finding was explicitly revealed. */
export function displayValue(finding: SecretFinding, revealed: boolean): string {
  return revealed ? finding.full : finding.masked;
}

/**
 * The copyable checklist behind `Copy rotate checklist` (Design §14.3). It never carries the value
 * itself — copying a credential to the clipboard is exactly what the masking is for.
 */
export function rotateChecklist(finding: SecretFinding): string {
  return [
    `Rotate the credential in ${finding.path} line ${finding.line} (rule: ${finding.rule}).`,
    "1. Revoke it at the provider — assume it is already public.",
    "2. Issue a replacement and keep it out of the repository (environment or secret manager).",
    `3. Remove the line from ${finding.path}, then commit.`,
    `4. If it is a fixture, allow it: append ${ALLOW_LINE_COMMENT} to the line, or list ${finding.path} in ${ALLOWLIST_FILE}.`,
    "5. It is not in any commit yet, so no history rewrite is needed — rotate anyway.",
  ].join("\n");
}

/** Rows of the `Rules` popover: what the rule set is and how to silence a finding. */
export const RULES_HELP: readonly { term: string; detail: string }[] = [
  {
    term: "Rule set",
    detail: `${RULESET_DATE}, shipped with this release. Nothing is fetched and nothing leaves this machine.`,
  },
  {
    term: "Scanned",
    detail:
      "The added lines of staged and unstaged hunks only. Committed history, generated files and binaries are not read.",
  },
  {
    term: "Allow one line",
    detail: `Append ${ALLOW_LINE_COMMENT} at the end of it (// … , -- … and <!-- … --> work too).`,
  },
  {
    term: "Allow a path",
    detail: `List it in ${ALLOWLIST_FILE} in the repository root (gitignore syntax, re-read on every scan).`,
  },
];

/** Atlas tab 14's wording rule: never say "no secrets", say what was actually looked for. */
export const NO_FINDINGS_NOTE =
  "No known token shapes found in the uncommitted changes. That is not a guarantee.";

/** Said by the palette action when there is nothing uncommitted to scan. */
export const NOTHING_TO_SCAN_NOTE =
  "Nothing to scan: this comparison has no staged or unstaged changes.";

/** Said by the palette action when the scan did find something (the banner carries the detail). */
export function foundNote(count: number): string {
  const { subject } = bannerCopy(count);
  return `${subject} in uncommitted changes — see the banner above the diff.`;
}

/**
 * Replaces every revealed value with its mask. Used wherever diffgit produces text *about* a diff
 * (the card's "Copy report", and the T11.10 export gate's override path): a finding diffgit itself
 * writes down is masked, always (Design §14.3 "Findings are masked by default everywhere including
 * copy"). The diff body itself is the user's own file shown verbatim and is not rewritten.
 */
export function redactFindings(text: string, findings: readonly SecretFinding[]): string {
  let out = text;
  for (const f of findings) {
    if (f.full === "") continue;
    out = out.split(f.full).join(f.masked);
  }
  return out;
}
