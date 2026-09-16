import { useStore } from "../store";

/** Design §9: polite live region announcing "Diff updated: n files" after each recompute. */
export function LiveRegion() {
  const announcement = useStore((s) => s.announcement);
  return (
    <output aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </output>
  );
}
