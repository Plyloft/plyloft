/**
 * Skills hub H2 (`docs/plans/SKILLS_HUB.md` R1, R14, R16, R17): the words for
 * the team library keeping itself current — "Updated 4 minutes ago", the
 * toast that names who changed a skill, the question when GitHub stops
 * letting this account read it, and leaving the team. Pure, so the pages and
 * the toast say the same thing.
 */
import type { LibraryPullView, SkillsHubPulled } from "../ipc";
import { relativeWhen } from "./proposals";
import { splitErrors } from "./ghTrouble";

export interface PullLine {
  text: string;
  /** `done`: current. `empty`: quiet, but not current. */
  state: "done" | "empty";
}

/**
 * The team section's one line about when the library was last pulled, or
 * `null` when another notice says it all (left the team).
 */
export function libraryPullLine(view: LibraryPullView | null, now: number): PullLine | null {
  if (!view || view.leftAt != null) return null;
  if (view.switchedOff) {
    return { text: "Switched off on this Mac · sessions get no team skills", state: "empty" };
  }
  const why = pullTrouble(view);
  if (view.lastPullAt == null) {
    if (view.hasClone) {
      // A clone from before this build kept a record: nothing to say yet.
      return why ? { text: `Not updated yet${why}`, state: "empty" } : null;
    }
    // (Challenger) The reason it isn't here yet is the one the last attempt
    // gave: "couldn't reach GitHub" only when GitHub couldn't be asked.
    return { text: `Not downloaded yet${notDownloadedWhy(view)}`, state: "empty" };
  }
  const when = relativeWhen(view.lastPullAt, now);
  return why
    ? { text: `Last updated ${when}${why}`, state: "empty" }
    : { text: `Updated ${when}`, state: "done" };
}

function pullTrouble(view: LibraryPullView): string {
  if (view.heldBack === "plan") return " · Team plan needed to keep it current";
  switch (view.lastError) {
    case "offline":
      return " · offline";
    case "noAccess":
      return " · GitHub refused the repository";
    case "failed":
      return " · couldn't update";
    // (Challenger) GitHub answered, but the copy on this Mac holds a change
    // not published yet (or an operation under way); Settings › Team says
    // which, with its way out.
    case "held":
      return " · waiting on a change on this Mac (see Settings › Team › Members and library)";
    default:
      return "";
  }
}

function notDownloadedWhy(view: LibraryPullView): string {
  switch (view.lastError) {
    case "offline":
      return " · couldn't reach GitHub";
    case "noAccess":
      return " · GitHub refused the repository";
    case "failed":
      return " · couldn't download it";
    default:
      return "";
  }
}

/** R16: the question, while it waits for the member's answer. */
export function accessLostNotice(view: LibraryPullView | null, now: number): string | null {
  if (!view || view.accessLost == null || view.keptLastCopy || view.switchedOff) return null;
  const who = view.login ? `${view.login}'s GitHub account` : "your GitHub account";
  const copy =
    view.lastPullAt != null
      ? `Your sessions still get the copy from ${relativeWhen(view.lastPullAt, now)}.`
      : "Your sessions still get the last copy.";
  return `${view.repo} isn't reachable with ${who} any more. ${copy}`;
}

/**
 * What of the pull record changes the Library's team rows: leaving or
 * rejoining, switching off or on, the clone going or coming back, and a pull
 * that moved it. The Library reads its rows again when this changes, and
 * not on every pull that brought nothing (Windows walk of H2).
 */
export function teamRowsKey(view: LibraryPullView | null): string {
  if (!view) return "";
  return [
    view.repo,
    view.hasClone ? "clone" : "no clone",
    view.leftAt != null ? "left" : "in",
    view.switchedOff ? "off" : "on",
    view.lastPullCommit ?? "",
  ].join("|");
}

/**
 * "Acme's team", or the name alone when it already says team ("Plyloft test
 * team", "acme/acme-team") — never "Plyloft test team's team" (Windows walk
 * of H2).
 */
export function teamPhrase(name: string): string {
  const trimmed = name.trim();
  return /team$/i.test(trimmed) ? trimmed : `${trimmed}'s team`;
}

/** R17: this Mac is no longer in the team. */
export function leftTeamNotice(view: LibraryPullView | null): string | null {
  if (!view || view.leftAt == null) return null;
  const team = teamPhrase(view.teamName ?? view.repo);
  const kept = view.cloneKept
    ? ` Its copy stays on this Mac (${view.cloneKept}).`
    : " Its library left this Mac.";
  return `You're no longer in ${team}.${kept} Skills copied into repositories stay as they are.`;
}

/**
 * Settings › Team: the read failed because GitHub couldn't be reached (the
 * pull record says offline, or the error is a network one). One plain line
 * instead of git's own words, which stay behind Show details. `null` when it
 * isn't that.
 */
export function offlineTeamLine(
  error: string | null | undefined,
  view: LibraryPullView | null,
  now: number,
): string | null {
  if (!error || !error.trim()) return null;
  // Offline by the pull record or by the words; and every error of the read
  // is one the network explains — another one (a manifest that doesn't
  // parse) keeps the read's own words.
  if (view?.lastError !== "offline" && !looksOffline(error)) return null;
  if (!splitErrors(error).every((e) => NETWORK_STEP.test(e) || looksOffline(e))) return null;
  if (view?.lastPullAt != null) {
    return `Couldn't reach GitHub. New sessions use the copy from ${relativeWhen(view.lastPullAt, now)}.`;
  }
  if (view?.hasClone) return "Couldn't reach GitHub. New sessions use the copy on this Mac.";
  return "Couldn't reach GitHub, so the team library isn't on this Mac yet.";
}

/** Network words from git, gh and curl (the offline list of
 *  `project_setup.rs`'s clone-failure classifier). */
const OFFLINE_WORDS = [
  "could not resolve host",
  "failed to connect",
  "couldn't connect",
  "connection timed out",
  "operation timed out",
  "connection reset",
  "network is unreachable",
  "error connecting to",
  "dial tcp",
  "no such host",
];

/** The read's steps that go over the network (`team::status_after_sync`,
 *  `team::probe_membership`). */
const NETWORK_STEP =
  /^Could not (pull the team repo|fetch the team repo|read your GitHub login|check access to)\b/;

function looksOffline(error: string): boolean {
  const lower = error.toLowerCase();
  return OFFLINE_WORDS.some((words) => lower.includes(words));
}

/** "Ana", "Ana and Bo", "Ana and 2 others". */
function people(names: string[]): string {
  if (names.length === 0) return "Someone";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/**
 * R1 / R14: one toast per pull, never one per skill — "Ana changed
 * review-rules", "Ana changed review-rules and 2 more". `null` when the pull
 * changed no skill.
 */
export function pulledToastText(pulled: SkillsHubPulled): string | null {
  const [first, ...rest] = pulled.changes;
  if (!first) return null;
  const authors: string[] = [];
  for (const change of pulled.changes) {
    for (const author of change.authors) if (!authors.includes(author)) authors.push(author);
  }
  const more = rest.length > 0 ? ` and ${rest.length} more` : "";
  return `${people(authors)} changed ${first.skill}${more}`;
}
