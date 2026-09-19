/**
 * Home history state (mockup §s1 H1–H5): the stored repositories, the browser's answer to
 * `queryPermission()` per row (the access dot), and the inline outcome of a click (H4).
 *
 * Every outcome stays on the row: opening asks for permission inside the click, and a failed open
 * comes back from the store as a `recentNotice` after `closeRepo()`, which a freshly mounted
 * HomeScreen picks up here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensurePermission,
  listRepos,
  type PermissionAnswer,
  queryPermission,
  removeRepo,
  type StoredRepo,
} from "../../persistence";
import { type RecentNotice, useStore } from "../../store";

/** What a row is showing right now. Only one row is ever "opening". */
export type RowState = "idle" | "opening" | "denied" | "gone" | "notrepo" | "forgotten";

/** Forget is undoable for 5 s (H4), so the delete is deferred rather than confirmed. */
export const UNDO_MS = 5_000;

export interface Recents {
  repos: StoredRepo[];
  /** True once `listRepos()` has answered; the facts table stays up until then (H0). */
  loaded: boolean;
  access: Record<string, PermissionAnswer>;
  state: Record<string, RowState>;
  open(repo: StoredRepo): void;
  /**
   * T11.11: asks the browser for read access **without** opening the repository, so a card whose
   * handle is still on `prompt` can be summarised. Must stay inside the click — `requestPermission`
   * is gated on user activation, which is the whole reason the dashboard never prompts on load.
   */
  grant(repo: StoredRepo): void;
  forget(repo: StoredRepo): void;
  undo(repo: StoredRepo): void;
  clearAll(): void;
  /** Drops an inline message without opening (used by "Forget"/"Choose another" siblings). */
  dismiss(repo: StoredRepo): void;
}

function kindOf(code: RecentNotice["code"]): RowState {
  return code === "HANDLE_GONE" ? "gone" : code === "NOT_A_REPO" ? "notrepo" : "denied";
}

/** `queryPermission` must never break the list; an unanswerable handle reads as "will ask once". */
async function askAccess(handle: unknown): Promise<PermissionAnswer> {
  try {
    return await queryPermission(handle);
  } catch {
    return "prompt"; // the dot must not guess: opening the row is what really answers
  }
}

export function useRecents(): Recents {
  const [repos, setRepos] = useState<StoredRepo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [access, setAccess] = useState<Record<string, PermissionAnswer>>({});
  // Seeded from the store on mount: the row that sent us back here shows why (H4).
  const [state, setState] = useState<Record<string, RowState>>(() => {
    const notice = useStore.getState().recentNotice;
    return notice ? { [notice.repoId]: kindOf(notice.code) } : {};
  });
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    useStore.getState().setRecentNotice(null); // consumed above; it must not survive this visit
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listRepos();
      if (!alive) return;
      setRepos(list);
      setLoaded(true);
      const answers = await Promise.all(
        list.map(async (r) => [r.id, await askAccess(r.handle)] as const),
      );
      if (alive) setAccess(Object.fromEntries(answers));
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Leaving Home (or the tab) inside the undo window commits the pending forgets.
  const flush = useRef<Map<string, ReturnType<typeof setTimeout>>>(pending.current);
  useEffect(() => {
    const timers = flush.current;
    return () => {
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        void removeRepo(id);
      }
      timers.clear();
    };
  }, []);

  const mark = useCallback((id: string, next: RowState) => {
    setState((s) => ({ ...s, [id]: next }));
  }, []);

  const forget = useCallback(
    (repo: StoredRepo) => {
      if (pending.current.has(repo.id)) return;
      mark(repo.id, "forgotten");
      const timer = setTimeout(() => {
        pending.current.delete(repo.id);
        void removeRepo(repo.id).then(() => setRepos((rs) => rs.filter((r) => r.id !== repo.id)));
      }, UNDO_MS);
      pending.current.set(repo.id, timer);
    },
    [mark],
  );

  const undo = useCallback(
    (repo: StoredRepo) => {
      const timer = pending.current.get(repo.id);
      if (timer) clearTimeout(timer);
      pending.current.delete(repo.id);
      mark(repo.id, "idle");
    },
    [mark],
  );

  const clearAll = useCallback(() => {
    for (const repo of repos) forget(repo);
  }, [repos, forget]);

  const dismiss = useCallback((repo: StoredRepo) => mark(repo.id, "idle"), [mark]);

  const grant = useCallback((repo: StoredRepo) => {
    void (async () => {
      const answer = await ensurePermission(repo.handle);
      setAccess((a) => ({ ...a, [repo.id]: answer }));
      // A refused grant is the same inline message a refused open gets (H4); nothing else changes.
      setState((s) => ({ ...s, [repo.id]: answer === "denied" ? "denied" : "idle" }));
    })();
  }, []);

  const open = useCallback(
    (repo: StoredRepo) => {
      mark(repo.id, "opening");
      // T11.11: opening wins over the dashboard; the background sweep stops before the gesture.
      useStore.getState().cancelSummaries();
      void (async () => {
        // The gesture is still live here: requestPermission() has to run inside the click.
        const answer = await ensurePermission(repo.handle);
        setAccess((a) => ({ ...a, [repo.id]: answer }));
        if (answer === "denied") {
          mark(repo.id, "denied");
          return;
        }
        const store = useStore.getState();
        await store.openRepo(repo.handle, {
          id: repo.id,
          lastSource: repo.lastSource,
          lastTarget: repo.lastTarget,
          expectedMs: repo.lastOpenMs,
        });
        // Order of checks (H4): permission → handle → layout. The last two come back as an error
        // screen; turn it into a row message and return Home instead of leaving the list.
        const after = useStore.getState();
        const code = after.error?.code;
        if (after.screen === "error" && (code === "HANDLE_GONE" || code === "NOT_A_REPO")) {
          after.setRecentNotice({ repoId: repo.id, code });
          await after.closeRepo();
          return;
        }
        mark(repo.id, "idle");
      })();
    },
    [mark],
  );

  return { repos, loaded, access, state, open, grant, forget, undo, clearAll, dismiss };
}
