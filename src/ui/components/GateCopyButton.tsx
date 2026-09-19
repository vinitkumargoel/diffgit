import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BTN, BTN_INK } from "./gate.styles";

/** Clipboard write with the 1.5 s label flash used across the app (FileHeader, useErrorActions). */
export function useCopy(): {
  state: "idle" | "done" | "failed";
  copy: (text: string) => Promise<void>;
} {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      // clipboard blocked (permissions / insecure context): say so instead of failing silently (T7.3)
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 1500);
  }, []);
  return { state, copy };
}

export function CopyButton({
  text,
  label,
  ink,
  icon = true,
}: {
  text: string;
  label: string;
  ink?: boolean;
  icon?: boolean;
}) {
  const { state, copy } = useCopy();
  return (
    <button type="button" className={ink ? BTN_INK : BTN} onClick={() => void copy(text)}>
      {icon && <Copy size={15} aria-hidden="true" className="shrink-0" />}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}
