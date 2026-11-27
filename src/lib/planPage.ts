// Launch A3 (LAUNCH_PLAN §2 D12, D14–D16, §3.2, §5): the words of Settings ›
// Account › Plan. Pure — built from the account the backend derived
// (`account.rs::AccountInfo`) — so every state is testable without a window.
// The backend decides the plan; this file only says it.
//
// 1.178.0 (A3): the Plyloft account is only for teams. Free has no devices
// and no notices; Team runs on one computer at a time, moved only by Use Team
// on this computer (`AccountInfo.team`, shown only, never a gate).
import type { AccountInfo } from "../ipc";
import { otherComputer, planWord } from "./signIn.ts";

/** D12: the plan stays while Stripe retries. */
export const PAST_DUE =
  "Payment problem — Stripe is retrying; update your card.";

/** D12 for a seat holder: the owner pays, so the owner fixes it. */
export const TEAM_PAST_DUE = "The team's payment has a problem; the owner is updating it.";

/** A seat holder's billing row. */
export const MEMBER_BILLING = "Billing is managed by the team owner.";

/** Manage subscription answered `not_found`, by what the plan is. */
export const NOT_FOUND_SEAT = "Your plan comes from a seat on the team; the team owner manages billing.";
export const NOT_FOUND_COMP = "Your plan is included with your account, so there is no subscription to manage.";
export const NOT_FOUND_PAID =
  "Plyloft's server found no subscription for this account. Check now; if your plan still shows, write to support.";
export const NO_SUBSCRIPTION_YET = "You have no subscription.";

/** What `not_found` from the billing portal means for `info`. */
export function notFoundText(info: AccountInfo | null): string {
  if (!info || info.plan === "free") return NO_SUBSCRIPTION_YET;
  if (info.comp) return NOT_FOUND_COMP;
  if (info.teamRole === "member") return NOT_FOUND_SEAT;
  return NOT_FOUND_PAID;
}

/** "Start a team": one subscription per account (the T lane's wording in
 *  Settings › Team). */
export const START_TEAM_HINT =
  "Team is paid per member, with seats you give to people. You buy it where the team is created, in Settings › Team › Members and library.";

/** `already_subscribed` on a Team checkout: the Portal opens instead. */
export const ALREADY_SUBSCRIBED =
  "You already have a paid plan, so Stripe's billing portal opened instead of a new payment page.";

/** N14 walk F12: the app's dates are English whatever the Mac's region
 *  ("4 Oct 2026", not "4 ott 2026"), as `teamBilling.euros` formats prices;
 *  the time zone stays the Mac's. */
export const APP_DATE_LOCALE = "en-GB";

/** "4 Oct 2026". */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(APP_DATE_LOCALE, { year: "numeric", month: "short", day: "numeric" });
}

/** "2 Oct 2026, 15:57". */
export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(APP_DATE_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function signedIn(info: AccountInfo | null): info is AccountInfo {
  return Boolean(info?.signedIn);
}

/** Only Team is a paid plan: an entitlement that still says `pro` (an old
 *  comp) reads as Free everywhere on this page. */
function onTeam(info: AccountInfo): boolean {
  return info.plan === "team";
}

/** The plan as the row says it: `Free`, `Team · owner`, `Team · member`,
 *  `Team · Included` (a comp, D15). */
export function planLine(info: AccountInfo | null): string {
  if (!signedIn(info)) return "Free";
  const word = planWord(info.plan);
  if (!onTeam(info)) return word;
  if (info.comp) return `${word} · Included`;
  if (info.teamRole) return `${word} · ${info.teamRole}`;
  return word;
}

/** The sentence under the plan: what it covers and when it renews. The
 *  entitlement carries the period's end but not whether it is set to cancel,
 *  so the end is said as it is. */
export function planHint(info: AccountInfo | null): string {
  if (!signedIn(info)) {
    return "All individual features are free. You only need a Plyloft account to start or join a team.";
  }
  const team =
    info.plan === "team"
      ? info.teamRepo
        ? `For the team ${info.teamRepo}. `
        : info.teamRole === "owner" || info.comp
          ? "No team repository is bound yet; Settings › Team › Members and library creates it. "
          : ""
      : "";
  if (!onTeam(info)) return "You can run cards in parallel and use all individual features for free.";
  if (info.comp) return `${team}Included with your account: nothing to pay or renew.`;
  if (info.periodEnd != null) {
    return info.cancelAtPeriodEnd
      ? `${team}Ends on ${fmtDate(info.periodEnd)} · not renewing.`
      : `${team}Renews on ${fmtDate(info.periodEnd)}.`;
  }
  return team.trim() || "Paid plan.";
}

/** D12: Stripe is retrying a failed renewal; the plan stays meanwhile. */
export function paymentProblem(info: AccountInfo | null): boolean {
  return signedIn(info) && onTeam(info) && info.status === "past_due";
}

/** The payment-problem line: the payer is told to update the card; a seat
 *  holder that the owner is on it. */
export function paymentProblemText(info: AccountInfo | null): string | null {
  if (!paymentProblem(info)) return null;
  return isTeamMember(info) ? TEAM_PAST_DUE : PAST_DUE;
}

/** A seat on somebody else's team (not a comp). */
export function isTeamMember(info: AccountInfo | null): boolean {
  return signedIn(info) && info.plan === "team" && info.teamRole === "member" && !info.comp;
}

/** Manage subscription for whoever pays: a Team owner. Not a comp
 *  (nothing to pay) and not a seat holder (the owner pays). */
export function canManage(info: AccountInfo | null): boolean {
  return signedIn(info) && onTeam(info) && !info.comp && !isTeamMember(info);
}

/** "Start a team" for anyone not on a team yet — signed out too (A3 D23).
 *  An account whose Team plan or seat waits on another computer, or for a
 *  choice, has a team already. */
export function canStartTeam(info: AccountInfo | null): boolean {
  if (!signedIn(info)) return true;
  return !onTeam(info) && !info.team;
}

/** Team is active on this computer: the **This device** row (D12) and Sign
 *  out other computers (D13) are drawn only here. */
export function teamHere(info: AccountInfo | null): boolean {
  return signedIn(info) && onTeam(info);
}

/** The last verified plan was Team: the offline and "not checked" notices
 *  are said only then — Free stays Free whatever the server says. */
function lastKnownTeam(info: AccountInfo): boolean {
  return info.lastKnownPlan === "team";
}

/** "Last checked 2 Oct 2026, 14:05". */
export function lastCheckedLine(info: AccountInfo | null): string {
  if (!info?.lastCheckedAt) return "Not checked yet";
  return `Last checked ${fmtDateTime(info.lastCheckedAt)}`;
}

/** What Free keeps and what it turns off, said the same everywhere. */
export const FREE_MEANWHILE = "Everything for one person keeps working; team features are off";

/** §5 "Offline later": the cached plan holds until it expires; after that
 *  this Mac runs on Free (QoL 1.168, owner D2), never a lock. */
export function offlineNote(info: AccountInfo | null): string | null {
  if (!signedIn(info) || !info.offline || !lastKnownTeam(info)) return null;
  return info.exp != null
    ? `Plyloft couldn't reach its server, so this is the plan it last checked. It holds until ${fmtDate(info.exp)}.`
    : `Plyloft couldn't reach its server, and the plan it last checked has run out, so this Mac is on Free until a check goes through. ${FREE_MEANWHILE}.`;
}

/** A3: the one press that moves Team (verbatim on both platforms: "this
 *  computer" is not `machineWords`'). */
export const USE_TEAM_HERE = "Use Team on this computer";
/** While the press is out (D14). */
export const USE_TEAM_BUSY = "Moving Team here…";
/** D17, through `machineWords`. */
export const USE_TEAM_DONE = "Team is on this Mac now";
export const USE_TEAM_FAILED = "Team wasn't moved to this Mac";

/** D14: why team features are off here, through `machineWords`. */
export const TEAM_ELSEWHERE_TEXT =
  "Team features run on one computer at a time, so they are off on this Mac. Everything for one person keeps working here.";
/** D15: a Team plan or seat that no computer has chosen yet. */
export const TEAM_READY_TEXT =
  "Team features run on one computer at a time. Choose this one, or press the same button on another. Everything for one person keeps working on both.";

/** D12: the This device row, on the computer that holds Team. */
export const THIS_DEVICE_HINT =
  "Team features run on one computer at a time, this one. Use Team on this computer on another one moves them there.";

/** The account's Team plan or seat, not active here: on another computer
 *  (D14) or waiting to be chosen (D15). Null on Free, signed out, Team here,
 *  or a server that doesn't say (`team` null: no button it can't honour). */
export interface TeamChoice {
  state: "elsewhere" | "nowhere";
  /** The callout's title. */
  title: string;
  /** The callout's sentence (`machineWords` when shown). */
  text: string;
  /** The sidebar row's first line (D16). */
  row: string;
  teamRepo: string | null;
}

/** The D14 / D15 titles, from the account's `team` alone, so the Plan page's
 *  callout and the joined-team notice (`teamBilling.ts::teamPlanPointer`)
 *  say the same words. Null when Team is active here or `team` is null. */
export function teamPointerTitle(team: AccountInfo["team"] | undefined): string | null {
  if (!team || team.state === "here") return null;
  if (team.state === "elsewhere") return `Team is on ${otherComputer(team.device ?? "")}`;
  return team.role === "member" && team.teamRepo ? `Your seat on ${team.teamRepo} is ready` : "Your Team plan is ready";
}

export function teamChoice(info: AccountInfo | null): TeamChoice | null {
  if (!signedIn(info) || onTeam(info)) return null;
  const team = info.team;
  const title = teamPointerTitle(team);
  if (!team || !title) return null;
  if (team.state === "elsewhere") {
    return { state: "elsewhere", title, text: TEAM_ELSEWHERE_TEXT, row: title, teamRepo: team.teamRepo };
  }
  const member = team.role === "member" && team.teamRepo;
  return {
    state: "nowhere",
    title,
    text: TEAM_READY_TEXT,
    row: member ? "Your Team seat is ready" : "Your Team plan is ready",
    teamRepo: team.teamRepo,
  };
}

const sameRepo = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** This computer follows the account's team (`settings.team.teamRepo`,
 *  compared as `teamLeave.ts` compares it): only then does the sidebar say
 *  that Team waits elsewhere (D16, owner g.4). */
export function followsTeam(info: AccountInfo | null, macTeamRepo: string | null | undefined): boolean {
  return sameRepo(info?.team?.teamRepo, macTeamRepo);
}

/** QoL 12.2 (owner D2): signed in, but the plan can't be verified (it ran
 *  out while Plyloft couldn't reach its server, or the answer didn't
 *  verify): Free until Check now succeeds. 1.178.0: said only when the last
 *  verified plan was Team. */
export function planUnverified(info: AccountInfo | null): boolean {
  return signedIn(info) && !info.entitlementValid && lastKnownTeam(info);
}

export function planUnverifiedText(info: AccountInfo): string {
  const since = info.lastCheckedAt ? `since ${fmtDateTime(info.lastCheckedAt)}` : "yet";
  return `Plyloft hasn't been able to check your plan ${since}, so this Mac is on Free until a check goes through. ${FREE_MEANWHILE}. Your work is untouched.`;
}

/** How long before a plan that isn't renewing ends the sidebar says so. */
export const ENDING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/** QoL 12.4 (G21): a plan problem said outside Settings, as one sidebar
 *  status row — the most urgent one. `does` names the row's action:
 *  `use_team` (Use Team on this computer), `check` (Check now), `portal`
 *  (Stripe's billing portal), `plan` (Settings › Account › Plan). `wrap`:
 *  the words on their line and the action under them (D16). */
export interface PlanAttention {
  tone: "warn" | "info";
  text: string;
  title: string;
  action: { label: string; does: "use_team" | "check" | "portal" | "plan"; title?: string };
  wrap?: boolean;
}

/** 1.178.0 (A3): a row only for Team — a Team plan whose payment, end or
 *  check needs a look, or (D16) a Team plan or seat active elsewhere or
 *  waiting, on a computer that follows that team (`followsTeam`). Never a
 *  row for a Free account. */
export function planAttention(info: AccountInfo | null, followsTeam: boolean, now: number = Date.now()): PlanAttention | null {
  if (!signedIn(info)) return null;
  const choice = teamChoice(info);
  if (choice) {
    if (!followsTeam) return null;
    return {
      tone: "info",
      text: choice.row,
      title: choice.text,
      action: { label: USE_TEAM_HERE, does: "use_team" },
      wrap: true,
    };
  }
  if (planUnverified(info)) {
    return {
      tone: "warn",
      text: info.lastCheckedAt ? `Plan not checked since ${fmtDate(info.lastCheckedAt)}` : "Plan not checked",
      title: planUnverifiedText(info),
      action: { label: "Check now", does: "check", title: "Ask Plyloft's server for your plan" },
    };
  }
  if (paymentProblem(info)) {
    return isTeamMember(info)
      ? {
          tone: "info",
          text: "The team's payment has a problem",
          title: TEAM_PAST_DUE,
          action: { label: "Details", does: "plan", title: "Open Settings › Setup and account › Plan" },
        }
      : {
          tone: "warn",
          text: "Payment problem",
          title: PAST_DUE,
          action: { label: "Fix", does: "portal", title: "Update your card in Stripe's billing portal" },
        };
  }
  if (info.cancelAtPeriodEnd && info.periodEnd != null && !info.comp && onTeam(info)) {
    const left = info.periodEnd - now;
    if (left > 0 && left <= ENDING_SOON_MS) {
      const text = `${planWord(info.plan)} ends ${fmtDate(info.periodEnd)}`;
      return canManage(info)
        ? {
            tone: "info",
            text,
            title: "Your plan isn't renewing. Renew it in Stripe's billing portal to keep it.",
            action: { label: "Renew", does: "portal", title: "Open Stripe's billing portal" },
          }
        : {
            tone: "info",
            text,
            title: "The team's plan isn't renewing; its owner can renew it.",
            action: { label: "Details", does: "plan", title: "Open Settings › Setup and account › Plan" },
          };
    }
  }
  return null;
}

/** What Settings › Plan draws, as the search and the palette filter it
 *  (`settingsSearch.ts::SearchVisibility`). */
export function planSearchFlags(info: AccountInfo | null): {
  signedIn: boolean;
  onTeamPlan: boolean;
  teamHere: boolean;
  managesBilling: boolean;
  teamMember: boolean;
} {
  return {
    signedIn: signedIn(info),
    // Start a team is drawn exactly when this is false (A3 D23).
    onTeamPlan: !canStartTeam(info),
    teamHere: teamHere(info),
    managesBilling: canManage(info),
    teamMember: isTeamMember(info),
  };
}
