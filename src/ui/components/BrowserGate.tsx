import { MonitorX } from "lucide-react";
import type { ReactNode } from "react";
import { CenteredColumn } from "./CenteredColumn";

export const PRIVACY_LINE =
  "Nothing leaves your browser: the folder is opened read-only, no data is uploaded, and there are no analytics.";

export function supportsFileSystemAccess(
  win: unknown = typeof window === "undefined" ? undefined : window,
): boolean {
  return typeof win === "object" && win !== null && "showDirectoryPicker" in (win as object);
}

/** Renders children only when the File System Access API exists (D3); otherwise the unsupported page. */
export function BrowserGate({ children }: { children: ReactNode }) {
  if (supportsFileSystemAccess()) return <>{children}</>;
  return (
    <CenteredColumn label="Unsupported browser">
      <MonitorX size={32} className="text-muted" aria-hidden="true" />
      <h1 className="text-2xl font-semibold leading-8">This browser can't open local folders</h1>
      <p className="text-muted">
        diffgoel reads your repository through the File System Access API, which only desktop
        Chromium browsers provide. Please open this page in one of:
      </p>
      <p className="font-medium">Google Chrome · Microsoft Edge · Brave · Arc (desktop)</p>
      <p className="text-muted">{PRIVACY_LINE}</p>
    </CenteredColumn>
  );
}
