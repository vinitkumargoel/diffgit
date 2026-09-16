import { lazy, Suspense, useEffect } from "react";
import { BrowserGate } from "./ui/components/BrowserGate";
import { HomeScreen } from "./ui/components/HomeScreen";
import { LiveRegion } from "./ui/components/LiveRegion";
import { LoadingScreen } from "./ui/components/LoadingScreen";
import { Toasts } from "./ui/components/Toasts";
import { useStore } from "./ui/store";
import { applyTheme } from "./ui/theme";

// Repo/error screens arrive in Phase 5; until then these placeholders keep the switch complete.
const RepoScreen = lazy(() => import("./ui/components/RepoScreen"));
const ErrorScreen = lazy(() => import("./ui/components/ErrorScreen"));

/** Route-less app: switches on the store's screen (Plan §6.1). */
export function App() {
  const screen = useStore((s) => s.screen);
  const repoName = useStore(
    (s) => s.repo?.name ?? (s.handle as { name?: string } | null)?.name ?? "Repository",
  );
  const theme = useStore((s) => s.prefs.theme);
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <BrowserGate>
      {screen === "home" && <HomeScreen />}
      {screen === "loading" && <LoadingScreen repoName={repoName} />}
      {screen === "repo" && (
        <Suspense fallback={<LoadingScreen repoName={repoName} />}>
          <RepoScreen />
        </Suspense>
      )}
      {screen === "error" && (
        <Suspense fallback={null}>
          <ErrorScreen />
        </Suspense>
      )}
      <Toasts />
      <LiveRegion />
    </BrowserGate>
  );
}
