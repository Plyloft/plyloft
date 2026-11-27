/**
 * v1.118.0 (team sharing rung 5): the rules the Team panel's owner-side
 * controls follow, kept out of JSX so they can be stated once and tested.
 *
 * The authority for every one of these is the backend — `team_admin.rs`
 * validates the Create-team form again, rebuilds the invite plan itself and
 * refuses to grant anything the owner did not read. What lives here is the
 * part the owner sees *while typing*: a live suggestion, and a button that
 * is not offered when it could only be refused.
 */

import type { InvitePlan, InviteStep, MemberStates, MemberStateView, RemoveOutcome } from "../ipc";

/**
 * `scripts/team-init.sh`'s `slugify`, and `team_admin::slugify`, in
 * TypeScript: lowercase, every run of non-alphanumerics collapsed to one
 * hyphen, none at either end.
 *
 * Three implementations of one rule is two too many, so this one is
 * deliberately only a **preview**: leaving the repo field blank sends the
 * empty string and the backend fills in its own answer. The test below
 * shares its vectors with `team_admin_tests.rs`, so a drift is visible
 * rather than silent.
 */
export function slugifyTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** The team repo Ply would create for this name, or "" when it cannot
 *  suggest one. Shown as the field's placeholder. */
export function suggestTeamRepo(login: string | null, name: string): string {
  const slug = slugifyTeamName(name);
  if (!slug || !login?.trim()) return "";
  // F6 (team walk): "Plyloft test team" is `plyloft-test-team`, not `…-team-team`.
  if (slug === "team" || slug.endsWith("-team")) return `${login.trim()}/${slug}`;
  return `${login.trim()}/${slug}-team`;
}

/** `owner/name`, the only shape `gh` accepts — the same check
 *  `team::is_valid_repo_slug` makes before anything is cloned or granted. */
export function isRepoSlug(slug: string): boolean {
  const parts = slug.trim().split("/");
  if (parts.length !== 2) return false;
  return parts.every(
    (part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part),
  );
}

/** A GitHub login: letters, digits and single inner hyphens, ≤ 39 chars.
 *  Mirrors `team_admin::is_valid_login`. */
export function isGithubLogin(login: string): boolean {
  const value = login.trim();
  return (
    value !== "" &&
    value.length <= 39 &&
    !value.startsWith("-") &&
    !value.endsWith("-") &&
    !value.includes("--") &&
    /^[A-Za-z0-9-]+$/.test(value)
  );
}

/** Why the Create-team button is disabled, or null when it is not.
 *  A name is the only required field: an empty repo takes the suggestion. */
export function createTeamBlocker(
  name: string,
  repo: string,
  login: string | null,
): string | null {
  if (!login?.trim()) {
    return "Plyloft could not read your GitHub login. Check `gh auth status`.";
  }
  if (!name.trim()) return "Give the team a name.";
  const typed = repo.trim();
  if (typed === "") {
    return suggestTeamRepo(login, name)
      ? null
      : `Plyloft cannot suggest a repository name for "${name.trim()}" — type one.`;
  }
  return isRepoSlug(typed) ? null : "Write the team's repository as owner/name, as on GitHub.";
}

/** Team walk 2026-10-01 (F7): what the Create-team form says under its
 *  fields. While `team_create_defaults` is still answering the account is
 *  being read, not missing — Create waits, and nothing is called an error. */
export const READING_GITHUB_ACCOUNT = "Reading your GitHub account…";

export function createTeamGate(
  defaultsRead: boolean,
  name: string,
  repo: string,
  login: string | null,
): { canCreate: boolean; reading: boolean; message: string | null } {
  if (!defaultsRead) {
    return { canCreate: false, reading: true, message: READING_GITHUB_ACCOUNT };
  }
  const blocker = createTeamBlocker(name, repo, login);
  return { canCreate: blocker === null, reading: false, message: blocker };
}

/** The steps that would actually grant something — what the owner is being
 *  asked to approve. The rest of the plan is shown too, because the screen's
 *  job is to list every repository the team owns. */
export function grantingSteps(plan: InvitePlan): InviteStep[] {
  return plan.steps.filter((step) => step.action === "grant");
}

/** Steps GitHub could not answer for. Ply never grants on a guess (the PUT
 *  names a permission, so it can downgrade an admin), so a plan with any of
 *  these cannot be sent until a refresh resolves them. */
export function unresolvedSteps(plan: InvitePlan): InviteStep[] {
  return plan.steps.filter((step) => step.action === "unresolved");
}

/** The chip of a repository when GitHub says nobody has this login. */
export const NO_ACCOUNT_CHIP = "no GitHub account with this name";

/** Steps refused because no account has this login. Reading the plan again
 *  wouldn't change it, so a plan with any can't be sent. */
export function noAccountSteps(plan: InvitePlan): InviteStep[] {
  return plan.steps.filter((step) => step.action === "no_such_account");
}

/** The send button's words. "Add to the team" means only the manifest changes,
 *  which isn't what a plan refused for its login would do. */
export function inviteSendLabel(plan: InvitePlan): string {
  return grantingSteps(plan).length === 0 && noAccountSteps(plan).length === 0 ? "Add to the team" : "Send invites";
}

/** 1.174.3: Review access on somebody the team lists, who has all they should
 *  or an invitation waiting. The sheet reports; there is nothing to add. */
export function nothingToDo(plan: InvitePlan): boolean {
  return (
    !plan.addsToManifest &&
    grantingSteps(plan).length === 0 &&
    unresolvedSteps(plan).length === 0 &&
    noAccountSteps(plan).length === 0
  );
}

/** The one-line summary above the confirmation list. */
export function invitePlanSummary(plan: InvitePlan): string {
  if (noAccountSteps(plan).length > 0) {
    // Someone the team already lists wasn't mistyped here: the account has gone.
    return plan.addsToManifest
      ? `GitHub has no account named ${plan.login}. Check the spelling; Plyloft sends nothing.`
      : `GitHub has no account named ${plan.login} now; it may have been renamed. Plyloft sends nothing.`;
  }
  const grants = grantingSteps(plan).length;
  const total = plan.steps.length;
  const unresolved = unresolvedSteps(plan).length;
  if (unresolved > 0) {
    return `GitHub could not answer for ${unresolved} of ${total} repositories. Plyloft never grants on a guess — refresh, then send.`;
  }
  const waiting = plan.steps.filter((step) => step.action === "invited").length;
  if (grants === 0) {
    if (waiting > 0) {
      const invitations =
        waiting === 1 ? "An invitation waits" : `${waiting} invitations wait`;
      return plan.addsToManifest
        ? `${plan.login} already has access or an invitation waiting on all ${total} — Plyloft would only add them to the team's member list.`
        : `${plan.login} is in ${plan.teamName}. ${invitations} on them; nothing to send. ${JOIN_STEP}`;
    }
    return plan.addsToManifest
      ? `${plan.login} already has access to all ${total} — Plyloft would only add them to the team's member list.`
      : `${plan.login} is already in ${plan.teamName} with access to all ${total}. Nothing to do.`;
  }
  const repos = grants === 1 ? "repository" : "repositories";
  const manifest = plan.addsToManifest
    ? ` and add them to the ${plan.teamName} manifest`
    : "";
  return `Plyloft will grant ${plan.login} write access to ${grants} ${repos}${manifest}. Read the list before sending.`;
}

/** What a finished invite says in its toast. Every half is named: a member
 *  who is listed but missing one grant is the state the owner has to retry,
 *  and it is invisible unless it is said. */
export function inviteOutcomeSummary(outcome: {
  login: string;
  manifestWritten: boolean;
  invited: string[];
  alreadyHad: string[];
  alreadyInvited?: string[];
  failed: string[];
}): string {
  const parts: string[] = [];
  if (outcome.manifestWritten) parts.push("added to the team's member list");
  if (outcome.invited.length > 0) {
    parts.push(`invited to ${outcome.invited.join(", ")}`);
  }
  if (outcome.alreadyHad.length > 0) {
    parts.push(`already had ${outcome.alreadyHad.join(", ")}`);
  }
  if ((outcome.alreadyInvited ?? []).length > 0) {
    parts.push(`an invitation already waits on them for ${(outcome.alreadyInvited ?? []).join(", ")}`);
  }
  if (parts.length === 0) parts.push("nothing needed changing");
  const done = `${outcome.login}: ${parts.join("; ")}.`;
  if (outcome.failed.length === 0) return done;
  return `${done} GitHub refused ${outcome.failed.join("; ")} — press Add somebody again to retry, it is safe.`;
}

/** What a scan says about itself. "Nothing found" and "nothing was looked
 *  at" are different answers, and an unanswered probe is neither. */
export function discoverySummary(discovery: {
  proposals: unknown[];
  scanned: number;
  unchecked: number;
  alreadyListed: number;
}): string {
  if (discovery.scanned === 0) {
    return "Plyloft found no repositories on this GitHub account to look at.";
  }
  const parts = [
    `${discovery.proposals.length} to propose out of ${discovery.scanned} scanned`,
  ];
  if (discovery.alreadyListed > 0) {
    parts.push(`${discovery.alreadyListed} already a team workspace`);
  }
  if (discovery.unchecked > 0) {
    parts.push(`${discovery.unchecked} GitHub could not answer for`);
  }
  return `${parts.join(" · ")}.`;
}

/** Team walk 2026-10-01 (F1): the GitHub-backed workspaces open on this Mac
 *  that the owner could still give the team — `team_create_defaults`'
 *  list without what the manifest already lists and without the team repo
 *  itself (never a workspace). One row per repository, first name wins:
 *  two workspaces on one origin are one team workspace. */
export function workspacesToGive(
  candidates: { repo: string; name: string }[],
  listed: string[],
  teamRepo: string | null,
): { repo: string; name: string }[] {
  const key = (slug: string) => slug.trim().toLowerCase();
  const taken = new Set(listed.map(key));
  if (teamRepo) taken.add(key(teamRepo));
  const out: { repo: string; name: string }[] = [];
  for (const candidate of candidates) {
    const k = key(candidate.repo);
    if (taken.has(k) || !isRepoSlug(candidate.repo)) continue;
    taken.add(k);
    out.push({ repo: candidate.repo.trim(), name: candidate.name });
  }
  return out;
}

/** What the owner reads after giving the team a workspace: existing members
 *  are not granted it by the manifest edit, only by Review access. */
export function workspaceGivenNote(repo: string, otherMembers: number): string {
  // QoL 14.4 (G24): one review for every member, not one per member.
  return otherMembers > 0
    ? `${repo} is a team workspace. Give everyone access so GitHub lets ${otherMembers === 1 ? "your member" : `the ${otherMembers} members`} into it.`
    : `${repo} is a team workspace. Members you add from now on get access to it with their invite.`;
}

/** QoL 14.4 (G24): Give everyone access — the members' plans read one by
 *  one through the same Review access plan, sent together. `ready` can be
 *  sent (something to grant, every repository answered); `waiting` could
 *  not be checked; `done` needs nothing. */
export function everyonesAccess<P extends InvitePlan>(plans: readonly P[]): {
  ready: P[];
  waiting: P[];
  done: P[];
  noAccount: P[];
  grants: number;
} {
  const noAccount: P[] = [];
  const ready: P[] = [];
  const waiting: P[] = [];
  const done: P[] = [];
  let grants = 0;
  for (const plan of plans) {
    if (noAccountSteps(plan).length > 0) noAccount.push(plan);
    else if (unresolvedSteps(plan).length > 0) waiting.push(plan);
    else if (grantingSteps(plan).length === 0) done.push(plan);
    else {
      ready.push(plan);
      grants += grantingSteps(plan).length;
    }
  }
  return { ready, waiting, done, noAccount, grants };
}

/** QoL 14.4 (G24): the sentence above Give everyone access's list. */
export function everyonesAccessSummary(
  view: { ready: unknown[]; waiting: unknown[]; done: unknown[]; noAccount?: { login: string }[]; grants: number },
  noSeat: readonly string[],
): string {
  const noAccount = view.noAccount ?? [];
  const parts: string[] = [];
  if (view.ready.length > 0) {
    parts.push(
      `${view.ready.length === 1 ? "1 member needs" : `${view.ready.length} members need`} ${view.grants === 1 ? "1 grant" : `${view.grants} grants`} on GitHub.`,
    );
  } else if (view.waiting.length === 0 && noSeat.length === 0 && noAccount.length === 0) {
    parts.push("Every member has what the team gives them.");
  } else {
    parts.push("Nothing to grant for the members Plyloft could check.");
  }
  if (view.waiting.length > 0) {
    parts.push(`GitHub didn't answer for ${view.waiting.length === 1 ? "1 member" : `${view.waiting.length} members`}; read it again for them.`);
  }
  if (noSeat.length > 0) {
    parts.push(`${noSeat.join(", ")} ${noSeat.length === 1 ? "has" : "have"} no seat yet: give one first.`);
  }
  if (noAccount.length > 0) {
    parts.push(`GitHub has no account named ${noAccount.map((p) => p.login).join(", ")}.`);
  }
  return parts.join(" ");
}

/** What an invited person does next, as the owner reads it: they never
 *  accept on GitHub themselves — pasting the team's invite code makes Plyloft
 *  accept the invitation for them (`team_join.rs`, D16), once `team.json`
 *  lists their login. Their seat was taken by Add member already. */
export const JOIN_STEP =
  "Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them.";

/** Team walk 2026-10-01 (F2): the line Members keeps after Send invites, so
 *  the owner knows the invitation left. What the invitee does next is the
 *  Invited row's (`memberStateHint`), which outlasts this line; the Copy invite
 *  row says it too. Null when nothing was sent (only the manifest changed, or
 *  every grant failed — the toast says which). */
export function invitationNote(outcome: { login: string; invited: string[] }): string | null {
  if (outcome.invited.length === 0) return null;
  return `Invitation sent to ${outcome.login}.`;
}

// ── N14 items 1 and 9: who has joined ───────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` as "9 Oct" — the day itself, no time zone guessing (the
 *  backend computed it in UTC). The input back when it isn't a date. */
export function shortDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return day;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month}` : day;
}

/** The chip a member row carries: Joined, Invited · expires 9 Oct, or No
 *  access. Null while GitHub hasn't answered (never "no access"). */
export function memberStateChip(
  view: Pick<MemberStateView, "state" | "invitationExpires">,
): { word: string; tone: "ok" | "warn" | "neutral" } | null {
  switch (view.state) {
    case "joined":
      return { word: "Joined", tone: "ok" };
    case "invited":
      return {
        word: view.invitationExpires
          ? `Invited · expires ${shortDay(view.invitationExpires)}`
          : "Invited",
        tone: "neutral",
      };
    case "no_access":
      return { word: "No access", tone: "warn" };
    default:
      return null;
  }
}

function listRepos(repos: string[]): string {
  if (repos.length <= 1) return repos.join("");
  return `${repos.slice(0, -1).join(", ")} and ${repos[repos.length - 1]}`;
}

function invitationsWait(repos: string[]): string {
  return repos.length === 1
    ? `An invitation to ${repos[0]} waits on them.`
    : `Invitations to ${listRepos(repos)} wait on them.`;
}

/** The sentence under a member's login: what their state means and what to
 *  press. `null` when there is nothing more than the default hint. Invited
 *  means the team repository's invitation waits too (`teamRepo`), so a line
 *  that names a workspace's names that one as well. */
export function memberStateHint(view: MemberStateView, teamRepo: string): string | null {
  if (view.owner) return null;
  const workspaces: string[] = [];
  if (view.workspacesInvited.length > 0) {
    workspaces.push(
      invitationsWait(view.state === "invited" ? [teamRepo, ...view.workspacesInvited] : view.workspacesInvited),
    );
  }
  if (view.workspacesMissing.length > 0) {
    workspaces.push(
      `No access to ${listRepos(view.workspacesMissing)} yet — press Review access to invite them.`,
    );
  }
  const tail = workspaces.length > 0 ? ` ${workspaces.join(" ")}` : "";
  switch (view.state) {
    case "joined":
      return workspaces.length > 0 ? `Joined the team repository.${tail}` : null;
    case "invited":
      return `Invited${
        view.invitationExpires ? ` until ${shortDay(view.invitationExpires)}` : ""
      }. ${JOIN_STEP}${tail}`;
    case "no_access":
      if (view.invitationExpired) {
        return `Listed in the team, but their invitation expired on ${shortDay(view.invitationExpired)}. Press Review access to invite them again.`;
      }
      return view.workspacesInvited.length > 0
        ? `Listed in the team, but GitHub gives them no access to ${teamRepo} and no invitation to it is waiting. ${invitationsWait(view.workspacesInvited)} Press Review access to invite them.`
        : "Listed in the team, but GitHub gives them no access and no invitation is waiting. Press Review access to invite them.";
    default:
      return null;
  }
}

// ── N14 item 3: Remove from team ────────────────────────────────────

/** What the confirmation sheet says, naming the person and every
 *  repository. */
export function removalLede(login: string, repos: string[]): string {
  const count = repos.length === 1 ? "1 repository" : `${repos.length} repositories`;
  return `Plyloft takes away ${login}'s access to the ${count} below — it withdraws any invitation still waiting and removes them as a collaborator — and then takes them out of the team. They keep their own clones, and nothing in the repositories changes.`;
}

/** U14: what happens to their claims, as far as it is known. Plyloft never
 *  unassigns anyone; the walk of 2026-11-02 saw GitHub do it when access went
 *  (two issues lost their assignee, on a private repository). */
export function removalClaimsNote(login: string): string {
  return `If GitHub no longer gives ${login} access, it takes them off their issues, and those cards go back to Ready to start.`;
}

/** 1.174.3: what Remove just took away, on the page at once: the states on
 *  screen were read before it, and the read after it takes a moment or may
 *  fail. The next read that lands says what GitHub says. */
export function statesAfterRemoval(
  states: MemberStates,
  outcome: Pick<RemoveOutcome, "login" | "removed">,
  teamRepo: string,
): MemberStates {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const gone = (repo: string) => outcome.removed.some((r) => same(r, repo));
  return {
    ...states,
    members: states.members.map((member) => {
      if (!same(member.login, outcome.login)) return member;
      const missing = outcome.removed.filter(
        (r) => !same(r, teamRepo) && !member.workspacesMissing.some((m) => same(m, r)),
      );
      return {
        ...member,
        ...(gone(teamRepo) ? { state: "no_access" as const, invitationExpires: null, invitationExpired: null } : {}),
        workspacesInvited: member.workspacesInvited.filter((r) => !gone(r)),
        workspacesMissing: [...member.workspacesMissing, ...missing],
      };
    }),
  };
}

/** 1.174.3: every repository done, and `team.json` not written. */
export function removalLeftUnfinished(outcome: Pick<RemoveOutcome, "failed" | "manifestUpdated">): boolean {
  return outcome.failed.length === 0 && !outcome.manifestUpdated;
}

/** 1.174.3: that member's row, in place of the No access hint. */
export const REMOVAL_UNFINISHED_HINT =
  "Their access is gone, but the team still lists them. Remove from team again to finish.";

/** The toast after Remove from team. Partial failures name every repository
 *  that failed and say that the team still lists them. */
export function removeOutcomeSummary(outcome: RemoveOutcome): {
  kind: "info" | "error";
  title: string;
  body: string;
} {
  if (outcome.failed.length > 0) {
    return {
      kind: "error",
      title: `${outcome.login} is still in the team`,
      body: `Not done on: ${outcome.failed.join("; ")}. ${
        outcome.removed.length > 0 ? `Their access to ${listRepos(outcome.removed)} is gone. ` : ""
      }The team keeps listing them until every repository is done — press Remove from team again, it is safe.`,
    };
  }
  if (!outcome.manifestUpdated) {
    return {
      kind: "error",
      title: `${outcome.login} is still listed in the team`,
      body: `Their access to ${listRepos(outcome.removed)} is gone, but Plyloft couldn't update the team: ${
        outcome.manifestError ?? "the change wasn't pushed"
      } Press Remove from team again to finish.`,
    };
  }
  const cancelled =
    outcome.cancelledInvitations.length > 0
      ? ` Withdrew the invitation to ${listRepos(outcome.cancelledInvitations)}.`
      : "";
  const reads =
    (outcome.stillRead ?? []).length > 0
      ? ` They can still read ${listRepos(outcome.stillRead)}.`
      : "";
  // Launch T2: the seat goes once their access is gone.
  if (outcome.seatError) {
    return {
      kind: "error",
      title: `${outcome.login} removed, but their seat is still taken`,
      body: `No write access to ${listRepos(outcome.removed)} any more, and the team no longer lists them.${cancelled}${reads} ${outcome.seatError}`,
    };
  }
  const seat = outcome.seatFreed ? " Their seat on the team's plan is free again." : "";
  return {
    kind: "info",
    title: `${outcome.login} removed from the team`,
    body: `No write access to ${listRepos(outcome.removed)} any more, and the team no longer lists them.${cancelled}${reads}${seat}`,
  };
}

/** QoL 14.4 (G24, Challenger): the toast after Give everyone access's send —
 *  how many members it reached, who is left and why, and how members accept. */
export function everyonesAccessSent(
  sent: readonly string[],
  left: { refused: readonly string[]; waiting: readonly string[]; noSeat: readonly string[]; noAccount?: readonly string[] },
): { title: string; body: string } {
  const title = sent.length === 1 ? "Access sent to 1 member" : `Access sent to ${sent.length} members`;
  const parts: string[] = [];
  if (sent.length > 0) {
    parts.push(
      "Members already in the team accept it when they get the workspace in Setup › Team, under The team's projects; anyone who hasn't joined yet pastes the team's code.",
    );
  }
  if (left.refused.length > 0) parts.push(`GitHub refused: ${left.refused.join("; ")}. Retrying is safe.`);
  if (left.waiting.length > 0) parts.push(`Not checked: ${left.waiting.join(", ")} — read it again, then check them alone.`);
  if (left.noSeat.length > 0) parts.push(`No seat yet: ${left.noSeat.join(", ")}.`);
  if ((left.noAccount ?? []).length > 0) parts.push(`No GitHub account: ${(left.noAccount ?? []).join(", ")}.`);
  return { title, body: parts.join(" ") };
}

/** 1.176.2 (E1, A3-80): the backend's text for a team that failed after its
 *  repository was made (`team_admin.rs` `stranded`): the repository, and
 *  what to do — which used to sit under Details, behind the raw error. */
export function decodeHalfMadeTeam(cause: unknown): { repo: string; body: string } | null {
  const raw = typeof cause === "string" ? cause : String((cause as { message?: unknown })?.message ?? cause);
  const m = /(\S+) exists on GitHub but is not finished \(.+?\)\./s.exec(raw);
  if (!m) return null;
  return {
    repo: m[1],
    body: `${m[1]} exists on GitHub but isn't finished. Press Create team again with the same name to complete it.`,
  };
}
