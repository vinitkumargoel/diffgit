import type { ReactNode } from "react";

export interface NoticeProps {
  tone?: "muted" | "danger";
  icon?: ReactNode;
  children: ReactNode;
  /** Optional bordered button(s) rendered 8 px below the text (Design §7.7). */
  action?: ReactNode;
  /** Additional muted line under the message (sizes, counts). */
  detail?: ReactNode;
}

/** Shared notice shell (Design §7.7): 28 px padding, centred, 13 px `--muted`. */
export function Notice({ tone = "muted", icon, children, action, detail }: NoticeProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 p-7 text-center text-[13px] leading-5 ${
        tone === "danger" ? "text-danger" : "text-muted"
      }`}
    >
      {icon}
      <div>{children}</div>
      {detail && <div className="text-xs text-muted">{detail}</div>}
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}
