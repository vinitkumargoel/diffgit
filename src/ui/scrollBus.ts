/**
 * Tiny pub/sub between the sidebar and the diff pane (Plan §6.1: "click scrolls to file").
 * The sidebar publishes a file id; the mounted pane (T5.3) scrolls its card into view. Kept out
 * of the store because a scroll request is an event, not state.
 *
 * T11.9 adds an optional new-side line number: a secret finding jumps to the card *and* to the
 * flagged line inside it. The card that has to answer it is usually not mounted yet (the pane is
 * virtualised), so the line is also parked in `pending` and claimed by that card when it mounts.
 */
type Listener = (id: string, line?: number) => void;
const listeners = new Set<Listener>();
let pending: { id: string; line: number } | null = null;

export function requestScrollTo(id: string, line?: number): void {
  pending = line === undefined ? null : { id, line };
  for (const l of listeners) l(id, line);
}

export function onScrollRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The line a not-yet-mounted card was asked to reveal, consumed once. Returns null for every other
 * card, so a stale request can never pull a second card's focus.
 */
export function takePendingLine(id: string): number | null {
  if (pending === null || pending.id !== id) return null;
  const { line } = pending;
  pending = null;
  return line;
}
