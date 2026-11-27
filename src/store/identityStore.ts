import { create } from "zustand";
import { githubCurrentLogin, identityGet } from "../ipc";

/** v1.49.0 (Team Mode Phase 0): the cached identity email surfaced to the
 *  React tree. The backend already stamps every shared-library write with
 *  `settings.identity.user_email` (Settings.identity backfilled at startup
 *  from `git config --global user.email`), so this store is purely for
 *  *display* and *guard* purposes — e.g. a future PR-claim check that
 *  needs to compare the current user against a GitHub Issue assignee,
 *  or a "Logged in as X" line in Settings.
 *
 *  Loaded once at app boot via `useIdentity.getState().load()`; cached
 *  forever in memory. Refetching is intentionally not exposed — if the
 *  user changes their git config mid-session they can restart Ply.
 *  This matches the backend's "fetch once, never re-probe" contract.
 */
interface IdentityState {
  /** `null` until `load()` resolves; `null` thereafter if git missing
   *  or no global email configured. */
  email: string | null;
  loaded: boolean;
  loadInFlight: boolean;
  load: () => Promise<void>;
  /** GH #66: this Mac's GitHub login, for the claim chip ("Yours" vs
   *  "Claimed by X"). null until loaded, or when `gh` can't say. Unlike the
   *  email it can change mid-session (`gh auth switch`), so it is re-read
   *  when older than a minute (matching the backend's own cache), and on
   *  `force` (Sync), which also bypasses the backend's cache. */
  githubLogin: string | null;
  githubLoginAt: number;
  loadGithubLogin: (force?: boolean) => Promise<string | null>;
}

const GITHUB_LOGIN_TTL_MS = 60_000;
let githubLoginInFlight: Promise<string | null> | null = null;

export const useIdentity = create<IdentityState>((set, get) => ({
  githubLogin: null,
  githubLoginAt: 0,
  loadGithubLogin: (force = false) => {
    const s = get();
    const fresh = Date.now() - s.githubLoginAt < GITHUB_LOGIN_TTL_MS;
    if (!force && s.githubLoginAt > 0 && fresh) {
      return Promise.resolve(s.githubLogin);
    }
    // A forced read never settles for a cached answer already on its way.
    if (githubLoginInFlight && !force) return githubLoginInFlight;
    const read = githubCurrentLogin(force)
      .catch((e) => {
        console.warn("identity: GitHub login failed", e);
        return null;
      })
      .then((login) => {
        // An older read finishing late must not overwrite a newer one.
        if (githubLoginInFlight === read) {
          set({ githubLogin: login ?? null, githubLoginAt: Date.now() });
        }
        return login ?? null;
      })
      .finally(() => {
        if (githubLoginInFlight === read) githubLoginInFlight = null;
      });
    githubLoginInFlight = read;
    return read;
  },
  email: null,
  loaded: false,
  loadInFlight: false,
  load: async () => {
    const s = get();
    if (s.loaded || s.loadInFlight) return;
    set({ loadInFlight: true });
    try {
      const email = await identityGet();
      set({ email: email ?? null, loaded: true, loadInFlight: false });
    } catch (e) {
      // Best-effort. A failed identity load shouldn't block the rest of
      // the app; subsequent retries are not attempted (see contract).
      console.warn("identity: load failed", e);
      set({ loaded: true, loadInFlight: false });
    }
  },
}));
