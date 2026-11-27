// Tier 3 pure-function test (OB-10, ONBOARDING_SPEC §5 step 6, §12). Run with Node 22+:
//   node --experimental-strip-types src/lib/teamStep.test.ts
import assert from "node:assert/strict";
import type { JoinPreview, JoinProblem } from "../ipc.ts";
import {
  CONNECT_FIRST,
  accountChoices,
  copiedToast,
  createBlocker,
  createError,
  createSheet,
  askOwnerToInvite,
  detectedTeamRow,
  detectionLine,
  getProjectsLabel,
  onlyProjectToGet,
  halfStateLine,
  isFieldProblem,
  joinProblemError,
  joinSheet,
  joinedLine,
  joinedToast,
  replaceSheet,
  ssoFromText,
  teamScreen,
  workspaceInviteSheet,
} from "./teamStep.ts";

const facts = {
  repo: "mb-adv/ply-team",
  url: "https://github.com/mb-adv/ply-team",
  name: "MB Adv",
  repoOwner: "mb-adv",
  repoOwnerIsOrg: false,
  manifestOwner: "mb-adv",
  private: true,
  login: "mb-member",
};
const problem = (kind: JoinProblem["kind"], over: Partial<JoinProblem> = {}): JoinProblem => ({
  kind,
  words: "words",
  org: null,
  repo: "mb-adv/ply-team",
  accepted: false,
  details: null,
  ...over,
});

// ── The screen ───────────────────────────────────────────────────────────
assert.equal(CONNECT_FIRST, "Connect GitHub first.");
assert.equal(teamScreen({ joined: true, githubConnected: false }), "joined");
assert.equal(teamScreen({ joined: false, githubConnected: null }), "checking");
assert.equal(teamScreen({ joined: false, githubConnected: false }), "needs-github");
assert.equal(teamScreen({ joined: false, githubConnected: true }), "choose");

assert.equal(joinedLine("MB Adv", "mb-adv/ply-team"), "You're in “MB Adv”.");
assert.equal(joinedLine(null, "mb-adv/ply-team"), "You're in “mb-adv/ply-team”.");
assert.equal(joinedLine(null, null), "You're in a team.");
assert.equal(
  halfStateLine("no_repo_access"),
  "The owner listed you, but GitHub hasn't given you access yet. Ask them to check your invitation.",
);
assert.equal(halfStateLine("not_listed"), "You can read the team's repository, but its owner hasn't added you to the team.");
assert.equal(halfStateLine("member"), null);
assert.equal(halfStateLine(null), null);

// ── Detection ────────────────────────────────────────────────────────────
assert.deepEqual(detectedTeamRow({ repo: "mb-adv/ply-team", name: "MB Adv", owner: "test-owner", current: false }), {
  title: "“MB Adv” lists you as a member",
  hint: "mb-adv/ply-team, by test-owner, on GitHub.",
  action: "Join MB Adv",
});
// U5: the owner's own team, whatever the case of the login; no "by".
assert.deepEqual(detectedTeamRow({ repo: "test-owner/ply-team", name: "MB Adv", owner: "test-owner", current: false }, "Test-Owner"), {
  title: "Your team “MB Adv”",
  hint: "test-owner/ply-team, on GitHub.",
  action: "Join MB Adv",
});
// U5: the manifest's claim alone isn't enough: the repository is under another account.
assert.equal(detectedTeamRow({ repo: "mb-adv/ply-team", name: "MB Adv", owner: "ana", current: false }, "ana").title, "“MB Adv” lists you as a member");
// U4: never "Ask {themselves}".
const ask = (over = {}) => askOwnerToInvite({ isOwner: false, ownerLogin: "own", login: "ana", accountLogin: "ana", ...over });
assert.equal(ask(), "Ask own to invite people.");
assert.equal(ask({ isOwner: true }), null);
assert.equal(ask({ login: null }), null, "not read yet");
assert.equal(ask({ login: "own" }), null);
assert.equal(ask({ login: "other", accountLogin: "OWN" }), null, "the owner with another GitHub account active");
assert.equal(ask({ ownerLogin: null }), "Ask your team's owner to invite people.");
// U19: a member already in it isn't told they're invited.
assert.equal(detectedTeamRow({ repo: "mb-adv/ply-team", name: "MB Adv", owner: "test-owner", current: false }, "ana").title, "“MB Adv” lists you as a member");
assert.equal(detectionLine({ teams: [], scanned: 12, truncated: false, unanswered: 0 }), "No team found that lists you yet.");
assert.equal(detectionLine({ teams: [], scanned: 100, truncated: true, unanswered: 0 }), "No team found in your 100 most recent repositories.");
assert.equal(detectionLine({ teams: [], scanned: 10, truncated: false, unanswered: 3 }), "No team found. GitHub didn't answer for 3 of 10 repositories.");
assert.equal(detectionLine({ teams: [{}], scanned: 10, truncated: false, unanswered: 0 }), null);
assert.equal(
  detectionLine({ teams: [{}], scanned: 100, truncated: true, unanswered: 40, timedOut: true }),
  "Plyloft stopped looking after 30 seconds: 40 of 100 repositories weren't checked. Look again, or paste your invite code.",
);
assert.deepEqual(
  accountChoices([
    { login: "b", active: false, state: "signed-in" },
    { login: "a", active: true, state: "signed-in" },
    { login: "c", active: false, state: "refused" },
  ]),
  ["a", "b"],
);

// ── The Join sheet ───────────────────────────────────────────────────────
const ready: JoinPreview = {
  kind: "ready",
  team: facts,
  workspaceInvites: [{ id: 7, repo: "mb-adv/app", inviter: "mb-adv" }],
  replaces: null,
  alreadyIn: false,
  calls: ["gh api repos/mb-adv/ply-team/contents/team.json"],
};
const readySheet = joinSheet(ready)!;
assert.equal(readySheet.title, "Join the team at mb-adv/ply-team?");
assert.deepEqual(readySheet.lines, [
  "The team is the private repository mb-adv/ply-team on GitHub, owned by mb-adv.",
  "It calls itself “MB Adv”.",
  "Joining lets your agents use the team's skills and notes, and shows the team's projects so you can pick which to get.",
]);
// A hostile team: the manifest claims a name and an owner it isn't. The
// title is the repository, the owner GitHub's, the claims said as claims.
const hostile = joinSheet({
  ...ready,
  team: { ...facts, repo: "evil/ply-team", url: "https://github.com/evil/ply-team", repoOwner: "evil", manifestOwner: "mb-adv" },
} as JoinPreview)!;
assert.equal(hostile.title, "Join the team at evil/ply-team?");
assert.deepEqual(hostile.lines.slice(0, 3), [
  "The team is the private repository evil/ply-team on GitHub, owned by evil.",
  "It calls itself “MB Adv”.",
  "team.json names mb-adv as the team's owner.",
]);
assert.deepEqual(readySheet.accepts, ["Plyloft will accept your GitHub invitation to mb-adv/app."]);
assert.ok(readySheet.details.includes("https://github.com/mb-adv/ply-team"));
assert.ok(readySheet.details.includes("Team owner (team.json): mb-adv"));
assert.ok(readySheet.details.includes("gh api repos/mb-adv/ply-team/contents/team.json"));

const invited: JoinPreview = {
  kind: "invited",
  team: { ...facts, name: null, manifestOwner: null, private: null },
  invitation: { id: 12, inviter: "mb-friend", inviterNotOwner: true },
  replaces: null,
  calls: [],
};
const invitedSheet = joinSheet(invited)!;
assert.equal(invitedSheet.title, "Join the team at mb-adv/ply-team?");
assert.ok(!invitedSheet.lines.some((l) => l.startsWith("It calls itself")));
assert.deepEqual(invitedSheet.accepts, ["Plyloft will accept your GitHub invitation to mb-adv/ply-team."]);
assert.ok(invitedSheet.lines.includes("Invited by mb-friend, not the team's owner."));
assert.ok(invitedSheet.lines.includes("Plyloft reads the team's member list right after, and stops if it doesn't list you."));
assert.ok(invitedSheet.details.includes("Team owner (team.json): read after joining"));
// A public team repository is said so.
const publicSheet = joinSheet({ ...ready, team: { ...facts, private: false } } as JoinPreview)!;
assert.equal(publicSheet.lines[0], "The team is the repository mb-adv/ply-team on GitHub. It is public: anyone can read the team's library. Its owner is mb-adv.");
assert.equal(joinSheet({ kind: "problem", problem: problem("no-access") }), null);

const replace = replaceSheet({ repo: "other/team", name: "Other team" }, "mb-adv/ply-team");
assert.equal(replace.lede, "This Mac is in “Other team”. Joining mb-adv/ply-team replaces it.");
assert.equal(
  replace.kept,
  "Your projects from “Other team”, their folders and everything on GitHub stay as they are. Plyloft stops following “Other team”.",
);
assert.equal(replace.confirm, "Join mb-adv/ply-team");

const wsSheet = workspaceInviteSheet([{ id: 1, repo: "mb-adv/app", inviter: "mb-adv" }]);
assert.deepEqual(wsSheet, {
  title: "Accept the invitation?",
  lines: ["Plyloft will accept your GitHub invitation to mb-adv/app (from mb-adv)."],
  confirm: "Accept and get it",
});

// ── Failures ─────────────────────────────────────────────────────────────
assert.ok(isFieldProblem(problem("not-a-code")));
assert.ok(isFieldProblem(problem("newer-version")));
assert.ok(!isFieldProblem(problem("no-access")));

const sso = joinProblemError(problem("sso", { org: "acme", words: "Your organization “acme” needs you to authorize the GitHub command for single sign-on." }));
assert.deepEqual(sso.actions.map((a) => a.id), ["authorise", "check"]);
assert.equal(sso.actions.filter((a) => a.primary).length, 1);
assert.equal(joinProblemError(problem("offline")).title, "You're offline.");
assert.deepEqual(joinProblemError(problem("offline")).actions.map((a) => a.label), ["Look again"]);
assert.deepEqual(joinProblemError(problem("signed-out")).actions.map((a) => a.label), ["Go to GitHub"]);
assert.deepEqual(joinProblemError(problem("expired")).actions, []);
assert.deepEqual(joinProblemError(problem("not-a-team")).actions, []);
assert.equal(joinProblemError(problem("no-access")).untouched, "Nothing was changed.");
assert.equal(
  joinProblemError(problem("not-a-team", { accepted: true })).untouched,
  "Only GitHub's invitation was accepted. Plyloft didn't join the team, and nothing else was changed.",
);
for (const kind of ["no-access", "not-listed", "sso", "offline", "rate-limited", "other", "invitation-gone"] as const) {
  const e = joinProblemError(problem(kind, { org: "acme" }));
  assert.ok(e.actions.length <= 2, kind);
  assert.ok(e.actions.filter((a) => a.primary).length <= 1, kind);
  assert.ok(e.todo.length > 0 && e.title.endsWith("."), kind);
}

assert.deepEqual(ssoFromText("HTTP 403 … (https://github.com/orgs/acme/sso?authorization_request=A)"), { org: "acme" });
assert.deepEqual(ssoFromText("Resource protected by organization SAML enforcement"), { org: null });
assert.equal(ssoFromText("HTTP 404: Not Found"), null);
assert.deepEqual(ssoFromText("https://github.com/orgs/-bad-/sso SAML"), { org: null });

// ── After joining, create, copy ──────────────────────────────────────────
assert.deepEqual(
  joinedToast({
    kind: "joined",
    repo: "mb-adv/ply-team",
    name: "MB Adv",
    acceptedInvitation: true,
    workspaces: { accepted: ["mb-adv/app"], failed: [{ repo: "mb-adv/site", words: "x" }], pending: [] },
    replaced: "other/team",
  }),
  {
    title: "You're in “MB Adv”.",
    body: "Plyloft no longer follows other/team. Accepted the invitations to mb-adv/app. Couldn't accept the invitations to mb-adv/site. Pick the team's projects you want on this Mac.",
  },
);
assert.equal(getProjectsLabel(1), "Get 1 project");
assert.equal(getProjectsLabel(3), "Get 3 projects");

// The only project left to get, new to this computer, starts ticked.
{
  const fresh = (repo: string, over = {}) => ({ repo, registered: false, cloned: false, conflict: null, ...over });
  assert.equal(onlyProjectToGet([]), null);
  assert.equal(onlyProjectToGet([fresh("o/a")]), "o/a");
  assert.equal(onlyProjectToGet([fresh("o/a"), fresh("o/b")]), null, "several: the person picks");
  assert.equal(onlyProjectToGet([fresh("o/a"), fresh("o/b", { registered: true, cloned: true })]), "o/a", "one already added");
  assert.equal(onlyProjectToGet([fresh("o/a"), fresh("o/b", { conflict: "Taken" })]), "o/a", "one can't be got");
  assert.equal(onlyProjectToGet([fresh("o/a", { conflict: "Taken" })]), null);
  // Getting a project whose folder is gone again loses its copies: a deliberate tick.
  assert.equal(onlyProjectToGet([fresh("o/a", { registered: true })]), null);
  assert.equal(onlyProjectToGet([fresh("o/a"), fresh("o/b", { registered: true })]), null, "that one counts as one to get");
  assert.equal(onlyProjectToGet([fresh("o/a", { registered: true, folderPresent: true })]), null, "there, and not a repository");
}

assert.deepEqual(createSheet("MB Adv", "test-owner/mb-adv-team"), {
  title: "Create the team “MB Adv”?",
  lede: "Plyloft will create the private repository test-owner/mb-adv-team on GitHub, with the team's member list and an empty library. You'll be its owner.",
  confirm: "Create team",
});
assert.equal(createBlocker("MB Adv", "a/b", null), "Plyloft couldn't read your GitHub account.");
assert.equal(createBlocker(" ", "a/b", "me"), "Give the team a name.");
assert.equal(createBlocker("MB", "", "me"), "Give the team's repository a name (owner/name).");
assert.equal(createBlocker("MB", "a/../b", "me"), "The repository must be owner/name on GitHub.");
assert.equal(createBlocker("MB", "a/b c", "me"), "The repository must be owner/name on GitHub.");
assert.equal(createBlocker("MB", "me/mb-team", "me"), null);
assert.equal(copiedToast("MB Adv").title, "Invite copied");
assert.ok(copiedToast("MB Adv").body.includes("nothing secret"));

const exists = createError("me/x-team already exists on GitHub and isn't an unfinished team Plyloft started.");
assert.equal(exists.title, "The team wasn't created.");
assert.deepEqual(exists.actions, []);
const ssoCreate = createError("HTTP 403 SAML (https://github.com/orgs/acme/sso?x=1)");
assert.equal(ssoCreate.happened, "Your organization “acme” needs you to authorize the GitHub command for single sign-on.");
assert.deepEqual(ssoCreate.actions.map((a) => a.id), ["authorise"]);

console.log("teamStep: ok");
