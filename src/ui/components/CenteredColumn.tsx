import type { ReactNode } from "react";

/** Design §7.8 shell for Home / Gate / Loading / Empty / Error: centred, max 560 px, 15 px body, 24 px gaps. */
export function CenteredColumn({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <main
      aria-label={label}
      className="flex min-h-full items-center justify-center bg-bg px-4 py-12 text-[15px] leading-6 text-ink"
    >
      <div className="flex w-full max-w-[560px] flex-col items-center gap-6 text-center">
        {children}
      </div>
    </main>
  );
}
