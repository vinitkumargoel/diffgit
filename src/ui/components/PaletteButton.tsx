import { Command as CommandGlyph } from "lucide-react";
import { useStore } from "../store";
import { PALETTE_TRIGGER_CLASS } from "./palette.styles";

/** The trigger button, so Escape can hand focus back to it wherever the palette was opened from. */
export let paletteTrigger: HTMLButtonElement | null = null;

export function setPaletteTrigger(el: HTMLButtonElement | null): void {
  paletteTrigger = el;
}

/** The `lucide:command` trigger that sits before the theme toggle (Design §14.1). */
export function PaletteButton() {
  const setPalette = useStore((s) => s.setPalette);
  const open = useStore((s) => s.palette);
  return (
    <button
      ref={(el) => {
        paletteTrigger = el;
      }}
      type="button"
      className={PALETTE_TRIGGER_CLASS}
      aria-label="Command palette"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Command palette (⌘K)"
      onClick={() => setPalette(true)}
    >
      <CommandGlyph size={16} aria-hidden />
    </button>
  );
}
