/**
 * T7.3 parity: the code registry, docs/errors.md, describeError and WARNING_COPY must agree.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_CODES, WARNING_CODES } from "../engine/errors";
import { describeError } from "./errors";
import { WARNING_COPY } from "./warnings";

const doc = readFileSync(resolve(__dirname, "../../docs/errors.md"), "utf8");

function section(title: string): string {
  const start = doc.indexOf(`## ${title}`);
  expect(start, `section "${title}"`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + title.length + 3);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** `| \`CODE\` | ... |` rows → code → remaining cells. */
function rows(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^\| `([A-Z_0-9]+)` \|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    out.set(
      m[1] as string,
      (m[2] as string).split("|").map((c) => c.trim()),
    );
  }
  return out;
}

describe("docs/errors.md parity", () => {
  const publicRows = rows(section("Public error codes"));
  const warningRows = rows(section("Warning codes"));

  it("documents exactly the public codes, with the describeError title as user copy", () => {
    expect([...publicRows.keys()].sort()).toEqual([...PUBLIC_CODES].sort());
    for (const code of PUBLIC_CODES) {
      const cells = publicRows.get(code) as string[];
      expect(cells, code).toHaveLength(3);
      const d = describeError(code);
      expect(cells[1], code).toBe(d.title);
      expect(cells[2], code).toBe(d.action ?? "–");
      expect(cells[0]?.length, `${code} thrown-by`).toBeGreaterThan(0);
    }
  });

  it("documents exactly the warning codes, with the banner subject and level", () => {
    expect([...warningRows.keys()].sort()).toEqual([...WARNING_CODES].sort());
    for (const code of WARNING_CODES) {
      const cells = warningRows.get(code) as string[];
      expect(cells, code).toHaveLength(3);
      expect(cells[1], code).toBe(WARNING_COPY[code].subject);
      expect(cells[2], code).toBe(WARNING_COPY[code].level);
    }
  });

  it("WARNING_COPY covers exactly WARNING_CODES and no public code doubles as a warning", () => {
    expect(Object.keys(WARNING_COPY).sort()).toEqual([...WARNING_CODES].sort());
    for (const code of PUBLIC_CODES) expect(WARNING_CODES as readonly string[]).not.toContain(code);
  });
});
