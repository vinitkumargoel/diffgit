import {
  ChevronRight,
  CircleX,
  Copy,
  Cpu,
  Database,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  HardDrive,
  KeyRound,
  Link,
  Lock,
  type LucideIcon,
  RefreshCw,
  Scale,
  Zap,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import {
  describeError,
  type ErrorDescription,
  type ErrorFixRow,
  type ErrorTone,
  errorReport,
} from "../errors";
import { useErrorActions } from "../hooks/useErrorActions";
import { upsertRepo } from "../persistence";
import { useStore } from "../store";
import { CenteredColumn } from "./CenteredColumn";
import { renderInline } from "./InlineText";

/** The tinted 40 × 40 tile behind the icon (mockup `.err .hd .ico`). */
const TONE_TILE: Record<ErrorTone, string> = {
  red: "bg-banner-error-bg text-danger border-danger/45",
  yellow: "bg-banner-warning-bg text-attention border-attention/45",
  blue: "bg-accent-subtle text-accent border-accent/45",
  grey: "bg-surface-raised text-muted border-line",
};

const ICONS: Record<ErrorDescription["icon"], LucideIcon> = {
  FolderGit2,
  GitBranch,
  Database,
  KeyRound,
  Link,
  HardDrive,
  FileText,
  Lock,
  Folder,
  Cpu,
  Zap,
  RefreshCw,
  Scale,
};

/** Codes the store never routes to this screen (E4.5 / E4.6); if one arrives it is a bug. */
const NEVER_A_SCREEN = new Set(["STALE", "CANCELLED", "TOO_LARGE", "STORAGE_UNAVAILABLE"]);

type Picker = (opts: { mode: "read"; id?: string }) => Promise<FileSystemDirectoryHandle>;

function picker(): Picker | null {
  const w = window as unknown as { showDirectoryPicker?: Picker };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}

/** "was open 14 min" for E3.4; null when the open time is unknown. */
function openFor(startedAt: number | null, now: number): string | null {
  if (startedAt === null || startedAt > now) return null;
  const min = Math.round((now - startedAt) / 60_000);
  if (min < 1) return "was open < 1 min";
  if (min < 60) return `was open ${min} min`;
  return `was open ${Math.round(min / 60)} h`;
}

/** First path-looking token in engine text, for the IO_ERROR sentence (E4.1). */
function pathIn(text: string | undefined): string | null {
  if (!text) return null;
  const m = /(?:^|[\s(])([\w.@-]*\/[\w./@-]+)/.exec(text);
  return m?.[1] ?? null;
}

interface Action {
  label: string;
  onClick: () => void;
  kind: "primary" | "secondary" | "ghost";
  icon?: ReactNode;
  disabled?: boolean;
}

const BTN: Record<Action["kind"], string> = {
  primary: "btn btn-ink px-3.5 py-2 text-[13.5px]",
  secondary: "btn px-3.5 py-2 text-[13.5px]",
  ghost: "btn btn-ghost px-3.5 py-2 text-[13.5px]",
};

function ActionButton({ action }: { action: Action }) {
  return (
    <button
      type="button"
      className={BTN[action.kind]}
      disabled={action.disabled ?? false}
      onClick={action.onClick}
    >
      {action.icon}
      {action.label}
    </button>
  );
}

/**
 * Design §7.8 / review E1–E4: one anatomy for every public code — tinted tile, title + `CODE ·
 * repo` line, one sentence, a "What to do" box, actions in a fixed order (primary · secondary ·
 * ghost right), and collapsible details carrying `errorReport`. Default export: lazy chunk.
 */
export default function ErrorScreen() {
  const {
    error,
    description,
    repoId,
    repoName,
    busy,
    denied,
    copied,
    reopen,
    regrant,
    forget,
    copyReport,
    chooseFolder,
  } = useErrorActions();
  const openRepo = useStore((s) => s.openRepo);
  const addToast = useStore((s) => s.addToast);
  const diffSource = useStore((s) => s.diffSource);
  const restarts = useStore((s) => s.refresh.restarts);
  const wasOpen = useStore((s) => s.refresh.lastAt !== null);
  const startedAt = useStore((s) => s.loading.startedAt);

  const code = error?.code ?? "INTERNAL";
  const stray = NEVER_A_SCREEN.has(code);
  // E4.5 / E4.6: a code that should never reach a screen renders as INTERNAL, code and all.
  const d = stray ? describeError("INTERNAL") : description;
  const giveUp = code === "WORKER_CRASHED" && (error?.message ?? "").includes("times in a minute");
  const goneWhileOpen = code === "HANDLE_GONE" && wasOpen;
  const permissionDenied = code === "PERMISSION" && denied;
  const Icon = ICONS[d.icon];

  /** E3.2: a fresh pick resets the browser's remembered "Don't allow". */
  const pickAgain = () => {
    const pick = picker();
    if (!pick) return;
    void (async () => {
      try {
        // D16: read-only access, always.
        const handle = await pick({ mode: "read", id: "diffgit-repo" });
        const stored = await upsertRepo(handle);
        await openRepo(handle, {
          id: stored.id,
          lastSource: stored.lastSource,
          lastTarget: stored.lastTarget,
        });
      } catch (e) {
        if ((e as { name?: unknown } | null)?.name === "AbortError") return; // user cancelled
        addToast({
          level: "error",
          message: `Couldn't open the folder: ${String((e as Error)?.message ?? e)}`,
        });
      }
    })();
  };

  let title = d.title;
  if (giveUp) title = "Engine keeps stopping";
  if (goneWhileOpen) title = "Folder disappeared";

  const codeSuffix: string[] = [];
  if (repoName) codeSuffix.push(repoName);
  if (giveUp) codeSuffix.push(`${restarts ?? 3} restarts`);
  if (goneWhileOpen) {
    const span = openFor(startedAt, Date.now());
    if (span) codeSuffix.push(span);
  }

  let message: string | null = d.message;
  if (goneWhileOpen)
    message =
      "The folder went away while the diff was open. The last diff is still on screen behind this message and will not update.";
  if (code === "REF_NOT_FOUND" && diffSource?.source)
    message = `\`${diffSource.source}\` no longer exists — it was deleted or renamed while it was selected.`;
  if (code === "IO_ERROR") {
    const path = pathIn(error?.hint) ?? pathIn(error?.message);
    if (path) message = `A file could not be read: \`${path}\`.`;
  }
  if (permissionDenied) message = null; // the callout says it instead

  let fix: ErrorFixRow[] = d.fix;
  if (permissionDenied)
    fix = [
      {
        label: "What to do",
        text: "Choose the folder again through the picker; the browser asks fresh for a folder chosen this way.",
      },
    ];
  else if (goneWhileOpen)
    fix = [
      {
        label: "What to do",
        text: "If you renamed or moved it, choose it again. If a drive was unplugged, plug it back in and retry.",
      },
    ];
  else if (code === "NOT_A_REPO" && repoName)
    fix = d.fix.map((row) => ({ ...row, text: row.text.replaceAll("<folder>", repoName) }));
  // The engine's `hint` is a terser form of the "What to do" row; it only surfaces when the copy
  // table has no fix rows at all (never for a registered code), and always in the Details report.
  const hint = error?.hint;
  if (hint && fix.length === 0) fix = [{ label: "What to do", text: hint }];

  const copyLabel =
    copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy report";
  const retry: Action = {
    label: "Retry",
    onClick: () => void reopen(),
    kind: "primary",
    disabled: busy,
  };
  const another: Action = {
    label: "Choose another folder",
    onClick: chooseFolder,
    kind: "secondary",
  };
  // E3.3 / E3.4: "Forget this repo" belongs to the folder-gone case only (Design §7.8).
  const forgetGhost: Action[] =
    repoId && code === "HANDLE_GONE"
      ? [{ label: "Forget this repo", onClick: () => void forget(), kind: "ghost" }]
      : [];

  let actions: Action[];
  if (stray || code === "INTERNAL") {
    actions = [
      retry,
      {
        label: copyLabel,
        onClick: () => void copyReport(),
        kind: "secondary",
        icon: <Copy size={13} aria-hidden />,
      },
      { label: "Back to start", onClick: chooseFolder, kind: "ghost" },
    ];
  } else if (giveUp) {
    actions = [
      retry,
      {
        label: "Retry without uncommitted",
        onClick: () => void reopen({ skipWorktree: true }),
        kind: "secondary",
        disabled: busy,
      },
      { label: "Choose another", onClick: chooseFolder, kind: "ghost" },
    ];
  } else if (code === "REF_NOT_FOUND") {
    actions = [
      {
        label: "Use defaults",
        onClick: () => void reopen({ defaults: true }),
        kind: "primary",
        disabled: busy,
      },
      // The compare picker lives in the top bar, which is not mounted behind this screen, so the
      // only thing this can do is re-open on the defaults and let the user pick from the bar.
      {
        label: "Pick a branch",
        onClick: () => void reopen({ defaults: true }),
        kind: "secondary",
        disabled: busy,
      },
    ];
  } else if (permissionDenied) {
    actions = [
      { label: "Pick the folder again", onClick: pickAgain, kind: "primary", disabled: busy },
      another,
      ...forgetGhost,
    ];
  } else if (code === "HANDLE_GONE") {
    actions = goneWhileOpen
      ? [
          retry,
          { label: "Choose it again", onClick: chooseFolder, kind: "secondary" },
          ...forgetGhost,
        ]
      : [
          { label: "Choose it again", onClick: chooseFolder, kind: "primary" },
          { label: "Back to start", onClick: chooseFolder, kind: "secondary" },
          ...forgetGhost,
        ];
  } else
    switch (d.action) {
      case "retry":
        actions = [retry, another];
        break;
      case "reopen-permission":
        actions = [
          { label: "Grant access", onClick: () => void regrant(), kind: "primary", disabled: busy },
          another,
          ...forgetGhost,
        ];
        break;
      case "choose-folder":
        actions = [
          { label: "Choose another folder", onClick: chooseFolder, kind: "primary" },
          { label: "Back to start", onClick: chooseFolder, kind: "secondary" },
          ...forgetGhost,
        ];
        break;
      default:
        actions = [{ label: "Back to start", onClick: chooseFolder, kind: "primary" }];
    }

  const ghosts = actions.filter((a) => a.kind === "ghost");
  const inline = actions.filter((a) => a.kind !== "ghost");

  return (
    <CenteredColumn label="Error">
      <div className="flex w-full flex-col gap-[18px] text-left">
        <div className="flex items-start gap-[14px]">
          <span
            className={`flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border ${TONE_TILE[d.tone]}`}
          >
            <Icon size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[21px] leading-[1.15] font-semibold tracking-[-0.02em]">{title}</h1>
            <div
              data-testid="error-code"
              className="mt-1 font-mono text-[11.5px] break-all text-muted/70"
            >
              {code}
              {codeSuffix.map((part) => (
                <span key={part} className="text-muted">
                  {" · "}
                  {part}
                </span>
              ))}
            </div>
          </div>
        </div>

        {message !== null && (
          <p className="text-[14.5px] leading-[22px] text-ink/80">
            {renderInline(message, "mono")}
          </p>
        )}

        {permissionDenied && (
          <div
            role="alert"
            className="flex items-start gap-[10px] rounded-[8px] border border-danger/50 bg-banner-error-bg px-3 py-[10px] text-[13px] leading-[19px] text-ink"
          >
            <CircleX size={14} className="mt-[3px] shrink-0 text-danger" aria-hidden="true" />
            <p>
              <strong className="font-semibold">Denied again.</strong>{" "}
              {
                'The browser remembers a "Don\'t allow" for this folder. Re-picking it from the folder dialog resets that.'
              }
            </p>
          </div>
        )}

        {fix.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-[8px] border border-line bg-surface-sunken px-[14px] py-3 text-[13.5px] leading-[20px]">
            {fix.map((row) => (
              <Fragment key={row.label}>
                <dt className="pt-[3px] font-mono text-[11px] font-medium tracking-[0.04em] text-muted/70 uppercase">
                  {row.label}
                </dt>
                <dd className="m-0">{renderInline(row.text)}</dd>
              </Fragment>
            ))}
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {inline.map((a) => (
            <ActionButton key={a.label} action={a} />
          ))}
          {ghosts.length > 0 && (
            <span className="ml-auto flex items-center gap-2">
              {ghosts.map((a) => (
                <ActionButton key={a.label} action={a} />
              ))}
            </span>
          )}
        </div>

        <details
          className="border-t border-line pt-2.5 text-[12.5px] text-muted"
          open={stray || code === "INTERNAL"}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} aria-hidden="true" />
            Details
          </summary>
          <pre
            data-testid="error-report"
            className="mt-2 max-h-48 overflow-auto rounded-[6px] border border-line bg-surface-raised px-3 py-2.5 font-mono text-[11.5px] leading-[1.5] break-all whitespace-pre-wrap text-ink/80"
          >
            {errorReport(error, repoName ? { repo: repoName } : {})}
          </pre>
        </details>
      </div>
    </CenteredColumn>
  );
}
