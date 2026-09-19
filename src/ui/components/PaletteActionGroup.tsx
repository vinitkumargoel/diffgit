import { Command } from "cmdk";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatBytes } from "../format";
import { openRepoOnce, pickAndOpenRepo } from "../openRepo";
import { CLOSE_PATCH_LABEL } from "../patch";
import { clearDerived, type DerivedSize } from "../persistence/derived";
import { INSTALL_LABEL, promptInstall, useInstallPrompt } from "../pwa";
import { ADVERTISED_PREFIXES } from "../search";
import { selectPreflightPair, useStore } from "../store";
import { WORKTREES_ACTION, worktreeCount } from "../worktrees";
import { MODES } from "./ModeSwitch";
import { openPatchPicker } from "./PatchDrop";
import {
  PALETTE_ACTION_LABEL_CLASS,
  PALETTE_KBD_CLASS,
  PALETTE_PREFIX_KBD_CLASS,
  PALETTE_PREFIX_NOTE_CLASS,
} from "./palette.styles";

export interface Action {
  id: string;
  label: string;
  /** Extra words the search matches on. */
  keywords?: string[];
  /** Right-aligned hint: the single-key shortcut, or a size. */
  hint?: string;
  run: () => void;
}

export interface PaletteActionGroupProps {
  search: string;
  cache: DerivedSize | null;
  setCache: (size: DerivedSize) => void;
  onArmPrefix: (prefix: string) => void;
  onRun: (action: () => void) => void;
  onHelp?: () => void;
}

/**
 * Action items (modes, preferences, export, shortcuts, PWA) and search scopes (Design §14.1).
 */
export function PaletteActionGroup({
  search,
  cache,
  setCache,
  onArmPrefix,
  onRun,
  onHelp,
}: PaletteActionGroupProps) {
  const setMode = useStore((s) => s.setMode);
  const setHistoryTab = useStore((s) => s.setHistoryTab);
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);
  const addToast = useStore((s) => s.addToast);
  const requestRefresh = useStore((s) => s.requestRefresh);
  const scanSecrets = useStore((s) => s.scanSecrets);
  const setExportOpen = useStore((s) => s.setExportOpen);
  const startBisect = useStore((s) => s.startBisect);
  const stopBisect = useStore((s) => s.stopBisect);
  const bisecting = useStore((s) => s.bisect !== null);
  const runPreflight = useStore((s) => s.runPreflight);
  const preflightPair = useStore(useShallow(selectPreflightPair));
  const patchOnly = useStore((s) => s.patchOnly);
  const repoOpen = useStore((s) => s.repo !== null);
  const worktrees = useStore((s) => s.worktrees);
  const setWorktreesOpen = useStore((s) => s.setWorktreesOpen);
  const installable = useInstallPrompt();

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [
      {
        id: "open",
        label: "Open a repository…",
        keywords: ["folder", "choose", "pick"],
        hint: "o",
        run: () => void pickAndOpenRepo(),
      },
      {
        id: "refresh",
        label: "Refresh the diff",
        keywords: ["reload"],
        hint: "r",
        run: () => requestRefresh("manual"),
      },
      {
        id: "force-refresh",
        label: "Force refresh: re-read every file",
        keywords: ["reload", "recount"],
        hint: "Shift+R",
        run: () => requestRefresh("force"),
      },
      ...MODES.map((m) => ({
        id: `mode-${m.mode}`,
        label: `Go to ${m.label}`,
        keywords: ["mode", "view", m.label],
        hint: m.key,
        run: () => setMode(m.mode),
      })),
      {
        id: "view-mode",
        label: prefs.viewMode === "split" ? "Use unified view" : "Use split view",
        keywords: ["diff", "side by side", "unified", "split"],
        hint: "s",
        run: () => setPref("viewMode", prefs.viewMode === "split" ? "unified" : "split"),
      },
      {
        id: "whitespace",
        label: prefs.ignoreWhitespace ? "Show whitespace changes" : "Ignore whitespace changes",
        keywords: ["blank", "indent"],
        run: () => setPref("ignoreWhitespace", !prefs.ignoreWhitespace),
      },
      {
        id: "hidden",
        label: prefs.showHidden ? "Hide hidden files" : "Show hidden files",
        keywords: ["ignored", "skip-worktree", "excluded"],
        hint: "Shift+H",
        run: () => setPref("showHidden", !prefs.showHidden),
      },
      {
        // T11.5: the Reflog list is the History sidebar's third sub-tab (Design §14.5).
        id: "reflog",
        label: "Show reflog",
        keywords: ["HEAD", "history", "lost commit", "orphan", "undo"],
        run: () => {
          setHistoryTab("reflog");
          setMode("history");
        },
      },
      {
        // T11.9: the scan runs itself after every compute; this is the "look again" for a working
        // tree that changed outside a refresh, and the only way to hear "nothing found".
        id: "scan-secrets",
        label: "Re-scan for secrets",
        keywords: ["credential", "key", "token", "leak", "password"],
        run: () => void scanSecrets({ announce: true }),
      },
      {
        // T11.13: the bisect strip and the preflight panel are reached from here or from a row
        // `…` menu — never from the bars (Design §14.1's last paragraph).
        id: "bisect",
        label: bisecting ? "Stop the bisect" : "Start bisect…",
        keywords: ["bisect", "regression", "broke", "midpoint", "git bisect"],
        run: () => void (bisecting ? stopBisect() : startBisect()),
      },
      ...(preflightPair
        ? [
            {
              id: "preflight",
              label: `Preflight rebase of ${preflightPair.branch} onto ${preflightPair.onto}`,
              keywords: ["rebase", "conflict", "replay", "todo", "preflight"],
              run: () => void runPreflight(preflightPair.branch, preflightPair.onto),
            },
          ]
        : []),
      ...(repoOpen
        ? [
            {
              // T11.16 (Design §14.1, atlas tab 19): `git worktree list` is a dialog, not a bar
              // control — the palette and the repo name are its two openers.
              id: "worktrees",
              label: WORKTREES_ACTION,
              keywords: ["worktree", "linked", "checkout", "prunable", "git worktree list"],
              ...(worktrees ? { hint: worktreeCount(worktrees.length) } : {}),
              run: () => setWorktreesOpen(true),
            },
          ]
        : []),
      {
        // T11.10: Design §14.6's menu is in the StatsRow; the palette is how it opens from anywhere.
        id: "export",
        label: "Export…",
        keywords: ["patch", "diff", "snapshot", "download", "save", "copy", "markdown"],
        hint: "e",
        run: () => setExportOpen(true),
      },
      // T11.14 (Design §14.6): the three patch-only / install rows. The Install row exists only
      // while `beforeinstallprompt` is pending, and "Close the patch" only inside a patch session —
      // the palette is where both live, so neither becomes a button in the bars (§14.1).
      {
        id: "open-patch",
        label: "Open a patch file…",
        keywords: ["patch", "diff", "unified", "apply", "file", "drop"],
        run: () => openPatchPicker(),
      },
      ...(patchOnly
        ? [
            {
              id: "close-patch",
              label: CLOSE_PATCH_LABEL,
              keywords: ["patch", "back", "home"],
              run: () => void useStore.getState().closeRepo(),
            },
          ]
        : []),
      ...(installable
        ? [
            {
              id: "install",
              label: `${INSTALL_LABEL}…`,
              keywords: ["pwa", "app", "offline", "desktop", "window"],
              run: () => void promptInstall(),
            },
          ]
        : []),
      {
        id: "help",
        label: "Show keyboard shortcuts",
        keywords: ["help", "keys"],
        hint: "?",
        run: () => onHelp?.(),
      },
      {
        id: "clear-cache",
        label: "Clear cached data",
        keywords: ["cache", "blame", "insights", "storage"],
        ...(cache ? { hint: formatBytes(cache.bytes) } : {}),
        run: () => {
          void clearDerived().then(() => {
            setCache({ entries: 0, bytes: 0 });
            addToast({ level: "info", message: "Cached blame, history and insights cleared." });
          });
        },
      },
      {
        // T11.15: the read-once flow Firefox and Safari get from the gate, available everywhere —
        // which is how snapshot mode is exercised on a Chromium browser.
        id: "open-once",
        label: "Open once (snapshot)",
        keywords: ["folder", "read once", "firefox", "safari", "webkitdirectory", "no refresh"],
        run: () =>
          void openRepoOnce().catch((e: unknown) =>
            addToast({
              level: "error",
              message: e instanceof Error ? e.message : "Couldn't read the folder.",
            }),
          ),
      },
    ];
    return list;
  }, [
    patchOnly,
    repoOpen,
    worktrees,
    setWorktreesOpen,
    installable,
    prefs,
    cache,
    setCache,
    setMode,
    setHistoryTab,
    setPref,
    requestRefresh,
    scanSecrets,
    setExportOpen,
    addToast,
    onHelp,
    bisecting,
    startBisect,
    stopBisect,
    runPreflight,
    preflightPair,
  ]);

  return (
    <>
      {/* Only on the empty box: the scopes are an offer, and once a command is being
          typed they would compete with it for the highlighted row. */}
      {search === "" && (
        <Command.Group heading="Scopes">
          {ADVERTISED_PREFIXES.map((p) => (
            <Command.Item
              key={p.prefix}
              value={`scope-${p.scope}`}
              keywords={["search", "find", p.prefix, p.label, p.note]}
              // Not a command: it arms the box with the prefix and leaves the palette open.
              onSelect={() => onArmPrefix(p.prefix.endsWith(":") ? p.prefix : `${p.prefix} `)}
            >
              <kbd className={PALETTE_PREFIX_KBD_CLASS} aria-hidden>
                {p.prefix}
              </kbd>
              <span className={PALETTE_ACTION_LABEL_CLASS}>Search {p.label.toLowerCase()}</span>
              <span className={PALETTE_PREFIX_NOTE_CLASS}>{p.note}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      <Command.Group heading="Actions">
        {actions.map((a) => (
          <Command.Item
            key={a.id}
            value={a.id}
            keywords={[a.label, ...(a.keywords ?? [])]}
            onSelect={() => onRun(a.run)}
          >
            <span className={PALETTE_ACTION_LABEL_CLASS}>{a.label}</span>
            {a.hint && (
              <kbd className={PALETTE_KBD_CLASS} aria-hidden>
                {a.hint}
              </kbd>
            )}
          </Command.Item>
        ))}
      </Command.Group>
    </>
  );
}
