import type { ReactNode } from "react";

export interface NoticeProps {
  /** Tints the icon only (mockup `.notice .ic.r`); the text is always ink + muted. */
  tone?: "muted" | "danger";
  icon?: ReactNode;
  /** The bold ink title line. */
  children: ReactNode;
  /** Optional bordered button(s) rendered below the sentence (Design §7.7). */
  action?: ReactNode;
  /** Muted sentence under the title (sizes, counts, what happened). */
  detail?: ReactNode;
  /** Dim mono line at the bottom: the error code and the engine message. */
  code?: ReactNode;
}

/**
 * Shared notice shell (Design §7.7, mockup `.notice`): 28 px padding, centred, icon 22 px,
 * bold ink title, muted sentence, `.btn-sm` actions row, dim mono code line.
 */
export function Notice({ tone = "muted", icon, children, action, detail, code }: NoticeProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 p-7 text-center text-[13px] leading-5 text-muted">
      {icon && <span className={tone === "danger" ? "text-danger" : "text-muted"}>{icon}</span>}
      <b className="font-medium text-ink">{children}</b>
      {detail && <div>{detail}</div>}
      {action && <div className="flex items-center gap-2">{action}</div>}
      {code && <div className="font-mono text-[11px] break-all text-muted/70">{code}</div>}
    </div>
  );
}
