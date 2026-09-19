import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, FileDiff } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import { describeError } from "../errors";
import { describeMode, formatBytes, formatLines } from "../format";
import { Lru } from "../lru";
import { mockPayload } from "../mock/mockContents";
import { DEFAULT_PREFS, type FileDiffEntry, useStore } from "../store";
import { BinaryNotice, sizesLabel } from "./BinaryNotice";
import { CardErrorBoundary, FileCard } from "./FileCard";
import { ImageDiff, mimeFor } from "./ImageDiff";
import { LargeFileGate } from "./LargeFileGate";
import { Notice } from "./Notice";
import { SubmoduleCard } from "./SubmoduleCard";
import { TypechangeNotice } from "./TypechangeNotice";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const diff = basicDiff as unknown as DiffResult;
const byId = (id: string): FileDiff => {
  const f = diff.files.find((x) => x.id === id);
  if (!f) throw new Error(`no recorded file ${id}`);
  return f;
};
const payloadOf = (f: FileDiff) => mockPayload(f, 1, false, false);

type Side = "old" | "new";
type BytesFn = (id: string, side: Side) => Promise<Uint8Array | null>;

/** Stub blob URLs (happy-dom has no createObjectURL) and record every create / revoke. */
function stubBlobUrls() {
  const created: { url: string; type: string }[] = [];
  const revoked: string[] = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (b: Blob | MediaSource) => {
    const url = `blob:mock/${created.length}`;
    created.push({ url, type: b instanceof Blob ? b.type : "" });
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    },
  };
}

/** Renders once per theme and snapshots both (markup must be token-driven, never theme-forked). */
function snapshotBothThemes(name: string, node: ReactNode) {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const { container } = render(node);
    expect(container.firstChild).toMatchSnapshot(`${name} (${theme})`);
    cleanup();
  }
  document.documentElement.classList.remove("dark");
}

afterEach(cleanup);

describe("format helpers", () => {
  it("formats bytes, lines and modes", () => {
    expect(formatBytes(84)).toBe("84 B");
    expect(formatBytes(18_637)).toBe("18.2 KB");
    expect(formatBytes(3 * 1024 * 1024 + 100_000)).toBe("3.1 MB");
    expect(formatLines(1)).toBe("1 line changed");
    expect(formatLines(3412)).toBe("3,412 lines changed");
    expect(describeMode(0o120000)).toBe("symlink");
    expect(describeMode(0o100755)).toBe("executable file");
    expect(describeMode(0o160000)).toBe("submodule");
    expect(describeMode(null)).toBe("absent");
    expect(sizesLabel(2048, 4096, "modified")).toBe("2.0 KB → 4.0 KB");
    expect(sizesLabel(0, 21, "added")).toBe("21 B");
    expect(sizesLabel(35, 0, "deleted")).toBe("35 B");
    expect(mimeFor("a/b.PNG")).toBe("image/png");
    expect(mimeFor("icon.svg")).toBe("image/svg+xml");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});

describe("notice snapshots (light + dark)", () => {
  it("Notice / Binary / LargeFileGate / Submodule / Typechange", () => {
    const bin = byId("data/blob.bin");
    const big = byId("src/big-change.txt");
    useStore.setState({ fileBytes: async () => null });
    snapshotBothThemes(
      "Notice",
      <Notice detail="detail line" action={<button type="button">Act</button>}>
        Message
      </Notice>,
    );
    snapshotBothThemes("BinaryNotice", <BinaryNotice file={bin} payload={payloadOf(bin)} />);
    snapshotBothThemes(
      "LargeFileGate tooLarge",
      <LargeFileGate
        file={big}
        stats={{ additions: 3000, deletions: 412 }}
        oldSize={31000}
        newSize={33000}
        huge={false}
        onLoad={() => {}}
      />,
    );
    snapshotBothThemes(
      "LargeFileGate huge",
      <LargeFileGate
        file={big}
        stats={null}
        oldSize={12_000_000}
        newSize={12_500_000}
        huge
        onLoad={() => {}}
      />,
    );
    snapshotBothThemes(
      "SubmoduleCard",
      <SubmoduleCard path="vendor/shared-ui" oldOid="339e41b0" newOid="a1b2c3d4" />,
    );
    snapshotBothThemes(
      "TypechangeNotice",
      <TypechangeNotice oldMode={0o120000} newMode={0o100644} />,
    );
  });
});

describe("LargeFileGate", () => {
  it("shows changed lines and calls onLoad; huge shows sizes and no button", () => {
    const big = byId("src/big-change.txt");
    const onLoad = vi.fn();
    render(
      <LargeFileGate
        file={big}
        stats={{ additions: 3000, deletions: 412 }}
        oldSize={31000}
        newSize={33000}
        huge={false}
        onLoad={onLoad}
      />,
    );
    expect(screen.getByText("Large diff (3,412 lines changed).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    expect(onLoad).toHaveBeenCalledTimes(1);
    cleanup();

    render(
      <LargeFileGate
        file={big}
        stats={null}
        oldSize={12_000_000}
        newSize={12_500_000}
        huge
        onLoad={onLoad}
      />,
    );
    expect(screen.getByText("Diff too large to display")).toBeTruthy();
    expect(
      screen.getByText(
        "Old 11.4 MB · new 11.9 MB. Files over 10 MB per side are not compared in the browser.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("TOO_LARGE")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("TypechangeNotice", () => {
  it("renders the §7.7 copy", () => {
    render(<TypechangeNotice oldMode={0o120000} newMode={0o100644} />);
    expect(screen.getByRole("note").textContent).toBe("Symlink to regular file");
  });
});

describe("BinaryNotice", () => {
  it("shows sizes, decodes small files on 'View as text', hides again", async () => {
    const bin = byId("data/blob.bin");
    const fileBytes = vi.fn<BytesFn>(async () => new TextEncoder().encode("hello bytes"));
    useStore.setState({ fileBytes });
    render(<BinaryNotice file={bin} payload={payloadOf(bin)} />);
    expect(screen.getByText("Binary file not shown")).toBeTruthy();
    expect(screen.getByText("2.0 KB → 4.0 KB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View as text" }));
    expect(fileBytes).toHaveBeenCalledWith("data/blob.bin", "new");
    await waitFor(() => expect(screen.getByText("hello bytes")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByText("Binary file not shown")).toBeTruthy();
  });

  it("offers no text view at or above 1 MB", () => {
    const bin = byId("data/blob.bin");
    const p = payloadOf(bin);
    p.classification = { ...p.classification, newSize: 1024 * 1024 };
    render(<BinaryNotice file={bin} payload={p} />);
    expect(screen.queryByRole("button", { name: "View as text" })).toBeNull();
    expect(screen.getByText("2.0 KB → 1.0 MB")).toBeTruthy();
  });
});

describe("ImageDiff", () => {
  it("loads both sides as typed blob URLs, captions dimensions + size, revokes on unmount", async () => {
    const blobs = stubBlobUrls();
    const fileBytes = vi.fn<BytesFn>(async (_id, side) => new Uint8Array(side === "old" ? 84 : 92));
    useStore.setState({ fileBytes });
    const f = byId("assets/logo.png");
    const { container, unmount } = render(<ImageDiff file={f} payload={payloadOf(f)} />);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
    expect(fileBytes).toHaveBeenCalledWith("assets/logo.png", "old");
    expect(fileBytes).toHaveBeenCalledWith("assets/logo.png", "new");
    const [oldImg, newImg] = Array.from(container.querySelectorAll("img"));
    expect(oldImg?.getAttribute("src")).toMatch(/^blob:/);
    expect(newImg?.getAttribute("alt")).toBe("New version of assets/logo.png");
    expect(blobs.created.map((c) => c.type)).toEqual(["image/png", "image/png"]);

    Object.defineProperty(newImg, "naturalWidth", { value: 512 });
    Object.defineProperty(newImg, "naturalHeight", { value: 256 });
    fireEvent.load(newImg as HTMLImageElement);
    expect(screen.getByText("New · 512 × 256 · 92 B")).toBeTruthy();
    expect(screen.getByText("Old · 84 B")).toBeTruthy();

    unmount();
    expect([...blobs.revoked].sort()).toEqual(blobs.created.map((c) => c.url).sort());
    blobs.restore();
  });

  it("renders a single pane for added files and reports unavailable bytes", async () => {
    const blobs = stubBlobUrls();
    useStore.setState({ fileBytes: vi.fn<BytesFn>(async () => null) });
    const base = byId("assets/logo.png");
    const added: FileDiff = {
      ...base,
      status: "added",
      oldOid: null,
      oldPath: null,
      oldMode: null,
    };
    const { container } = render(<ImageDiff file={added} payload={payloadOf(added)} />);
    await waitFor(() => expect(screen.getByText("Image unavailable")).toBeTruthy());
    expect(container.querySelectorAll("figure").length).toBe(1);
    expect(screen.queryByText(/^Old/)).toBeNull();
    blobs.restore();
  });
});

describe("FileCard wiring", () => {
  function seedReady(f: FileDiff) {
    const lru = new Lru<string, FileDiffEntry>(200);
    lru.set(`${f.id}|x`, { status: "ready", data: payloadOf(f) });
    useStore.setState({
      screen: "repo",
      diff,
      stats: {},
      viewed: new Set(),
      collapsed: new Set(),
      prefs: DEFAULT_PREFS,
      fileDiffs: lru,
      loadFileDiff: vi.fn(async () => {}),
      cancelFileDiff: vi.fn(),
      setCollapsed: vi.fn(),
      toggleViewed: vi.fn(),
      setPref: vi.fn(),
      fileBytes: vi.fn<BytesFn>(async () => new Uint8Array(8)),
    });
  }

  it("image cards render ImageDiff, typechange cards get the mode row above the diff", async () => {
    const blobs = stubBlobUrls();
    const img = byId("assets/logo.png");
    seedReady(img);
    const { container } = render(<FileCard file={img} index={0} />);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
    expect(screen.queryByText("Binary file not shown")).toBeNull();
    cleanup();
    blobs.restore();

    const link = byId("src/link");
    seedReady(link);
    render(<FileCard file={link} index={0} />);
    expect(screen.getByRole("note").textContent).toBe("Symlink to regular file");
    expect(await screen.findByRole("table")).toBeTruthy();
  });
});

describe("E6 in-card failure notices", () => {
  function seedCard(f: FileDiff, entry: FileDiffEntry, bytes?: BytesFn) {
    const lru = new Lru<string, FileDiffEntry>(200);
    lru.set(`${f.id}|x`, entry);
    const loadFileDiff = vi.fn(async () => {});
    useStore.setState({
      screen: "repo",
      diff,
      stats: {},
      viewed: new Set(),
      collapsed: new Set(),
      prefs: DEFAULT_PREFS,
      fileDiffs: lru,
      loadFileDiff,
      cancelFileDiff: vi.fn(),
      setCollapsed: vi.fn(),
      toggleViewed: vi.fn(),
      setPref: vi.fn(),
      fileBytes: vi.fn<BytesFn>(bytes ?? (async () => new Uint8Array(0))),
    });
    return loadFileDiff;
  }

  it("load error: describeError sentence, code line, Retry and View raw", async () => {
    const f = byId("docs/guide.md");
    const bytes = vi.fn<BytesFn>(async () => new TextEncoder().encode("raw file text"));
    const loadFileDiff = seedCard(
      f,
      { status: "error", error: { code: "IO_ERROR", message: "NotReadableError" } },
      bytes,
    );
    render(<FileCard file={f} index={0} />);
    expect(screen.getByText("Couldn't load this diff")).toBeTruthy();
    expect(
      screen.getByText(`${describeError("IO_ERROR").message} Other files are unaffected.`),
    ).toBeTruthy();
    expect(screen.getByText("IO_ERROR · NotReadableError")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadFileDiff).toHaveBeenCalledWith("docs/guide.md");

    fireEvent.click(screen.getByRole("button", { name: "View raw" }));
    expect(bytes).toHaveBeenCalledWith("docs/guide.md", "new");
    await waitFor(() => expect(screen.getByText("raw file text")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByText("Couldn't load this diff")).toBeTruthy();
  });

  it("deleted files read their old side for View raw", async () => {
    const f: FileDiff = { ...byId("docs/guide.md"), status: "deleted" };
    const bytes = vi.fn<BytesFn>(async () => new Uint8Array(0));
    seedCard(f, { status: "error", error: { code: "IO_ERROR", message: "x" } }, bytes);
    render(<FileCard file={f} index={0} />);
    fireEvent.click(screen.getByRole("button", { name: "View raw" }));
    await waitFor(() => expect(bytes).toHaveBeenCalledWith("docs/guide.md", "old"));
  });

  it("render crash: the zap notice, Retry, View raw and a copyable report", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const Boom = () => {
      throw new Error("render exploded");
    };
    render(
      <CardErrorBoundary raw="RAW DIFF TEXT" resetKey={1}>
        <Boom />
      </CardErrorBoundary>,
    );
    expect(screen.getByText("Couldn't render this diff")).toBeTruthy();
    expect(
      screen.getByText("The renderer threw. This is a diffgit bug; the raw diff is intact."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View raw" }));
    expect(screen.getByText("RAW DIFF TEXT")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(writeText.mock.calls[0]?.[0]).toContain("code: INTERNAL");
    expect(writeText.mock.calls[0]?.[0]).toContain("render exploded");
    quiet.mockRestore();
  });

  it("render crash: a failed copy says so on the button", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const Boom = () => {
      throw new Error("nope");
    };
    render(
      <CardErrorBoundary raw={null} resetKey={1}>
        <Boom />
      </CardErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy());
    quiet.mockRestore();
  });
});
