// Tier 3 pure-function test (OB-7a, ONBOARDING_SPEC §5 step 5). Run with Node 22+:
//   node --experimental-strip-types src/lib/githubStep.test.ts
import assert from "node:assert/strict";
import type { GithubAccount, GithubStatus } from "../ipc.ts";
import {
  CODE_HINT,
  CONNECT_GROUP,
  FOOTER_LABEL,
  GITHUB_STEP_NAME,
  GITHUB_TITLE,
  GITHUB_WHY,
  HELPER_NOW_LINE,
  HELPER_SHEET,
  LOGIN_COMMAND,
  SETUP_GIT_COMMAND,
  SKIP_GITHUB_NOTE,
  TOKEN_NOTE,
  connectFooter,
  connectLine,
  connectParts,
  connectRows,
  connectRuns,
  consentCovers,
  keepHelperYes,
  connectSheet,
  helperLaterLine,
  helperNeed,
  accountRow,
  expectedAccountView,
  backfillAddress,
  backfillLine,
  ghInstallFailure,
  ghInstallSheet,
  connectDownloadLine,
  ghInstallVia,
  ghRow,
  githubConnected,
  helperRowShown,
  helperHint,
  missingScopes,
  ssoLine,
} from "./githubStep.ts";

const ZIP = "v=$(curl -fsSI https://github.com/cli/cli/releases/latest | …) && … ~/.local/bin/gh --version";
const WINGET = "winget install --id GitHub.cli -e --source winget --scope user --accept-package-agreements --accept-source-agreements";

const acct = (login: string, over: Partial<GithubAccount> = {}): GithubAccount => ({
  login,
  active: false,
  state: "signed-in",
  scopes: "gist, read:org, repo, workflow",
  ...over,
});
const status = (over: Partial<GithubStatus> = {}): GithubStatus => ({
  ghFound: true,
  accounts: [],
  helper: "none",
  githubEmail: null,
  githubNoreply: null,
  sso: null,
  ...over,
});

// ── How gh installs: brew, the zip on a Mac without Homebrew, winget ─────
assert.equal(ghInstallVia("brew install gh", false), "brew");
assert.equal(ghInstallVia(ZIP, false), "zip");
assert.equal(ghInstallVia(null, false), "zip");
assert.equal(ghInstallVia(WINGET, true), "winget");
assert.match(ghInstallSheet("zip").lede, /~\/\.local\/bin\. No administrator needed\./);
assert.match(ghInstallSheet("brew").lede, /Homebrew/);
assert.match(ghInstallSheet("winget").lede, /winget, Windows' package installer, for your account only/);
for (const via of ["brew", "zip", "winget"] as const) {
  assert.equal(ghInstallSheet(via).title, "Install the GitHub command?");
  assert.match(ghInstallSheet(via).lede, /The GitHub command is how Plyloft talks to GitHub\./);
}

// ── The GitHub CLI row ──────────────────────────────────────────────────
assert.equal(ghRow(null, false, false).state, "unknown");
assert.deepEqual(ghRow({ id: "gh", found: false, installCmd: ZIP }, true, false), {
  state: "missing",
  hint: "Not installed.",
  command: ZIP,
  via: "zip",
  update: null,
});
assert.equal(ghRow({ id: "gh", found: true, version: "gh version 2.101.0 (2026-09-01)" }, true, false).hint, "Installed (gh 2.101.0).");
assert.deepEqual(
  ghRow(
    { id: "gh", found: true, version: "2.100.0", update: { latest: "2.101.0", detail: "Version 2.101.0 is available.", command: "brew upgrade gh" } },
    true,
    false,
  ).update,
  { detail: "Version 2.101.0 is available.", command: "brew upgrade gh" },
);

// ── Accounts ────────────────────────────────────────────────────────────
assert.equal(accountRow(null).state, "unknown");
assert.deepEqual(accountRow(status({ ghFound: false, accounts: null })), {
  state: "signed-out",
  hint: "Install the GitHub command first.",
  action: null,
});
assert.deepEqual(accountRow(status()), {
  state: "signed-out",
  hint: "Not signed in.",
  action: { id: "login.gh", label: "Sign in" },
});
assert.deepEqual(accountRow(status({ accounts: [acct("test-owner", { active: true })] })), {
  state: "signed-in",
  hint: "Signed in as test-owner.",
  action: { id: "add-account.gh", label: "Add another account" },
});
// Several: the active one first and named so (§5 step 5).
assert.equal(
  accountRow(status({ accounts: [acct("mb-work"), acct("test-owner", { active: true })] })).hint,
  "Signed in with 2 accounts: test-owner (active), mb-work.",
);
assert.equal(
  accountRow(status({ accounts: [acct("a", { active: true }), acct("b", { state: "refused" })] })).hint,
  "Signed in with 2 accounts: a (active), b (signed out).",
);
// A refused token: sign in again; a check that never reached GitHub: can't tell.
assert.deepEqual(accountRow(status({ accounts: [acct("a", { active: true, state: "refused" })] })).hint,
  "GitHub no longer accepts the sign-in for a. Sign in again.");
assert.equal(accountRow(status({ accounts: [acct("a", { active: true, state: "unknown" })] })).state, "could-not-tell");
assert.equal(accountRow(status({ accounts: null })).state, "could-not-tell");

// Step 5 is done with one account signed in.
assert.equal(githubConnected(null), null);
assert.equal(githubConnected(status({ ghFound: false, accounts: null })), false);
assert.equal(githubConnected(status()), false);
assert.equal(githubConnected(status({ accounts: null })), null);
assert.equal(githubConnected(status({ accounts: [acct("a", { active: true })] })), true);
assert.equal(githubConnected(status({ accounts: [acct("a", { state: "unknown" })] })), null);
assert.equal(githubConnected(status({ accounts: [acct("a", { state: "refused" })] })), false);

// ── Git uses your GitHub sign-in: only when needed ──────────────────────
assert.equal(helperRowShown("other", true), true);
assert.equal(helperRowShown("none", true), true);
assert.equal(helperRowShown("gh", true), false);
// T5: Plyloft's own git can't show GCM's sign-in window, so GCM is offered it too.
assert.equal(helperRowShown("gcm", true), true);
assert.equal(helperRowShown("gcm", false), false);
// T5 review: with GCM the row is a recommendation, not a sign git is broken.
assert.match(helperHint("gcm"), /^Recommended\./);
assert.ok(!/broken|fail/i.test(helperHint("gcm")));
assert.equal(helperHint("none"), "Git can push to GitHub with the same sign-in.");
assert.equal(helperRowShown("unknown", true), false);
assert.equal(helperRowShown("none", false), false, "nothing to hand Git before a sign-in");
assert.equal(helperRowShown("none", null), false);

// N14 item 7: Windows, Git Credential Manager probed with `git credential fill`.
assert.equal(helperRowShown("gcm", true, { state: "same", login: "octo" }), false, "GCM already answers for Setup's account");
assert.equal(helperRowShown("gcm", true, { state: "none", login: null }), true);
assert.equal(helperRowShown("gcm", true, { state: "other", login: "mb-work" }), true);
assert.equal(helperRowShown("gcm", true, { state: "unknown", login: null }), true);
assert.equal(helperRowShown("gcm", true, null), true, "not probed: as before");
assert.equal(
  helperHint("gcm", { state: "none", login: null }, "octo"),
  "Git Credential Manager has no GitHub sign-in saved, and Plyloft's own git can't open its sign-in window. Turn this on so Git uses your GitHub command's sign-in instead.",
);
assert.equal(
  helperHint("gcm", { state: "other", login: "mb-work" }, "octo"),
  "Git Credential Manager is signed in to GitHub as mb-work. Turn this on so Plyloft's git uses octo, the account Setup uses.",
);
assert.equal(
  helperHint("gcm", { state: "other", login: null }, null),
  "Git Credential Manager is signed in to GitHub with another account. Turn this on so Plyloft's git uses the account Setup uses.",
);
assert.match(helperHint("gcm", { state: "unknown", login: null }, "octo"), /^Recommended\./);
assert.equal(helperHint("none", { state: "none", login: null }), "Git can push to GitHub with the same sign-in.");

// ── Scopes ──────────────────────────────────────────────────────────────
assert.equal(missingScopes([acct("a", { active: true, scopes: "gist, repo" })]), true);
assert.equal(missingScopes([acct("a", { active: true, scopes: "read:org, gist" })]), true);
assert.equal(missingScopes([acct("a", { active: true })]), false);
assert.equal(missingScopes([acct("a", { active: true, scopes: null })]), false, "unknown is not missing");
assert.equal(missingScopes([acct("a", { active: false, scopes: "gist" })]), false, "only the active account");
assert.equal(missingScopes(null), false);

// ── Identity back-fill ──────────────────────────────────────────────────
const NOREPLY = "1234567+matteo@users.noreply.github.com";
assert.equal(backfillAddress("matteo@example.com", null, NOREPLY), NOREPLY);
assert.equal(backfillAddress("matteo@example.com", "m@work.com", NOREPLY), "m@work.com");
assert.equal(backfillAddress("M@Work.com", "m@work.com", NOREPLY), null, "the same address");
assert.equal(backfillAddress(NOREPLY, null, NOREPLY), null);
assert.equal(backfillAddress("matteo@users.noreply.github.com", null, NOREPLY), null, "an older noreply form");
assert.equal(backfillAddress(null, "m@work.com", NOREPLY), null, "no email yet: step 4's job");
assert.equal(backfillAddress("m@example.com", null, null), null, "GitHub's unknown");
assert.equal(backfillLine(" m@example.com "), "Your commits use m@example.com, which your GitHub account may not know.");

// ── SSO ─────────────────────────────────────────────────────────────────
assert.equal(ssoLine("acme"), "Your organization “acme” needs you to authorize the GitHub command for single sign-on.");
assert.match(ssoLine(null), /^Your organization needs you to authorize/);

// ── Failures ────────────────────────────────────────────────────────────
const failed = ghInstallFailure("install.gh", "failed", ZIP, ["curl: (6) Could not resolve host"]);
assert.equal(failed?.title, "The GitHub command wasn't installed.");
assert.deepEqual(failed?.actions.map((a) => a.label), ["Try again", "Do it yourself"]);
assert.match(failed?.details ?? "", /Could not resolve host/);
assert.equal(ghInstallFailure("install.gh", "succeeded", ZIP, []), null);
assert.equal(ghInstallFailure("install.gh", "cancelled", ZIP, []), null);
assert.equal(ghInstallFailure("login.gh", "failed", null, []), null, "a sign-in keeps its row");
assert.equal(ghInstallFailure("update.gh", "failed", "brew upgrade gh", [])?.title, "The GitHub command's updater stopped.");
// 1.176.0 R2: an update that didn't take gets the block too, with its cause.
const refused = ghInstallFailure("update.gh", "still-on-old-version", "brew upgrade gh", ["Error: Permission denied @ apply2files - /opt/homebrew/Cellar/gh"], {
  cause: "permissions",
  causePath: "/opt/homebrew/Cellar",
  versionBefore: "2.60.0",
});
assert.equal(refused?.title, "The GitHub command wasn't updated.");
assert.equal(refused?.happened, "The computer didn't let the GitHub command's updater change the folder /opt/homebrew/Cellar.");
assert.equal(refused?.untouched, "The GitHub command still works, on version 2.60.0.");
assert.deepEqual(refused?.actions.map((a) => a.label), ["Try again", "Do it yourself"]);
const slowGh = ghInstallFailure("update.gh", "timed-out", "brew upgrade gh", []);
assert.equal(slowGh?.happened, "The GitHub command's updater took too long and was stopped.");
assert.equal(slowGh?.untouched, "Part of it may have been updated.");
assert.equal(ghInstallFailure("update.gh", "older-version-now", "x", [])?.untouched, "An older copy of the GitHub command answers now.");
assert.equal(ghInstallFailure("update.gh", "nothing-newer", "x", []), null, "nothing newer works as before");

// N14 walk F16c: the account Settings › Team asked to sign in.
assert.equal(expectedAccountView(status(), null), null);
assert.equal(expectedAccountView(status(), "  "), null);
assert.deepEqual(expectedAccountView(status(), "team-acct"), {
  note: "Your team uses the GitHub account team-acct, which isn't signed in on this Mac. Sign in as team-acct; in the browser, use that GitHub account.",
  label: "Sign in as team-acct",
});
// Refused: still "isn't signed in" (a missing token and a rejected one look
// the same to Setup; Settings › Team says this for the missing one).
assert.deepEqual(expectedAccountView(status({ accounts: [acct("team-acct", { state: "refused" })] }), "team-acct"), {
  note: "Your team uses the GitHub account team-acct, which isn't signed in on this Mac. Sign in as team-acct; in the browser, use that GitHub account.",
  label: "Sign in as team-acct",
});
// Can't be told: neutral, never "isn't signed in".
const NEUTRAL = "Your team uses the GitHub account team-acct. Sign in as team-acct; in the browser, use that GitHub account.";
assert.equal(expectedAccountView(status({ accounts: null }), "team-acct")?.note, NEUTRAL);
assert.equal(expectedAccountView(status({ accounts: [acct("team-acct", { state: "unknown" })] }), "team-acct")?.note, NEUTRAL);
assert.equal(expectedAccountView(status({ accounts: [acct("other", { state: "unknown", active: true })] }), "team-acct")?.note, NEUTRAL);
// gh not installed, or not read yet: no note (the row has no button).
assert.equal(expectedAccountView(status({ ghFound: false }), "team-acct"), null);
assert.equal(expectedAccountView(null, "team-acct"), null);
assert.equal(
  expectedAccountView(status({ accounts: [acct("other", { active: true })] }), "team-acct")?.label,
  "Sign in as team-acct",
  "another account signed in doesn't count",
);
assert.equal(expectedAccountView(status({ accounts: [acct("Team-Acct")] }), "team-acct"), null);

// ── 1.175.0 F1: the step's words ─────────────────────────────────────
// (Its explanation, a note of its own since UX P-C D3, is now the step's
// title and sentence. 1.178.0 A3 D2/D3: no "second" sign-in — the Plyloft
// account before it is optional.)
assert.equal(GITHUB_STEP_NAME, "GitHub for your projects");
assert.equal(GITHUB_TITLE, "Connect GitHub for your projects");
assert.equal(
  GITHUB_WHY,
  "This lets this Mac send your work to GitHub: Ship it puts each finished card there as a pull request. It is not your Plyloft account. GitHub shows you a code. It takes about a minute.",
);
assert.equal(SKIP_GITHUB_NOTE, "If you skip it, Ship it will keep your changes on this Mac.");
assert.equal(CONNECT_GROUP, "What Connect GitHub does");
assert.equal(CODE_HINT, "Enter this code on github.com/login/device and approve.");
assert.equal(HELPER_NOW_LINE, "Git now uses your GitHub sign-in.");
assert.equal(
  failed?.todo,
  "Try again, or install it yourself from the GitHub command's page: Plyloft sees it when it's there.",
  "the step has no Check again button to press",
);

// ── F1: whether Git has to be told ───────────────────────────────────
assert.equal(helperNeed(false, status()), "later", "no Git yet: in the Git step");
assert.equal(helperNeed(false, null), "later");
assert.equal(helperNeed(true, status({ helper: "none" })), "needed");
assert.equal(helperNeed(true, status({ helper: "other" })), "needed");
assert.equal(helperNeed(true, status({ helper: "gh" })), "done");
assert.equal(helperNeed(true, status({ helper: "unknown" })), "hidden", "Git's settings couldn't be read");
assert.equal(helperNeed(true, null), "hidden", "not read yet");
// Windows: Git Credential Manager follows the row's own rule.
assert.equal(helperNeed(true, status({ helper: "gcm" })), "needed");
assert.equal(helperNeed(true, status({ helper: "gcm", gcm: { state: "none", login: null } })), "needed");
assert.equal(helperNeed(true, status({ helper: "gcm", gcm: { state: "other", login: "x" } })), "needed");
assert.equal(helperNeed(true, status({ helper: "gcm", gcm: { state: "same", login: "octocat" } })), "hidden");
assert.equal(helperNeed(null, status({ helper: "none" })), "needed", "Git not judged yet: as it reads");

// ── F1: what is still missing, and what a yes starts ─────────────────
assert.deepEqual(connectParts(false, false, "needed"), ["install", "signin", "helper"]);
assert.deepEqual(connectParts(true, false, "needed"), ["signin", "helper"]);
assert.deepEqual(connectParts(false, null, "hidden"), ["install", "signin"]);
assert.deepEqual(connectParts(true, false, "done"), ["signin"]);
assert.deepEqual(connectParts(true, true, "needed"), ["helper"], "connected, but Git doesn't use it yet");
assert.deepEqual(connectParts(true, true, "done"), []);
assert.deepEqual(connectParts(true, true, "hidden"), []);
// Without Git the third thing is named with the rest, and done later…
assert.deepEqual(connectParts(false, false, "later"), ["install", "signin", "helper"]);
// F1 round 2: already signed in, Git not installed — Git's part is still
// offered until its yes is kept; then nothing is left in this step.
assert.deepEqual(connectParts(true, true, "later"), ["helper"]);
assert.deepEqual(connectParts(true, true, "later", true), []);
assert.deepEqual(connectParts(false, false, "later", true), ["install", "signin"], "a yes kept isn't asked again");
assert.deepEqual(connectParts(true, true, "needed", true), ["helper"], "with Git there, kept or not, it runs here");
// Git's part never starts with the sheet's press: it follows the sign-in.
assert.deepEqual(connectRuns(["install", "signin", "helper"]), ["install.gh", "login.gh"]);
assert.deepEqual(connectRuns(["signin", "helper"]), ["login.gh"]);
assert.deepEqual(connectRuns(["signin"]), ["login.gh"]);
assert.deepEqual(connectRuns(["helper"]), ["setupgit.gh"], "alone, it is what the press starts");
assert.deepEqual(connectRuns([]), []);
// F1 round 2: without Git, Git's part alone runs nothing now.
assert.deepEqual(connectRuns(["helper"], true), []);
assert.deepEqual(connectRuns(["install", "signin", "helper"], true), ["install.gh", "login.gh"]);
// Try again / Get a new code: only what the yes covered.
assert.equal(consentCovers(["install", "signin", "helper"], ["signin", "helper"]), true);
assert.equal(consentCovers(["signin"], ["signin"]), true);
assert.equal(consentCovers(["signin"], ["install", "signin"]), false, "the command vanished: the sheet asks");
assert.equal(consentCovers(["signin"], ["signin", "helper"]), false);
assert.equal(consentCovers(null, ["signin"]), false);
assert.equal(consentCovers(["signin"], []), false);
// When the yes for later is kept: at the press when already signed in,
// else only once the sign-in succeeds.
assert.equal(keepHelperYes({ agreedHelperLater: true, connectedAtPress: true }), "now");
assert.equal(keepHelperYes({ agreedHelperLater: true, connectedAtPress: false }), "on-sign-in");
assert.equal(keepHelperYes({ agreedHelperLater: false, connectedAtPress: false }), "never");
// Git's part alone, later: today's sheet, saying when.
{
  const later = connectSheet({ parts: ["helper"], helper: "later", windows: false, installCommand: null, gitStepNumber: 5 })!;
  assert.equal(later.title, "Let Git use your GitHub sign-in?");
  assert.equal(
    later.lede,
    "Plyloft will run gh auth setup-git, which tells Git on this Mac to ask the GitHub command for your password. Once Git is installed, in step 5.",
  );
}

// ── F1: the one sheet, with one, two and three things ────────────────
{
  const sheet = (parts: Parameters<typeof connectSheet>[0]["parts"], over: Partial<Parameters<typeof connectSheet>[0]> = {}) =>
    connectSheet({ parts, helper: "needed", windows: false, installCommand: "brew install gh", gitStepNumber: 5, ...over });
  const three = sheet(["install", "signin", "helper"])!;
  assert.equal(three.title, "Connect GitHub on this Mac?");
  assert.equal(three.lede, "Plyloft does these three things, one after the other. Nothing else changes.");
  assert.deepEqual(three.items.map((i) => i.title), ["Installs the GitHub command", "Signs it in as you", "Lets Git use that sign-in"]);
  assert.equal(
    three.items[0].body,
    "With Homebrew. On a Mac without Homebrew, Plyloft downloads it from GitHub, checks it against GitHub's published checksum and puts it in ~/.local/bin. No administrator needed.",
  );
  assert.equal(three.items[1].body, "Your browser opens github.com/login/device. You type the code Plyloft shows and approve.");
  assert.equal(three.items[2].body, "Git on this Mac asks the GitHub command for your password, so sending your work never asks you.");
  assert.equal(three.note, TOKEN_NOTE);
  assert.equal(three.confirm, "Connect GitHub");
  assert.deepEqual(three.commands, ["brew install gh", LOGIN_COMMAND, SETUP_GIT_COMMAND], "every command, under Details");
  // Windows installs another way.
  assert.equal(
    sheet(["install", "signin", "helper"], { windows: true, installCommand: WINGET })!.items[0].body,
    "With winget, Windows' package installer, for your account only. No administrator needed.",
  );
  // Two things: only what is missing is named.
  const two = sheet(["signin", "helper"])!;
  assert.equal(two.lede, "Plyloft does these two things, one after the other. Nothing else changes.");
  assert.deepEqual(two.items.map((i) => i.part), ["signin", "helper"]);
  assert.deepEqual(two.commands, [LOGIN_COMMAND, SETUP_GIT_COMMAND]);
  assert.deepEqual(sheet(["install", "signin"], { helper: "hidden" })!.items.map((i) => i.part), ["install", "signin"]);
  // Without Git, the third thing says when it happens.
  assert.equal(
    sheet(["install", "signin", "helper"], { helper: "later" })!.items[2].body,
    "Git on this Mac asks the GitHub command for your password, so sending your work never asks you. Once Git is installed, in step 5.",
  );
  // One thing. Git's part alone is today's sheet, in today's words…
  const one = sheet(["helper"])!;
  assert.equal(one.title, HELPER_SHEET.title);
  assert.equal(one.lede, HELPER_SHEET.lede);
  assert.equal(one.confirm, "Turn on");
  assert.deepEqual(one.commands, [SETUP_GIT_COMMAND]);
  assert.deepEqual(one.items, []);
  // …and a sign-in alone installs and changes nothing: it starts at once.
  assert.equal(sheet(["signin"]), null);
  assert.equal(sheet([]), null);
}
assert.equal(helperLaterLine(5), "Once Git is installed, in step 5.");
assert.equal(helperLaterLine(6), "Once Git is installed, in step 6.");

// ── F1: the three rows ───────────────────────────────────────────────
{
  const missing = ghRow({ id: "gh", found: false, installCmd: "brew install gh" }, true, false);
  const ready = ghRow({ id: "gh", found: true, version: "gh version 2.62.0 (2026-01-01)" }, true, false);
  const signedOut = accountRow(status({ ghFound: false }));
  const none = accountRow(status({ accounts: [] }));
  const signed = accountRow(status({ accounts: [acct("octocat", { active: true })] }));
  const base = { running: null, started: false, halted: false, signInEnd: null, gitStepNumber: 5 } as const;
  const view = (rows: ReturnType<typeof connectRows>) => rows.map((r) => [r.label, r.hint, r.word?.text ?? null]);

  // The first time: the plan, with no button and no state.
  assert.deepEqual(view(connectRows({ ...base, gh: missing, account: signedOut, helper: "needed" })), [
    ["Installs the GitHub command", "Not installed. It is how Plyloft talks to GitHub.", null],
    ["Signs it in as you", "Your browser opens github.com, where you type a code Plyloft shows.", null],
    ["Lets Git use that sign-in", "So sending your work to GitHub never asks for a password.", null],
  ]);
  // Git not installed yet: the third row says when.
  assert.deepEqual(view(connectRows({ ...base, gh: missing, account: signedOut, helper: "later" }))[2], [
    "Lets Git use that sign-in",
    "Once Git is installed, in step 5.",
    null,
  ]);
  // Nothing to offer for Git: two rows.
  assert.equal(connectRows({ ...base, gh: missing, account: signedOut, helper: "hidden" }).length, 2);
  // The command already there is itself, ready; the rest is still the plan.
  assert.deepEqual(view(connectRows({ ...base, gh: ready, account: none, helper: "needed" })), [
    ["GitHub command", "Installed (gh 2.62.0).", "Ready"],
    ["Signs it in as you", "Your browser opens github.com, where you type a code Plyloft shows.", null],
    ["Lets Git use that sign-in", "So sending your work to GitHub never asks for a password.", null],
  ]);
  // Installing: what comes after says Next.
  assert.deepEqual(
    view(connectRows({ ...base, started: true, running: "install.gh", gh: missing, account: signedOut, helper: "needed" })),
    [
      ["GitHub command", "Not installed.", "Installing"],
      ["Account", "", "Next"],
      ["Git uses your GitHub sign-in", "Git can push to GitHub with the same sign-in.", "Next"],
    ],
  );
  // Signing in.
  assert.deepEqual(
    view(connectRows({ ...base, started: true, running: "login.gh", gh: ready, account: none, helper: "needed" })),
    [
      ["GitHub command", "Installed (gh 2.62.0).", "Ready"],
      ["Account", "", "Signing in"],
      ["Git uses your GitHub sign-in", "Git can push to GitHub with the same sign-in.", "Next"],
    ],
  );
  // Done.
  assert.deepEqual(view(connectRows({ ...base, started: true, gh: ready, account: signed, helper: "done" })), [
    ["GitHub command", "Installed (gh 2.62.0).", "Ready"],
    ["Account", "Signed in as octocat.", "Ready"],
    ["Git uses your GitHub sign-in", "In this Mac's Git settings. A project whose own Git settings set another way to sign in, or none, keeps that.", "Ready"],
  ]);
  // The installer failed: nothing after it was started.
  assert.deepEqual(
    view(connectRows({ ...base, started: true, halted: true, gh: missing, account: signedOut, helper: "needed" })),
    [
      ["GitHub command", "Not installed.", null],
      ["Account", "", "Not started"],
      ["Git uses your GitHub sign-in", "Git can push to GitHub with the same sign-in.", "Not started"],
    ],
  );
  // The code expired.
  assert.deepEqual(
    view(connectRows({ ...base, started: true, halted: true, signInEnd: "expired", gh: ready, account: none, helper: "needed" })),
    [
      ["GitHub command", "Installed (gh 2.62.0).", "Ready"],
      ["Account", "Not signed in yet.", "Not started"],
      ["Git uses your GitHub sign-in", "Git can push to GitHub with the same sign-in.", "Not started"],
    ],
  );
  // Connected, and Git doesn't use it yet: the step opens on that alone.
  assert.deepEqual(view(connectRows({ ...base, gh: ready, account: signed, helper: "needed" })), [
    ["GitHub command", "Installed (gh 2.62.0).", "Ready"],
    ["Account", "Signed in as octocat.", "Ready"],
    ["Git uses your GitHub sign-in", "Git can push to GitHub with the same sign-in.", null],
  ]);
  // No row has a button: the view carries none.
  for (const row of connectRows({ ...base, gh: missing, account: signedOut, helper: "needed" })) {
    assert.deepEqual(Object.keys(row).sort(), ["hint", "key", "label", "word"]);
  }
}

// ── F1: the line under the rows, and the footer's one button ─────────
assert.deepEqual(connectLine({ running: "install.gh", signInEnd: null, complete: false }), {
  state: "running",
  text: "Installing the GitHub command…",
});
assert.equal(connectLine({ running: "login.gh", signInEnd: null, complete: false })?.text, "Waiting for you to approve on GitHub…");
assert.equal(connectLine({ running: "add-account.gh", signInEnd: null, complete: true })?.text, "Waiting for you to approve on GitHub…");
assert.equal(connectLine({ running: "setupgit.gh", signInEnd: null, complete: false }), null, "the run's own line");
assert.equal(
  connectLine({ running: null, signInEnd: "expired", complete: false })?.text,
  "That code expired before GitHub had your approval. Nothing was changed.",
);
assert.equal(connectLine({ running: null, signInEnd: "stopped", complete: false })?.text, "You stopped the sign-in. Nothing was changed.");
assert.deepEqual(connectLine({ running: null, signInEnd: null, complete: true }), { state: "done", text: "GitHub is connected on this Mac." });
assert.equal(connectLine({ running: null, signInEnd: null, complete: false }), null);

{
  const foot = (over: Partial<Parameters<typeof connectFooter>[0]>) =>
    connectFooter({ reported: true, running: false, parts: ["install", "signin", "helper"], failed: false, signInEnd: null, ...over });
  assert.equal(foot({}), "connect");
  assert.equal(foot({ running: true }), null, "while it runs the footer has no filled button");
  assert.equal(foot({ parts: [] }), "continue");
  assert.equal(foot({ reported: false }), "continue", "before the doctor answers, as before");
  assert.equal(foot({ failed: true }), "try-again", "after an error: no second consent");
  assert.equal(foot({ signInEnd: "expired", parts: ["signin", "helper"] }), "new-code");
  assert.equal(foot({ signInEnd: "stopped", parts: ["signin", "helper"] }), "connect", "the person stopped it: asked again");
  assert.equal(foot({ parts: ["helper"] }), "connect", "connected, Git's part left");
  assert.deepEqual(FOOTER_LABEL, {
    continue: "Continue",
    connect: "Connect GitHub",
    "try-again": "Try again",
    "new-code": "Get a new code",
  });
}

// 1.176.1: a command the installer needed wasn't found.
{
  const e = ghInstallFailure("install.gh", "failed", "brew install gh", [], { cause: "command-not-found", causePath: "brew" }, true)!;
  assert.equal(e.happened, "The GitHub command's installer needed the brew command and couldn't find it.");
  assert.match(e.todo, /Program folders/);
}
// 1.176.1 walk: missing while Program folders is set — no install command.
{
  const row = ghRow({ id: "gh", found: false, installCmd: ZIP }, true, false, true);
  assert.deepEqual([row.state, row.hint, row.command, row.programFolders], ["missing", "Not in your Program folders.", null, true]);
}
// 1.176.4: what Connect GitHub downloads, from where.
assert.equal(connectDownloadLine(false, "zip"), null, "nothing is downloaded when the command is there");
assert.match(connectDownloadLine(true, "zip") ?? "", /from GitHub.*checksum/);
assert.match(connectDownloadLine(true, "brew") ?? "", /Homebrew/);
assert.match(connectDownloadLine(true, "winget") ?? "", /winget/);
assert.doesNotMatch(connectDownloadLine(true, "zip") ?? "", /Windows/);
console.log("githubStep: ok");
