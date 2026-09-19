/**
 * Installing diffgit as an app (T11.14, Design §14.6, atlas tab 17).
 *
 * Three small jobs, all optional and all feature-detected, because none of them exists outside
 * Chromium and the page must behave identically without them:
 *
 *  1. **Service worker** — registered in a production build only, so `vite dev` is never shadowed
 *     by a cache and the E2E build (`VITE_E2E=1`) keeps its zero-request privacy assertion. It
 *     precaches nothing remote; see `public/sw.js`.
 *  2. **Install affordance** — `beforeinstallprompt` is captured and held, and the Install entry is
 *     offered *only* while it is pending (Design §14.6). Chrome fires it once; after
 *     `appinstalled`, or after the user dismisses the OS prompt, it is gone and so is the entry.
 *  3. **File handler** — the manifest registers `.patch` / `.diff`; `launchQueue` hands the file
 *     over on launch and it opens in patch-only mode, exactly as a drop does.
 *
 * An update is **one toast**, never a nag: the waiting worker is announced once per page load and
 * the reload is the user's (`public/sw.js` deliberately does not `skipWaiting()`).
 */
import { useSyncExternalStore } from "react";
import { useStore } from "./store";

/** Chrome's non-standard install event (not in lib.dom). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface LaunchParams {
  files: FileSystemHandle[];
}

export const INSTALL_LABEL = "Install diffgit";
export const INSTALL_HINT = "Opens in its own window and remembers folder permissions";
export const INSTALLED_NOTE = "diffgit is installed. It now opens in its own window.";
export const UPDATE_NOTE = "A new version of diffgit is ready — reload to use it.";
export const RELOAD_LABEL = "Reload";

let pending: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** True while an install prompt is held and the Install entry should be offered. */
export function canInstall(): boolean {
  return pending !== null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the Install entries when Chrome offers, or withdraws, the prompt. */
export function useInstallPrompt(): boolean {
  return useSyncExternalStore(subscribe, canInstall, () => false);
}

/**
 * Shows the OS install dialog. The event may be used once, so it is dropped either way: accepted
 * means installed, dismissed means Chrome will offer it again on a later visit, not this one.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = pending;
  if (!event) return "unavailable";
  pending = null;
  announce();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch (e) {
    console.warn("install prompt failed", e);
    return "dismissed";
  }
}

/** Only a real production build registers a worker (never `vite dev`, never the E2E build). */
export function shouldRegister(env: { PROD: boolean; VITE_E2E?: string }): boolean {
  return env.PROD && env.VITE_E2E !== "1";
}

/** The one toast an update is allowed: armed once per page load, whoever finds the new worker. */
function announceUpdate(registration: ServiceWorkerRegistration): void {
  let told = false;
  const tell = () => {
    if (told || !navigator.serviceWorker.controller) return; // a first install is not an update
    told = true;
    useStore.getState().addToast({
      level: "info",
      message: UPDATE_NOTE,
      action: { label: RELOAD_LABEL, onClick: () => location.reload() },
    });
  };
  if (registration.waiting) tell();
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") tell();
    });
  });
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(announceUpdate, (e) => {
      // Not user-actionable: the app works online exactly as before.
      console.warn("service worker registration failed", e);
    });
  });
}

function watchInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the event instead of letting Chrome show its own mini-infobar: Design §14.6 puts the
    // affordance in the app, and only while this event is pending.
    event.preventDefault();
    pending = event as InstallPromptEvent;
    announce();
  });
  window.addEventListener("appinstalled", () => {
    pending = null;
    announce();
    useStore.getState().addToast({ level: "info", message: INSTALLED_NOTE });
  });
}

/**
 * The OS opened a `.patch` with diffgit. `launchQueue` may fire before or after the first render;
 * the store action is safe either way, since patch-only mode is state, not a route.
 */
function watchLaunchQueue(): void {
  const queue = (
    window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }
  ).launchQueue;
  if (!queue) return;
  queue.setConsumer((params) => {
    void (async () => {
      const handle = params.files[0];
      if (handle?.kind !== "file") return;
      const file = await (handle as FileSystemFileHandle).getFile();
      await useStore.getState().openPatchFile(file);
    })();
  });
}

/** Called once from `src/main.tsx`. Every part is optional and silent where unsupported. */
export function installPwa(): void {
  if (typeof window === "undefined") return;
  if (shouldRegister(import.meta.env)) registerServiceWorker();
  watchInstallPrompt();
  watchLaunchQueue();
}
