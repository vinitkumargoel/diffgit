import { CircleX, Info, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { type Toast, useStore } from "../store";

/** Design §7.8: toasts auto-dismiss after 8 s. */
export const TOAST_TTL_MS = 8_000;

/** Mockup E5.2: the engine-restart toast gets the refresh glyph instead of the level icon. */
function ToastIcon({ toast }: { toast: Toast }) {
  const cls = "mt-[2px] shrink-0";
  if (toast.message.startsWith("Engine restarted"))
    return <RefreshCw size={14} className={`${cls} text-accent`} aria-hidden />;
  if (toast.level === "error")
    return <CircleX size={14} className={`${cls} text-danger`} aria-hidden />;
  if (toast.level === "warning")
    return <TriangleAlert size={14} className={`${cls} text-attention`} aria-hidden />;
  return <Info size={14} className={`${cls} text-accent`} aria-hidden />;
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
      <ToastIcon toast={toast} />
      <span className="min-w-0 flex-1 break-words">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="ml-auto shrink-0 font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
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
        className="mt-[1px] shrink-0 rounded-[3px] p-0.5 text-muted hover:bg-surface-raised hover:text-ink"
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
