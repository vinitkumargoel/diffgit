/**
 * Tiny pub/sub between the sidebar and the diff pane (Plan §6.1: "click scrolls to file").
 * The sidebar publishes a file id; the mounted pane (T5.3) scrolls its card into view. Kept out
 * of the store because a scroll request is an event, not state.
 */
type Listener = (id: string) => void;
const listeners = new Set<Listener>();

export function requestScrollTo(id: string): void {
  for (const l of listeners) l(id);
}

export function onScrollRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
