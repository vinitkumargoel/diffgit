import {
  CircleX,
  Copy,
  ExternalLink,
  Link as LinkIcon,
  Lock,
  Monitor,
  MonitorX,
  Play,
  Share2,
  Smartphone,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { describeBrowser, detectMobileOs, type GateWindow } from "../browserGate";
import { type GateCause, useStore } from "../store";
import { CopyButton, useCopy } from "./GateCopyButton";
import { DemoCard } from "./GateDemoCard";
import { ReadOnceCard } from "./GateReadOnceCard";
import {
  BROWSERS,
  BTN,
  BTN_INK,
  CANONICAL,
  CARD,
  CARD_TITLE,
  canReadOnce,
  DET,
  FACT,
  H1,
  isBrowserCause,
  MONO,
  P,
  RED_WORD,
  SIDE_P,
  SIDE_TITLE,
  STEPS,
  STRONG,
} from "./gate.styles";
import { Logo } from "./Logo";

export function pillText(
  cause: GateCause,
  name: string,
  version: string | null,
  os: string | null,
): string {
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

export function PillIcon({ cause }: { cause: GateCause }) {
  const props = { size: 13, "aria-hidden": true as const, className: "shrink-0" };
  if (cause === "mobile") return <Smartphone {...props} />;
  if (cause === "policy") return <Lock {...props} />;
  if (cause === "insecure" || cause === "iframe" || cause === "old")
    return <TriangleAlert {...props} />;
  return <MonitorX {...props} />;
}

export function Prose({
  cause,
  name,
  hostname,
}: {
  cause: GateCause;
  name: string;
  hostname: string;
}) {
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

export function BrowserGrid() {
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

export function UrlRow() {
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

export function Steps() {
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

export function SideCaption({ cause }: { cause: GateCause }) {
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

export function GatePage({
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
