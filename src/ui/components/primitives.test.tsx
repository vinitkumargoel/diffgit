import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileStatus } from "../../engine/types";
import { Badge } from "./Badge";
import { type ChipKind, chipsFor, LayerChip } from "./LayerChip";
import { StatusIcon, statusLabel } from "./StatusIcon";

afterEach(cleanup);

/** Renders in light, then in dark (`.dark` on <html>); markup must be identical (tokens only). */
function bothThemes(ui: React.ReactElement): string {
  document.documentElement.classList.remove("dark");
  const light = render(ui).container.innerHTML;
  cleanup();
  document.documentElement.classList.add("dark");
  const dark = render(ui).container.innerHTML;
  cleanup();
  document.documentElement.classList.remove("dark");
  expect(dark).toBe(light);
  return light;
}

const STATUSES: FileStatus[] = ["added", "modified", "deleted", "renamed", "copied", "typechange"];
const CHIPS: ChipKind[] = ["staged", "unstaged", "untracked", "conflict", "generated"];

describe("shared primitives (Design §3.3, §11)", () => {
  it("StatusIcon renders the same markup in both themes and matches the snapshot", () => {
    for (const s of STATUSES) {
      expect(bothThemes(<StatusIcon status={s} />)).toMatchSnapshot(s);
    }
    const html = bothThemes(<StatusIcon status="renamed" title="a → b (87%)" />);
    expect(html).toContain('aria-label="Renamed"');
    expect(html).toContain('title="a → b (87%)"');
    expect(statusLabel("typechange")).toBe("Type changed");
  });

  it("LayerChip renders the same markup in both themes and matches the snapshot", () => {
    for (const c of CHIPS) {
      const html = bothThemes(<LayerChip kind={c} />);
      expect(html).toMatchSnapshot(c);
      expect(html).toContain(`border-chip-${c}-fg/40`);
    }
  });

  it("chipsFor drops committed and appends generated", () => {
    expect(chipsFor({ layers: ["committed"] })).toEqual([]);
    expect(chipsFor({ layers: ["staged", "unstaged"], generated: true })).toEqual([
      "staged",
      "unstaged",
      "generated",
    ]);
  });

  it("Badge renders the same markup in both themes and matches the snapshot", () => {
    for (const k of ["head", "default", "remote"] as const) {
      expect(bothThemes(<Badge kind={k} />)).toMatchSnapshot(k);
    }
  });
});
