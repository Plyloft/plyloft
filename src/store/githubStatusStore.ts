import { create } from "zustand";
import { setupGithubStatus, type GithubStatus } from "../ipc";

/**
 * OB-7a — what Setup's GitHub step last read (`setup_github_status`): gh's
 * accounts (all of them), git's credential helper for github.com, and — for
 * the step itself — GitHub's address for the identity back-fill and a single
 * sign-on refusal. Setup reads it when it opens (step 5's state in the list)
 * and the step again when it shows and after each of its runs.
 * Session-only; a token is never part of it (Rust keeps none).
 */
interface GithubStatusState {
  status: GithubStatus | null;
  reading: boolean;
  /** `details`: also GitHub's address (one `gh api user`). */
  refresh: (details?: boolean) => Promise<void>;
}

/** The read in flight. A plain read asked while a detailed one is out
 *  shares it (a plain one must never replace the step's answer); otherwise
 *  the newest read wins — a read after a sign-in must not reuse one that
 *  started before it. */
let inFlight: { details: boolean; promise: Promise<void> } | null = null;
let latest = 0;

export const useGithubStatus = create<GithubStatusState>((set, get) => ({
  status: null,
  reading: false,
  refresh: (details = false) => {
    if (inFlight?.details && !details) return inFlight.promise;
    const mine = ++latest;
    set({ reading: true });
    const entry: { details: boolean; promise: Promise<void> } = { details, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        const next = await setupGithubStatus(details);
        if (mine !== latest) return;
        const prev = get().status;
        // A plain read keeps what the last detailed one learned.
        const status =
          details || !prev
            ? next
            : { ...next, githubEmail: prev.githubEmail, githubNoreply: prev.githubNoreply, sso: prev.sso };
        set({ status, reading: false });
      } catch {
        // Unknown, not "signed out": the step says it couldn't tell.
        if (mine === latest) set({ reading: false });
      } finally {
        if (inFlight === entry) inFlight = null;
      }
    })();
    inFlight = entry;
    return entry.promise;
  },
}));

/** Tests: forget a read left in flight by the previous test. */
export function resetGithubStatusForTests(): void {
  inFlight = null;
  latest = 0;
}
