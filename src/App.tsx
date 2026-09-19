import { lazy, Suspense, useEffect, useState } from "react";
import { installCompareHash } from "./ui/compareHash";
import { BrowserGate } from "./ui/components/BrowserGate";
import { HomeScreen } from "./ui/components/HomeScreen";
import { LiveRegion } from "./ui/components/LiveRegion";
import { LoadingScreen } from "./ui/components/LoadingScreen";
import { PatchDropZone } from "./ui/components/PatchDrop";
import { Toasts } from "./ui/components/Toasts";
import { useStore } from "./ui/store";
import { applyTheme } from "./ui/theme";

// Repo/error screens arrive in Phase 5; until then these placeholders keep the switch complete.
const RepoScreen = lazy(() => import("./ui/components/RepoScreen"));
const ErrorScreen = lazy(() => import("./ui/components/ErrorScreen"));
const DebugPanel = lazy(() =>
  import("./ui/components/DebugPanel").then((m) => ({ default: m.DebugPanel })),
);

/** `/#debug` shows the hidden metrics panel (T7.2); follows hash changes. */
function useDebugHash(): boolean {
  const [on, setOn] = useState(() => typeof location !== "undefined" && location.hash === "#debug");
  useEffect(() => {
    const onHash = () => setOn(location.hash === "#debug");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return on;
}

/** Route-less app: switches on the store's screen (Plan §6.1). */
export function App() {
  const screen = useStore((s) => s.screen);
  const theme = useStore((s) => s.prefs.theme);
  useEffect(() => applyTheme(theme), [theme]);
  // T11.2: `#compare=<from>...<to>` — written on every source change, applied to the first
  // repository opened after a reload.
  useEffect(() => installCompareHash(), []);
  const debug = useDebugHash();

  return (
    <BrowserGate>
      {screen === "home" && <HomeScreen />}
      {screen === "loading" && <LoadingScreen />}
      {screen === "repo" && (
        <Suspense fallback={<LoadingScreen />}>
          <RepoScreen />
        </Suspense>
      )}
      {screen === "error" && (
        <Suspense fallback={null}>
          <ErrorScreen />
        </Suspense>
      )}
      {/* T11.14: a .patch dropped anywhere — on Home or on the repo screen — opens patch-only mode. */}
      <PatchDropZone />
      <Toasts />
      <LiveRegion />
      {debug && (
        <Suspense fallback={null}>
          <DebugPanel />
        </Suspense>
      )}
    </BrowserGate>
  );
}
