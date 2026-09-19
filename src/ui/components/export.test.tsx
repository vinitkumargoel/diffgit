/**
 * T11.10 — the Export menu, the `.patch` bytes and the review snapshot (Design §14.6, atlas tab 12).
 *
 * Everything runs against the recorded fixtures through the mock worker client, which renders the
 * patch with the engine's own `src/engine/diff/patchText.ts` writer. The bytes the menu saves are
 * therefore asserted against that writer's output for the same rows, not against a literal.
 *
 * Fixtures: `showcase` (a rename, a binary, a typechange, a file over the 1 MB gate — the richest
 * recorded set of header forms), `hidden` (the 11 MB file, which is the `huge` stub row) and
 * `secrets` (the four recorded findings, which is the gate).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PatchRow, patchText as renderPatch } from "../../engine/diff/patchText";
import type { FileDiff } from "../../engine/types";
import { byteLength } from "../export/download";
import {
  EXPORT_LABELS,
  exportFileName,
  fileListMarkdown,
  GATE_CANCEL,
  GATE_CONFIRM,
  sanitiseName,
  scopeLabel,
  statsLine,
} from "../export/exportModel";
import { escapeHtml, splitPatch } from "../export/snapshot";
import { cssBlock, designTokens } from "../export/tokens";
import { formatBytes } from "../format";
import { mockPayload } from "../mock/mockContents";
import { setStoreClient, useStore } from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { CommandPalette } from "./CommandPalette";
import { StatsRow } from "./StatsRow";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const initial = useStore.getState();
let mock: MockWorkerClient;
let copied: string[];
let saved: { name: string; blob: Blob | null }[];

const urlApi = URL as unknown as {
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
};
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

beforeEach(() => {
  mock = createMockWorkerClient();
  setStoreClient(mock);
  useStore.setState(initial, true);
  copied = [];
  saved = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => {
        copied.push(t);
      }),
    },
  });
  // The download path: a Blob URL on a detached anchor. Both halves are stubbed so the test can
  // read the bytes that would have been written; nothing here is a file-system handle.
  let lastBlob: Blob | null = null;
  urlApi.createObjectURL = (b: Blob) => {
    lastBlob = b;
    return "blob:test";
  };
  urlApi.revokeObjectURL = () => {};
  clickSpy.mockImplementation(function click(this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: lastBlob });
  });
});

/** The bytes of the nth download (`downloadText` hands the anchor a Blob URL). */
async function savedText(i = 0): Promise<string> {
  return (await saved[i]?.blob?.text()) ?? "";
}

afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
  clickSpy.mockReset();
});

type Fixture = "showcase" | "hidden" | "secrets" | "basic";

/** Opens a recorded fixture for real (compute → streamed stats → the T11.9 secret scan). */
async function openFixture(name: Fixture): Promise<void> {
  await useStore.getState().openRepo({ name }, { id: name });
  await waitFor(() => expect(useStore.getState().diff).not.toBeNull());
  await waitFor(() => expect(useStore.getState().secrets).not.toBeNull());
}

/** The engine writer's output for the given rows of the current diff — the reference bytes. */
function referencePatch(ids: string[] | null): string {
  const s = useStore.getState();
  const files = s.diff?.files ?? [];
  const wanted = ids === null ? null : new Set(ids);
  const rows: PatchRow[] = files
    .filter((f) => wanted === null || wanted.has(f.id))
    .map((f: FileDiff) => {
      const p = mockPayload(f, s.diff?.generation ?? 0, false, true);
      return {
        file: f,
        description: {
          classification: p.classification,
          hunks: p.hunks,
          oldText: p.oldText,
          newText: p.newText,
          stats: p.stats,
          language: p.language,
        },
        oldOid: f.oldOid,
        newOid: f.newOid,
      };
    });
  return renderPatch(rows);
}

/** Opens the menu in a rendered StatsRow and waits for the sizes. */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(useStore.getState().export.status).toBe("ready"));
  return screen.getByTestId("export-menu");
}

const itemNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent);

describe("the menu (Design §14.6)", () => {
  it("lists the five rows of §14.6 with real sizes once the patch is rendered", async () => {
    await openFixture("showcase");
    render(<StatsRow />);
    const menu = await openMenu();
    const { patch, snapshot } = useStore.getState().export;
    expect(itemNames(menu)).toEqual([
      `${EXPORT_LABELS["copy-patch"]}${formatBytes(byteLength(patch))}`,
      `${EXPORT_LABELS["save-patch"]}${formatBytes(byteLength(patch))}`,
      `${EXPORT_LABELS.snapshot}${formatBytes(byteLength(snapshot))}`,
      `${EXPORT_LABELS["copy-list"]}12 lines`,
      `${EXPORT_LABELS["copy-stats"]}${statsLine(
        useStore.getState().diff?.files ?? [],
        (f) => useStore.getState().stats[f.id] ?? f.stats ?? null,
      )}`,
    ]);
    expect(within(menu).getByText(scopeLabel(12, 12))).toBeTruthy();
  });

  it("scopes the patch to the filter, and says so in the header", async () => {
    await openFixture("showcase");
    useStore.setState({ filter: "src/a" });
    render(<StatsRow />);
    const menu = await openMenu();
    expect(useStore.getState().export.ids).toEqual(["src/a.txt"]);
    expect(useStore.getState().export.patch).toBe(referencePatch(["src/a.txt"]));
    expect(within(menu).getByText(scopeLabel(12, 1))).toBeTruthy();
  });

  it("opens and closes on `e`, and from the command palette", async () => {
    await openFixture("basic");
    render(<StatsRow />);
    fireEvent.keyDown(document, { key: "e" });
    await waitFor(() => expect(useStore.getState().export.open).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useStore.getState().export.open).toBe(false);

    render(<CommandPalette />);
    useStore.getState().setPalette(true);
    await screen.findByPlaceholderText("Type a command or a file…");
    fireEvent.click(await screen.findByText("Export…"));
    expect(useStore.getState().export.open).toBe(true);
  });
});

describe("the patch bytes", () => {
  it("are exactly what the engine's renderer writes for the whole comparison", async () => {
    await openFixture("showcase");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Save as \.patch/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await savedText();
    expect(text).toBe(referencePatch(null));
    expect(text).toContain("similarity index 87%");
    expect(text).toContain("rename from src/util.ts");
    expect(saved[0]?.blob?.type).toContain("text/x-patch");
  });

  it("includes the huge-file stub row, note and all", async () => {
    await openFixture("hidden");
    render(<StatsRow />);
    const menu = await openMenu();
    const patch = useStore.getState().export.patch;
    expect(patch).toBe(referencePatch(null));
    expect(patch).toContain(
      "# diffgit: big.txt is larger than 10 MB; the patch records its object names only.",
    );
    expect(patch).toContain("Binary files a/big.txt and b/big.txt differ");
    // The stub is a section of its own, so the snapshot carries it as a file card too.
    expect(splitPatch(patch)[0]?.[0]).toBe(
      "# diffgit: big.txt is larger than 10 MB; the patch records its object names only.",
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Copy as unified diff/ }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toBe(patch);
  });

  it("names the file `<repo> · <from>…<to> · <date>.patch`, sanitised", async () => {
    await openFixture("basic");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Save as \.patch/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const name = saved[0]?.name ?? "";
    expect(name.endsWith(".patch")).toBe(true);
    expect(name.startsWith("basic · ")).toBe(true);
    expect(name).not.toContain("/");
    expect(sanitiseName("refs/heads/feature: v1")).toBe("refs-heads-feature- v1");
    expect(exportFileName("acme-web", "main … feat/coupons", "html", Date.UTC(2026, 8, 19))).toBe(
      "acme-web · main…feat-coupons · 2026-09-19.html",
    );
  });
});

describe("the secret gate (Design §14.3, contracts `selectSecretGate`)", () => {
  it("replaces the three line-carrying rows with the warning and a list of findings", async () => {
    await openFixture("secrets");
    render(<StatsRow />);
    const menu = await openMenu();
    expect(itemNames(menu)).toEqual([
      expect.stringContaining(EXPORT_LABELS["copy-list"]),
      expect.stringContaining(EXPORT_LABELS["copy-stats"]),
    ]);
    expect(within(menu).getByText("4 possible secrets in this diff")).toBeTruthy();
    expect(within(menu).getByText("config/deploy.sh:3")).toBeTruthy();
  });

  it("`Export anyway` puts the rows back and the export then writes", async () => {
    await openFixture("secrets");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: GATE_CONFIRM }));
    await waitFor(() => expect(itemNames(menu)).toHaveLength(5));
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Save as \.patch/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(await savedText()).toBe(referencePatch(null));
  });

  it("`Cancel` writes nothing", async () => {
    await openFixture("secrets");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: GATE_CANCEL }));
    expect(saved).toEqual([]);
    expect(copied).toEqual([]);
    expect(useStore.getState().export.open).toBe(false);
  });

  it("parks an export asked for elsewhere and names the count in the question", async () => {
    await openFixture("secrets");
    render(<StatsRow />);
    void useStore.getState().requestExport({ kind: "file-patch", ids: ["config/id_rsa"] });
    await waitFor(() => expect(useStore.getState().export.pending).not.toBeNull());
    const menu = screen.getByTestId("export-menu");
    expect(within(menu).getByText("4 possible secrets in this diff — export anyway?")).toBeTruthy();
    expect(saved).toEqual([]);
    fireEvent.click(within(menu).getByRole("button", { name: GATE_CONFIRM }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(await savedText()).toBe(referencePatch(["config/id_rsa"]));
    expect(saved[0]?.name).toContain("config-id_rsa");
  });

  it("gates an unscanned comparison as unknown, not as clean", async () => {
    await openFixture("basic");
    useStore.setState({ secrets: null });
    render(<StatsRow />);
    const menu = await openMenu();
    expect(within(menu).getByText("Not scanned for secrets yet")).toBeTruthy();
    expect(itemNames(menu)).toHaveLength(2);
  });

  it("never gates the two list rows, and masks what it copies", async () => {
    await openFixture("secrets");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Copy file list as Markdown/ }));
    await waitFor(() => expect(copied).toHaveLength(1));
    const s = useStore.getState();
    expect(copied[0]).toBe(
      fileListMarkdown(
        s.diff?.files ?? [],
        (f) => s.stats[f.id] ?? f.stats ?? null,
        () => false,
      ),
    );
    for (const f of s.secrets ?? []) expect(copied[0]).not.toContain(f.full);
  });
});

describe("the review snapshot", () => {
  it("is one self-contained page with the tree, the cards and the viewed ticks", async () => {
    await openFixture("showcase");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Save review snapshot/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const html = await savedText();
    expect(saved[0]?.name.endsWith(".html")).toBe(true);
    expect(saved[0]?.blob?.type).toContain("text/html");
    // Every file of the comparison is both a tree row and a card.
    for (const f of useStore.getState().diff?.files ?? []) {
      expect(html).toContain(escapeHtml(f.newPath ?? f.oldPath ?? f.id));
    }
    expect((html.match(/<section class="file"/g) ?? []).length).toBe(12);
    expect((html.match(/<input type="checkbox" data-file=/g) ?? []).length).toBe(12);
    // No network, no worker, no remote asset: the reviewer opens it from a file:// URL.
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|https?:\/\//);
    expect(html).not.toMatch(/new Function\(|[^a-zA-Z_.]eval\(/);
    // Themed by the Design §3 tokens, taken out of src/index.css rather than re-typed.
    expect(html).toContain(designTokens().light);
    expect(html).toContain(designTokens().dark);
    expect(cssBlock(":root {\n  --bg: x;\n}\n", ":root")).toBe("--bg: x;");
  });

  it("carries the finding count when it was written past the gate", async () => {
    await openFixture("secrets");
    render(<StatsRow />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: GATE_CONFIRM }));
    await waitFor(() => expect(itemNames(menu)).toHaveLength(5));
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Save review snapshot/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(await savedText()).toContain("4 possible secrets were found in these changes");
  });
});

describe("accessibility", () => {
  it("has no axe violations in either theme, open and gated", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await openFixture("secrets");
      const { container } = render(<StatsRow />);
      await openMenu();
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});
