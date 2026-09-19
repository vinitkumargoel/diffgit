/**
 * T11.14 — patch-only mode and the install affordance (Design §14.6, atlas tab 17).
 *
 * The patches under test are not literals: the mock worker client renders the recorded `basic` and
 * `showcase` fixtures with the engine's own `patchText` writer, and the same bytes are handed back
 * to `parsePatch`. What is asserted is therefore the real round trip a user gets when they save a
 * diff from diffgit and open it again with no repository.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PATCH_BYTES,
  OPEN_PATCH_LABEL,
  patchBaseName,
  patchTagLabel,
  tooLargeMessage,
} from "../patch";
import { INSTALL_LABEL, installPwa, shouldRegister } from "../pwa";
import { setStoreClient, useStore } from "../store";
import { WARNING_COPY } from "../warnings";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { CommandPalette } from "./CommandPalette";
import { HomeScreen } from "./HomeScreen";
import { PatchDropZone } from "./PatchDrop";
import RepoScreen from "./RepoScreen";
import { StatsRow } from "./StatsRow";
import { TopBar } from "./TopBar";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

// The diff pane is virtualised: happy-dom measures everything as 0, so the cards need a viewport
// before any of them renders (same stubs as `diffpane.test.tsx`).
const rect = { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 800, width: 900, height: 800 };
HTMLElement.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { get: () => 900, configurable: true });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get: () => 800,
  configurable: true,
});

const initial = useStore.getState();
let mock: MockWorkerClient;

beforeEach(() => {
  mock = createMockWorkerClient();
  mock.latency = 0;
  setStoreClient(mock);
  useStore.setState(initial, true);
});

afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

/** The recorded fixture's own diff, rendered as a `.patch` by the engine's writer (T10.10). */
async function patchTextOf(fixture: "basic" | "showcase"): Promise<string> {
  await useStore.getState().openRepo({ name: fixture }, { id: fixture });
  await waitFor(() => expect(useStore.getState().diff).not.toBeNull());
  const generation = useStore.getState().diff?.generation ?? 0;
  const text = await mock.patchText(generation, null);
  await useStore.getState().closeRepo();
  return text;
}

/** A `File` the drop handler and the input both accept; `size` is overridable for the gate test. */
function patchFile(text: string, name = "fix.patch", size?: number): File {
  const file = new File([text], name, { type: "text/x-patch" });
  if (size !== undefined) Object.defineProperty(file, "size", { value: size });
  return file;
}

/** A `DataTransfer` stub: happy-dom has no drag data store. */
function transferOf(files: File[]): DataTransfer {
  return { types: ["Files"], files, dropEffect: "none" } as unknown as DataTransfer;
}

describe("opening a patch (Design §14.6)", () => {
  it("renders the `basic` recording's own patch as cards, with no repository", async () => {
    const text = await patchTextOf("basic");
    await useStore.getState().openPatchText(text, "basic.patch");
    const s = useStore.getState();
    expect(s.patchOnly).toBe(true);
    expect(s.screen).toBe("repo");
    expect(s.repo).toBeNull();
    expect(s.handle).toBeNull();
    expect(s.diffSource).toBeNull(); // nothing to recompute, nothing to refresh
    expect(s.patchSession.name).toBe("basic.patch");
    expect(s.patchSession.text).toBe(text);
    expect(s.diff?.files.length).toBeGreaterThan(0);
    // The contract's two honest gaps: no sizes, and every row is committed (`<!-- T10.12 -->`).
    for (const f of s.diff?.files ?? []) {
      expect(f.oldSize).toBe(0);
      expect(f.newSize).toBe(0);
      expect(f.layers).toEqual(["committed"]);
    }
    expect(s.warnings.map((w) => w.code)).toEqual(["PATCH_ONLY"]);
  });

  it("keeps the `showcase` recording's file set, statuses and hunks", async () => {
    const text = await patchTextOf("showcase");
    const before = useStore.getState().diff;
    await useStore.getState().openPatchText(text, "showcase.patch");
    const after = useStore.getState().diff;
    // `patchText` writes no `---`/`+++`/hunks for a pure mode change, so compare what a patch can
    // carry: the rows it does write, by id and status.
    const carried = new Set(after?.files.map((f) => f.id));
    for (const f of before?.files ?? []) {
      if (!carried.has(f.id)) continue;
      const row = after?.files.find((x) => x.id === f.id);
      expect(row?.status, f.id).toBe(f.status);
    }
    expect(carried.size).toBeGreaterThan(5);
    // Every card is already loaded: no `fileDiff` call can reach an engine with no repository.
    const calls = mock.clientMetrics().calls;
    const beforeCalls = calls.fileDiff ?? 0;
    await useStore.getState().loadFileDiff(after?.files[0]?.id ?? "");
    expect(mock.clientMetrics().calls.fileDiff ?? 0).toBe(beforeCalls);
  });

  it("shows the `Patch · <name>` tag instead of the pickers, and disables the other modes", async () => {
    const text = await patchTextOf("basic");
    await useStore.getState().openPatchText(text, "fix-rounding.patch");
    render(<TopBar />);
    expect(screen.getByTestId("patch-tag").textContent).toBe(patchTagLabel("fix-rounding.patch"));
    expect(screen.queryByText("base:")).toBeNull();
    expect(screen.queryByText("compare:")).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    const files = screen.getByRole("button", { name: "Files" });
    expect(files.hasAttribute("disabled")).toBe(false);
    for (const label of ["History", "Branches", "Insights"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.hasAttribute("disabled"), label).toBe(true);
      expect(button.getAttribute("title"), label).toContain("needs a repository");
    }
    // The keys and the palette obey the same rule as the buttons.
    useStore.getState().setMode("history");
    expect(useStore.getState().mode).toBe("files");
  });

  it("says why a file is not a patch, naming the line, and does not open anything", async () => {
    render(<PatchDropZone />);
    await useStore.getState().openPatchText("not a diff at all\n", "notes.txt");
    const error = useStore.getState().patchSession.error;
    expect(error?.code).toBe("NOT_A_PATCH");
    expect(error?.detail).toMatch(/^line \d+: /);
    expect(useStore.getState().patchOnly).toBe(false);
    expect(useStore.getState().screen).toBe("home");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(error?.message);
    expect(alert.textContent).toContain(error?.detail);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(useStore.getState().patchSession.error).toBeNull();
  });

  it("refuses a file over the size cap with both numbers, and never reads it", async () => {
    render(<PatchDropZone />);
    const huge = patchFile("diff --git a/a b/a\n", "huge.patch", MAX_PATCH_BYTES + 1);
    await useStore.getState().openPatchFile(huge);
    const error = useStore.getState().patchSession.error;
    expect(error?.code).toBe("TOO_LARGE");
    expect(error?.message).toBe(tooLargeMessage("huge.patch", MAX_PATCH_BYTES + 1));
    expect(useStore.getState().patchOnly).toBe(false);
  });
});

describe("the ways in (Design §14.6: dropped, chosen, handed over by the OS)", () => {
  it("opens a patch dropped anywhere on the page", async () => {
    const text = await patchTextOf("basic");
    render(<PatchDropZone />);
    fireEvent.dragEnter(window, { dataTransfer: transferOf([]) });
    expect(screen.getByText("Drop the patch to view it")).toBeTruthy();
    fireEvent.drop(window, { dataTransfer: transferOf([patchFile(text, "dropped.patch")]) });
    await waitFor(() => expect(useStore.getState().patchOnly).toBe(true));
    expect(useStore.getState().patchSession.name).toBe("dropped.patch");
    expect(screen.queryByText("Drop the patch to view it")).toBeNull();
  });

  it("opens one through the hidden file input the palette and Home share", async () => {
    const text = await patchTextOf("basic");
    render(<PatchDropZone />);
    const input = screen.getByTestId("patch-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [patchFile(text, "chosen.diff")] } });
    await waitFor(() => expect(useStore.getState().patchOnly).toBe(true));
    expect(useStore.getState().patchSession.name).toBe("chosen.diff");
  });

  it("puts one entry in Home's existing CTA row, and the Install button only once offered", async () => {
    render(
      <>
        <HomeScreen />
        <PatchDropZone />
      </>,
    );
    const cta = document.querySelector(".cta") as HTMLElement;
    const open = within(cta).getByRole("button", { name: OPEN_PATCH_LABEL });
    expect(open.title).toContain("no repository needed");
    // Design §14.6: the Install affordance exists only while `beforeinstallprompt` is pending.
    expect(within(cta).queryByRole("button", { name: INSTALL_LABEL })).toBeNull();
    installPwa();
    act(() => {
      const event = new Event("beforeinstallprompt");
      Object.assign(event, { prompt: async () => {}, userChoice: Promise.resolve({}) });
      window.dispatchEvent(event);
    });
    expect(within(cta).getByRole("button", { name: INSTALL_LABEL })).toBeTruthy();
    // Using it consumes the event, and the affordance goes with it.
    act(() => {
      fireEvent.click(within(cta).getByRole("button", { name: INSTALL_LABEL }));
    });
    await waitFor(() =>
      expect(within(cta).queryByRole("button", { name: INSTALL_LABEL })).toBeNull(),
    );
  });

  it("offers the patch row in the palette always, and Close only inside a patch", async () => {
    useStore.setState({ palette: true });
    render(<CommandPalette />);
    expect(screen.getByText("Open a patch file…")).toBeTruthy();
    expect(screen.queryByText("Close the patch")).toBeNull();
    // Install is offered only while `beforeinstallprompt` is pending — it never fires here.
    expect(screen.queryByText(`${INSTALL_LABEL}…`)).toBeNull();
    cleanup();

    const text = await patchTextOf("basic");
    await useStore.getState().openPatchText(text, "basic.patch");
    useStore.setState({ palette: true });
    render(<CommandPalette />);
    fireEvent.click(screen.getByText("Close the patch"));
    await waitFor(() => expect(useStore.getState().patchOnly).toBe(false));
    expect(useStore.getState().screen).toBe("home");
  });
});

describe("export and a11y in a patch-only session", () => {
  it("re-emits the patch it opened, byte for byte, named after the file", async () => {
    const text = await patchTextOf("showcase");
    await useStore.getState().openPatchText(text, "review.patch");
    render(<StatsRow />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(useStore.getState().export.status).toBe("ready"));
    expect(useStore.getState().export.patch).toBe(text);
    // The snapshot is built from those same bytes, so the menu's sizes are real.
    expect(useStore.getState().export.snapshot).toContain("review");
    expect(patchBaseName("review.patch")).toBe("review");
  });

  it("has no axe violations in either theme", async () => {
    const text = await patchTextOf("basic");
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await useStore.getState().openPatchText(text, "basic.patch");
      const { container } = render(
        <>
          <RepoScreen />
          <PatchDropZone />
        </>,
      );
      // The cards are drawn from the patch's own hunks, with no engine behind them, and the one
      // banner Design §14.6 asks for is the `PATCH_ONLY` info line — never a stack of them.
      expect(container.querySelector(".dg-diff"), "a rendered diff body").toBeTruthy();
      expect(screen.getByText(WARNING_COPY.PATCH_ONLY.subject)).toBeTruthy();
      expect(screen.getAllByTestId("patch-tag").length).toBe(1);
      // Nothing that needs a repository is offered on a card or in the sidebar.
      expect(screen.queryByRole("button", { name: "Blame" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show hidden files" }).hasAttribute("disabled"),
      ).toBe(true);
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("the installable app (manifest + service worker)", () => {
  const read = (file: string) => readFileSync(resolve(__dirname, "../../../public", file), "utf8");

  it("ships a manifest Chrome can install, with the .patch file handler", () => {
    const manifest = JSON.parse(read("manifest.webmanifest"));
    expect(manifest.name).toContain("diffgit");
    expect(manifest.short_name).toBe("diffgit");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.launch_handler).toEqual({ client_mode: "navigate-existing" });
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(
      manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
      "a maskable icon",
    ).toBe(true);
    const handler = manifest.file_handlers[0];
    expect(handler.action).toBe("/");
    expect(Object.keys(handler.accept)).toContain("text/x-patch");
    for (const extensions of Object.values(handler.accept) as string[][]) {
      expect(extensions).toEqual([".patch", ".diff"]);
    }
  });

  it("ships a worker that is stamped at build time and fetches nothing remote", () => {
    const sw = read("sw.js");
    // The two placeholders `vite.config.ts` rewrites; `scripts/check-dist.sh` asserts the result.
    expect(sw).toContain('"__SW_VERSION__"');
    expect(sw).toContain('["__SW_PRECACHE__"]');
    expect(sw).toContain("url.origin !== self.location.origin");
    expect(sw).not.toMatch(/https?:\/\//);
    expect(sw).not.toContain("importScripts");
    // No `skipWaiting`: an update waits and is announced once, in one toast (Design §14.6).
    expect(sw).not.toMatch(/^\s*self\.skipWaiting\(\)/m);
    // The fail-safe: a worker that cannot read its own assets steps aside instead of breaking the app.
    expect(sw).toContain("self.registration.unregister()");
  });

  it("keeps `connect-src 'none'` on the page and gives only the worker its own policy", () => {
    const headers = read("_headers");
    const block = (name: string) =>
      headers.split(/^(?=\S)/m).find((b) => b.startsWith(`${name}\n`)) ?? "";
    expect(block("/*")).toContain("connect-src 'none'");
    expect(block("/*")).not.toContain("connect-src 'self'");
    // Cloudflare joins duplicate headers rather than replacing them, so the `/*` value is detached.
    expect(block("/sw.js")).toContain("! Content-Security-Policy");
    expect(block("/sw.js")).toContain("connect-src 'self'");
  });

  it("registers the worker only in a production build that is not the E2E one", () => {
    expect(shouldRegister({ PROD: true })).toBe(true);
    expect(shouldRegister({ PROD: false })).toBe(false);
    expect(shouldRegister({ PROD: true, VITE_E2E: "1" })).toBe(false);
  });
});
