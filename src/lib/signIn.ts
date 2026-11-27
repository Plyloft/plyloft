// Launch A2 (LAUNCH_PLAN §2 D1, D2; §3.1): the words and the state of
// "Sign in to Plyloft" — Setup's optional step 2, the Plan page's account row,
// Create team's `sign_in` stage and the joined team's notice draw the same
// view (1.178.0 A3: there is no full-window Sign-in screen any more; signed
// out is an ordinary state of the app). Pure: built from the account store's
// state (`accountStore.ts`, mirroring `account.rs`), so every state is
// testable without a backend.
//
// A Plyloft account is a GitHub sign-in used for identity only. It is not
// the GitHub CLI (`gh`) that Setup's later step connects for pull requests;
// the words keep the two apart ("Plyloft account" vs "GitHub for pull
// requests").
import type { AccountError, AccountInfo, AccountPlan, SignInProgress, SignInStart } from "../ipc";

export const SIGNIN_TITLE = "Sign in to Plyloft";
/** The step's name in Setup's list. */
export const ACCOUNT_STEP_TITLE = "Plyloft account";

/** What the account is, in plain words (1.178.0 A3: only for teams). */
export const SIGNIN_ABOUT =
  "Sign in to Plyloft with GitHub to start or join a team. This sign-in identifies your GitHub account and grants no access to your repositories.";

/** 1.178.0 A3: Setup step 2's lede — the step is optional. */
export const SIGNIN_SETUP_LEDE =
  "Only for teams. Skip this if you work alone; you can sign in later in Settings › Setup and account › Plan.";

/** Setup only (A3 D1): this is not the next step's GitHub sign-in. Through
 *  `machineWords` ("this PC" on Windows). */
export const SIGNIN_NOT_GH =
  "This is separate from GitHub for your projects, the next step, which lets this Mac open pull requests. That one is for everyone who ships to GitHub, alone or in a team.";

/** D2: no GitHub account yet. */
export const NO_GITHUB_ACTION = "No GitHub account? Create one";
export const NO_GITHUB_NOTE =
  "GitHub's sign-up page is open in your browser. Create your account there, then come back here and choose Sign in with GitHub.";

/** Where the code is typed, as the button and the text say it. */
export const DEVICE_PAGE = "github.com/login/device";
export const OPEN_DEVICE_PAGE = `Open ${DEVICE_PAGE}`;

/** Debug builds run with the sign-in skip (account.rs). The variable is not
 *  named here: a release binary must never contain it
 *  (scripts/app-tester/check-no-release.sh). */
export const DEV_SKIP_NOTE = "Sign-in is skipped in this development build. Plans read as Free.";

/** Only Team is a paid plan; an entitlement that still says `pro` reads as Free. */
export function planWord(plan: AccountPlan): string {
  switch (plan) {
    case "team":
      return "Team";
    default:
      return "Free";
  }
}

/** "Signed in as octocat · Free". */
export function signedInLine(info: Pick<AccountInfo, "login" | "plan">): string {
  return `Signed in as ${info.login ?? "you"} · ${planWord(info.plan)}`;
}

/** What the account store holds that the view reads. */
export interface SignInInput {
  info: AccountInfo | null;
  signIn: SignInStart | null;
  progress: SignInProgress | null;
  error: AccountError | null;
  /** `account_sign_in_start` is out (no code yet). */
  starting: boolean;
  /** `account_refresh` is out (no view of its own since QoL 1.168: a
   *  signed-in account is done). */
  checking?: boolean;
}

/** The one action the view offers; the caller turns it into a button.
 *  (1.178.0 A3 D5: "Sign in and sign out the other computers" is gone.) */
export type SignInAction = "start" | "refresh";

export interface SignInView {
  /** The step's headline ("Sign in to Plyloft"). */
  headline: string;
  /** What the account is (`SIGNIN_ABOUT`). Setup's step draws it as its
   *  first paragraph under its own lede (`SIGNIN_SETUP_LEDE`). */
  lede: string;
  /** A signed-in account whose entitlement is valid. */
  done: boolean;
  /** The code to type, while a sign-in waits for it. */
  code: string | null;
  /** The status line: what is happening, or what went wrong. */
  status: { tone: "running" | "done" | "aborted" | "empty"; text: string } | null;
  /** The sign-in's own action ("Sign in with GitHub", "Try again", "Get a
   *  new code"), or null while there is nothing to press. 1.178.0 A3: drawn
   *  as a bordered button in the body (`SignInBody`), never a frame's filled
   *  primary — signing in is optional. */
  primary: { label: string; action: SignInAction; disabled?: boolean } | null;
  /** A second, quiet action. None since 1.178.0 (A3 D5); kept in the shape. */
  secondary: { label: string; action: SignInAction } | null;
  /** Cancel is offered (a sign-in is under way). */
  cancel: boolean;
  /** D2's "No GitHub account? Create one" is offered. */
  noGithub: boolean;
}

/** A failed sign-in, in words, with its way out. */
function failure(error: AccountError): { text: string; primary: { label: string; action: SignInAction } } {
  switch (error.code) {
    case "expired_token":
      return {
        text: "The code expired before it was entered on GitHub.",
        primary: { label: "Get a new code", action: "start" },
      };
    case "access_denied":
      return {
        text: "The sign-in was turned down on GitHub. Nothing was shared with Plyloft.",
        primary: { label: "Try again", action: "start" },
      };
    case "network":
      return {
        // 1.178.0 A3 D4: one sentence; nothing needs the network signed out.
        text: "Plyloft couldn't reach GitHub or the Plyloft server. Check your connection and try again.",
        primary: { label: "Try again", action: "start" },
      };
    case "not_configured":
      return {
        text: "Sign-in isn't set up in this copy of Plyloft yet, so it can't sign you in. An update to Plyloft turns it on.",
        primary: { label: "Try again", action: "start" },
      };
    case "rate_limited":
      return {
        text: "GitHub or the Plyloft server asked to slow down. Wait a minute, then try again.",
        primary: { label: "Try again", action: "start" },
      };
    case "keychain":
      return {
        text: "Plyloft couldn't save your sign-in in this computer's keychain. Try again; if it keeps failing, Diagnostics in Settings says more.",
        primary: { label: "Try again", action: "start" },
      };
    default:
      return {
        text: error.message?.trim() || "Plyloft couldn't sign you in.",
        primary: { label: "Try again", action: "start" },
      };
  }
}

/** 1.175.0 (E-app, contract §6b): the computer that took the plan, as the
 *  sentences name it. From 1.175.0 the server gives a generic label
 *  ("MacBook Pro", "Windows PC"), which read alone as if it were a name —
 *  or this computer, when both are the same model. "another computer
 *  (MacBook Pro)"; "another computer" when the server couldn't name it; a
 *  name kept from before 1.175.0 reads the same way. */
export function otherComputer(name: string): string {
  const n = name.trim();
  if (!n || n.toLowerCase() === "another device") return "another computer";
  if (n.toLowerCase().startsWith("another computer")) return n;
  return `another computer (${n})`;
}

/**
 * The view for the store's state. Order: a code waiting → the code and its
 * progress; signed in → done (QoL 1.168: an unverified plan is Free, not a
 * sign-in); a code being asked for → that; a failure → its words and way
 * out; otherwise the start. (1.178.0 A3 D5: no "Your plan moved to …" — a
 * sign-in elsewhere signs nobody out.)
 */
export function signInView(input: SignInInput): SignInView {
  const { info, signIn, progress, error, starting } = input;
  const base: SignInView = {
    headline: SIGNIN_TITLE,
    lede: SIGNIN_ABOUT,
    done: false,
    code: null,
    status: null,
    primary: { label: "Sign in with GitHub", action: "start" },
    secondary: null,
    cancel: false,
    noGithub: true,
  };
  // A code waiting comes first.
  if (signIn) {
    let text = "Waiting for you to enter the code on GitHub.";
    if (progress?.state === "slow_down") text = "GitHub asked Plyloft to check less often. Still waiting for the code.";
    if (progress?.state === "verifying") text = "GitHub said yes. Plyloft is checking your account…";
    return {
      ...base,
      code: signIn.userCode,
      status: { tone: "running", text },
      primary: null,
      secondary: null,
      cancel: true,
      noGithub: false,
    };
  }

  // QoL 1.168 (owner D1, D2): a signed-in account is all sign-in asks for.
  // A plan that can't be verified, or Team on another computer, reads as
  // Free and is said in Settings › Plan (and, for Team, the sidebar).
  if (info?.signedIn) {
    return {
      ...base,
      headline: SIGNIN_TITLE,
      lede: SIGNIN_ABOUT,
      done: true,
      status: { tone: "done", text: signedInLine(info) },
      primary: null,
      noGithub: false,
    };
  }

  if (starting) {
    return {
      ...base,
      status: { tone: "running", text: "Asking GitHub for a code…" },
      primary: { ...base.primary!, disabled: true },
      secondary: null,
    };
  }

  if (error && error.code !== "cancelled") {
    const f = failure(error);
    return { ...base, status: { tone: "aborted", text: f.text }, primary: f.primary };
  }

  return base;
}
