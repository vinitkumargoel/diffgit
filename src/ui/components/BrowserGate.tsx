import {
  CircleX,
  Copy,
  ExternalLink,
  FolderOpen,
  Link as LinkIcon,
  LoaderCircle,
  Lock,
  Monitor,
  MonitorX,
  Play,
  Share2,
  Smartphone,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { describeBrowser, detectGateCause, detectMobileOs, type GateWindow } from "../browserGate";
import {
  SNAPSHOT_ENTRY_LIMIT,
  type SnapshotInputFile,
  type SnapshotProgress,
  SnapshotTooLargeError,
} from "../fs/memoryDirHandle";
import { openRepoOnce } from "../openRepo";
import { type GateCause, useStore } from "../store";
import { Logo } from "./Logo";

/** The address the gate points people at — never `location.href`, which may be a LAN ip or a frame. */
const CANONICAL = "https://diffgit.com";

export function supportsFileSystemAccess(
  win: unknown = typeof window === "undefined" ? undefined : window,
): boolean {
  return typeof win === "object" && win !== null && "showDirectoryPicker" in (win as object);
}

/* ------------------------------------------------------------------ styling */

const BTN =
  "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-3.5 py-[9px] text-[14px] font-medium leading-5 text-ink hover:bg-surface-raised";
const BTN_INK =
  "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-ink bg-ink px-3.5 py-[9px] text-[14px] font-medium leading-5 text-bg hover:opacity-90";
const H1 =
  "m-0 mb-3.5 max-w-[16ch] text-[clamp(28px,3.6vw,40px)] font-medium leading-[1.02] tracking-[-0.04em]";
const DET =
  "mb-4 inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-[5px] font-mono text-[12.5px] font-medium text-muted";
const P = "m-0 mb-3 max-w-[52ch] text-[15.5px] leading-6 text-muted";
const STRONG = "font-medium text-ink";
const MONO = "font-mono text-[13px] text-ink/80";
const CARD = "rounded-xl border border-line bg-surface p-4";
const CARD_TITLE =
  "mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted";
const FACT = "inline-flex items-center gap-1.5";

/* --------------------------------------------------------------- copy button */

/** Clipboard write with the 1.5 s label flash used across the app (FileHeader, useErrorActions). */
function useCopy(): { state: "idle" | "done" | "failed"; copy: (text: string) => Promise<void> } {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      // clipboard blocked (permissions / insecure context): say so instead of failing silently (T7.3)
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 1500);
  }, []);
  return { state, copy };
}

function CopyButton({
  text,
  label,
  ink,
  icon = true,
}: {
  text: string;
  label: string;
  ink?: boolean;
  icon?: boolean;
}) {
  const { state, copy } = useCopy();
  return (
    <button type="button" className={ink ? BTN_INK : BTN} onClick={() => void copy(text)}>
      {icon && <Copy size={15} aria-hidden="true" className="shrink-0" />}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/* ------------------------------------------------------------------- copy deck */

/** The `--danger` word in the headline; the one thing that differs between the six pages. */
const RED_WORD: Record<GateCause, string> = {
  firefox: "browser",
  safari: "browser",
  unknown: "browser",
  mobile: "phone",
  insecure: "address",
  iframe: "frame",
  old: "version",
  policy: "policy",
};

/** Causes whose fix is "use a different browser on this machine" — they get the 2 × 2 link grid. */
function isBrowserCause(cause: GateCause): boolean {
  return cause === "firefox" || cause === "safari" || cause === "unknown";
}

const BROWSERS: { name: string; note: string; href: string }[] = [
  { name: "Google Chrome", note: "86+", href: "https://www.google.com/chrome/" },
  { name: "Microsoft Edge", note: "86+", href: "https://www.microsoft.com/edge" },
  { name: "Brave", note: "desktop", href: "https://brave.com/download/" },
  { name: "Arc", note: "desktop", href: "https://arc.net/" },
];

function pillText(cause: GateCause, name: string, version: string | null, os: string | null) {
  switch (cause) {
    case "safari":
      return `${name} · no showDirectoryPicker()`;
    case "mobile":
      return `${os ? `${name} on ${os}` : name} · folder access is desktop-only`;
    case "insecure":
      return `${name} · page is not https`;
    case "iframe":
      return `${name} · embedded page`;
    case "old":
      return `${version ? `${name} ${version}` : name} · needs 86 or newer`;
    case "policy":
      return `${name} · FileSystemReadBlockedForUrls`;
    default:
      return `${name} · no File System Access API`;
  }
}

function PillIcon({ cause }: { cause: GateCause }) {
  const props = { size: 13, "aria-hidden": true as const, className: "shrink-0" };
  if (cause === "mobile") return <Smartphone {...props} />;
  if (cause === "policy") return <Lock {...props} />;
  if (cause === "insecure" || cause === "iframe" || cause === "old")
    return <TriangleAlert {...props} />;
  return <MonitorX {...props} />;
}

function Prose({ cause, name, hostname }: { cause: GateCause; name: string; hostname: string }) {
  switch (cause) {
    case "safari":
      return (
        <p className={P}>
          {'Safari has an "origin private file system" but it cannot open a folder '}
          <b className={STRONG}>you</b>
          {
            " choose, which is the whole point here. Chrome, Edge, Brave or Arc on this Mac will work."
          }
        </p>
      );
    case "mobile":
      return (
        <p className={P}>
          No mobile browser can hand a web page a folder, so there is nothing to fix on the phone.
          Send yourself the link and open it on the computer where the repository is.
        </p>
      );
    case "insecure":
      return (
        <p className={P}>
          {"Your browser supports folder access, but only on "}
          <b className={STRONG}>https://</b>
          {" pages (and "}
          <b className={STRONG}>localhost</b>
          {"). This page was loaded over plain http from "}
          <span className={MONO}>{hostname}</span>
          {", so the browser hides the API."}
        </p>
      );
    case "iframe":
      return (
        <p className={P}>
          diffgit is being shown inside another site. Browsers don't allow a folder picker from an
          embedded page, and diffgit's own headers forbid embedding anyway.
        </p>
      );
    case "old":
      return (
        <p className={P}>
          Folder access arrived in Chrome 86 (October 2020). Updating the browser is the only fix.
        </p>
      );
    case "policy":
      return (
        <p className={P}>
          {"Your browser has the API but an administrator policy (or "}
          <span className={MONO}>
            {name === "Edge" ? "edge" : "chrome"}://settings/content/filesystem
          </span>
          {") blocks reading folders for this site. The picker throws "}
          <span className={MONO}>SecurityError</span>
          {" immediately."}
        </p>
      );
    default:
      return (
        <>
          <p className={P}>
            {"diffgit reads the repository straight from your disk through "}
            <b className={STRONG}>showDirectoryPicker()</b>
            {`. ${name} doesn't ship it, and there is no way to read a folder without it — so nothing here would work, and we'd rather say so now than fail later.`}
          </p>
          <p className={P}>Open this page in one of these on the same machine:</p>
        </>
      );
  }
}

function BrowserGrid() {
  return (
    <div className="mt-[22px] mb-[18px] grid grid-cols-2 gap-2.5">
      {BROWSERS.map((b) => (
        <a
          key={b.name}
          href={b.href}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-medium hover:bg-surface-raised"
        >
          <Monitor size={18} aria-hidden="true" className="shrink-0 text-muted" />
          {b.name}
          <small className="ml-auto font-mono text-[11.5px] font-normal text-muted/70">
            {b.note}
          </small>
        </a>
      ))}
    </div>
  );
}

/* -------------------------------------------------------- read once (T11.15) */

/**
 * Engines that simply do not have `showDirectoryPicker()`. Both of them do have
 * `<input webkitdirectory>`, which is snapshot mode's way in (Design §14.6, atlas tab 18). The other
 * causes are not about the engine — a phone cannot hand over a folder at all, and a framed, plain-http
 * or policy-blocked page has a real fix that is better than reading the folder once.
 */
export function canReadOnce(cause: GateCause): boolean {
  return isBrowserCause(cause) || cause === "old";
}

const num = (n: number) => n.toLocaleString("en-US");
const mb = (bytes: number) => `${Math.round(bytes / 1048576).toLocaleString("en-US")} MB`;

/**
 * The read-once offer: one `<input type="file" webkitdirectory>` behind a button, a counter while the
 * list is walked, and the refusal with advice when the folder is too big for this to work at all.
 * The Chromium recommendation above it stays where it is (atlas risk 2: snapshot mode must not look
 * like the product).
 */
function ReadOnceCard({ name }: { name: string }) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SnapshotProgress | null>(null);
  const [failure, setFailure] = useState<{ message: string; advice: string | null } | null>(null);
  const [showDifferences, setShowDifferences] = useState(false);

  const start = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files: SnapshotInputFile[] = Array.from(list);
    setBusy(true);
    setFailure(null);
    setProgress({ entries: 0, total: files.length, bytes: 0 });
    try {
      await openRepoOnce(files, setProgress);
    } catch (e) {
      setProgress(null);
      setFailure(
        e instanceof SnapshotTooLargeError
          ? { message: e.message, advice: e.advice }
          : {
              message: `${name} could not hand the folder over${e instanceof Error && e.message !== "" ? `: ${e.message}` : "."}`,
              advice: null,
            },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${CARD} mt-[26px] max-w-[52ch]`}>
      <div className={CARD_TITLE}>Read it once instead</div>
      <p className="m-0 mb-3 text-[14px] leading-6 text-muted">
        {`${name} does not let a page keep access to a folder, so diffgit reads it a single time. You get the full diff; you do not get live refresh, recent repositories, or files over 1 MB. Chrome, Edge, Brave or Arc give you everything.`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={inputId}
          type="file"
          multiple
          disabled={busy}
          className="peer sr-only"
          ref={(el) => {
            // `webkitdirectory` is not in the React attribute types; the property is the one the
            // browsers actually read, and setting it here keeps the input a plain controlled node.
            if (el) el.webkitdirectory = true;
          }}
          onChange={(e) => void start(e.currentTarget.files)}
        />
        <label
          htmlFor={inputId}
          className={`${BTN_INK} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${busy ? "pointer-events-none opacity-60" : ""}`}
        >
          {busy ? (
            <LoaderCircle size={15} aria-hidden="true" className="spin shrink-0" />
          ) : (
            <FolderOpen size={15} aria-hidden="true" className="shrink-0" />
          )}
          Open a repository once
        </label>
        <button
          type="button"
          className={BTN}
          aria-expanded={showDifferences}
          onClick={() => setShowDifferences((v) => !v)}
        >
          What is different in snapshot mode
        </button>
      </div>

      {showDifferences && (
        <ul className="m-0 mt-3.5 list-none border-t border-line-subtle p-0 text-[13px] text-muted">
          {[
            "The diff never refreshes itself — re-open the folder to see newer changes.",
            "The repository is not remembered: there is nothing to put in Recent.",
            "Only the files the diff needs are read; everything else is listed, never opened.",
            `Small repositories only: a folder over ${num(SNAPSHOT_ENTRY_LIMIT)} entries is refused.`,
          ].map((line) => (
            <li key={line} className="border-b border-line-subtle py-[7px] leading-5">
              {line}
            </li>
          ))}
        </ul>
      )}

      {progress && (
        <div className="mt-3.5 border-t border-line-subtle pt-3">
          <p role="status" className="m-0 font-mono text-[12.5px] text-ink">
            {`Reading ${num(progress.entries)} of ${num(progress.total)} files · ${mb(progress.bytes)}`}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <span
              className="block h-full bg-accent"
              style={{
                width: `${progress.total === 0 ? 0 : Math.round((progress.entries / progress.total) * 100)}%`,
              }}
            />
          </div>
          <p className="m-0 mt-2 text-[12.5px] text-muted">
            {`${name} lists the whole folder before diffgit sees it; a big folder takes a while.`}
          </p>
        </div>
      )}

      {failure && (
        <div
          role="alert"
          className="mt-3.5 flex gap-2 border-t border-line-subtle pt-3 text-[13px] leading-5"
        >
          <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-attention" />
          <p className="m-0">
            {failure.message}
            {failure.advice && <span className="block text-muted">{failure.advice}</span>}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the sides */

function UrlRow() {
  const { state, copy } = useCopy();
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-[12.5px]">
      <LinkIcon size={14} aria-hidden="true" className="shrink-0 text-muted" />
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{CANONICAL}</span>
      <button
        type="button"
        className="shrink-0 cursor-pointer text-muted hover:text-ink"
        aria-label={
          state === "done" ? "Copied" : state === "failed" ? "Copy failed" : `Copy ${CANONICAL}`
        }
        onClick={() => void copy(CANONICAL)}
      >
        <Copy size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

const STEPS: { id: string; head: ReactNode; note: ReactNode }[] = [
  {
    id: "localhost",
    head: (
      <>
        {"Use "}
        <code className="font-mono text-[12.5px] text-ink/80">http://localhost:4173</code>
        {" instead of the LAN IP"}
      </>
    ),
    note: "localhost counts as secure",
  },
  {
    id: "https",
    head: "Or serve it over https",
    note: (
      <>
        <code className="font-mono text-[12.5px] text-ink/80">vite preview --https</code>
        {", or Caddy with a local cert"}
      </>
    ),
  },
  {
    id: "flag",
    head: "Or allow the origin in Chrome",
    note: (
      <code className="font-mono text-[12.5px] text-ink/80">
        chrome://flags/#unsafely-treat-insecure-origin-as-secure
      </code>
    ),
  },
];

function Steps() {
  return (
    <ol className="m-0 list-none border-t border-line-subtle p-0">
      {STEPS.map((s, i) => (
        <li
          key={s.id}
          className="grid grid-cols-[22px_1fr] gap-2.5 border-b border-line-subtle py-[9px] text-[14px]"
        >
          <span className="h-[22px] w-[22px] rounded-full border border-line bg-surface-raised text-center font-mono text-[11px] font-semibold leading-[22px] text-ink">
            {i + 1}
          </span>
          <div>
            {s.head}
            <span className="block text-[12.5px] text-muted">{s.note}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function DemoLine({
  tone,
  num,
  text,
}: {
  tone: "ctx" | "add" | "del" | "hunk";
  num: string;
  text: string;
}) {
  const row =
    tone === "add"
      ? "bg-diff-add-bg"
      : tone === "del"
        ? "bg-diff-del-bg"
        : tone === "hunk"
          ? "bg-diff-hunk-bg text-muted"
          : "";
  const gutter =
    tone === "add"
      ? "bg-diff-add-num text-success"
      : tone === "del"
        ? "bg-diff-del-num text-danger"
        : "bg-surface-sunken text-muted/70";
  return (
    <div className={`grid grid-cols-[36px_1fr] font-mono text-[11.5px] leading-5 ${row}`}>
      <span className={`whitespace-pre px-2 text-right text-[10.5px] ${gutter}`}>{num}</span>
      <span className="whitespace-pre px-2">{text}</span>
    </div>
  );
}

/** The landing page's demo runs in every browser, so the gate shows a taste of it and links down. */
function DemoCard({ onTry }: { onTry: () => void }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-line bg-surface sm:block">
      <div className="flex justify-between border-b border-line-subtle px-3 py-2 font-mono text-[12px] text-muted">
        <span>
          {"demo · "}
          <b className="font-medium text-success">works here</b>
        </span>
        <span>sample repo</span>
      </div>
      <div className="flex h-6 items-center gap-[7px] bg-accent-subtle px-3 font-mono text-[11.5px] text-ink/80">
        <span className="inline-block h-4 w-4 flex-none rounded-[4px] bg-status-m-bg text-center text-[10px] font-bold leading-4 text-status-m-fg">
          M
        </span>
        <span className="overflow-hidden text-ellipsis">cart.ts</span>
        <span className="flex-none rounded-full border border-chip-staged-fg/45 bg-chip-staged-bg px-[5px] text-[9.5px] font-semibold leading-[15px] text-chip-staged-fg">
          staged
        </span>
        <span className="ml-auto text-[11px] text-muted">
          <b className="font-medium text-success">+41</b>{" "}
          <i className="not-italic text-danger">−9</i>
        </span>
      </div>
      <div className="flex h-6 items-center gap-[7px] px-3 font-mono text-[11.5px] text-ink/80">
        <span className="inline-block h-4 w-4 flex-none rounded-[4px] bg-status-a-bg text-center text-[10px] font-bold leading-4 text-status-a-fg">
          A
        </span>
        <span className="overflow-hidden text-ellipsis">coupon.ts</span>
        <span className="flex-none rounded-full border border-chip-untracked-fg/45 bg-chip-untracked-bg px-[5px] text-[9.5px] font-semibold leading-[15px] text-chip-untracked-fg">
          untracked
        </span>
        <span className="ml-auto text-[11px] text-muted">
          <b className="font-medium text-success">+96</b>
        </span>
      </div>
      <DemoLine tone="hunk" num="" text="@@ -12,6 +12,9 @@ export function total(cart)" />
      <DemoLine tone="ctx" num="12" text="  const sub = sum(cart.items);" />
      <DemoLine tone="del" num="13" text="- return sub;" />
      <DemoLine tone="add" num="13" text="+ const off = coupon(cart.code, sub);" />
      <DemoLine tone="add" num="14" text="+ return sub - off;" />
      <div className="flex items-center justify-between border-t border-line-subtle px-3 py-2.5 text-[13px]">
        <span>The interactive demo runs in any browser.</span>
        <button
          type="button"
          className="cursor-pointer font-medium text-accent hover:underline"
          onClick={onTry}
        >
          Try it ↓
        </button>
      </div>
    </div>
  );
}

const SIDE_TITLE: Partial<Record<GateCause, string>> = {
  firefox: "Open on a Chromium browser",
  safari: "Open on a Chromium browser",
  unknown: "Open on a Chromium browser",
  mobile: "On your computer",
  insecure: "If this is your own build",
  iframe: "Direct link",
};

function SideCaption({ cause }: { cause: GateCause }) {
  if (cause === "safari") return <p className={SIDE_P}>Nothing to install, no account.</p>;
  if (cause === "mobile")
    return <p className={SIDE_P}>Chrome, Edge, Brave or Arc on Windows, macOS or Linux.</p>;
  if (cause === "iframe")
    return (
      <p className={SIDE_P}>
        {"Opens with "}
        <span className="font-mono">target=_top</span>
        {"; the demo still runs inside the frame."}
      </p>
    );
  return (
    <p className={SIDE_P}>Nothing to install, no account. The folder is picked on that machine.</p>
  );
}

const SIDE_P = "m-0 mt-2 text-[13px] text-muted";

/* ------------------------------------------------------------------ the page */

function GatePage({
  cause,
  win,
  onDemo,
}: {
  cause: GateCause;
  win: GateWindow;
  onDemo: () => void;
}) {
  const setGateCause = useStore((s) => s.setGateCause);
  const { name, version, platform } = describeBrowser(win);
  const os = detectMobileOs(win);
  const href = win.location?.href ?? CANONICAL;
  const host = win.location?.host ?? "";
  const hostname = win.location?.hostname ?? "";
  const twoColumn = cause !== "old" && cause !== "policy";
  const fixable =
    cause === "insecure" || cause === "iframe" || cause === "old" || cause === "policy";
  const context =
    cause === "policy"
      ? "API present but disabled"
      : cause === "iframe"
        ? "inside a frame"
        : cause === "insecure"
          ? "insecure context"
          : "secure context";
  const demoLabel = isBrowserCause(cause) ? "See the demo anyway" : "See the demo";
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <main aria-label="Unsupported browser" className="min-h-full bg-surface text-[13px] text-ink">
      <div className="flex items-center gap-2.5 border-b border-line-subtle bg-surface-raised px-4 py-2.5 font-mono text-[12px] text-muted">
        <span
          aria-hidden="true"
          className={`h-[7px] w-[7px] flex-none rounded-full ${fixable ? "bg-attention" : "bg-muted/70"}`}
        />
        <span>
          {`detected: ${name}${version ? ` ${version}` : ""} · ${platform} · `}
          <span className={fixable && cause !== "old" ? "text-attention" : undefined}>
            {context}
          </span>
        </span>
        <span className="ml-auto text-muted/70">{host}</span>
      </div>

      <div
        className={`grid items-start gap-10 px-12 py-14 ${twoColumn ? "min-[1000px]:grid-cols-[1fr_340px]" : ""}`}
      >
        <div>
          <div className="mb-[26px] flex items-center gap-[9px] text-[15px] font-semibold">
            <Logo size={26} />
            <span>
              diff
              <span className="text-success">git</span>
            </span>
          </div>

          <h1 className={H1}>
            {cause === "policy" ? "A " : "This "}
            <em className="not-italic text-danger">{RED_WORD[cause]}</em>
            {cause === "policy" ? " blocks opening local folders." : " can't open local folders."}
          </h1>

          <span className={DET}>
            <PillIcon cause={cause} />
            {pillText(cause, name, version, os)}
          </span>

          <Prose cause={cause} name={name} hostname={hostname} />

          {isBrowserCause(cause) && <BrowserGrid />}

          <div className="mt-1 flex flex-wrap items-center gap-3">
            {isBrowserCause(cause) && <CopyButton ink text={href} label="Copy link" />}
            {cause === "mobile" && <CopyButton ink text={href} label="Copy link" />}
            {cause === "mobile" && canShare && (
              <button
                type="button"
                className={BTN}
                onClick={() => {
                  // The share sheet rejects when the user dismisses it; there is nothing to report.
                  void navigator.share({ url: href, title: "diffgit" }).catch(() => undefined);
                }}
              >
                <Share2 size={15} aria-hidden="true" className="shrink-0" />
                Share…
              </button>
            )}
            {cause === "insecure" && (
              <a className={BTN_INK} href={CANONICAL}>
                <ExternalLink size={15} aria-hidden="true" className="shrink-0" />
                Open diffgit.com
              </a>
            )}
            {cause === "iframe" && (
              <a className={BTN_INK} href={href} target="_top">
                <ExternalLink size={15} aria-hidden="true" className="shrink-0" />
                Open in its own tab
              </a>
            )}
            {cause === "old" && (
              <a
                className={BTN_INK}
                href="https://www.google.com/chrome/update/"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={15} aria-hidden="true" className="shrink-0" />
                Update Chrome
              </a>
            )}
            {cause === "policy" && (
              <>
                <button type="button" className={BTN_INK} onClick={() => setGateCause(null)}>
                  Try again
                </button>
                <CopyButton
                  text="FileSystemReadBlockedForUrls"
                  label="Copy policy name for IT"
                  icon
                />
              </>
            )}
            <button type="button" className={BTN} onClick={onDemo}>
              <Play size={15} aria-hidden="true" className="shrink-0" />
              {demoLabel}
            </button>
          </div>

          {/* T11.15 / Design §14.6: the one thing Firefox and Safari can do, under the advice. */}
          {canReadOnce(cause) && <ReadOnceCard name={name} />}

          {(isBrowserCause(cause) || cause === "mobile") && (
            <div className="mt-[26px] flex flex-wrap gap-3.5 border-t border-line-subtle pt-3.5 text-[13px] text-muted/70">
              <span className={FACT}>
                <Lock size={13} aria-hidden="true" />
                read-only
              </span>
              <span className={FACT}>
                <Zap size={13} aria-hidden="true" />
                {cause === "mobile" ? "0 bytes uploaded" : "0 bytes uploaded, by CSP"}
              </span>
              <span className={FACT}>
                <CircleX size={13} aria-hidden="true" />
                no analytics
              </span>
            </div>
          )}
        </div>

        {twoColumn && (
          <div className="flex flex-col gap-3.5">
            <div className={CARD}>
              <div className={CARD_TITLE}>{SIDE_TITLE[cause]}</div>
              {cause === "insecure" ? (
                <Steps />
              ) : (
                <>
                  <UrlRow />
                  <SideCaption cause={cause} />
                </>
              )}
            </div>
            {isBrowserCause(cause) && <DemoCard onTry={onDemo} />}
          </div>
        )}
      </div>
    </main>
  );
}

/* --------------------------------------------------------------------- shell */

/**
 * Renders children only when a local folder can actually be opened (D3, Design §7.8 B1–B6).
 *
 * Two things can raise the gate: `detectGateCause` on load (no `showDirectoryPicker`), and the
 * store's `gateCause`, which the home screen sets to "policy" when the picker itself refuses. The
 * store wins, because it knows something detection cannot. "See the demo" drops the gate to a
 * warning strip and reveals the landing page below it, whose demo runs in every browser.
 */
export function BrowserGate({ children, win }: { children: ReactNode; win?: GateWindow }) {
  const gateCause = useStore((s) => s.gateCause);
  const snapshotMode = useStore((s) => s.snapshotMode);
  const target =
    win ?? (typeof window === "undefined" ? ({} as GateWindow) : (window as GateWindow));
  const cause = gateCause ?? detectGateCause(target);
  const [showDemo, setShowDemo] = useState(false);

  useEffect(() => {
    if (!showDemo) return;
    document.getElementById("demo")?.scrollIntoView?.();
  }, [showDemo]);

  if (!cause) return <>{children}</>;
  // T11.15: the folder was read once, so the app is usable in this browser after all. Closing the
  // repository clears the flag and puts the gate back, which is also the error screens' way out.
  if (snapshotMode) return <>{children}</>;

  if (showDemo) {
    return (
      <>
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-banner-warning-border bg-banner-warning-bg px-4 py-2 text-[13px] text-ink">
          <TriangleAlert size={14} aria-hidden="true" className="shrink-0 text-attention" />
          <span>Folder access unavailable in this browser — the demo below still works.</span>
          <button
            type="button"
            className="ml-auto cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[12px] font-medium hover:bg-surface-raised"
            onClick={() => setShowDemo(false)}
          >
            Back
          </button>
        </div>
        {children}
      </>
    );
  }

  return <GatePage cause={cause} win={target} onDemo={() => setShowDemo(true)} />;
}
