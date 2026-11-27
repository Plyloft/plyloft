// N14 walk F16: what a GitHub read's raw errors come down to, in one place.
//
// The backend joins every error of a read (a team refresh: the pull, the
// login, the repo access) into one string of the tools' own words. Two
// causes are worth one plain sentence and one way out instead:
//
// - **gh-signed-out** — the GitHub CLI has no signed-in account (or its
//   token is no longer valid): every gh call ends in gh's "To get started
//   with GitHub CLI, please run: gh auth login" or "not logged into any
//   GitHub hosts". The way out is Setup › GitHub for pull requests.
// - **the team's (or a workspace's) account isn't signed in** — Plyloft's
//   own words from `github_account::team_words` / `resolve` ("Your team uses
//   the GitHub account X, which isn't signed in on this PC. …"), which the
//   account scope says for *every* gh and git call of the read, so the same
//   sentence arrives once per error (F16b). Still kind gh-signed-out, with
//   `account` named in the line; "…, and the GitHub CLI isn't installed" is
//   gh-missing.
// - **git-sign-in** — Git couldn't sign in to GitHub (its credential helper,
//   GCM on Windows, couldn't answer without asking): `platform::GIT_AUTH_WORDS`
//   / `GIT_SSH_AUTH_WORDS`, kept as they are (they already say what to do).
//
// gh signed out outranks the git case: with no gh account the git helper
// that asks gh fails too, and signing gh in is the fix for both.
//
// F16c (Windows VM, 2026-10-05): gh's config can still name an account
// whose token gh can't read (the keychain/Credential Manager entry is gone).
// gh then passes its "are you signed in" check, sends GitHub a request with
// no token, and GitHub answers "Requires authentication (HTTP 401)" — no
// "gh auth login" in sight — while git, whose helper gets nothing either,
// fails with "could not read Username … terminal prompts disabled"
// (`GIT_AUTH_WORDS`). That is gh signed out too. When the caller knows the
// account the read runs as (`settings.team.account`), the line names it:
// "The GitHub account X isn't signed in on this Mac, …" — for gh's
// "gh auth login" and "Requires authentication"; a sign-in GitHub refuses
// ("Bad credentials (HTTP 401)") stays gh-expired, its line naming the
// account ("The GitHub account X's sign-in … has expired or was revoked").
// Git's words alone, with no gh trouble in the same read, stay the
// git-sign-in case (gh signed in, GCM couldn't answer: F16's words). Git
// over SSH (`GIT_SSH_AUTH_WORDS`) is never folded into gh's line: signing gh
// in doesn't fix an SSH key, so it stays its own line.
//
// The raw text always stays reachable (the caller's "Show details").
// Pure, so every case is tested:
//
//     node --experimental-strip-types src/lib/ghTrouble.test.ts

/** `sharedLibrary.GIT_SIGN_IN_MARKER` (kept here too so this file stays
 *  free of imports): `platform::GIT_AUTH_WORDS` begins with it. */
const GIT_SIGN_IN_MARKER = "Git couldn't sign in to GitHub";

export type GhTroubleKind = "gh-signed-out" | "gh-expired" | "gh-missing" | "git-sign-in";

export type GhTrouble = {
  kind: GhTroubleKind;
  /** The one plain line ("this Mac"; `StatusLine` / `machineWords` turn it
   *  into "this PC" on Windows). */
  line: string;
  /** The one way out — Setup › GitHub for pull requests — or null when the
   *  fix isn't there (git over SSH: the SSH key). */
  action: string | null;
  /** The GitHub account the trouble is about: the one Plyloft's account
   *  words named, or (F16c) the account the caller said the read runs as
   *  (`GhTroubleContext.account`) when gh's own words say it has no usable
   *  sign-in. Null when no account is known. "Sign in to GitHub" passes it
   *  to Setup › GitHub, which asks to sign in as it. */
  account: string | null;
  /** The tools' own words, for Details. */
  raw: string;
  /** What Details shows: `raw` one error per line, an identical error
   *  once, and a reason every error repeats said once above the errors it
   *  ended (F16b). */
  details: string[];
  /** The read's other errors, which this trouble doesn't explain (a 404, a
   *  timeout): still shown as they are, never folded into the line. */
  others: string[];
};

/** The action that opens Setup › GitHub for pull requests to sign gh in. */
export const GH_SIGN_IN_ACTION = "Sign in to GitHub";
/** The action that opens Setup › GitHub for "Git uses your GitHub sign-in". */
export const GIT_SIGN_IN_ACTION = "Open GitHub setup";
/** The disclosure holding the raw messages. */
export const GH_TROUBLE_DETAILS = "Show details";

/** gh's own words for "no account" / "token no longer valid". */
const GH_SIGNED_OUT = /\bgh auth login\b|not logged in(?:to| to) any|you are not logged in/i;
/** F16c: GitHub's answer to a gh request sent with no token — gh's config
 *  names an account it has no readable token for (`gh api`: "gh: Requires
 *  authentication (HTTP 401)"; `gh auth status`: "HTTP 401: Requires
 *  authentication"). GitHub's exact words, so git's "Authentication
 *  required" never matches. */
const GH_NO_TOKEN = /Requires authentication \(HTTP 401\)|HTTP 401: Requires authentication/;
/** F16c: GitHub refused the token gh sent (`gh api`'s "gh: Bad credentials
 *  (HTTP 401)", with or without gh's "gh auth login" hint). */
const GH_REFUSED = /Bad credentials \(HTTP 401\)|HTTP 401: Bad credentials/;
/** gh had an account but GitHub refuses its token (expired or revoked). */
const GH_EXPIRED = /HTTP 401|Bad credentials|token in [^\n]* is invalid|token [^\n]*(?:expired|revoked)/i;
/** F16c: git's own words for "nobody answered my sign-in question" (the
 *  backend usually turns them into `GIT_AUTH_WORDS` first). */
const GIT_PROMPT_REFUSED =
  /could not read (?:Username|Password) for '[^']*github\.com[^']*'|terminal prompts disabled|cannot prompt because user interactivity has been disabled/i;

/** `GIT_SSH_AUTH_WORDS`' start: git over SSH, which gh's sign-in can't fix. */
const GIT_SSH_MARKER = "Git couldn't sign in to GitHub over SSH";

/** An error git's HTTPS sign-in ended — ours (`GIT_AUTH_WORDS`) or git's own
 *  — which signing gh in fixes. Never git over SSH. */
function isGitSignIn(error: string): boolean {
  if (error.includes(GIT_SSH_MARKER)) return false;
  return error.includes(GIT_SIGN_IN_MARKER) || GIT_PROMPT_REFUSED.test(error);
}

/** The caller's knowledge of the read (F16c). */
export type GhTroubleContext = {
  /** The GitHub account the read runs as when the caller knows it
   *  (`settings.team.account`): gh's sign-in trouble then names it. */
  account?: string | null;
};

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Plyloft's words for "the account the team/workspace uses isn't signed
 *  in" (`github_account::team_words`, `resolve`): the sentence and the one
 *  after it (where to fix it). Machine words are any of ours. */
const ACCOUNT_SIGNED_OUT =
  /(?:Your team|This workspace) uses the GitHub account ([A-Za-z0-9-]+), which isn't signed in on (?:this|your) (?:Mac|PC|computer|machine)\.(?: (?!Could not )[^.]*\.)?/;
/** …and "the GitHub CLI isn't installed" with an account named. */
const ACCOUNT_GH_MISSING =
  /(?:Your team|This workspace) uses the GitHub account ([A-Za-z0-9-]+), and the GitHub CLI isn't installed\.(?: (?!Could not )[^.]*\.)?/;

/** gh has no usable signed-in account, by its own words. */
export function isGhSignedOut(raw: string): boolean {
  return GH_SIGNED_OUT.test(raw) || GH_NO_TOKEN.test(raw) || GH_REFUSED.test(raw);
}

/** A gh error that says GitHub refused the token gh *sent* (expired or
 *  revoked) — not "no token was sent" (F16c's `Requires authentication`). */
function isGhExpired(error: string): boolean {
  return !GH_NO_TOKEN.test(error) && GH_EXPIRED.test(error);
}

/**
 * The line for gh signed out. `what` finishes "so Plyloft can't …"
 * ("read the team"); the sentence stands on its own without it.
 */
export function ghSignedOutLine(what?: string): string {
  return what
    ? `The GitHub command isn't signed in on this Mac, so Plyloft can't ${what}.`
    : "The GitHub command isn't signed in on this Mac.";
}

/** The line for the team's (workspace's) account not signed in. */
export function accountSignedOutLine(account: string, what?: string): string {
  return what
    ? `The GitHub account ${account} isn't signed in on this Mac, so Plyloft can't ${what}.`
    : `The GitHub account ${account} isn't signed in on this Mac.`;
}

/** F16c: the line for the account's sign-in that GitHub refuses. */
export function accountExpiredLine(account: string, what?: string): string {
  return what
    ? `The GitHub account ${account}'s sign-in on this Mac has expired or was revoked, so Plyloft can't ${what}.`
    : `The GitHub account ${account}'s sign-in on this Mac has expired or was revoked.`;
}

/** The line for gh not installed while an account is chosen. */
export function ghMissingLine(what?: string): string {
  return what
    ? `The GitHub command isn't installed on this Mac, so Plyloft can't ${what}.`
    : "The GitHub command isn't installed on this Mac.";
}

/** The line for a gh sign-in GitHub no longer accepts. */
export function ghExpiredLine(what?: string): string {
  return what
    ? `The GitHub command's sign-in on this Mac has expired or was revoked, so Plyloft can't ${what}.`
    : "The GitHub command's sign-in on this Mac has expired or was revoked.";
}

/** The read's errors one by one: the backend joins them with a space, each
 *  starting "Could not …". A string with no such start is one error. */
export function splitErrors(raw: string): string[] {
  return raw
    .split(/\s+(?=Could not )/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * Details' lines: each error once; when `reason` (a sentence every error
 * ended with) is given, it is said once and each error keeps only its own
 * start ("Could not pull the team repo (git fetch)").
 */
export function detailLines(raw: string, reason?: string | null): string[] {
  const parts = [...new Set(splitErrors(raw))];
  if (!reason) return parts;
  const heads: string[] = [];
  const rest: string[] = [];
  for (const part of parts) {
    const at = part.indexOf(reason);
    if (at < 0) {
      rest.push(part);
      continue;
    }
    // "Could not pull the team repo: git fetch: " → "… repo (git fetch)".
    const [head, ...via] = part
      .slice(0, at)
      .split(/:\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (head) heads.push(via.length ? `${head} (${via.join(": ")})` : head);
  }
  if (heads.length === 0) return parts;
  return [reason, ...[...new Set(heads)].map((h) => `  ${h}`), ...rest];
}

/** The `GIT_AUTH_WORDS` sentence(s) inside a joined error string. */
function gitSignInWords(raw: string): string | null {
  const at = raw.indexOf(GIT_SIGN_IN_MARKER);
  if (at < 0) return null;
  const rest = raw.slice(at);
  // HTTPS: "Git couldn't sign in to GitHub. In Setup › GitHub, turn on "…", then try again."
  // Walk follow-ups 2026-10-19: or `GIT_AUTH_GH_SIGNED_OUT_WORDS` ("… to
  // GitHub because the GitHub command isn't signed in on …").
  const https = rest.match(/^Git couldn't sign in to GitHub(?:\.| because )[^]*?then try again\./);
  if (https) return https[0];
  // SSH (or anything else after the marker): its first sentence and the next.
  const two = rest.match(/^[^.]*\.(?:\s[^.]*\.)?/);
  return two ? two[0] : rest;
}

/**
 * What `raw` (a read's joined errors) comes down to, or null when it is
 * neither case (the caller shows it as it is). `what` finishes the
 * signed-out line ("read the team").
 */
export function ghTrouble(
  raw: string | null | undefined,
  what?: string,
  context: GhTroubleContext = {},
): GhTrouble | null {
  if (!raw || !raw.trim()) return null;
  const parts = splitErrors(raw);
  const known = context.account?.trim() ?? "";
  const account = LOGIN.test(known) ? known : null;
  // Plyloft's account words first: they name the account, and with the
  // account unusable every gh and git call of the read ends in them.
  for (const [words, kind] of [
    [ACCOUNT_SIGNED_OUT, "gh-signed-out"],
    [ACCOUNT_GH_MISSING, "gh-missing"],
  ] as const) {
    const said = raw.match(words);
    if (!said) continue;
    const reason = said[0];
    const account = said[1];
    const others = [...new Set(parts)].filter(
      (e) => !words.test(e) && !isGhSignedOut(e) && !isGitSignIn(e),
    );
    return {
      kind,
      line: kind === "gh-missing" ? ghMissingLine(what) : accountSignedOutLine(account, what),
      action: kind === "gh-missing" ? GIT_SIGN_IN_ACTION : GH_SIGN_IN_ACTION,
      account,
      raw,
      details: detailLines(raw, reason),
      others,
    };
  }
  if (isGhSignedOut(raw)) {
    // Errors the missing sign-in explains: gh's own, and git's that asked gh
    // (or asked a helper that had nothing either). Each distinct one once.
    const others = [...new Set(parts)].filter((e) => !isGhSignedOut(e) && !isGitSignIn(e));
    const expired = parts.some((e) => isGhSignedOut(e) && isGhExpired(e));
    // F16c: the account the read runs as is known — the line names it
    // (signed out: no account or no readable token; expired: refused).
    const line = account
      ? expired
        ? accountExpiredLine(account, what)
        : accountSignedOutLine(account, what)
      : expired
        ? ghExpiredLine(what)
        : ghSignedOutLine(what);
    return {
      kind: expired ? "gh-expired" : "gh-signed-out",
      line,
      action: GH_SIGN_IN_ACTION,
      account,
      raw,
      details: detailLines(raw),
      others,
    };
  }
  const git = gitSignInWords(raw);
  if (git) {
    const viaSetup = /Git uses your GitHub sign-in/.test(git);
    // Walk follow-ups 2026-10-19 (Challenger): the backend's words for gh
    // itself signed out advise gh's sign-in — the way out is that one.
    const viaSignIn = /sign in to GitHub, then try again/.test(git);
    // Every git sign-in error of the read is the line's (SSH included).
    const others = [...new Set(parts)].filter(
      (e) => !e.includes(GIT_SIGN_IN_MARKER) && !GIT_PROMPT_REFUSED.test(e),
    );
    return {
      kind: "git-sign-in",
      line: git,
      action: viaSignIn ? GH_SIGN_IN_ACTION : viaSetup ? GIT_SIGN_IN_ACTION : null,
      account: null,
      raw,
      details: detailLines(raw),
      others,
    };
  }
  return null;
}
