/**
 * T11.9 — the pure half of the secret surfaces (Design §14.3, atlas tab 14). Every case runs on
 * the recorded `secrets` fixture, so the wording is asserted against the four findings the real
 * T10.7 scanner produced: `config/deploy.sh:3` anthropic and `config/id_rsa:1` RSA (staged),
 * `config/settings.ini:4` AWS and `:5` GitHub (unstaged).
 */
import { describe, expect, it } from "vitest";
import { ALLOW_COMMENT, RULESET_DATE, SECRET_ALLOWLIST_FILE } from "../engine/scan/secretRules";
import type { DiffResult, SecretFinding } from "../engine/types";
import hiddenV2 from "../test/recorded/hidden.v2.json";
import secretsDiff from "../test/recorded/secrets.diffresult.json";
import secretsV2 from "../test/recorded/secrets.v2.json";
import {
  ALLOW_LINE_COMMENT,
  ALLOWLIST_FILE,
  bannerCopy,
  byLine,
  cappedLine,
  displayValue,
  entropyLabel,
  findingLabel,
  foundNote,
  hasUncommittedLayer,
  locationLabel,
  NO_FINDINGS_NOTE,
  RULES_HELP,
  redactFindings,
  rotateChecklist,
  SECRET_TAG,
  whereLine,
  whyFlagged,
} from "./secrets";

const findings = secretsV2.secrets as SecretFinding[];
const diff = secretsDiff as unknown as DiffResult;
const find = (path: string, line: number): SecretFinding => {
  const hit = findings.find((f) => f.path === path && f.line === line);
  if (!hit) throw new Error(`no recorded finding for ${path}:${line}`);
  return hit;
};
const anthropic = find("config/deploy.sh", 3);
const aws = find("config/settings.ini", 4);
const github = find("config/settings.ini", 5);

describe("what gets scanned", () => {
  it("is every row with a staged or unstaged layer, and nothing else", () => {
    expect(diff.files.map((f) => f.id)).toEqual([
      "config/deploy.sh",
      "config/id_rsa",
      "config/settings.ini",
    ]);
    expect(diff.files.every(hasUncommittedLayer)).toBe(true);
    expect(hasUncommittedLayer({ layers: ["committed"] })).toBe(false);
    expect(hasUncommittedLayer({ layers: [] })).toBe(false);
    // The `hidden` fixture is the zero-findings case: it has uncommitted work and no secrets.
    expect(hiddenV2.secrets).toEqual([]);
  });
});

describe("banner copy", () => {
  it("counts in the singular and the plural and never says the word 'committed' wrongly", () => {
    expect(bannerCopy(1).subject).toBe("1 possible secret");
    expect(bannerCopy(1).message).toContain("It is in the working tree, not committed yet.");
    expect(bannerCopy(findings.length).subject).toBe("4 possible secrets");
    expect(bannerCopy(4).message).toContain("rotating a credential is safer");
  });

  it("prints the SECRETS_FOUND cap only when the list was actually cut", () => {
    expect(cappedLine(4, 4)).toBeNull();
    expect(cappedLine(500, 604)).toBe("604 findings in total; the first 500 are listed.");
  });

  it("gives the palette something to say either way", () => {
    expect(foundNote(4)).toContain("4 possible secrets");
    // Atlas tab 14's wording risk: "no warning" must never read as "no secrets".
    expect(NO_FINDINGS_NOTE).toContain("No known token shapes found");
    expect(NO_FINDINGS_NOTE).toContain("not a guarantee");
  });
});

describe("one finding, as the popover and the rows word it", () => {
  it("groups by line, so two findings on one line share one marker", () => {
    const perFile = findings.filter((f) => f.fileId === "config/settings.ini");
    expect([...byLine(perFile).keys()]).toEqual([4, 5]);
    const doubled = byLine([aws, { ...github, line: 4 }]);
    expect(doubled.get(4)).toHaveLength(2);
    expect(byLine([])).toEqual(new Map());
  });

  it("reports entropy for every rule, to two decimals", () => {
    expect(entropyLabel(anthropic)).toBe("5.79 bits/char");
    // The RSA header does not clear the 3.8 floor; its rule is shape-only and still reports it.
    expect(entropyLabel(find("config/id_rsa", 1))).toBe("3.38 bits/char");
  });

  it("says where the value is — never that it is in a commit", () => {
    expect(anthropic.layer).toBe("staged");
    expect(whereLine(anthropic)).toBe("staged in the index, not in any commit yet");
    expect(aws.layer).toBe("unstaged");
    expect(whereLine(aws)).toContain("working tree only");
    for (const f of findings) expect(whereLine(f)).toContain("not in any commit yet");
  });

  it("names the rule and the entropy in the 'why flagged' line", () => {
    expect(whyFlagged(github)).toBe(
      "the value matches the github-personal-access-token shape and its body is 5.17 bits/char",
    );
  });

  it("labels a row with the rule, the location and the mask — never the value", () => {
    expect(locationLabel(aws)).toBe("config/settings.ini:4");
    expect(findingLabel(aws)).toBe(
      "Possible secret: aws-access-key-id in config/settings.ini line 4, AKIAIOSF…MPLE",
    );
    expect(findingLabel(anthropic)).not.toContain(anthropic.full);
  });
});

describe("masking", () => {
  it("shows the mask until this one finding is explicitly revealed", () => {
    expect(displayValue(anthropic, false)).toBe(anthropic.masked);
    expect(displayValue(anthropic, true)).toBe(anthropic.full);
    // The default is the mask for every recorded finding, including the short RSA header.
    for (const f of findings) expect(displayValue(f, false)).toBe(f.masked);
  });

  it("never lets a 5-character window of the token's middle through the mask", () => {
    for (const f of findings) {
      const middle = f.full.slice(8, -4);
      for (let i = 0; i + 5 <= middle.length; i++) {
        expect(f.masked).not.toContain(middle.slice(i, i + 5));
      }
    }
  });

  it("redacts every known value out of text diffgit writes about a diff", () => {
    const report = `crash in ${anthropic.path}: ${anthropic.full} and ${github.full}`;
    const masked = redactFindings(report, findings);
    expect(masked).not.toContain(anthropic.full);
    expect(masked).not.toContain(github.full);
    expect(masked).toContain(anthropic.masked);
    expect(masked).toContain(github.masked);
    expect(redactFindings("nothing to hide", [])).toBe("nothing to hide");
  });
});

describe("the rotate checklist and the rule help", () => {
  it("tells the user what to do without putting the credential on the clipboard", () => {
    const text = rotateChecklist(anthropic);
    expect(text).toContain("config/deploy.sh line 3");
    expect(text).toContain("rule: anthropic-api-key");
    expect(text).toContain("Revoke it at the provider");
    expect(text).toContain(ALLOW_LINE_COMMENT);
    expect(text).toContain(ALLOWLIST_FILE);
    expect(text).not.toContain(anthropic.full);
  });

  it("spells the two allowlists exactly as the engine matches them", () => {
    expect(ALLOW_LINE_COMMENT).toBe(`# ${ALLOW_COMMENT}`);
    expect(ALLOW_LINE_COMMENT).toBe("# diffgit:allow-secret");
    expect(ALLOWLIST_FILE).toBe(SECRET_ALLOWLIST_FILE);
    expect(ALLOWLIST_FILE).toBe(".diffgitignore-secrets");
    const help = RULES_HELP.map((r) => `${r.term}: ${r.detail}`).join("\n");
    expect(help).toContain(RULESET_DATE);
    expect(help).toContain("Nothing is fetched");
    expect(help).toContain(ALLOW_LINE_COMMENT);
    expect(help).toContain(ALLOWLIST_FILE);
    expect(help).toContain("staged and unstaged hunks only");
    expect(SECRET_TAG).toBe("secret");
  });
});
