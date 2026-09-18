import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeBrowser, detectGateCause, type GateWindow } from "../browserGate";
import { useStore } from "../store";
import { BrowserGate, supportsFileSystemAccess } from "./BrowserGate";

vi.mock("../persistence", () => ({
  listRepos: vi.fn(async () => []),
  upsertRepo: vi.fn(async () => ({ id: "x", name: "x", handle: {}, lastOpenedAt: 1 })),
  removeRepo: vi.fn(async () => {}),
  touchRepo: vi.fn(async () => {}),
  ensurePermission: vi.fn(async () => "granted" as const),
  queryPermission: vi.fn(async () => "granted" as const),
}));

const UA = {
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.0 Mobile/15E148 Safari/604.1",
  chrome128:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  chrome84:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.89 Safari/537.36",
  edge128:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
};

const GREASE = { brand: "Not_A Brand", version: "99" };

/** A window-like object; nothing here touches the real `window`, so the six pages stay testable. */
function win(over: Partial<GateWindow> & { ua?: string } = {}): GateWindow {
  const { ua, ...rest } = over;
  return {
    navigator: { userAgent: ua ?? UA.chrome128 },
    isSecureContext: true,
    location: {
      href: "https://diffgit.com/",
      host: "diffgit.com",
      hostname: "diffgit.com",
    },
    ...rest,
  };
}

const WINDOWS = {
  firefox: win({ ua: UA.firefox }),
  safari: win({ ua: UA.safari }),
  mobile: win({ ua: UA.iphone }),
  insecure: win({
    isSecureContext: false,
    location: {
      href: "http://192.168.0.234:4173/",
      host: "192.168.0.234:4173",
      hostname: "192.168.0.234",
    },
  }),
  iframe: win({ ua: UA.edge128, top: { name: "parent" }, self: undefined }),
  old: win({
    ua: UA.chrome84,
    navigator: {
      userAgent: UA.chrome84,
      userAgentData: {
        // Chromium reports both names; the display name prefers the product over the engine.
        brands: [
          GREASE,
          { brand: "Chromium", version: "84" },
          { brand: "Google Chrome", version: "84" },
        ],
        mobile: false,
      },
    },
  }),
  ok: win({ showDirectoryPicker: () => {} }),
};

const initial = useStore.getState();
beforeEach(() => {
  useStore.setState({ gateCause: null });
});
afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
  vi.restoreAllMocks();
});

function gate(w: GateWindow, children: ReactNode = <p>child</p>) {
  return render(<BrowserGate win={w}>{children}</BrowserGate>);
}

function headline(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

function redWord(container: HTMLElement): string {
  return container.querySelector("h1 em")?.textContent ?? "";
}

describe("detectGateCause", () => {
  it("names the cause from the browser, the device, the frame and the origin", () => {
    expect(detectGateCause(WINDOWS.firefox)).toBe("firefox");
    expect(detectGateCause(WINDOWS.safari)).toBe("safari");
    expect(detectGateCause(WINDOWS.mobile)).toBe("mobile");
    expect(detectGateCause(WINDOWS.iframe)).toBe("iframe");
    expect(detectGateCause(WINDOWS.insecure)).toBe("insecure");
    expect(detectGateCause(WINDOWS.old)).toBe("old");
    expect(detectGateCause(win({ ua: "Mozilla/5.0 (Unknown)" }))).toBe("unknown");
  });

  it("returns null as soon as the picker exists, whatever the browser looks like", () => {
    expect(detectGateCause(WINDOWS.ok)).toBeNull();
    expect(detectGateCause({ ...WINDOWS.firefox, showDirectoryPicker: () => {} })).toBeNull();
  });

  it("prefers the device over the engine: Chrome on iOS is 'mobile', not 'safari'", () => {
    expect(detectGateCause(WINDOWS.mobile)).toBe("mobile");
    expect(
      detectGateCause(
        win({ navigator: { userAgent: UA.chrome128, userAgentData: { mobile: true } } }),
      ),
    ).toBe("mobile");
  });

  it("ignores GREASE brands when reading the Chromium version", () => {
    const modern = win({
      navigator: {
        userAgent: UA.edge128,
        userAgentData: {
          brands: [GREASE, { brand: "Chromium", version: "128" }],
          mobile: false,
        },
      },
    });
    expect(detectGateCause(modern)).toBe("unknown");
  });
});

describe("describeBrowser", () => {
  it("names the browser and its major version without showing the user-agent string", () => {
    expect(describeBrowser(WINDOWS.firefox)).toEqual({
      name: "Firefox",
      version: "130",
      platform: "desktop",
    });
    expect(describeBrowser(WINDOWS.safari)).toEqual({
      name: "Safari",
      version: "18",
      platform: "desktop",
    });
    expect(describeBrowser(WINDOWS.mobile)).toEqual({
      name: "Chrome",
      version: "128",
      platform: "phone",
    });
    expect(describeBrowser(win({ ua: UA.edge128 }))).toEqual({
      name: "Edge",
      version: "128",
      platform: "desktop",
    });
    expect(describeBrowser(win({ ua: UA.chrome128 }))).toEqual({
      name: "Chrome",
      version: "128",
      platform: "desktop",
    });
  });

  it("prefers userAgentData brands over the UA, and falls back to a neutral name", () => {
    const brave = win({
      navigator: {
        userAgent: UA.chrome128,
        userAgentData: { brands: [GREASE, { brand: "Brave", version: "128" }], mobile: false },
      },
    });
    expect(describeBrowser(brave).name).toBe("Brave");
    expect(describeBrowser(win({ ua: "Mozilla/5.0 (Unknown)" }))).toEqual({
      name: "This browser",
      version: null,
      platform: "desktop",
    });
  });
});

describe("BrowserGate", () => {
  it("keeps the legacy feature test exported with the same semantics", () => {
    expect(supportsFileSystemAccess({})).toBe(false);
    expect(supportsFileSystemAccess({ showDirectoryPicker: () => {} })).toBe(true);
  });

  it("renders the children when the picker is available", () => {
    gate(WINDOWS.ok);
    expect(screen.getByText("child")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("B1 Firefox: 'browser' is red, the pill names the missing API, four browsers are offered", () => {
    const { container } = gate(WINDOWS.firefox);
    expect(headline()).toBe("This browser can't open local folders.");
    expect(redWord(container)).toBe("browser");
    expect(screen.getByText("Firefox · no File System Access API")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Google Chrome/ }).getAttribute("href")).toBe(
      "https://www.google.com/chrome/",
    );
    expect(screen.getByRole("link", { name: /Microsoft Edge/ }).getAttribute("href")).toBe(
      "https://www.microsoft.com/edge",
    );
    expect(screen.getByRole("link", { name: /Brave/ }).getAttribute("href")).toBe(
      "https://brave.com/download/",
    );
    expect(screen.getByRole("link", { name: /Arc/ }).getAttribute("href")).toBe("https://arc.net/");
    expect(screen.getByText("detected: Firefox 130 · desktop ·", { exact: false })).toBeTruthy();
    // the privacy line survives as three icon facts, and the demo stays reachable
    expect(screen.getByText("read-only")).toBeTruthy();
    expect(screen.getByText("0 bytes uploaded, by CSP")).toBeTruthy();
    expect(screen.getByText("no analytics")).toBeTruthy();
    expect(screen.getByRole("button", { name: /See the demo anyway/ })).toBeTruthy();
    expect(screen.getByText("The interactive demo runs in any browser.")).toBeTruthy();
    // never the raw user-agent string
    expect(container.textContent).not.toContain("Gecko/20100101");
  });

  it("B2 Safari: same red word, a different pill and no File System Access claim", () => {
    const { container } = gate(WINDOWS.safari);
    expect(redWord(container)).toBe("browser");
    expect(screen.getByText("Safari · no showDirectoryPicker()")).toBeTruthy();
    expect(screen.getByText("Nothing to install, no account.")).toBeTruthy();
  });

  it("B3 phone: 'phone' is red and the fix is another machine", () => {
    const { container } = gate(WINDOWS.mobile);
    expect(headline()).toBe("This phone can't open local folders.");
    expect(redWord(container)).toBe("phone");
    expect(screen.getByText("Chrome on iOS · folder access is desktop-only")).toBeTruthy();
    expect(screen.getByText("On your computer")).toBeTruthy();
    expect(screen.getByText("0 bytes uploaded")).toBeTruthy();
    // no navigator.share in this environment, so the Share… button is hidden
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Google Chrome/ })).toBeNull();
  });

  it("B3 phone: Share… appears and calls navigator.share when the browser has it", async () => {
    const share = vi.fn(async (_data: { url?: string; title?: string }) => {});
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      gate(WINDOWS.mobile);
      fireEvent.click(screen.getByRole("button", { name: /Share/ }));
      await waitFor(() => expect(share).toHaveBeenCalled());
      expect(share.mock.calls[0][0]).toMatchObject({ url: "https://diffgit.com/" });
    } finally {
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("B4 insecure context: 'address' is red and the card lists the three fixes", () => {
    const { container } = gate(WINDOWS.insecure);
    expect(headline()).toBe("This address can't open local folders.");
    expect(redWord(container)).toBe("address");
    expect(screen.getByText("Chrome · page is not https")).toBeTruthy();
    expect(screen.getByText("192.168.0.234")).toBeTruthy();
    expect(screen.getByText("If this is your own build")).toBeTruthy();
    expect(screen.getByText("http://localhost:4173")).toBeTruthy();
    expect(screen.getByText("vite preview --https")).toBeTruthy();
    expect(
      screen.getByText("chrome://flags/#unsafely-treat-insecure-origin-as-secure"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open diffgit.com/ }).getAttribute("href")).toBe(
      "https://diffgit.com",
    );
    expect(screen.getByText("192.168.0.234:4173")).toBeTruthy();
  });

  it("B5 iframe: 'frame' is red and the CTA breaks out with target=_top", () => {
    const { container } = gate(WINDOWS.iframe);
    expect(headline()).toBe("This frame can't open local folders.");
    expect(redWord(container)).toBe("frame");
    expect(screen.getByText("Edge · embedded page")).toBeTruthy();
    const out = screen.getByRole("link", { name: /Open in its own tab/ });
    expect(out.getAttribute("target")).toBe("_top");
    expect(out.getAttribute("href")).toBe("https://diffgit.com/");
    expect(screen.getByText("Direct link")).toBeTruthy();
  });

  it("B6 old Chromium: 'version' is red, the page is single column, Update Chrome links out", () => {
    const { container } = gate(WINDOWS.old);
    expect(headline()).toBe("This version can't open local folders.");
    expect(redWord(container)).toBe("version");
    expect(screen.getByText("Chrome 84 · needs 86 or newer")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Update Chrome/ }).getAttribute("href")).toBe(
      "https://www.google.com/chrome/update/",
    );
    expect(screen.queryByText("Open on a Chromium browser")).toBeNull();
  });

  it("B6 policy: the store's cause wins over detection and rewrites the headline", () => {
    useStore.setState({ gateCause: "policy" });
    const { container } = gate({ ...WINDOWS.ok, ua: UA.edge128 } as GateWindow);
    expect(headline()).toBe("A policy blocks opening local folders.");
    expect(redWord(container)).toBe("policy");
    expect(screen.getByText("Chrome · FileSystemReadBlockedForUrls")).toBeTruthy();
    expect(screen.getByText("API present but disabled")).toBeTruthy();
  });

  it("'Try again' clears the store cause so Home renders again", () => {
    useStore.setState({ gateCause: "policy" });
    gate(WINDOWS.ok);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(useStore.getState().gateCause).toBeNull();
    expect(screen.getByText("child")).toBeTruthy();
  });

  it("'See the demo anyway' reveals the landing page under a warning strip, and Back returns", () => {
    gate(WINDOWS.firefox);
    expect(screen.queryByText("child")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /See the demo anyway/ }));
    expect(screen.getByText("child")).toBeTruthy();
    expect(
      screen.getByText("Folder access unavailable in this browser — the demo below still works."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("child")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("'Copy link' writes this page's address to the clipboard and flashes the label", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    gate(WINDOWS.firefox);
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://diffgit.com/"));
    await screen.findByRole("button", { name: /Copied/ });
  });

  it("says so when the clipboard refuses instead of pretending it copied", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    gate(WINDOWS.firefox);
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await screen.findByRole("button", { name: /Copy failed/ });
  });

  it("B1 and B4 look the same in both themes", () => {
    for (const [name, w] of [
      ["B1 firefox", WINDOWS.firefox],
      ["B4 insecure", WINDOWS.insecure],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        const { container } = gate(w);
        expect(container.firstChild).toMatchSnapshot(`${name} (${theme})`);
        cleanup();
      }
    }
    document.documentElement.classList.remove("dark");
  });

  it("B1 has no serious or critical axe violations", async () => {
    const { container } = gate(WINDOWS.firefox);
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
      resultTypes: ["violations"],
    });
    const bad = result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id);
    expect(bad).toEqual([]);
  });
});
