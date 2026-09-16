import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getWorkerClient } from "./ui/engineClient";
import { ensurePermission, installPersistence } from "./ui/persistence";
import { observerStarter } from "./ui/refresh/observer";
import { createScheduler } from "./ui/refresh/scheduler";
import "./index.css";

installPersistence();
// T6.1: the scheduler registers itself with the store and owns observer/poller lifetimes.
createScheduler({
  client: getWorkerClient(),
  startObserver: observerStarter,
  requestPermission: async (handle) => (await ensurePermission(handle)) === "granted",
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing from index.html");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
