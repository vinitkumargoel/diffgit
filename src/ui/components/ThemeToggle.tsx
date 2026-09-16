import { Moon, Sun } from "lucide-react";
import { useStore } from "../store";
import { isDark } from "../theme";

/** 28 × 28 icon button (Design §7.1 item 8): sun in dark mode, moon in light mode. T5.6 adds "system". */
export function ThemeToggle() {
  const theme = useStore((s) => s.prefs.theme);
  const setPref = useStore((s) => s.setPref);
  // `theme` is read so the button re-renders after a preference change; the DOM class is the truth.
  const dark = theme === "dark" || (theme !== "light" && isDark());
  const next = dark ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setPref("theme", next)}
    >
      {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
    </button>
  );
}
