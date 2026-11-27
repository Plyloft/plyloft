// OB-10 (ONBOARDING_SPEC §5 step 6, §12): the Team step's words and states,
// pure, so node runs its test (`node --experimental-strip-types
// src/lib/teamStep.test.ts`). The step itself is `components/setup/TeamStep.tsx`;
// the decisions that matter for safety (which invitation is accepted, what a
// code may name) are Rust's (`team_join.rs`) — nothing here decides them.
import type {
  DetectedTeam,
  JoinCurrentTeam,
  JoinPreview,
  JoinProblem,
  JoinResult,
  JoinWorkspaceInvite,
  Membership,
} from "../ipc.ts";
import type { UxError, UxErrorAction } from "./uxError.ts";

export const TEAM_TITLE = "Your team";
export const TEAM_WHY =
  "A Plyloft team is a private GitHub repository that lists who is in it, which projects you share, and a library your agents can use. Team features run on the Team plan.";
/** 1.176.3: why the step is there, for GitHub connected: the account is
 *  listed in a team, or an invitation waits. Once this computer is in a team,
 *  or when GitHub wasn't read, the step keeps `TEAM_WHY`. */
export function teamWhy(input: {
  githubConnected: boolean | null;
  joined: boolean;
  teams: readonly string[];
  invitations: number;
}): string {
  if (input.githubConnected !== true || input.joined) return TEAM_WHY;
  if (input.teams.length === 1) {
    return `GitHub lists you in a Plyloft team: ${input.teams[0]}. You can join it without an invite code, or set it aside for now.`;
  }
  if (input.teams.length > 1) {
    return `GitHub lists you in Plyloft teams: ${input.teams.join(", ")}. You can join one of them without an invite code, or set them aside for now.`;
  }
  if (input.invitations > 0) {
    return "GitHub shows an invitation to a Plyloft team. Paste the invite code your team's owner sent you, or the repository's link, to join, or set it aside for now.";
  }
  return TEAM_WHY;
}
/** The name part of `owner/name`. */
export const repoName = (repo: string) => repo.split("/").pop() || repo;
/** The invite-code row's own button (the footer's Continue asks with the code too). */
export const CODE_BUTTON = "Look it up";
export const JOIN_GENERIC_HINT = "Someone invited you, or sent you an invite code.";
export const JOIN_ANOTHER_LABEL = "Join another team";
export const JOIN_ANOTHER_HINT = "Paste an invite code, or look for other teams.";
export const CHOOSE_LINE = "Choose one of the options above, or press Not now.";
export const PASTE_OR_CHOOSE_LINE = "Paste an invite code, or press Not now.";
export const CHOOSE_TEAM_LINE = "Choose a team above, or paste an invite code.";
export const STILL_LOOKING_LINE = "Plyloft is still looking for your teams. Press Continue again in a moment.";
export const LOOK_PROBLEM_LINE = "Plyloft couldn't look for your teams (said above). Press Continue again to go on without a team.";
export const JOIN_HINT = "You see what joining gives you before anything happens.";
export const NOT_NOW_LABEL = "Not now";
export const NOT_NOW_HINT = "You work on your own. Add the team any time in Settings › Team › Members and library.";
/** D14: the step waits for GitHub. */
export const CONNECT_FIRST = "Connect GitHub first.";
export const CONNECT_FIRST_HINT =
  "Your team lives on GitHub. You can go on with the other steps and come back here.";
export const JOIN_LABEL = "Join a team";
export const CREATE_LABEL = "Create a team";
export const CODE_LABEL = "Paste your invite code";
export const CODE_HINT = "Your team's owner sends it from Plyloft.";
export const LOOKING = "Looking for your teams on GitHub…";
export const JOIN_GRANTS =
  "Joining lets your agents use the team's skills and notes, and shows the team's projects so you can pick which to get.";
export const INVITE_PEOPLE = "Invite people";
export const COPY_INVITE = "Copy invite";

/** Which screen the step draws. */
export type TeamScreen = "checking" | "needs-github" | "joined" | "choose";

/**
 * §5 step 6: detected done wins (`settings.team.teamRepo`, a key's team, a
 * clone); otherwise the step waits for GitHub (D14) — `null` is gh's
 * accounts not read yet.
 */
export function teamScreen(input: { joined: boolean; githubConnected: boolean | null }): TeamScreen {
  if (input.joined) return "joined";
  if (input.githubConnected === null) return "checking";
  if (!input.githubConnected) return "needs-github";
  return "choose";
}

/** The done state's line: *You're in “MB Adv”.* */
export function joinedLine(name: string | null | undefined, repo: string | null | undefined): string {
  const n = name?.trim() || repo?.trim();
  return n ? `You're in “${n}”.` : "You're in a team.";
}

/** §5 step 6 "Detected": the half-state the membership probe explains. */
export function halfStateLine(membership: Membership | null | undefined): string | null {
  switch (membership) {
    case "no_repo_access":
      return "The owner listed you, but GitHub hasn't given you access yet. Ask them to check your invitation.";
    case "not_listed":
      return "You can read the team's repository, but its owner hasn't added you to the team.";
    default:
      return null;
  }
}

/** A detected team's row. The name is the manifest's own (a claim); the
 *  repository says where it really is. */
export function detectedTeamRow(team: DetectedTeam, login?: string | null): { title: string; hint: string; action: string } {
  // U5: the person who owns it: the manifest can claim anything, so the
  // repository has to be under this account too. U19: a detected team is one
  // whose manifest lists this account and that it can read already
  // (`team_join.rs::detect`), not an invitation still to accept, so nothing
  // here says "invited".
  const me = login?.toLowerCase();
  const own = Boolean(me && team.owner?.toLowerCase() === me && team.repo.split("/")[0].toLowerCase() === me);
  return {
    title: own ? `Your team “${team.name}”` : `“${team.name}” lists you as a member`,
    hint: `${team.repo}${team.owner && !own ? `, by ${team.owner}` : ""}, on GitHub.`,
    action: `Join ${team.name}`,
  };
}

/** The group of those rows. */
export const DETECTED_TEAMS_LABEL = "Teams that list you";

/** What the detection found, in a line; null when the rows say it. */
export function detectionLine(d: {
  teams: unknown[];
  scanned: number;
  truncated: boolean;
  unanswered: number;
  timedOut?: boolean;
}): string | null {
  if (d.timedOut) {
    return `Plyloft stopped looking after 30 seconds: ${d.unanswered} of ${d.scanned} repositories weren't checked. Look again, or paste your invite code.`;
  }
  if (d.teams.length > 0) return null;
  if (d.unanswered > 0) return `No team found. GitHub didn't answer for ${d.unanswered} of ${d.scanned} repositories.`;
  if (d.truncated) return `No team found in your ${d.scanned} most recent repositories.`;
  return "No team found that lists you yet.";
}

/** The account list (several signed in): the choice's options, active first. */
export function accountChoices(
  accounts: readonly { login: string; active: boolean; state: string }[] | null | undefined,
): string[] {
  const signed = (accounts ?? []).filter((a) => a.state === "signed-in");
  return [...signed.filter((a) => a.active), ...signed.filter((a) => !a.active)].map((a) => a.login);
}

// ── The Join sheet (§5 step 6 Join 2) ────────────────────────────────────

export interface JoinSheetView {
  title: string;
  lines: string[];
  /** One line per invitation Plyloft will accept. */
  accepts: string[];
  details: string[];
  confirm: string;
}

/** How the sheets name the team: its repository. The manifest's name is a
 *  claim the team makes about itself, shown as one (never the title). */
export function joinName(preview: JoinPreview): string {
  if (preview.kind === "problem") return preview.problem.repo ?? "the team";
  return preview.team.repo;
}

/**
 * The sheet, always, even from a detected team: the repository and its owner
 * (GitHub's, and the manifest's once read), what joining grants, and each
 * invitation that will be accepted — the team repository's (only the one the
 * pasted code names) and the team workspaces'.
 */
export function joinSheet(preview: JoinPreview): JoinSheetView | null {
  if (preview.kind === "problem") return null;
  const t = preview.team;
  // The owner is always GitHub's (§12.3: from GitHub, not from the code or
  // the manifest).
  const owner = t.repoOwner;
  const where =
    t.private === false
      ? `The team is the repository ${t.repo} on GitHub. It is public: anyone can read the team's library.`
      : `The team is the private repository ${t.repo} on GitHub`;
  const lines = [
    t.private === false ? `${where}${owner ? ` Its owner is ${owner}.` : ""}` : `${where}${owner ? `, owned by ${owner}.` : "."}`,
  ];
  const name = t.name?.trim();
  if (name) lines.push(`It calls itself “${name}”.`);
  if (t.manifestOwner && (!t.repoOwner || t.manifestOwner.toLowerCase() !== t.repoOwner.toLowerCase())) {
    lines.push(`team.json names ${t.manifestOwner} as the team's owner.`);
  }
  lines.push(JOIN_GRANTS);
  const accepts: string[] = [];
  if (preview.kind === "invited") {
    accepts.push(`Plyloft will accept your GitHub invitation to ${t.repo}.`);
    if (preview.invitation.inviterNotOwner && preview.invitation.inviter) {
      lines.push(`Invited by ${preview.invitation.inviter}, not the team's owner.`);
    }
    lines.push("Plyloft reads the team's member list right after, and stops if it doesn't list you.");
  } else {
    for (const w of preview.workspaceInvites) accepts.push(`Plyloft will accept your GitHub invitation to ${w.repo}.`);
  }
  const details = [
    t.url,
    t.manifestOwner ? `Team owner (team.json): ${t.manifestOwner}` : "Team owner (team.json): read after joining",
    `Joining as: ${t.login}`,
    ...preview.calls,
  ];
  return { title: `Join the team at ${t.repo}?`, lines, accepts, details, confirm: "Join" };
}

/** §5 step 6 "Already in another team": one team per Mac. Names what is kept. */
export function replaceSheet(current: JoinCurrentTeam, joining: string): { title: string; lede: string; kept: string; confirm: string } {
  const now = current.name?.trim() || current.repo;
  return {
    title: `Replace “${now}”?`,
    lede: `This Mac is in “${now}”. Joining ${joining} replaces it.`,
    kept: `Your projects from “${now}”, their folders and everything on GitHub stay as they are. Plyloft stops following “${now}”.`,
    confirm: `Join ${joining}`,
  };
}

/** The team workspaces' invitations, asked before getting them. */
export function workspaceInviteSheet(invites: readonly JoinWorkspaceInvite[]): { title: string; lines: string[]; confirm: string } {
  return {
    title: invites.length === 1 ? "Accept the invitation?" : "Accept the invitations?",
    lines: invites.map(
      (i) => `Plyloft will accept your GitHub invitation to ${i.repo}${i.inviter ? ` (from ${i.inviter})` : ""}.`,
    ),
    confirm: invites.length === 1 ? "Accept and get it" : "Accept and get them",
  };
}

// ── Failures (§5 step 6 table) ───────────────────────────────────────────

/** A code the field refuses is said under the field, not as an error block. */
export function isFieldProblem(problem: JoinProblem): boolean {
  return problem.kind === "not-a-code" || problem.kind === "newer-version";
}

const TITLES: Record<JoinProblem["kind"], string> = {
  "not-a-code": "That isn't a Plyloft invite code.",
  "newer-version": "This invite is from a newer Plyloft.",
  "no-access": "You don't have access to the team yet.",
  "not-listed": "You're not on the team's list yet.",
  "not-a-team": "That repository isn't a Plyloft team.",
  expired: "The GitHub invitation expired.",
  "invitation-gone": "The invitation isn't there any more.",
  "needs-replace": "This Mac is in another team.",
  sso: "Your organization needs single sign-on.",
  offline: "You're offline.",
  "signed-out": "GitHub didn't accept the sign-in.",
  "rate-limited": "GitHub asked Plyloft to wait.",
  other: "Plyloft couldn't join the team.",
};

const TODO: Record<JoinProblem["kind"], string> = {
  "not-a-code": "Paste the code exactly as your team's owner sent it.",
  "newer-version": "Update Plyloft, then paste the code again.",
  "no-access": "When the owner has invited you, press Look again: Plyloft accepts the invitation for you.",
  "not-listed": "Ask the team's owner to add you, then press Look again.",
  "not-a-team": "Check the code with your team's owner.",
  expired: "Ask the owner to invite you again.",
  "invitation-gone": "Press Look again, or ask the owner to invite you again.",
  "needs-replace": "Confirm that this team replaces the one this Mac is in.",
  sso: "Authorize the GitHub command for your organization, then press Look again.",
  offline: "Check the connection, then press Look again.",
  "signed-out": "Sign in again in the GitHub step.",
  "rate-limited": "Wait a few minutes, then press Look again.",
  other: "Press Look again. If it keeps failing, Details has GitHub's answer.",
};

/** The ErrorBlock for a join problem (§4.5: what happened · what was left
 *  untouched · what to do, at most two ways out). */
export function joinProblemError(problem: JoinProblem): UxError {
  const actions: UxErrorAction[] = [];
  if (problem.kind === "sso" && problem.org) actions.push({ id: "authorise", label: "Authorize", primary: true });
  if (problem.kind === "signed-out") actions.push({ id: "github", label: "Go to GitHub", primary: true });
  else if (!["not-a-team", "expired", "not-a-code", "newer-version", "needs-replace"].includes(problem.kind)) {
    actions.push({ id: "check", label: "Look again", primary: actions.length === 0 });
  }
  return {
    title: TITLES[problem.kind],
    happened: problem.words,
    untouched: problem.accepted
      ? "Only GitHub's invitation was accepted. Plyloft didn't join the team, and nothing else was changed."
      : "Nothing was changed.",
    todo: TODO[problem.kind],
    actions,
    details: problem.details,
  };
}

/** Create's refusal (`team_create`'s words, e.g. a name that exists and
 *  isn't an unfinished team — `resume_decision`), with single sign-on said
 *  as step 5 says it. */
export function createError(text: string): UxError {
  const sso = ssoFromText(text);
  return {
    title: "The team wasn't created.",
    happened: sso
      ? sso.org
        ? `Your organization “${sso.org}” needs you to authorize the GitHub command for single sign-on.`
        : "Your organization needs you to authorize the GitHub command for single sign-on."
      : text,
    untouched: "Nothing else was changed on this Mac.",
    todo: sso ? "Authorize, then press Create team again." : "Check the name, then press Create team again.",
    actions: sso?.org ? [{ id: "authorise", label: "Authorize", primary: true }] : [],
    details: text,
  };
}

/** A single sign-on refusal in gh's own words (the create path, whose errors
 *  come back as text): the organisation from gh's SSO URL, as
 *  `setup_github::sso_need` reads it. */
export function ssoFromText(text: string): { org: string | null } | null {
  const url = /github\.com\/orgs\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/sso/i.exec(text);
  if (url) return { org: url[1] };
  return /saml/i.test(text) ? { org: null } : null;
}

// ── After joining ────────────────────────────────────────────────────────

export function joinedToast(result: Extract<JoinResult, { kind: "joined" }>): { title: string; body: string } {
  const parts: string[] = [];
  if (result.replaced) parts.push(`Plyloft no longer follows ${result.replaced}.`);
  if (result.workspaces.accepted.length > 0) {
    parts.push(`Accepted the invitations to ${result.workspaces.accepted.join(", ")}.`);
  }
  if (result.workspaces.failed.length > 0) {
    parts.push(`Couldn't accept the invitations to ${result.workspaces.failed.map((f) => f.repo).join(", ")}.`);
  }
  parts.push("Pick the team's projects you want on this Mac.");
  return { title: `You're in “${result.name}”.`, body: parts.join(" ") };
}

/** "Get 2 projects" for the picker's button. */
export function getProjectsLabel(n: number): string {
  return n === 1 ? "Get 1 project" : `Get ${n} projects`;
}

// ── Create (§5 step 6 Create) ────────────────────────────────────────────

export function createSheet(name: string, repo: string): { title: string; lede: string; confirm: string } {
  return {
    title: `Create the team “${name.trim()}”?`,
    lede: `Plyloft will create the private repository ${repo} on GitHub, with the team's member list and an empty library. You'll be its owner.`,
    confirm: "Create team",
  };
}

/** Why Create can't be pressed yet, or null. */
export function createBlocker(name: string, repo: string, login: string | null): string | null {
  if (!login?.trim()) return "Plyloft couldn't read your GitHub account.";
  if (!name.trim()) return "Give the team a name.";
  const r = repo.trim();
  if (!r) return "Give the team's repository a name (owner/name).";
  const parts = r.split("/");
  const ok =
    parts.length === 2 &&
    parts.every((p) => p !== "" && p !== "." && p !== ".." && /^[A-Za-z0-9._-]+$/.test(p) && p.length <= 100);
  return ok ? null : "The repository must be owner/name on GitHub.";
}

/** U31: a team project registered here whose folder isn't there.
 *  `team_workspace_add` clones it again in the same place. */
export function folderGone(w: { registered: boolean; cloned: boolean; folderPresent?: boolean; conflict?: string | null }): boolean {
  return w.registered && !w.cloned && !w.folderPresent && !w.conflict;
}
/** U31: the folder is there and isn't a repository: a clone there is refused. */
export function folderNotRepository(w: { registered: boolean; cloned: boolean; folderPresent?: boolean; conflict?: string | null }): boolean {
  return w.registered && !w.cloned && w.folderPresent === true && !w.conflict;
}
/** The project a person who just joined would surely tick: the only one left to
 *  get, new to this computer. A project whose folder is gone stays unticked, since
 *  its row warns that getting it again loses what the old copy held. */
export function onlyProjectToGet(
  workspaces: readonly { repo: string; registered: boolean; cloned: boolean; folderPresent?: boolean; conflict?: string | null }[],
): string | null {
  const toGet = workspaces.filter((w) => (!w.registered || folderGone(w)) && !w.conflict);
  return toGet.length === 1 && !toGet[0].registered ? toGet[0].repo : null;
}
export const FOLDER_GONE_NOTE = "Its folder isn't where Plyloft left it";
export const FOLDER_NOT_REPOSITORY_NOTE = "Its folder isn't a git repository";
export const CLONE_AGAIN = "Clone it again";
/** U31: a new clone is a new folder; what lived in the old one doesn't come with it. */
export const CLONE_AGAIN_LOSES_COPIES = "A new clone doesn't bring back the card copies that were inside the old folder.";

/** U31: the toast after a project was added, or brought back. */
export function addedTitle(added: { name: string; registered: boolean; cloned: boolean }): string {
  if (added.registered) return `${added.name} added`;
  return added.cloned ? `${added.name} cloned again` : `${added.name} is already open`;
}

/** U27: the team's repository isn't read on this Mac yet. */
export const READ_IT_AGAIN = "Read it again";
export const TEAM_NOT_READ = "Plyloft hasn't read the team repository on this Mac yet. Read it again to see the team's projects.";

/** U4/U20: Setup's line for a member, in Invite people's place: only the team's
 *  owner can invite (`team_owner_gate`). Null unless this is known to be someone
 *  else: `isOwner` is also false for an unread login or for the owner with
 *  another GitHub account active, who must not read "Ask {themselves}". */
export function askOwnerToInvite(facts: {
  isOwner: boolean;
  ownerLogin: string | null | undefined;
  /** The account GitHub answered as. */
  login: string | null | undefined;
  /** The Plyloft account signed in. */
  accountLogin: string | null | undefined;
}): string | null {
  if (facts.isOwner || !facts.login?.trim()) return null;
  const owner = facts.ownerLogin?.trim();
  const me = [facts.login, facts.accountLogin].map((l) => l?.trim().toLowerCase());
  if (owner && me.includes(owner.toLowerCase())) return null;
  return `Ask ${owner || "your team's owner"} to invite people.`;
}

/** Copy invite's toast. */
export function copiedToast(name: string | null | undefined): { title: string; body: string } {
  return {
    title: "Invite copied",
    body: `Send it to the people you invited to ${name?.trim() || "the team"}. It holds the team's name and code, nothing secret.`,
  };
}
