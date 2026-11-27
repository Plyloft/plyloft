// Tier 3 pure-function test (N14 walk F16). Run with Node 22+:
//   node --experimental-strip-types src/lib/ghTrouble.test.ts
import assert from "node:assert/strict";
import {
  GH_SIGN_IN_ACTION,
  GIT_SIGN_IN_ACTION,
  ghExpiredLine,
  ghSignedOutLine,
  ghTrouble,
  isGhSignedOut,
  detailLines,
} from "./ghTrouble.ts";

const GIT_AUTH_WORDS =
  'Git couldn\'t sign in to GitHub. In Settings › Setup and account › Setup › GitHub, turn on "Git uses your GitHub sign-in", then try again.';
const GIT_SSH_AUTH_WORDS =
  "Git couldn't sign in to GitHub over SSH. Check your SSH key, or use HTTPS with the GitHub command's sign-in.";
const GH_START = "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.";

// The VM member walk (F16): the three errors a team refresh joined.
const walk = [
  `Could not pull the team repo: ${GIT_AUTH_WORDS}`,
  `Could not read your GitHub login: ${GH_START}`,
  `Could not check access to boss/team: ${GH_START}`,
].join(" ");

{
  const t = ghTrouble(walk, "read the team");
  assert.ok(t);
  assert.equal(t.kind, "gh-signed-out", "gh signed out outranks the git sign-in it causes");
  assert.equal(t.line, "The GitHub command isn't signed in on this Mac, so Plyloft can't read the team.");
  assert.equal(t.action, GH_SIGN_IN_ACTION);
  assert.equal(t.raw, walk, "the raw words are kept whole for Details");
  assert.deepEqual(t.others, [], "every error of the walk is the missing sign-in");
}

// gh's other ways of saying it.
for (const raw of [
  "You are not logged into any GitHub hosts. To log in, run: gh auth login",
  "Could not read your GitHub login: not logged in to any hosts",
]) {
  assert.equal(isGhSignedOut(raw), true, raw);
  assert.equal(ghTrouble(raw)?.kind, "gh-signed-out", raw);
}
// "authentication required" alone is not gh signed out (Challenger P3-1).
assert.equal(isGhSignedOut("remote: authentication required for the github host"), false);
assert.equal(ghTrouble("Could not pull the team repo: authentication required, try gh later"), null);

// A sign-in GitHub no longer accepts: expired or revoked (Challenger P3-2).
for (const raw of [
  "Could not read your GitHub login: HTTP 401: Bad credentials (https://api.github.com/user)\nTry authenticating with:  gh auth login",
  "The token in default is invalid.\n  - To re-authenticate, run: gh auth login -h github.com",
]) {
  const t = ghTrouble(raw, "read the team");
  assert.equal(t?.kind, "gh-expired", raw);
  assert.equal(t?.line, "The GitHub command's sign-in on this Mac has expired or was revoked, so Plyloft can't read the team.");
  assert.equal(t?.action, GH_SIGN_IN_ACTION);
}
assert.equal(ghExpiredLine(), "The GitHub command's sign-in on this Mac has expired or was revoked.");

// Distinct errors alongside are not folded into the line (Challenger P3-2).
{
  const raw = `Could not read your GitHub login: ${GH_START} Could not read team.json: HTTP 404: Not Found`;
  const t = ghTrouble(raw, "read the team");
  assert.equal(t?.kind, "gh-signed-out");
  assert.deepEqual(t?.others, ["Could not read team.json: HTTP 404: Not Found"]);
}
assert.equal(ghSignedOutLine(), "The GitHub command isn't signed in on this Mac.");
assert.equal(ghTrouble("Could not read your GitHub login: x")?.line, undefined);

// Git couldn't sign in (GCM): its own words, Setup › GitHub as the way out.
{
  const raw = `Could not pull the team repo: ${GIT_AUTH_WORDS} Could not read team.json: missing`;
  const t = ghTrouble(raw, "read the team");
  assert.ok(t);
  assert.equal(t.kind, "git-sign-in");
  assert.equal(t.line, GIT_AUTH_WORDS);
  assert.equal(t.action, GIT_SIGN_IN_ACTION);
  assert.equal(t.raw, raw);
  assert.deepEqual(t.others, ["Could not read team.json: missing"]);
}
// Walk follow-ups 2026-10-19: `team::sign_in_advice` gives git's words for
// gh itself signed out (`GIT_AUTH_GH_SIGNED_OUT_WORDS`). Beside gh's own words
// they are explained by gh's line; alone, their way out is gh's sign-in.
{
  const GH_OUT_WORDS =
    "Git couldn't sign in to GitHub because the GitHub command isn't signed in on this PC. In Settings › Setup and account › Setup › GitHub, sign in to GitHub, then try again.";
  const beside = ghTrouble(
    `Could not pull the team repo: ${GH_OUT_WORDS} Could not read your GitHub login: gh: Requires authentication (HTTP 401)`,
    "read the team",
  );
  assert.equal(beside?.kind, "gh-signed-out");
  assert.deepEqual(beside?.others, []);
  assert.equal(beside?.action, GH_SIGN_IN_ACTION);
  const alone = ghTrouble(`Could not pull the team repo: ${GH_OUT_WORDS}`);
  assert.equal(alone?.kind, "git-sign-in");
  assert.equal(alone?.line, GH_OUT_WORDS);
  assert.equal(alone?.action, GH_SIGN_IN_ACTION);
}
// Over SSH: the key, so no Setup action.
{
  const t = ghTrouble(`Could not pull the team repo: ${GIT_SSH_AUTH_WORDS}`);
  assert.ok(t);
  assert.equal(t.kind, "git-sign-in");
  assert.equal(t.line, GIT_SSH_AUTH_WORDS);
  assert.equal(t.action, null);
}

// Anything else stays as it is.
for (const raw of [
  null,
  undefined,
  "",
  "   ",
  "Could not pull the team repo: GitHub didn't answer in time.",
  "Could not check access to boss/team: HTTP 404: Not Found",
]) {
  assert.equal(ghTrouble(raw), null, String(raw));
}

// N14 walk F16b (Windows VM, 2026-10-02 21:07): the team joined with an
// account gh doesn't have signed in. The team scope says Plyloft's words
// (`github_account::team_words`) for every call, so they arrive three times.
const TEAM_WORDS =
  "Your team uses the GitHub account test-owner, which isn't signed in on this PC. Sign it in in Setup's GitHub step, or leave the team and join it again with another account.";
const f16b = [
  `Could not pull the team repo: git fetch: ${TEAM_WORDS}`,
  `Could not read your GitHub login: ${TEAM_WORDS}`,
  `Could not check access to test-owner/plyloft-test-team: ${TEAM_WORDS}`,
].join(" ");
{
  const t = ghTrouble(f16b, "read the team");
  assert.ok(t);
  assert.equal(t.kind, "gh-signed-out");
  assert.equal(t.account, "test-owner");
  assert.equal(t.line, "The GitHub account test-owner isn't signed in on this Mac, so Plyloft can't read the team.");
  assert.equal(t.action, GH_SIGN_IN_ACTION);
  assert.deepEqual(t.others, []);
  assert.equal(t.raw, f16b);
  // Details: the reason once, then what it stopped.
  assert.deepEqual(t.details, [
    TEAM_WORDS,
    "  Could not pull the team repo (git fetch)",
    "  Could not read your GitHub login",
    "  Could not check access to test-owner/plyloft-test-team",
  ]);
}
// The same on a Mac, a workspace's wording, and beside gh's own words.
for (const raw of [
  f16b.split("this PC").join("this Mac"),
  "Could not read your GitHub login: This workspace uses the GitHub account work-acct, which isn't signed in on this computer. Sign it in in Setup's GitHub step, or pick another account in Settings › Setup and account › Setup › Account for each project.",
  `Could not read your GitHub login: Your team uses the GitHub account work-acct, which isn't signed in on this Mac. Sign it in in Setup's GitHub step, or leave the team and join it again with another account. Could not check access to boss/team: ${GH_START}`,
]) {
  const t = ghTrouble(raw, "read the team");
  assert.equal(t?.kind, "gh-signed-out", raw);
  assert.match(t!.line, /^The GitHub account [\w-]+ isn't signed in on this Mac, so Plyloft can't read the team\.$/);
  assert.deepEqual(t?.others, [], raw);
}
// A distinct error beside it still shows.
{
  const t = ghTrouble(`Could not read your GitHub login: ${TEAM_WORDS} Could not read team.json: HTTP 404: Not Found`);
  assert.equal(t?.account, "test-owner");
  assert.deepEqual(t?.others, ["Could not read team.json: HTTP 404: Not Found"]);
  assert.deepEqual(t?.details, [TEAM_WORDS, "  Could not read your GitHub login", "Could not read team.json: HTTP 404: Not Found"]);
}
// team_words' other variant: gh not installed.
{
  const words =
    "Your team uses the GitHub account test-owner, and the GitHub CLI isn't installed. Set it up in Setup's GitHub step.";
  const t = ghTrouble(`Could not read your GitHub login: ${words} Could not check access to a/b: ${words}`, "read the team");
  assert.equal(t?.kind, "gh-missing");
  assert.equal(t?.line, "The GitHub command isn't installed on this Mac, so Plyloft can't read the team.");
  assert.equal(t?.action, GIT_SIGN_IN_ACTION);
  assert.deepEqual(t?.details, [words, "  Could not read your GitHub login", "  Could not check access to a/b"]);
}
// Details dedupe identical errors in every case.
assert.deepEqual(detailLines("Could not a: x Could not a: x Could not b: y"), ["Could not a: x", "Could not b: y"]);
assert.deepEqual(ghTrouble(walk)?.details, walk.split(/\s+(?=Could not )/));

// F16c (Windows VM, 2026-10-05): gh's config still names the team's account,
// but gh has no readable token for it — GitHub answers gh's tokenless request
// "Requires authentication (HTTP 401)", and git (its helper had nothing)
// couldn't sign in. With the team's account known, one line names it.
const F16C = [
  `Could not pull the team repo: ${GIT_AUTH_WORDS}`,
  "Could not read your GitHub login: gh: Requires authentication (HTTP 401)",
].join(" ");
{
  const t = ghTrouble(F16C, "read the team", { account: "test-user" });
  assert.ok(t);
  assert.equal(t.kind, "gh-signed-out");
  assert.equal(t.account, "test-user");
  assert.equal(
    t.line,
    "The GitHub account test-user isn't signed in on this Mac, so Plyloft can't read the team.",
  );
  assert.equal(t.action, GH_SIGN_IN_ACTION);
  assert.deepEqual(t.others, [], "nothing raw outside Details");
  assert.deepEqual(t.details, [
    `Could not pull the team repo: ${GIT_AUTH_WORDS}`,
    "Could not read your GitHub login: gh: Requires authentication (HTTP 401)",
  ]);
  // Without the account: still gh signed out (no token sent is not "expired").
  const bare = ghTrouble(F16C, "read the team");
  assert.equal(bare?.kind, "gh-signed-out");
  assert.equal(bare?.line, "The GitHub command isn't signed in on this Mac, so Plyloft can't read the team.");
  assert.deepEqual(bare?.others, []);
}
// gh auth status's form of the same answer.
assert.equal(isGhSignedOut("HTTP 401: Requires authentication (https://api.github.com/)"), true);
// gh's "gh auth login", with the account known: that account isn't signed in.
{
  const raw = `Could not pull the team repo: ${GIT_AUTH_WORDS} Could not read your GitHub login: ${GH_START}`;
  const t = ghTrouble(raw, "read the team", { account: "test-user" });
  assert.equal(t?.kind, "gh-signed-out");
  assert.equal(t?.account, "test-user");
  assert.equal(
    t?.line,
    "The GitHub account test-user isn't signed in on this Mac, so Plyloft can't read the team.",
  );
  assert.deepEqual(t?.others, []);
}
// A sign-in GitHub refuses, with the account known: expired, naming it.
for (const raw of [
  `Could not pull the team repo: ${GIT_AUTH_WORDS} Could not read your GitHub login: gh: Bad credentials (HTTP 401)`,
  "Could not read your GitHub login: HTTP 401: Bad credentials (https://api.github.com/user)\nTry authenticating with:  gh auth login",
]) {
  const t = ghTrouble(raw, "read the team", { account: "test-user" });
  assert.equal(t?.kind, "gh-expired", raw);
  assert.equal(t?.account, "test-user", raw);
  assert.equal(
    t?.line,
    "The GitHub account test-user's sign-in on this Mac has expired or was revoked, so Plyloft can't read the team.",
    raw,
  );
  assert.equal(t?.action, GH_SIGN_IN_ACTION);
  assert.deepEqual(t?.others, [], raw);
}
// Git over SSH beside gh signed out: its own line, never folded into gh's.
{
  const raw = `Could not pull the team repo: ${GIT_SSH_AUTH_WORDS} Could not read your GitHub login: gh: Requires authentication (HTTP 401)`;
  const t = ghTrouble(raw, "read the team", { account: "test-user" });
  assert.equal(t?.kind, "gh-signed-out");
  assert.deepEqual(t?.others, [`Could not pull the team repo: ${GIT_SSH_AUTH_WORDS}`]);
  assert.deepEqual(ghTrouble(raw, "read the team")?.others, [`Could not pull the team repo: ${GIT_SSH_AUTH_WORDS}`]);
}
// A bare refused token without the account: expired, as before.
assert.equal(ghTrouble("Could not read your GitHub login: gh: Bad credentials (HTTP 401)")?.kind, "gh-expired");
// git's own prompt words (not yet turned into GIT_AUTH_WORDS) fold in too.
{
  const raw =
    "Could not pull the team repo: git fetch failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled Could not read your GitHub login: gh: Requires authentication (HTTP 401)";
  const t = ghTrouble(raw, "read the team", { account: "test-user" });
  assert.equal(t?.kind, "gh-signed-out");
  assert.deepEqual(t?.others, []);
}
// Each raw message once in Details.
{
  const once = "Could not read your GitHub login: gh: Requires authentication (HTTP 401)";
  const t = ghTrouble(`${once} ${once} Could not pull the team repo: ${GIT_AUTH_WORDS}`, "read the team", {
    account: "test-user",
  });
  assert.deepEqual(t?.details, [once, `Could not pull the team repo: ${GIT_AUTH_WORDS}`]);
}
// gh signed in, git (GCM) couldn't answer: F16's own words, even with the
// account known — the GitHub CLI isn't the problem.
{
  const raw = `Could not pull the team repo: ${GIT_AUTH_WORDS}`;
  const t = ghTrouble(raw, "read the team", { account: "test-user" });
  assert.equal(t?.kind, "git-sign-in");
  assert.equal(t?.line, GIT_AUTH_WORDS);
  assert.equal(t?.action, GIT_SIGN_IN_ACTION);
  assert.equal(t?.account, null);
}
// git's "Authentication required" is not GitHub's "Requires authentication".
assert.equal(isGhSignedOut("remote: Authentication required. fatal: Authentication failed"), false);
// An account that isn't a login is ignored (gh's own line).
assert.equal(ghTrouble(F16C, "read the team", { account: "not a login" })?.account, null);
// Plyloft's own account words still win (they name the account themselves).
{
  const raw =
    "Could not read your GitHub login: Your team uses the GitHub account work-acct, which isn't signed in on this Mac. Sign it in in Setup's GitHub step, or leave the team and join it again with another account.";
  assert.equal(ghTrouble(raw, "read the team", { account: "other" })?.account, "work-acct");
}

console.log("ghTrouble: ok");
