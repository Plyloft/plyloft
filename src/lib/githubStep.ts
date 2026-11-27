// OB-7a — Setup's GitHub step (ONBOARDING_SPEC §5 step 5; since 1.175.0 F1
// it is step 3, "GitHub for your projects", right after the Plyloft account):
// the words and states, pure, so every case is tested under node:
//
//     node --experimental-strip-types src/lib/githubStep.test.ts
//
// The step's component is `components/setup/GitHubStep.tsx`; its reads are
// Rust's `setup_github.rs` (accounts, git's credential helper, GitHub's
// address), its runs the allowlist's gh actions in the guided terminal.
import type { GcmSignIn, GithubAccount, GithubHelperState, GithubStatus, SetupOutcome, SetupRunActionId } from "../ipc.ts";
import type { UxError } from "./uxError.ts";
import type { SetupRunEvidence } from "./setupEvidence.ts";
import { causeWords } from "./aiTools.ts";

/** 1.175.0 F1: the step's name in Setup's list (`setupSteps.ts`). */
export const GITHUB_STEP_NAME = "GitHub for your projects";
/** F1: the step comes right after the Plyloft account. 1.178.0 (A3, D2): its
 *  title says what it is for, not that it is a second sign-in — the
 *  Plyloft account before it is optional, so for most it is the only one. */
export const GITHUB_TITLE = "Connect GitHub for your projects";
/** 1.171.0 A3 (FR-1): what skipping it means, said in the step's words
 *  and on its Skip for now (through `machineWords`). */
export const SKIP_GITHUB_CONSEQUENCE = "Ship it will keep your changes on this Mac.";
/** F1: through `machineWords` ("this PC" on Windows). 1.178.0 (A3, D3): it
 *  no longer names a first sign-in, which most people skip. */
export const GITHUB_WHY =
  "This lets this Mac send your work to GitHub: Ship it puts each finished card there as a pull request. It is not your Plyloft account. GitHub shows you a code. It takes about a minute.";
/** F1: under the three rows. */
export const SKIP_GITHUB_NOTE = "If you skip it, " + SKIP_GITHUB_CONSEQUENCE;

/** Team mode adds this to the body (§5 step 5). */
export const TEAM_NEEDS_GITHUB = "Your team needs GitHub.";
export const SIGNUP_NOTE = "Create your account in the browser, then come back and press Connect GitHub.";
/** What `Skip for now` says (solo). */
export const SKIP_SOLO = "Local only. You can connect GitHub any time in Settings › Setup and account › Setup.";
/** Team mode: `Skip for now` warns first (D14). */
export const SKIP_TEAM_SHEET = {
  title: "Skip GitHub for now?",
  lede: "Your team needs GitHub. The Team step waits until you connect it; you can go on with the other steps.",
  confirm: "Skip for now",
  cancel: "Cancel",
};

// ── The GitHub CLI row ─────────────────────────────────────────────────

/** What the row reads of the doctor's `gh` tool. */
export interface GhToolInput {
  id: string;
  found: boolean;
  version?: string | null;
  installCmd?: string;
  update?: { latest: string; detail: string; command: string } | null;
}

/** How `install.gh` installs it here (Rust picks the same way, §6). */
export type GhInstallVia = "brew" | "zip" | "winget";

export function ghInstallVia(installCmd: string | null | undefined, windows: boolean): GhInstallVia {
  if (windows) return "winget";
  return installCmd?.trim().startsWith("brew ") ? "brew" : "zip";
}

export interface GhRowView {
  state: "unknown" | "ready" | "missing";
  hint: string;
  /** The install command the consent sheet names under Details. */
  command: string | null;
  via: GhInstallVia;
  /** A newer version (D6): the quiet `Update`. */
  update: { detail: string; command: string } | null;
  /** 1.176.1 walk: missing while Program folders is set. */
  programFolders?: boolean;
}

export const GH_LABEL = "GitHub command";

export function ghRow(tool: GhToolInput | null, reported: boolean, windows: boolean, programFoldersSet = false): GhRowView {
  const via = ghInstallVia(tool?.installCmd, windows);
  if (!reported) return { state: "unknown", hint: "Looking…", command: null, via, update: null };
  if (!tool?.found && programFoldersSet) {
    // 1.176.1 walk: missing from the folders set, maybe installed: no
    // install command to offer.
    return { state: "missing", hint: "Not in your Program folders.", command: null, via, update: null, programFolders: true };
  }
  if (!tool?.found) {
    return { state: "missing", hint: "Not installed.", command: tool?.installCmd || null, via, update: null };
  }
  const v = tool.version?.match(/\d+(?:\.\d+)+/)?.[0];
  return {
    state: "ready",
    hint: v ? `Installed (gh ${v}).` : "Installed.",
    command: null,
    via,
    update: tool.update ? { detail: tool.update.detail, command: tool.update.command } : null,
  };
}

/** 1.176.4: under Connect GitHub, when the GitHub command is missing: what
 *  Connect GitHub downloads and from where (`ghInstallSheet`'s facts). Null
 *  when nothing is downloaded. Through `machineWords`. */
export function connectDownloadLine(missing: boolean, via: GhInstallVia): string | null {
  if (!missing) return null;
  switch (via) {
    case "brew":
      return "Connect GitHub installs the GitHub command with Homebrew, then opens github.com for you to sign in.";
    case "zip":
      return "Connect GitHub downloads the GitHub command from GitHub, checks it against GitHub's published checksum and puts it in ~/.local/bin, then opens github.com for you to sign in. No administrator needed.";
    case "winget":
      return "Connect GitHub installs the GitHub command with winget, Windows' package installer, for your account only, then opens github.com for you to sign in. No administrator needed.";
  }
}

/** The install consent sheet: Homebrew, GitHub's release zip (a Mac
 *  without Homebrew), or winget. */
export function ghInstallSheet(via: GhInstallVia): { title: string; lede: string; confirm: string } {
  const why = "The GitHub command is how Plyloft talks to GitHub.";
  switch (via) {
    case "brew":
      return { title: "Install the GitHub command?", lede: `${why} Plyloft installs it with Homebrew.`, confirm: "Install" };
    case "zip":
      return {
        title: "Install the GitHub command?",
        lede: `${why} Plyloft downloads it from GitHub, checks it against GitHub's published checksum and puts it in ~/.local/bin. No administrator needed.`,
        confirm: "Install",
      };
    case "winget":
      return {
        title: "Install the GitHub command?",
        lede: `${why} Plyloft installs it with winget, Windows' package installer, for your account only. No administrator needed.`,
        confirm: "Install",
      };
  }
}

export function ghUpdateSheet(detail: string): { title: string; lede: string; confirm: string } {
  return { title: "Update the GitHub command?", lede: `${detail} Plyloft runs its updater; nothing else changes.`, confirm: "Update" };
}

// ── The Account row ────────────────────────────────────────────────────

export const ACCOUNT_LABEL = "Account";

export type AccountRowState = "unknown" | "signed-in" | "signed-out" | "could-not-tell";

export interface AccountRowView {
  state: AccountRowState;
  hint: string;
  /** The sign-in action the row offers. */
  action: { id: "login.gh" | "add-account.gh"; label: string } | null;
}

const signedIn = (a: GithubAccount) => a.state === "signed-in";

/** gh's accounts, the active one first. */
function ordered(accounts: readonly GithubAccount[]): GithubAccount[] {
  return [...accounts].sort((a, b) => Number(b.active) - Number(a.active));
}

function accountName(a: GithubAccount, several: boolean): string {
  if (a.state === "refused") return `${a.login} (signed out)`;
  return several && a.active ? `${a.login} (active)` : a.login;
}

export function accountRow(status: GithubStatus | null): AccountRowView {
  if (!status) return { state: "unknown", hint: "Looking…", action: null };
  if (!status.ghFound) {
    return { state: "signed-out", hint: "Install the GitHub command first.", action: null };
  }
  const accounts = status.accounts;
  if (accounts === null) {
    return {
      state: "could-not-tell",
      hint: "Plyloft couldn't read the GitHub command's sign-in. Look again in a moment.",
      action: { id: "login.gh", label: "Sign in" },
    };
  }
  const list = ordered(accounts);
  const ok = list.filter(signedIn);
  if (ok.length > 0) {
    const hint =
      list.length === 1
        ? `Signed in as ${list[0].login}.`
        : `Signed in with ${list.length} accounts: ${list.map((a) => accountName(a, true)).join(", ")}.`;
    return { state: "signed-in", hint, action: { id: "add-account.gh", label: "Add another account" } };
  }
  if (list.some((a) => a.state === "unknown")) {
    return {
      state: "could-not-tell",
      hint: "Plyloft couldn't check your GitHub sign-in. GitHub may be unreachable; look again in a moment.",
      action: { id: "login.gh", label: "Sign in" },
    };
  }
  const refused = list.find((a) => a.state === "refused");
  return {
    state: "signed-out",
    hint: refused ? `GitHub no longer accepts the sign-in for ${refused.login}. Sign in again.` : "Not signed in.",
    action: { id: "login.gh", label: "Sign in" },
  };
}

/** N14 walk F16c: the account an opener asked to sign in (the team's, from
 *  Settings › Team's "Sign in to GitHub"), while gh hasn't a working sign-in
 *  for it: a note above the rows and the Account row's button "Sign in as X".
 *  Null once it is signed in, or when none was asked for. "this Mac" —
 *  the caller passes it through `machineWords`. */
export function expectedAccountView(
  status: GithubStatus | null,
  expected: string | null,
): { note: string; label: string } | null {
  const login = expected?.trim();
  if (!login) return null;
  // gh not installed (or not read yet): the row has no sign-in button.
  if (!status || !status.ghFound) return null;
  const want = login.toLowerCase();
  const mine = status.accounts?.find((a) => a.login.toLowerCase() === want) ?? null;
  if (mine && signedIn(mine)) return null;
  const label = `Sign in as ${login}`;
  const how = `Sign in as ${login}; in the browser, use that GitHub account.`;
  // `refused` too says "isn't signed in": gh's 401 can't tell a missing
  // token from a rejected one, and Settings › Team says "isn't signed in"
  // for the missing one (F16c walk). The Account row keeps its own hint.
  // Can't be told (gh's answer unread, GitHub unreachable): never claim
  // it isn't signed in.
  if (status.accounts === null || mine?.state === "unknown" || status.accounts.some((a) => a.state === "unknown")) {
    return { note: `Your team uses the GitHub account ${login}. ${how}`, label };
  }
  return {
    note: `Your team uses the GitHub account ${login}, which isn't signed in on this Mac. ${how}`,
    label,
  };
}

/** Step 5's own fact: at least one account signed in (§5 step 5 Success).
 *  Null while it can't be told. */
export function githubConnected(status: GithubStatus | null): boolean | null {
  if (!status) return null;
  if (!status.ghFound) return false;
  if (status.accounts === null) return null;
  if (status.accounts.some(signedIn)) return true;
  if (status.accounts.some((a) => a.state === "unknown")) return null;
  return false;
}

// ── Git uses your GitHub sign-in ───────────────────────────────────────

export const HELPER_LABEL = "Git uses your GitHub sign-in";
export const HELPER_HINT = "Git can push to GitHub with the same sign-in.";
/** WALKFIX-1 (walk, C4 A): Ready is read from this Mac's Git settings; a
 *  project's own Git settings can name another helper (or none), and then
 *  its publish can still fail to sign in. Said, so Ready isn't read as more. */
export const HELPER_READY_HINT =
  "In this Mac's Git settings. A project whose own Git settings set another way to sign in, or none, keeps that.";
/** T5 review: Windows with Git Credential Manager — nothing is broken; the
 *  row is the dependable option for the git Plyloft runs itself. */
export const HELPER_HINT_GCM =
  "Recommended. Git Credential Manager keeps working for you; Plyloft's own git can't open its sign-in window, so this lets it use the same sign-in as the GitHub command.";

/** N14 item 7: Git Credential Manager has nothing saved for github.com. */
export const HELPER_HINT_GCM_NONE =
  "Git Credential Manager has no GitHub sign-in saved, and Plyloft's own git can't open its sign-in window. Turn this on so Git uses your GitHub command's sign-in instead.";

/** N14 item 7: Git Credential Manager is signed in as another account. */
export function helperHintGcmOther(gcmLogin: string | null, account: string | null): string {
  const who = gcmLogin ? `as ${gcmLogin}` : "with another account";
  const target = account ? `${account}, the account Setup uses` : "the account Setup uses";
  return `Git Credential Manager is signed in to GitHub ${who}. Turn this on so Plyloft's git uses ${target}.`;
}

/** The row's hint for the helper git uses now. `gcm`: what Git Credential
 *  Manager has saved (N14 item 7); `account`: the account Setup uses. */
export function helperHint(
  helper: GithubHelperState,
  gcm: GcmSignIn | null = null,
  account: string | null = null,
): string {
  if (helper !== "gcm") return HELPER_HINT;
  if (gcm?.state === "none") return HELPER_HINT_GCM_NONE;
  if (gcm?.state === "other") return helperHintGcmOther(gcm.login, account);
  return HELPER_HINT_GCM;
}
export const SETUP_GIT_COMMAND = "gh auth setup-git --hostname github.com";
export const HELPER_SHEET = {
  title: "Let Git use your GitHub sign-in?",
  lede: "Plyloft will run gh auth setup-git, which tells Git on this Mac to ask the GitHub command for your password.",
  confirm: "Turn on",
};

/**
 * The row is shown only when git doesn't already ask gh for github.com, and
 * only once an account is signed in (setup-git has nothing to hand Git before
 * that). A config Plyloft couldn't read shows nothing.
 *
 * T5 (team walk, Windows): Git Credential Manager (`gcm`, told only on
 * Windows) is offered it too. The git Plyloft runs itself can't show GCM's
 * sign-in window (`GCM_INTERACTIVE=never`), so a GCM with no saved sign-in
 * for this account fails every fetch; the GitHub CLI's sign-in doesn't.
 */
export function helperRowShown(
  helper: GithubHelperState,
  connected: boolean | null,
  gcm: GcmSignIn | null = null,
): boolean {
  // N14 item 7: GCM already answers for the account Setup uses, without its
  // window — Plyloft's git works as it is, so nothing is offered.
  if (helper === "gcm" && gcm?.state === "same") return false;
  return connected === true && (helper === "other" || helper === "none" || helper === "gcm");
}

// ── Scopes ─────────────────────────────────────────────────────────────

export const SCOPE_LINE = "Your GitHub sign-in can't see private repositories.";
export const REFRESH_COMMAND = "gh auth refresh -h github.com -s repo,read:org";

/** The active account's token lacks `repo` or `read:org`. Unknown scopes
 *  (a fine-grained token, gh didn't say) are not called missing. */
export function missingScopes(accounts: readonly GithubAccount[] | null): boolean {
  const active = accounts?.find((a) => a.active && signedIn(a));
  if (!active?.scopes) return false;
  const have = active.scopes.split(",").map((s) => s.trim());
  return !have.includes("repo") || !have.includes("read:org");
}

// ── Identity back-fill ─────────────────────────────────────────────────

/**
 * The address `Use my GitHub address` writes, or null when the row isn't
 * shown: step 4's email is set and differs from GitHub's public email and
 * from its private noreply address (GitHub knows any noreply address of its
 * own), and GitHub's is known.
 */
export function backfillAddress(
  gitEmail: string | null | undefined,
  githubEmail: string | null,
  noreply: string | null,
): string | null {
  const mine = gitEmail?.trim().toLowerCase();
  const offer = githubEmail?.trim() || noreply?.trim() || null;
  if (!mine || !offer) return null;
  if (mine.endsWith("@users.noreply.github.com")) return null;
  if (mine === githubEmail?.trim().toLowerCase() || mine === noreply?.trim().toLowerCase()) return null;
  return offer;
}

export function backfillLine(gitEmail: string): string {
  return `Your commits use ${gitEmail.trim()}, which your GitHub account may not know.`;
}

// ── Single sign-on ─────────────────────────────────────────────────────

export function ssoLine(org: string | null): string {
  return org
    ? `Your organization “${org}” needs you to authorize the GitHub command for single sign-on.`
    : "Your organization needs you to authorize the GitHub command for single sign-on. GitHub shows the link on the organization's page.";
}

// ── Details ────────────────────────────────────────────────────────────

/** GitHub Enterprise is outside Setup (§5 step 5). */
export const ENTERPRISE_NOTE =
  "Setup signs in to github.com only. For GitHub Enterprise, run gh auth login --hostname <your host> in a terminal; Plyloft uses that sign-in afterwards.";
/** SSH remotes (§5 step 5). */
export const SSH_NOTE =
  "This sign-in covers projects whose GitHub address starts with https://. A project whose address uses SSH (git@github.com:…) keeps using your SSH keys.";
export const TOKEN_NOTE =
  "The GitHub command keeps your sign-in. Plyloft never stores or shows it, and never gives it to the agents' terminals.";

// ── A run that didn't end well ─────────────────────────────────────────

/** The GitHub step's actions, for its own runs only. */
export function isGithubAction(id: string): id is SetupRunActionId {
  return id.endsWith(".gh");
}

/** 1.176.0 R2: the outcomes that get gh's error block. A Record, so a new
 *  outcome doesn't compile until it is placed; `nothing-newer` works as before. */
const GH_FAILS: Record<SetupOutcome, boolean> = {
  succeeded: false,
  "not-observed": true,
  "could-not-tell": false,
  failed: true,
  "timed-out": true,
  "installer-closed": false,
  "still-on-old-version": true,
  "nothing-newer": false,
  "older-version-now": true,
  cancelled: false,
};

/**
 * The error block after gh's installer or updater stopped with an error (a
 * sign-in cancelled or whose code expired just leaves the row at *Not
 * signed in yet.* with `Sign in`: the terminal line says it). `Do it
 * yourself` opens the GitHub CLI's own page.
 */
export function ghInstallFailure(
  actionId: string,
  outcome: SetupOutcome | null,
  command: string | null,
  tail: readonly string[],
  evidence: SetupRunEvidence = {},
  programFoldersSet = false,
): UxError | null {
  if (actionId !== "install.gh" && actionId !== "update.gh") return null;
  if (!outcome || !GH_FAILS[outcome]) return null;
  const update = actionId === "update.gh";
  const before = evidence.versionBefore ?? null;
  // 1.176.0 R2: the cause in plain words, when the output names one.
  const why = causeWords("the GitHub command", update, outcome === "timed-out" ? { ...evidence, cause: "timed-out" } : evidence, tail, programFoldersSet);
  return {
    title:
      outcome === "still-on-old-version" || outcome === "older-version-now"
        ? "The GitHub command wasn't updated."
        : update
          ? "The GitHub command's updater stopped."
          : "The GitHub command wasn't installed.",
    happened:
      outcome === "not-observed"
        ? "The installer ended, but Plyloft can't find the GitHub command yet."
        : (why?.happened ??
          (outcome === "older-version-now"
            ? "The update didn't finish."
            : update
              ? "The updater ended with an error."
              : "The installer ended with an error.")),
    untouched:
      outcome === "still-on-old-version"
        ? before
          ? `The GitHub command still works, on version ${before}.`
          : "The GitHub command still works, on the version it had."
        : outcome === "older-version-now"
          ? "An older copy of the GitHub command answers now."
          : outcome === "timed-out"
            ? `Part of it may have been ${update ? "updated" : "installed"}.`
            : "Nothing else was changed.",
    // F1: the step has no "Check again" button; Plyloft reads again by itself.
    todo:
      evidence.cause === "command-not-found" && programFoldersSet
        ? (why?.todo ?? "")
        : "Try again, or install it yourself from the GitHub command's page: Plyloft sees it when it's there.",
    actions: [
      { id: "retry", label: "Try again", primary: true },
      { id: "yourself", label: "Do it yourself" },
    ],
    details: [command, ...tail].filter(Boolean).join("\n") || null,
  };
}

// ── 1.175.0 F1: one press, one consent ─────────────────────────────────
//
// The step shows three rows with no button of their own — the GitHub
// command, the account, Git using that sign-in — and one footer button,
// Connect GitHub, which opens one sheet naming what is still missing. What
// the sheet names runs in order, and nothing runs before its press. The
// third thing needs Git: on a computer without it, the yes is remembered
// (`onboarding.gitHelperConsented`) and the Git step does it.

export const CONNECT_GROUP = "What Connect GitHub does";
export const CONNECT_LABEL = "Connect GitHub";
/** The command the sign-in runs (`setup_actions.rs`), for the sheet's Details. */
export const LOGIN_COMMAND = "gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key";

/** The three things Connect GitHub does, in order. */
export type ConnectPart = "install" | "signin" | "helper";

/**
 * Whether Git has to be told to use the GitHub command's sign-in.
 * - `needed`: Git works and doesn't ask the GitHub command yet;
 * - `done`: it already does;
 * - `later`: Git isn't installed yet — it happens in the Git step;
 * - `hidden`: nothing to offer (Git Credential Manager already answers for
 *   the account Setup uses, or Git's own settings couldn't be read).
 */
export type HelperNeed = "needed" | "done" | "later" | "hidden";

export function helperNeed(gitWorks: boolean | null, status: GithubStatus | null): HelperNeed {
  if (gitWorks === false) return "later";
  const helper = status?.helper ?? "unknown";
  if (helper === "gh") return "done";
  if (helper === "unknown") return "hidden";
  // The same rule as the row had (`helperRowShown`), as if an account were
  // signed in: before the sign-in what Git Credential Manager holds isn't
  // compared with any account yet, and it is asked again after it.
  return helperRowShown(helper, true, status?.gcm ?? null) ? "needed" : "hidden";
}

/** What is still missing, in the order it runs: what the sheet names.
 *  Git's part for later (no Git yet) is offered until its yes is kept
 *  (`kept`, `onboarding.gitHelperConsented`) — also with an account
 *  already signed in (F1 round 2: it wasn't, and Git's part was lost). */
export function connectParts(
  ghReady: boolean,
  connected: boolean | null,
  helper: HelperNeed,
  kept = false,
): ConnectPart[] {
  const parts: ConnectPart[] = [];
  if (!ghReady) parts.push("install");
  if (connected !== true) parts.push("signin");
  if (helper === "needed" || (helper === "later" && !kept)) parts.push("helper");
  return parts;
}

/**
 * F1 round 2: Try again and Get a new code run what is missing now only
 * when the yes given covers all of it. When something the sheet didn't
 * name went missing since (the GitHub command vanished after a sign-in
 * alone was agreed), the press asks again: nothing the sheet didn't name
 * ever runs.
 */
export function consentCovers(consent: readonly ConnectPart[] | null, parts: readonly ConnectPart[]): boolean {
  return consent !== null && parts.length > 0 && parts.every((p) => consent.includes(p));
}

/** "in step 5": the Git step's number in the list on screen. */
export function helperLaterLine(gitStepNumber: number | null): string {
  return gitStepNumber ? `Once Git is installed, in step ${gitStepNumber}.` : "Once Git is installed.";
}

export interface ConnectSheetView {
  title: string;
  lede: string;
  items: { part: ConnectPart; title: string; body: string }[];
  /** `TOKEN_NOTE`, when the sheet signs in. */
  note: string | null;
  /** The commands, under Details. */
  commands: string[];
  confirm: string;
}

/** "these three things" for the parts the sheet names: three, or two (a
 *  sheet never names one — a sign-in alone has no sheet, and Git's part
 *  alone has its own). */
function thingsLede(count: number): string {
  const many = count === 3 ? "these three things" : "these two things";
  return `Plyloft does ${many}, one after the other. Nothing else changes.`;
}

/**
 * The one consent sheet. Only what is missing is named. With nothing but
 * Git's part left (an account is already signed in) it is today's sheet for
 * that, in its words. `null` when only the sign-in is missing: a sign-in
 * installs nothing and changes nothing on the computer, so it starts at
 * once, as it always did. Through `machineWords`.
 */
export function connectSheet(input: {
  parts: readonly ConnectPart[];
  helper: HelperNeed;
  windows: boolean;
  installCommand: string | null;
  gitStepNumber: number | null;
}): ConnectSheetView | null {
  const { parts, helper, windows } = input;
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0] === "signin") return null;
  if (parts.length === 1 && parts[0] === "helper") {
    return {
      title: HELPER_SHEET.title,
      // F1 round 2: an account already signed in and no Git yet — the yes
      // is kept, and the Git step does it.
      lede: helper === "later" ? `${HELPER_SHEET.lede} ${helperLaterLine(input.gitStepNumber)}` : HELPER_SHEET.lede,
      items: [],
      note: null,
      commands: [SETUP_GIT_COMMAND],
      confirm: HELPER_SHEET.confirm,
    };
  }
  const items: ConnectSheetView["items"] = [];
  const commands: string[] = [];
  for (const part of parts) {
    if (part === "install") {
      items.push({
        part,
        title: "Installs the GitHub command",
        body: windows
          ? "With winget, Windows' package installer, for your account only. No administrator needed."
          : "With Homebrew. On a Mac without Homebrew, Plyloft downloads it from GitHub, checks it against GitHub's published checksum and puts it in ~/.local/bin. No administrator needed.",
      });
      if (input.installCommand) commands.push(input.installCommand);
    } else if (part === "signin") {
      items.push({
        part,
        title: "Signs it in as you",
        body: "Your browser opens github.com/login/device. You type the code Plyloft shows and approve.",
      });
      commands.push(LOGIN_COMMAND);
    } else {
      const what = "Git on this Mac asks the GitHub command for your password, so sending your work never asks you.";
      items.push({
        part,
        title: "Lets Git use that sign-in",
        body: helper === "later" ? `${what} ${helperLaterLine(input.gitStepNumber)}` : what,
      });
      commands.push(SETUP_GIT_COMMAND);
    }
  }
  return {
    title: "Connect GitHub on this Mac?",
    lede: thingsLede(items.length),
    items,
    note: TOKEN_NOTE,
    commands,
    confirm: CONNECT_LABEL,
  };
}

/** The runs a yes to the sheet starts now, in order. Git's part is not
 *  among them: it starts after the sign-in, once Plyloft has read again
 *  whether Git still needs it (`helperRowShown`), or in the Git step. */
export function connectRuns(parts: readonly ConnectPart[], helperLater = false): SetupRunActionId[] {
  const runs: SetupRunActionId[] = [];
  if (parts.includes("install")) runs.push("install.gh");
  if (parts.includes("signin")) runs.push("login.gh");
  // Without Git, Git's part alone runs nothing now: the Git step does it.
  if (runs.length === 0 && parts.includes("helper") && !helperLater) runs.push("setupgit.gh");
  return runs;
}

/**
 * F1 round 2: when the yes to Git's part (no Git yet) is kept for the Git
 * step. With an account already signed in, at the press; otherwise only
 * when the sign-in succeeds — an expired code, a stopped or failed sign-in,
 * or Setup closed before it finished keep nothing.
 */
export function keepHelperYes(input: {
  agreedHelperLater: boolean;
  connectedAtPress: boolean;
}): "now" | "on-sign-in" | "never" {
  if (!input.agreedHelperLater) return "never";
  return input.connectedAtPress ? "now" : "on-sign-in";
}

/** How a sign-in that didn't succeed ended, when Plyloft can tell. */
export type SignInEnd = "expired" | "stopped";

/** A row of the step: no button of its own. */
export interface ConnectRowView {
  key: "gh" | "account" | "helper";
  label: string;
  hint: string;
  /** The state word, with its dot; null: nothing to say. */
  word: { state: "done" | "running" | "empty"; text: string } | null;
}

export interface ConnectRowsInput {
  gh: GhRowView;
  account: AccountRowView;
  helper: HelperNeed;
  /** The step's run under way. */
  running: SetupRunActionId | null;
  /** Something was started here, in this visit. */
  started: boolean;
  /** The last run ended and something is still missing: what wasn't
   *  reached says "Not started". */
  halted: boolean;
  /** A sign-in that ended without one. */
  signInEnd: SignInEnd | null;
  gitStepNumber: number | null;
  /** Git's row hint once the step is under way ([`helperHint`]: Git
   *  Credential Manager's cases on Windows); `HELPER_HINT` when absent. */
  helperHint?: string;
}

/**
 * The three rows. Before anything was started they say what Connect GitHub
 * will do ("Installs the GitHub command"); once something runs, or an
 * account is signed in, they are the things themselves with their state
 * ("GitHub command · Ready"). A thing that is already there is always shown
 * as itself. Git's row isn't drawn when there is nothing to offer for it.
 */
export function connectRows(input: ConnectRowsInput): ConnectRowView[] {
  const { gh, account, helper, running, started, halted } = input;
  const ghReady = gh.state === "ready";
  const signed = account.state === "signed-in";
  // Nothing started and nobody signed in yet: the rows are the plan.
  const plan = !started && !running && !signed;
  const installing = running === "install.gh" || running === "update.gh";
  const signingIn = running === "login.gh" || running === "add-account.gh";
  const ready: ConnectRowView["word"] = { state: "done", text: "Ready" };
  /** A part not reached yet: "Next" while the run goes on, "Not started"
   *  once it stopped short. */
  const notReached: ConnectRowView["word"] = running
    ? { state: "empty", text: "Next" }
    : halted
      ? { state: "empty", text: "Not started" }
      : null;

  const rows: ConnectRowView[] = [];
  if (ghReady) {
    rows.push({ key: "gh", label: GH_LABEL, hint: gh.hint, word: ready });
  } else if (plan) {
    rows.push({
      key: "gh",
      label: "Installs the GitHub command",
      hint: gh.state === "missing" ? "Not installed. It is how Plyloft talks to GitHub." : gh.hint,
      word: null,
    });
  } else {
    rows.push({
      key: "gh",
      label: GH_LABEL,
      hint: gh.hint,
      word: installing ? { state: "running", text: "Installing" } : null,
    });
  }

  if (signed) {
    rows.push({ key: "account", label: ACCOUNT_LABEL, hint: account.hint, word: ready });
  } else if (plan) {
    rows.push({
      key: "account",
      label: "Signs it in as you",
      hint:
        account.state === "could-not-tell"
          ? account.hint
          : "Your browser opens github.com, where you type a code Plyloft shows.",
      word: null,
    });
  } else {
    rows.push({
      key: "account",
      label: ACCOUNT_LABEL,
      hint: input.signInEnd ? "Not signed in yet." : account.state === "could-not-tell" ? account.hint : "",
      word: signingIn ? { state: "running", text: "Signing in" } : notReached,
    });
  }

  if (helper === "done") {
    rows.push({ key: "helper", label: HELPER_LABEL, hint: HELPER_READY_HINT, word: ready });
  } else if (helper === "later") {
    rows.push({
      key: "helper",
      label: plan ? "Lets Git use that sign-in" : HELPER_LABEL,
      hint: helperLaterLine(input.gitStepNumber),
      word: null,
    });
  } else if (helper === "needed") {
    rows.push(
      plan
        ? {
            key: "helper",
            label: "Lets Git use that sign-in",
            hint: "So sending your work to GitHub never asks for a password.",
            word: null,
          }
        : { key: "helper", label: HELPER_LABEL, hint: input.helperHint ?? HELPER_HINT, word: notReached },
    );
  }
  return rows;
}

/** The line under the rows while the step's run goes on, and how it ended.
 *  `null`: the guided terminal's own line stands (`setupLine`). Through
 *  `machineWords`. */
export function connectLine(input: {
  running: SetupRunActionId | null;
  signInEnd: SignInEnd | null;
  /** Everything the step does is there. */
  complete: boolean;
}): { state: "running" | "done" | "empty"; text: string } | null {
  if (input.running === "install.gh") return { state: "running", text: "Installing the GitHub command…" };
  if (input.running === "login.gh" || input.running === "add-account.gh") {
    return { state: "running", text: "Waiting for you to approve on GitHub…" };
  }
  if (input.running) return null;
  if (input.signInEnd === "expired") {
    return { state: "empty", text: "That code expired before GitHub had your approval. Nothing was changed." };
  }
  if (input.signInEnd === "stopped") return { state: "empty", text: "You stopped the sign-in. Nothing was changed." };
  if (input.complete) return { state: "done", text: "GitHub is connected on this Mac." };
  return null;
}

/** Above the code, while the sign-in waits. */
export const CODE_HINT = "Enter this code on github.com/login/device and approve.";

/** The footer's one button, by state. `null`: no filled button (a run is
 *  under way: the code's own button is the one to press). */
export type ConnectFooter = "continue" | "connect" | "try-again" | "new-code" | null;

export function connectFooter(input: {
  /** The doctor has answered. */
  reported: boolean;
  running: boolean;
  /** What is still missing (`connectParts`). */
  parts: readonly ConnectPart[];
  /** The last run here ended badly (an installer's error, a sign-in that
   *  failed), and it wasn't the person who stopped it. */
  failed: boolean;
  signInEnd: SignInEnd | null;
}): ConnectFooter {
  if (!input.reported) return "continue";
  if (input.running) return null;
  if (input.parts.length === 0) return "continue";
  if (input.signInEnd === "expired") return "new-code";
  if (input.signInEnd === "stopped") return "connect";
  return input.failed ? "try-again" : "connect";
}

export const FOOTER_LABEL: Record<Exclude<ConnectFooter, null>, string> = {
  continue: "Continue",
  connect: CONNECT_LABEL,
  "try-again": "Try again",
  "new-code": "Get a new code",
};

/** The Git step, once Git is installed and the yes was given in this step. */
export const HELPER_NOW_LINE = "Git now uses your GitHub sign-in.";
