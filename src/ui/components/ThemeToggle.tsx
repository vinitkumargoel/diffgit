import { Moon, Sun, SunMoon } from "lucide-react";
import { useStore } from "../store";

const ORDER = ["system", "light", "dark"] as const;
type Theme = (typeof ORDER)[number];

/** system → light → dark → system (T5.6 amendment). */
export function nextTheme(theme: Theme): Theme {
  const i = ORDER.indexOf(theme);
  return ORDER[(i + 1) % ORDER.length] ?? "system";
}

const ICON = { system: SunMoon, light: Sun, dark: Moon } as const;

/** 28 × 28 icon button (Design §7.1 item 8) cycling the persisted `prefs.theme`. */
export function ThemeToggle() {
  const theme = useStore((s) => s.prefs.theme);
  const setPref = useStore((s) => s.setPref);
  const next = nextTheme(theme);
  const Icon = ICON[theme];
  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label={`Switch to ${next} theme`}
      title={`Theme: ${theme}. Click to switch to ${next}.`}
      data-theme={theme}
      onClick={() => setPref("theme", next)}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}
