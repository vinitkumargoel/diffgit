/**
 * T11.9 — the secret surfaces (Design §14.3, atlas tab 14): the banner in the WarningBanners
 * stack, the sidebar chip, the in-card line marker and its popover, and the palette's re-scan.
 *
 * Everything runs against the recorded `secrets` fixture through the mock worker client, so the
 * four findings, their line numbers and the `SECRETS_FOUND` warning are the real T10.7 output; the
 * recorded `hidden` fixture (uncommitted work, no findings) is the zero-findings case.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, SecretFinding } from "../../engine/types";
import secretsV2 from "../../test/recorded/secrets.v2.json";
import { onScrollRequest } from "../scrollBus";
import { redactFindings } from "../secrets";
import { selectSecretGate, setStoreClient, useStore } from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { CommandPalette } from "./CommandPalette";
import { CardErrorBoundary, FileCard } from "./FileCard";
import { Sidebar } from "./Sidebar";
import { WarningBanners } from "./WarningBanners";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}
const rect = { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 600, width: 300, height: 600 };
HTMLElement.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });

const recorded = secretsV2.secrets as SecretFinding[];
const ANTHROPIC = recorded[0] as SecretFinding;
const AWS = recorded[2] as SecretFinding;

const initial = useStore.getState();
let mock: MockWorkerClient;

beforeEach(() => {
  mock = createMockWorkerClient();
  setStoreClient(mock);
  useStore.setState(initial, true);
});
afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

/** Opens a recorded fixture for real: compute → streamed stats → `scanSecrets`. */
async function open(name: "secrets" | "hidden"): Promise<void> {
  await useStore.getState().openRepo({ name }, { id: name });
  await waitFor(() => expect(useStore.getState().secrets).not.toBeNull());
}

const banner = () => screen.queryByTestId("secret-banner");
const showButton = () => screen.getByRole("button", { name: "Show" });
const fileOf = (id: string) => {
  const f = useStore.getState().diff?.files.find((x) => x.id === id);
  if (!f) throw new Error(`no file ${id} in the recorded diff`);
  return f;
};
/** Renders one card and waits for its diff body (the mock serves the fixture's real text). */
async function card(id: string) {
  const out = render(<FileCard file={fileOf(id)} index={0} />);
  await screen.findByLabelText(`Diff of ${id}`);
  return out;
}

describe("the scan runs itself after a compute (store)", () => {
  it("fills `secrets` from the recorded findings and carries the warning", async () => {
    const spy = vi.spyOn(mock, "scanSecrets");
    await open("secrets");
    const s = useStore.getState();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(s.diff?.generation);
    expect(s.secrets).toEqual(recorded);
    expect(s.warnings.find((w) => w.code === "SECRETS_FOUND")?.detail).toBe("4");
    expect(selectSecretGate(s)).toMatchObject({ scanned: true, count: 4, total: 4 });
  });

  it("answers `[]` for the zero-findings fixture", async () => {
    await open("hidden");
    expect(useStore.getState().secrets).toEqual([]);
    expect(useStore.getState().warnings.some((w) => w.code === "SECRETS_FOUND")).toBe(false);
  });

  it("never asks the engine for a committed-only diff", async () => {
    await open("secrets");
    const diff = useStore.getState().diff as DiffResult;
    const committed: DiffResult = {
      ...diff,
      files: diff.files.map((f) => ({ ...f, layers: ["committed"] as const })),
    };
    const spy = vi.spyOn(mock, "scanSecrets");
    useStore.setState({ diff: committed, secrets: null });
    await useStore.getState().scanSecrets();
    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().secrets).toEqual([]);
  });

  it("drops a STALE answer instead of emptying the banner", async () => {
    await open("secrets");
    setStoreClient({
      ...mock,
      scanSecrets: async () => {
        throw { code: "STALE", message: "generation 1 is not current" };
      },
    } as MockWorkerClient);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    await useStore.getState().scanSecrets();
    expect(useStore.getState().secrets).toEqual(recorded);
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });
});

describe("palette: Re-scan for secrets", () => {
  const rescan = async () => {
    useStore.getState().setPalette(true);
    render(<CommandPalette />);
    fireEvent.click(await screen.findByText("Re-scan for secrets"));
  };

  it("re-runs the scan and says what it found", async () => {
    await open("secrets");
    const spy = vi.spyOn(mock, "scanSecrets");
    await rescan();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useStore.getState().toasts.at(-1)?.message).toContain("4 possible secrets"),
    );
  });

  it("says 'no known token shapes found' rather than nothing when it is clean", async () => {
    await open("hidden");
    await rescan();
    await waitFor(() =>
      expect(useStore.getState().toasts.at(-1)?.message).toContain("No known token shapes found"),
    );
  });
});

describe("SecretBanner (Design §14.3)", () => {
  it("appears only when a finding exists", async () => {
    await open("hidden");
    render(<WarningBanners />);
    expect(banner()).toBeNull();
    cleanup();

    useStore.setState({ secrets: null });
    render(<WarningBanners />);
    expect(banner()).toBeNull();
    cleanup();

    await open("secrets");
    render(<WarningBanners />);
    const el = banner() as HTMLElement;
    expect(el.getAttribute("data-level")).toBe("error");
    expect(el.textContent).toContain("4 possible secrets");
    expect(el.textContent).toContain("rotating a credential is safer");
  });

  it("gives SECRETS_FOUND no banner row of its own", async () => {
    await open("secrets");
    render(<WarningBanners />);
    // One error-level row — the contextual banner — and no generic warning row for the code.
    expect(document.body.textContent).not.toContain("SECRETS_FOUND");
    expect(screen.queryByRole("button", { name: /^Dismiss/ })).toBeNull();
  });

  it("`Show` lists every finding and jumps to the first file and line", async () => {
    await open("secrets");
    const jumps: [string, number | undefined][] = [];
    const off = onScrollRequest((id, line) => jumps.push([id, line]));
    render(<WarningBanners />);
    fireEvent.click(showButton());

    const list = screen.getByRole("list", { name: "Possible secrets" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toBe(
      `anthropic-api-key${ANTHROPIC.path}:${ANTHROPIC.line}${ANTHROPIC.masked}`,
    );
    expect(rows.map((r) => r.getAttribute("data-secret-finding"))).toEqual([
      "config/deploy.sh:3",
      "config/id_rsa:1",
      "config/settings.ini:4",
      "config/settings.ini:5",
    ]);
    // No row carries the value itself.
    for (const f of recorded) expect(list.textContent).not.toContain(f.full);

    expect(jumps).toEqual([["config/deploy.sh", 3]]);
    expect(useStore.getState().activeFileId).toBe("config/deploy.sh");
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    off();
  });

  it("a finding row focuses its own card and line, expanded and in Diff mode", async () => {
    await open("secrets");
    useStore.setState({ mode: "history", cardModes: { "config/settings.ini": "blame" } });
    useStore.getState().setCollapsed("config/settings.ini", true);
    const jumps: [string, number | undefined][] = [];
    const off = onScrollRequest((id, line) => jumps.push([id, line]));
    render(<WarningBanners />);
    fireEvent.click(showButton());
    jumps.length = 0;

    fireEvent.click(screen.getByLabelText(new RegExp(`^Possible secret: ${AWS.rule}`)));
    const s = useStore.getState();
    expect(jumps).toEqual([["config/settings.ini", 4]]);
    expect(s.mode).toBe("files");
    expect(s.activeFileId).toBe("config/settings.ini");
    expect(s.cardModes["config/settings.ini"]).toBe("diff");
    expect(s.collapsed.has("config/settings.ini")).toBe(false);
    off();
  });

  it("prints the SECRETS_FOUND cap inside the list, not as a second banner", async () => {
    await open("secrets");
    useStore.setState((s) => ({
      warnings: s.warnings.map((w) => (w.code === "SECRETS_FOUND" ? { ...w, detail: "604" } : w)),
    }));
    render(<WarningBanners />);
    fireEvent.click(showButton());
    const list = screen.getByRole("list", { name: "Possible secrets" });
    expect(list.textContent).toContain("604 findings in total; the first 4 are listed.");
    expect(document.querySelectorAll('[data-testid="secret-banner"]')).toHaveLength(1);
  });

  it("`Rules` names the rule-set date and both allowlists, and Escape closes it", async () => {
    await open("secrets");
    render(<WarningBanners />);
    const trigger = screen.getByRole("button", { name: "Rules" });
    fireEvent.click(trigger);
    const pop = screen.getByTestId("secret-rules");
    expect(pop.textContent).toContain("2026-09-19");
    expect(pop.textContent).toContain("# diffgit:allow-secret");
    expect(pop.textContent).toContain(".diffgitignore-secrets");
    expect(pop.textContent).toContain("staged and unstaged hunks only");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("secret-rules")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("sidebar chip (Design §14.3)", () => {
  it("marks exactly the flagged rows, after the XY layer code", async () => {
    await open("secrets");
    render(<Sidebar initialRect={{ width: 300, height: 600 }} />);
    const tagged = [...document.querySelectorAll("[data-secret-tag]")];
    expect(tagged.map((el) => el.getAttribute("aria-label"))).toEqual([
      "1 possible secret in this file",
      "1 possible secret in this file",
      "2 possible secrets in this file",
    ]);
    expect(tagged.every((el) => el.textContent === "secret")).toBe(true);
    // The chip sits after the layer code and before `+n −m` (Design §7.4 element order).
    const row = tagged[2]?.parentElement as HTMLElement;
    const order = [...row.children].map((el) =>
      el.hasAttribute("data-secret-tag") ? "secret" : el.tagName,
    );
    expect(order.indexOf("secret")).toBeGreaterThan(0);
  });

  it("marks nothing when the scan found nothing", async () => {
    await open("hidden");
    render(<Sidebar initialRect={{ width: 300, height: 600 }} />);
    expect(document.querySelectorAll("[data-secret-tag]")).toHaveLength(0);
  });
});

describe("in the card: line rule, marker and popover", () => {
  it("rules the flagged line and puts one marker on it", async () => {
    await open("secrets");
    await card("config/settings.ini");
    const flagged = [...document.querySelectorAll("tr.dg-secret-line")];
    expect(flagged).toHaveLength(2);
    const markers = [...document.querySelectorAll("[data-secret-line]")];
    expect(markers.map((m) => m.getAttribute("data-secret-line"))).toEqual(["4", "5"]);
    expect(markers[0]?.getAttribute("aria-label")).toBe(
      "Possible secret: aws-access-key-id in config/settings.ini line 4, AKIAIOSF…MPLE",
    );
    // The allowlisted `ghp_` line and the 40-hex digest are in the same hunk and stay silent.
    expect(document.body.textContent).toContain("legacy_token");
    expect(document.body.textContent).toContain("release_commit");
  });

  it("puts no marker on a file the scan cleared", async () => {
    await open("hidden");
    await card("notes.txt");
    expect(document.querySelectorAll("[data-secret-line]")).toHaveLength(0);
    expect(document.querySelectorAll("tr.dg-secret-line")).toHaveLength(0);
  });

  it("keeps one marker per line in split view too", async () => {
    await open("secrets");
    useStore.setState((s) => ({ prefs: { ...s.prefs, viewMode: "split" } }));
    await card("config/settings.ini");
    expect(document.querySelectorAll(".diff-split")).not.toHaveLength(0);
    const markers = [...document.querySelectorAll("[data-secret-line]")];
    expect(markers.map((m) => m.getAttribute("data-secret-line"))).toEqual(["4", "5"]);
    expect(document.querySelectorAll("tr.dg-secret-line")).toHaveLength(2);
  });

  it("focuses the flagged line's marker when the card mounts after the jump", async () => {
    await open("secrets");
    render(<WarningBanners />);
    fireEvent.click(showButton());
    // The pane is virtualised, so the card the banner jumped to mounts afterwards and claims the
    // parked line itself (`takePendingLine`).
    await card("config/deploy.sh");
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute("data-secret-line")).toBe(
        "3",
      ),
    );
  });

  it("shows the rule, the entropy and where the value is — masked", async () => {
    await open("secrets");
    await card("config/deploy.sh");
    fireEvent.click(screen.getByLabelText(/^Possible secret: anthropic-api-key/));
    const pop = screen.getByTestId("secret-popover");
    expect(pop.textContent).toContain("Line 3");
    expect(pop.textContent).toContain("anthropic-api-key");
    expect(pop.textContent).toContain("5.79 bits/char");
    expect(pop.textContent).toContain("staged in the index, not in any commit yet");
    expect(pop.textContent).toContain("# diffgit:allow-secret");
    expect(within(pop).getByText(ANTHROPIC.masked)).toBeTruthy();
    expect(within(pop).queryByText(ANTHROPIC.full)).toBeNull();
  });

  it("reveals on an explicit click, masks again, and never remembers it", async () => {
    await open("secrets");
    await card("config/deploy.sh");
    const trigger = screen.getByLabelText(/^Possible secret: anthropic-api-key/);
    fireEvent.click(trigger);

    const reveal = screen.getByRole("button", { name: "Reveal" });
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(reveal);
    expect(screen.getByText(ANTHROPIC.full)).toBeTruthy();
    const mask = screen.getByRole("button", { name: "Mask" });
    expect(mask.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mask);
    expect(screen.queryByText(ANTHROPIC.full)).toBeNull();

    // Reveal, close, reopen: masked again. Nothing about a reveal is state anyone can persist.
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByText(ANTHROPIC.full)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("secret-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByText(ANTHROPIC.full)).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    const persisted = JSON.stringify(useStore.getState().prefs);
    expect(persisted).not.toContain("reveal");
  });

  it("copies a rotate checklist that does not carry the credential", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open("secrets");
    await card("config/deploy.sh");
    fireEvent.click(screen.getByLabelText(/^Possible secret: anthropic-api-key/));
    fireEvent.click(screen.getByRole("button", { name: /^Copy: Rotate the credential/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("config/deploy.sh line 3");
    expect(text).toContain("Revoke it at the provider");
    expect(text).not.toContain(ANTHROPIC.full);
  });
});

describe("masked in what diffgit writes down", () => {
  it("redacts the card's crash report", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error(`render exploded on ${ANTHROPIC.full}`);
    }
    render(
      <CardErrorBoundary raw={null} resetKey={1} redact={(t) => redactFindings(t, recorded)}>
        <Boom />
      </CardErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("code: INTERNAL");
    expect(text).not.toContain(ANTHROPIC.full);
    expect(text).toContain(ANTHROPIC.masked);
    quiet.mockRestore();
  });
});

describe("accessibility", () => {
  it("has no axe violations in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await open("secrets");
      // One tree, so axe sees the banner, its list, the Rules popover, the sidebar chips, the
      // marker and the finding popover together.
      const { container } = render(
        <>
          <WarningBanners />
          <Sidebar initialRect={{ width: 300, height: 600 }} />
          <FileCard file={fileOf("config/settings.ini")} index={0} />
        </>,
      );
      await screen.findByLabelText("Diff of config/settings.ini");
      fireEvent.click(showButton());
      fireEvent.click(screen.getByRole("button", { name: "Rules" }));
      fireEvent.click(
        within(screen.getByLabelText("Diff of config/settings.ini")).getByLabelText(
          /^Possible secret: aws-access-key-id/,
        ),
      );
      expect(screen.getByTestId("secret-popover")).toBeTruthy();
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});
