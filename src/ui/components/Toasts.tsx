import { CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { type Toast, useStore } from "../store";

/** Design §7.8: toasts auto-dismiss after 8 s. */
export const TOAST_TTL_MS = 8_000;

function ToastIcon({ level }: { level: Toast["level"] }) {
  if (level === "error") return <CircleX size={14} className="shrink-0 text-danger" aria-hidden />;
  if (level === "warning")
    return <TriangleAlert size={14} className="shrink-0 text-attention" aria-hidden />;
  return <Info size={14} className="shrink-0 text-accent" aria-hidden />;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // one timer per toast id, untouched by parent re-renders
  useEffect(() => {
    const t = setTimeout(() => useStore.getState().dismissToast(toast.id), TOAST_TTL_MS);
    return () => clearTimeout(t);
  }, [toast.id]);
  return (
    <div
      role={toast.level === "error" ? "alert" : "status"}
      className="flex w-[360px] max-w-[calc(100vw-32px)] items-start gap-2 rounded-[6px] border border-line bg-surface px-4 py-3 text-[13px] leading-5 text-ink shadow-popover"
    >
      <span className="mt-0.5">
        <ToastIcon level={toast.level} />
      </span>
      <p className="min-w-0 flex-1 break-words">{toast.message}</p>
      {toast.action && (
        <button
          type="button"
          className="shrink-0 font-medium text-accent underline-offset-2 hover:underline"
          onClick={() => {
            toast.action?.onClick();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="shrink-0 rounded-[3px] p-0.5 text-muted hover:bg-surface-raised hover:text-ink"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

/** Bottom-right toast host; mounted once in `App`. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <section className="fixed right-4 bottom-4 z-30 flex flex-col gap-2" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </section>
  );
}
