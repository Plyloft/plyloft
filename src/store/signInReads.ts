import { prReadSignedOutAgain, type GithubStatus } from "../ipc";
import { useGithubStatus } from "./githubStatusStore";
import { useUi } from "./uiStore";

/** The GitHub logins gh says are signed in. */
function signedIn(status: GithubStatus | null): Set<string> {
  return new Set((status?.accounts ?? []).filter((a) => a.state === "signed-in").map((a) => a.login));
}

/** 1.172.0 B2: a read of GitHub's accounts found a sign-in the one before
 *  it didn't have. The first read (no earlier one) is none. */
export function newSignIn(prev: GithubStatus | null, next: GithubStatus | null): boolean {
  if (!prev || !next) return false;
  const before = signedIn(prev);
  for (const login of signedIn(next)) if (!before.has(login)) return true;
  return false;
}

/**
 * 1.172.0 B2 (PLAN §12): a card's "Plyloft can't read GitHub: sign in
 * again" clears at once after the sign-in, not on the poller's next look
 * (its backoff after refused reads reaches 10 minutes): the cards that
 * asked for it are read again when a new sign-in is read, and when Settings
 * closes — the card's Sign in to GitHub opens it. Reads only those cards
 * (none, mostly), in the background.
 */
let started = false;

export function startSignInReads(): () => void {
  if (started) return () => {};
  started = true;
  const readAgain = () => {
    prReadSignedOutAgain().catch(() => {});
  };
  const unsubs = [
    useUi.subscribe((s, prev) => {
      if (prev.settingsOverlayOpen && !s.settingsOverlayOpen) readAgain();
    }),
    useGithubStatus.subscribe((s, prev) => {
      if (s.status !== prev.status && newSignIn(prev.status, s.status)) readAgain();
    }),
  ];
  return () => {
    started = false;
    for (const u of unsubs) u();
  };
}
