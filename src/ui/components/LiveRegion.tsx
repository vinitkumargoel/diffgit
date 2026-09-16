import { useStore } from "../store";

/** Design §9: polite live region announcing "Diff updated: n files" after each recompute. */
export function LiveRegion() {
  const announcement = useStore((s) => s.announcement);
  const seq = useStore((s) => s.announcementSeq);
  // `key` swaps the text node on every announcement, so two identical "Diff updated: 3 files"
  // messages in a row are both spoken (T7.5 review).
  return (
    <output aria-live="polite" aria-atomic="true" className="sr-only">
      <span key={seq}>{announcement}</span>
    </output>
  );
}
