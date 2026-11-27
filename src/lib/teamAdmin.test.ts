import assert from "node:assert/strict";
import {
  createTeamBlocker,
  createTeamGate,
  READING_GITHUB_ACCOUNT,
  discoverySummary,
  grantingSteps,
  unresolvedSteps,
  inviteOutcomeSummary,
  invitePlanSummary,
  isGithubLogin,
  isRepoSlug,
  slugifyTeamName,
  suggestTeamRepo,
  invitationNote,
  workspaceGivenNote,
  everyonesAccess,
  everyonesAccessSummary,
  everyonesAccessSent,
  inviteSendLabel,
  NO_ACCOUNT_CHIP,
  noAccountSteps,
  workspacesToGive,
  memberStateChip,
  memberStateHint,
  removalClaimsNote,
  removalLede,
  removeOutcomeSummary,
  shortDay,
  nothingToDo,
  removalLeftUnfinished,
  statesAfterRemoval,
} from "./teamAdmin.ts";
import type { InvitePlan, InviteStep, MemberStateView, RemoveOutcome } from "../ipc.ts";

// ── The suggestion must match the backend's ───────────────────────────
//
// Three implementations of one slugify — this file, `team_admin.rs` and
// `scripts/team-init.sh` — is two too many, so the TypeScript one is only a
// preview: an empty repo field sends "" and the backend fills in its own
// answer. These are the same vectors `team_admin_tests.rs` asserts, so a
// drift shows up here rather than as two different repository names for the
// same team.

assert.equal(slugifyTeamName("MB Adv"), "mb-adv");
assert.equal(slugifyTeamName("  Two   Words!! "), "two-words");
assert.equal(slugifyTeamName("---"), "");
assert.equal(suggestTeamRepo("MatteoB-adv", "MB Adv"), "MatteoB-adv/mb-adv-team");
// F6 (team walk): a name already ending in "team" is not doubled.
assert.equal(suggestTeamRepo("test-owner", "Plyloft test team"), "test-owner/plyloft-test-team");
assert.equal(suggestTeamRepo("o", "Team"), "o/team");
assert.equal(suggestTeamRepo("o", "The A-Team!"), "o/the-a-team");
assert.equal(suggestTeamRepo("o", "Dreamteam"), "o/dreamteam-team");
assert.equal(suggestTeamRepo("o", "Teams"), "o/teams-team");
assert.equal(suggestTeamRepo("MatteoB-adv", "!!!"), "");
assert.equal(suggestTeamRepo(null, "MB Adv"), "");

// ── The shapes GitHub accepts ─────────────────────────────────────────

for (const good of ["owner/name", "MatteoB-adv/atelier", "a/b.c-d_e"]) {
  assert.equal(isRepoSlug(good), true, good);
}
for (const bad of ["", "owner", "a/b/c", "../etc", "owner/", "a b/c"]) {
  assert.equal(isRepoSlug(bad), false, bad);
}
for (const good of ["minidev", "MatteoB-adv", "a"]) {
  assert.equal(isGithubLogin(good), true, good);
}
for (const bad of ["", "-lead", "trail-", "a--b", "a b", "a_b", "x".repeat(40)]) {
  assert.equal(isGithubLogin(bad), false, bad);
}

// ── Create team: the button is not offered when it could only fail ────
//
// A name is the only required field. An empty repo is not an error — it
// means "use the suggestion" — but a name that suggests nothing is.

assert.equal(createTeamBlocker("MB Adv", "", "MatteoB-adv"), null);
assert.equal(createTeamBlocker("MB Adv", "MatteoB-adv/team", "MatteoB-adv"), null);
assert.match(createTeamBlocker("", "", "MatteoB-adv") ?? "", /name/);
assert.match(createTeamBlocker("MB Adv", "", null) ?? "", /GitHub login/);
assert.match(createTeamBlocker("MB Adv", "nonsense", "MatteoB-adv") ?? "", /owner\/name/);
assert.match(createTeamBlocker("!!!", "", "MatteoB-adv") ?? "", /cannot suggest/);

// F7: while the account is being read, Create waits and says so — no error.
assert.deepEqual(createTeamGate(false, "MB Adv", "", null), {
  canCreate: false,
  reading: true,
  message: READING_GITHUB_ACCOUNT,
});
assert.equal(READING_GITHUB_ACCOUNT, "Reading your GitHub account…");
assert.deepEqual(createTeamGate(true, "MB Adv", "", "MatteoB-adv"), {
  canCreate: true,
  reading: false,
  message: null,
});
const unread = createTeamGate(true, "MB Adv", "", null);
assert.equal(unread.canCreate, false);
assert.equal(unread.reading, false);
assert.match(unread.message ?? "", /GitHub login/);

// ── The confirmation screen ───────────────────────────────────────────
//
// The list shows every repository the team owns; the *summary* counts only
// what would actually be granted, because that is what the owner is being
// asked to approve.

const step = (repo: string, action: InviteStep["action"]): InviteStep => ({
  repo,
  kind: repo.endsWith("-team") ? "team_repo" : "workspace",
  permission: "push",
  current: action === "grant" ? "no access" : "write",
  action,
  invitationExpires: action === "invited" ? "2026-10-09" : null,
  purpose: "…",
});

const plan: InvitePlan = {
  login: "minidev",
  teamName: "MB Adv",
  steps: [
    step("MatteoB-adv/mb-adv-team", "grant"),
    step("MatteoB-adv/atelier", "grant"),
    step("MatteoB-adv/other", "already_has"),
  ],
  addsToManifest: true,
  warnings: [],
  digest: "matteob-adv/atelier=push matteob-adv/mb-adv-team=push",
};

assert.equal(grantingSteps(plan).length, 2);
assert.equal(plan.steps.length, 3, "every repo the team owns stays on the list");
assert.match(invitePlanSummary(plan), /grant minidev write access to 2 repositories/);
assert.match(invitePlanSummary(plan), /MB Adv manifest/);

// Nothing to grant, but not yet in the manifest: still worth doing, and the
// summary says which half.
const manifestOnly: InvitePlan = {
  ...plan,
  steps: plan.steps.map((s) => ({ ...s, action: "already_has" as const })),
};
assert.match(invitePlanSummary(manifestOnly), /only add them to the team's member list/);

// Nothing to do at all.
assert.match(
  invitePlanSummary({ ...manifestOnly, addsToManifest: false }),
  /Nothing to do/,
);

// 1.174.3: the sheet offers no add only when there is truly nothing to do.
assert.equal(nothingToDo({ ...manifestOnly, addsToManifest: false }), true);
assert.equal(nothingToDo(manifestOnly), false, "new to the list: Add to the team stands");
assert.equal(nothingToDo({ ...plan, addsToManifest: false }), false, "something to grant");
assert.equal(
  nothingToDo({ ...manifestOnly, addsToManifest: false, steps: [{ ...manifestOnly.steps[0], action: "invited" as const }] }),
  true,
  "an invitation waits: nothing to send",
);
assert.equal(
  nothingToDo({ ...manifestOnly, addsToManifest: false, steps: [{ ...manifestOnly.steps[0], action: "unresolved" as const }] }),
  false,
  "GitHub didn't answer: not known",
);

// 1.174.3: Remove's own result, on the page before the read lands.
{
  const member = {
    login: "Ana",
    owner: false,
    state: "joined" as const,
    invitationExpires: null,
    invitationExpired: null,
    workspacesInvited: ["o/invited"],
    workspacesMissing: [],
  };
  const states = { members: [member], problems: [], repos: ["o/team", "o/invited", "o/kept"] };
  const after = statesAfterRemoval(states, { login: "ana", removed: ["O/Team", "o/invited"] }, "o/team");
  assert.equal(after.members[0].state, "no_access");
  assert.deepEqual(after.members[0].workspacesInvited, []);
  assert.deepEqual(after.members[0].workspacesMissing, ["o/invited"]);
  const teamRefused = statesAfterRemoval(states, { login: "ana", removed: ["o/invited"] }, "o/team");
  assert.equal(teamRefused.members[0].state, "joined", "the team repository wasn't done");
  const other = statesAfterRemoval(states, { login: "bo", removed: ["o/team"] }, "o/team");
  assert.equal(other.members[0].state, "joined");
}

// 1.174.3: only every repository done and team.json not written.
assert.equal(removalLeftUnfinished({ failed: [], manifestUpdated: false }), true);
assert.equal(removalLeftUnfinished({ failed: [], manifestUpdated: true }), false);
assert.equal(removalLeftUnfinished({ failed: ["o/r: refused"], manifestUpdated: false }), false);

// ── The outcome names every half ──────────────────────────────────────
//
// A member who is listed but missing one grant is exactly the state the
// owner has to retry, and it is invisible unless it is said out loud.

assert.match(
  inviteOutcomeSummary({
    login: "minidev",
    manifestWritten: true,
    invited: ["a/b"],
    alreadyHad: ["c/d"],
    failed: [],
  }),
  /added to the team's member list; invited to a\/b; already had c\/d/,
);
const partial = inviteOutcomeSummary({
  login: "minidev",
  manifestWritten: true,
  invited: ["a/b"],
  alreadyHad: [],
  failed: ["c/d: HTTP 403"],
});
assert.match(partial, /GitHub refused c\/d: HTTP 403/);
assert.match(partial, /safe/, "a retry is idempotent and the owner should know");
assert.match(partial, /press Add somebody again to retry/, "the control's name");
assert.match(
  inviteOutcomeSummary({
    login: "minidev",
    manifestWritten: false,
    invited: [],
    alreadyHad: [],
    failed: [],
  }),
  /nothing needed changing/,
);

// ── A scan says what it looked at ─────────────────────────────────────
//
// "Nothing found" and "nothing was looked at" are different answers, and a
// probe GitHub could not answer is neither.

assert.match(
  discoverySummary({ proposals: [], scanned: 0, unchecked: 0, alreadyListed: 0 }),
  /no repositories/,
);
const summary = discoverySummary({
  proposals: [1, 2],
  scanned: 40,
  unchecked: 3,
  alreadyListed: 1,
});
assert.match(summary, /2 to propose out of 40 scanned/);
assert.match(summary, /1 already a team workspace/);
assert.match(summary, /3 GitHub could not answer for/);


// 6th Challenger round on PR #29: an unanswered access check is unresolved,
// never a grant, and the summary tells the owner to refresh before sending.
{
  const unresolvedPlan = {
    ...plan,
    steps: [
      step("MatteoB-adv/mb-adv-team", "grant"),
      { ...step("MatteoB-adv/atelier", "grant"), action: "unresolved" as const, current: "unknown" },
    ],
  };
  assert.equal(unresolvedSteps(unresolvedPlan).length, 1);
  assert.equal(grantingSteps(unresolvedPlan).length, 1);
  assert.match(invitePlanSummary(unresolvedPlan), /could not answer for 1 of 2/);
  assert.match(invitePlanSummary(unresolvedPlan), /refresh/);
}

// ── Give the team a workspace (team walk 2026-10-01, F1) ──────────────
//
// The workspaces open on this Mac, minus what the manifest already lists and
// minus the team repo, compared the way GitHub compares slugs (no case).

{
  const offered = workspacesToGive(
    [
      { repo: "test-owner/plyloft-ci-sandbox", name: "Ship loop sandbox" },
      // Same origin, second workspace: one row, the first name.
      { repo: "TEST-owner/Plyloft-CI-Sandbox", name: "ghpr" },
      { repo: "MatteoB-adv/atelier", name: "atelier" },
      { repo: "test-owner/plyloft-test-team", name: "the team clone" },
      { repo: "not a slug", name: "broken" },
    ],
    ["matteob-adv/ATELIER"],
    "test-owner/plyloft-test-team",
  );
  assert.deepEqual(offered, [
    { repo: "test-owner/plyloft-ci-sandbox", name: "Ship loop sandbox" },
  ]);
  assert.deepEqual(workspacesToGive([], [], null), []);
  assert.match(workspaceGivenNote("a/b", 1), /Give everyone access so GitHub lets your member into it/);
  assert.match(workspaceGivenNote("a/b", 3), /the 3 members/);
  assert.doesNotMatch(workspaceGivenNote("a/b", 0), /Give everyone access/);
}
// ── After Send invites (F2) ───────────────────────────────────────────

assert.equal(
  invitationNote({ login: "friend", invited: ["owner/test-team"] }),
  "Invitation sent to friend.",
);
assert.equal(invitationNote({ login: "friend", invited: [] }), null);

// ── N14 item 1: a pending invitation is not a grant ───────────────────

{
  const waiting: InvitePlan = {
    login: "friend",
    teamName: "MB Adv",
    steps: [step("MatteoB-adv/mb-adv-team", "invited"), step("MatteoB-adv/atelier", "already_has")],
    addsToManifest: false,
    warnings: [],
    digest: "",
  };
  assert.equal(grantingSteps(waiting).length, 0);
  assert.equal(
    invitePlanSummary(waiting),
    "friend is in MB Adv. An invitation waits on them; nothing to send. Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them.",
  );
  assert.match(invitePlanSummary({ ...waiting, addsToManifest: true }), /only add them to the team's member list/);
  assert.match(
    inviteOutcomeSummary({
      login: "friend",
      manifestWritten: false,
      invited: [],
      alreadyHad: [],
      alreadyInvited: ["MatteoB-adv/mb-adv-team"],
      failed: [],
    }),
    /an invitation already waits on them for MatteoB-adv\/mb-adv-team/,
  );
}

// ── N14 items 1 and 9: Joined / Invited / No access ───────────────────

{
  assert.equal(shortDay("2026-10-09"), "9 Oct");
  assert.equal(shortDay("2026-01-31"), "31 Jan");
  assert.equal(shortDay("soon"), "soon");
  const view = (over: Partial<MemberStateView>): MemberStateView => ({
    login: "friend",
    owner: false,
    state: "joined",
    invitationExpires: null,
    invitationExpired: null,
    workspacesInvited: [],
    workspacesMissing: [],
    ...over,
  });
  assert.deepEqual(memberStateChip(view({})), { word: "Joined", tone: "ok" });
  assert.deepEqual(memberStateChip(view({ state: "invited", invitationExpires: "2026-10-09" })), {
    word: "Invited · expires 9 Oct",
    tone: "neutral",
  });
  assert.deepEqual(memberStateChip(view({ state: "no_access" })), { word: "No access", tone: "warn" });
  assert.equal(memberStateChip(view({ state: "unknown" })), null, "could not ask is never no access");

  assert.equal(memberStateHint(view({}), "o/team"), null);
  assert.equal(
    memberStateHint(view({ workspacesInvited: ["o/a"], workspacesMissing: ["o/b", "o/c"] }), "o/team"),
    "Joined the team repository. An invitation to o/a waits on them. No access to o/b and o/c yet — press Review access to invite them.",
  );
  assert.equal(
    memberStateHint(view({ state: "invited", invitationExpires: "2026-10-09" }), "o/team"),
    "Invited until 9 Oct. Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them.",
  );
  // Walk 2026-11-03: Invited means the team repository's invitation waits too.
  assert.equal(
    memberStateHint(view({ state: "invited", invitationExpires: "2026-10-09", workspacesInvited: ["o/a"] }), "o/team"),
    "Invited until 9 Oct. Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them. Invitations to o/team and o/a wait on them.",
  );
  assert.equal(
    memberStateHint(view({ workspacesInvited: ["o/a", "o/b"] }), "o/team"),
    "Joined the team repository. Invitations to o/a and o/b wait on them.",
    "joined: the team repository isn't waiting, so it isn't named",
  );
  assert.equal(
    memberStateHint(view({ state: "no_access", invitationExpired: "2026-09-08" }), "o/team"),
    "Listed in the team, but their invitation expired on 8 Sep. Press Review access to invite them again.",
  );
  assert.match(memberStateHint(view({ state: "no_access" }), "o/team") ?? "", /no invitation is waiting/);
  // Review: not "no invitation is waiting" with a workspace's waiting.
  assert.equal(
    memberStateHint(view({ state: "no_access", workspacesInvited: ["o/a"] }), "o/team"),
    "Listed in the team, but GitHub gives them no access to o/team and no invitation to it is waiting. An invitation to o/a waits on them. Press Review access to invite them.",
  );
  assert.equal(memberStateHint(view({ state: "unknown" }), "o/team"), null);
  assert.equal(memberStateHint(view({ owner: true, state: "no_access" }), "o/team"), null);
}

// ── N14 item 3: Remove from team ──────────────────────────────────────

{
  assert.match(removalLede("friend", ["o/team", "o/a"]), /friend's access to the 2 repositories below/);
  assert.match(removalLede("friend", ["o/team"]), /the 1 repository below/);
  assert.match(removalClaimsNote("friend"), /If GitHub no longer gives friend access, it takes them off their issues/);
  assert.doesNotMatch(removalClaimsNote("friend"), /keep them as assignee/);
  const base: RemoveOutcome = {
    login: "friend",
    removed: ["o/team", "o/a"],
    cancelledInvitations: ["o/a"],
    stillRead: [],
    failed: [],
    manifestUpdated: true,
    manifestError: null,
  };
  assert.deepEqual(removeOutcomeSummary(base), {
    kind: "info",
    title: "friend removed from the team",
    body: "No write access to o/team and o/a any more, and the team no longer lists them. Withdrew the invitation to o/a.",
  });
  assert.match(
    removeOutcomeSummary({ ...base, stillRead: ["o/a"] }).body,
    /They can still read o\/a\.$/,
  );
  const partial = removeOutcomeSummary({
    ...base,
    removed: ["o/team"],
    failed: ["o/a: GitHub refused to remove them (HTTP 403)"],
    manifestUpdated: false,
  });
  assert.equal(partial.kind, "error");
  assert.equal(partial.title, "friend is still in the team");
  assert.match(partial.body, /^Not done on: o\/a: GitHub refused/);
  assert.match(partial.body, /Their access to o\/team is gone/);
  assert.match(partial.body, /press Remove from team again/);
  const unpushed = removeOutcomeSummary({ ...base, manifestUpdated: false, manifestError: "offline." });
  assert.equal(unpushed.title, "friend is still listed in the team");
  assert.match(unpushed.body, /offline\. Press Remove from team again/);
}

// ── QoL 14.4 (G24): Give everyone access ──────────────────────────────
{
  const step = (action: string) => ({ repo: `o/${action}`, kind: "workspace" as const, permission: "push", current: "none", action: action as never, invitationExpires: null, purpose: "" });
  const plan = (login: string, actions: string[]) => ({ login, teamName: "T", steps: actions.map(step), addsToManifest: false, warnings: [], digest: login });
  const view = everyonesAccess([plan("a", ["grant", "grant"]), plan("b", ["none"]), plan("c", ["grant", "unresolved"])]);
  assert.deepEqual(view.ready.map((p) => p.login), ["a"]);
  assert.deepEqual(view.done.map((p) => p.login), ["b"]);
  assert.deepEqual(view.waiting.map((p) => p.login), ["c"]);
  assert.equal(view.grants, 2);
  assert.equal(
    everyonesAccessSummary(view, ["d"]),
    "1 member needs 2 grants on GitHub. GitHub didn't answer for 1 member; read it again for them. d has no seat yet: give one first.",
  );
  assert.equal(everyonesAccessSummary(everyonesAccess([plan("b", ["none"])]), []), "Every member has what the team gives them.");
  // Not "everyone has it" while someone wasn't checked or has no seat.
  assert.equal(
    everyonesAccessSummary(everyonesAccess([plan("b", ["none"])]), ["d"]),
    "Nothing to grant for the members Plyloft could check. d has no seat yet: give one first.",
  );
  const sent = everyonesAccessSent(["a", "b"], { refused: [], waiting: ["c"], noSeat: ["d"] });
  assert.equal(sent.title, "Access sent to 2 members");
  assert.match(sent.body, /in Setup › Team, under The team's projects/);
  assert.match(sent.body, /Not checked: c/);
  assert.match(sent.body, /No seat yet: d\./);
}


// A login nobody has: its own state, refused, and no obstacle to anyone else.
{
  const step = (repo: string, action: "grant" | "no_such_account" | "already_has") => ({
    repo,
    kind: "workspace" as const,
    permission: "push",
    current: "no access",
    action,
    invitationExpires: null,
    purpose: "",
  });
  const plan = (login: string, actions: ("grant" | "no_such_account" | "already_has")[]) => ({
    login,
    teamName: "T",
    steps: actions.map((a, i) => step(`o/r${i}`, a)),
    addsToManifest: true,
    warnings: [],
    digest: "",
  });
  const ghost = plan("nobody", ["no_such_account", "no_such_account"]);
  assert.equal(NO_ACCOUNT_CHIP, "no GitHub account with this name");
  assert.equal(noAccountSteps(ghost).length, 2);
  assert.equal(invitePlanSummary(ghost), "GitHub has no account named nobody. Check the spelling; Plyloft sends nothing.");
  assert.equal(
    invitePlanSummary({ ...ghost, addsToManifest: false }),
    "GitHub has no account named nobody now; it may have been renamed. Plyloft sends nothing.",
    "someone the team already lists wasn't mistyped",
  );
  assert.equal(inviteSendLabel(ghost), "Send invites", "not Add to the team: that would be only the manifest");
  assert.equal(inviteSendLabel(plan("a", ["grant"])), "Send invites");
  assert.equal(inviteSendLabel(plan("a", ["already_has"])), "Add to the team");

  const view = everyonesAccess([ghost, plan("ana", ["grant", "grant"])]);
  assert.deepEqual(view.noAccount.map((p) => p.login), ["nobody"]);
  assert.deepEqual(view.ready.map((p) => p.login), ["ana"], "she can still be sent");
  assert.equal(view.grants, 2, "the refused one adds no grant");
  assert.equal(
    everyonesAccessSummary(view, []),
    "1 member needs 2 grants on GitHub. GitHub has no account named nobody.",
  );
  assert.equal(
    everyonesAccessSummary(everyonesAccess([ghost]), []),
    "Nothing to grant for the members Plyloft could check. GitHub has no account named nobody.",
  );
  assert.match(everyonesAccessSent(["ana"], { refused: [], waiting: [], noSeat: [], noAccount: ["nobody"] }).body, /No GitHub account: nobody\./);
}

console.log("teamAdmin.test.ts ✓");
