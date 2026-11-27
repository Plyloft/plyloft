// Launch T1–T3: the words and sums of a team with seats and payment. Pure (no
// React, no stores, no IPC), so `teamBilling.test.ts` runs it on its own. The
// backend decides (`team_billing.rs`, `billing_client.rs`, `license.rs`); this
// file only says it.
import type { AccountError, BillingInterval, CreateStage, TeamAccount, TeamView } from "../ipc";
import { teamPointerTitle } from "./planPage.ts";

/** Where to ask for help. A placeholder until the owner names an address. */
export const SUPPORT_CONTACT = "support@plyloft.com";

/** LAUNCH_PLAN D9 / §3.4: 2–50 seats, the owner's included. */
export const TEAM_MIN_SEATS = 2;
export const TEAM_MAX_SEATS = 50;

/** Team prices per member, VAT included (D19): €9 a month, €86.40 a year. */
export const SEAT_PRICE_CENTS: Record<BillingInterval, number> = { month: 900, year: 8640 };

export const WAITING_TITLE = "Waiting for the payment…";
export const PENDING_TITLE = "If you paid, your plan will appear shortly";
export const FINISH_TITLE = "Finish creating your team";
export const LAPSED_TITLE = "The team's plan has ended";

/** An amount in the currency's minor unit: `€12.90`, else `12.90 USD`. */
export function money(minor: number, currency: string): string {
  if (currency.toLowerCase() === "eur") return euros(minor);
  return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/** A seat count the server accepts: a whole number from 2 to 50. */
export function clampSeats(n: number): number {
  if (!Number.isFinite(n)) return TEAM_MIN_SEATS;
  return Math.min(TEAM_MAX_SEATS, Math.max(TEAM_MIN_SEATS, Math.round(n)));
}

/** `€9`, `€86.40`, `€1,728`: whole euros without cents. */
export function euros(cents: number): string {
  const whole = cents % 100 === 0;
  const value = cents / 100;
  return `€${value.toLocaleString("en-GB", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The choice's label: `Monthly · €9 per member a month`. */
export function intervalLabel(interval: BillingInterval): string {
  return interval === "month"
    ? `Monthly · ${euros(SEAT_PRICE_CENTS.month)} per member a month`
    : `Yearly · ${euros(SEAT_PRICE_CENTS.year)} per member a year`;
}

/** What Checkout will ask: `2 seats · €18 a month, VAT included.` */
export function totalLine(seats: number, interval: BillingInterval): string {
  const n = clampSeats(seats);
  const total = euros(SEAT_PRICE_CENTS[interval] * n);
  return `${n} seats · ${total} a ${interval}, VAT included.`;
}

/** Members' count: `2 of 3 seats`. */
export function seatCountLabel(team: Pick<TeamView, "seats" | "assigned">): string {
  return `${team.assigned.length} of ${team.seats} seats`;
}

/** Every seat is taken (`team_billing::seat_limit_words`). */
export function isSeatLimit(text: string | null | undefined): boolean {
  return /All (\d+ )?seats are taken/.test(text ?? "");
}

/** Seat holders the team's manifest doesn't list (not the owner), matched
 *  by GitHub id — a login can change: an add whose GitHub half never
 *  finished, or a removal whose seat stayed. `members` are the manifest's
 *  members with the ids GitHub gave; until they are read, nothing is said. */
export function seatsOutsideTheTeam(team: TeamView, members: readonly TeamAccount[] | null): TeamView["assigned"] {
  if (!members) return [];
  const listed = new Set(members.map((m) => m.sub));
  return team.assigned.filter((a) => a.sub !== team.owner.sub && !listed.has(a.sub));
}

/** Listed members (not the owner) who hold no seat, by GitHub id. */
export function membersWithoutSeat(team: TeamView, members: readonly TeamAccount[] | null): TeamAccount[] {
  if (!members) return [];
  const seated = new Set(team.assigned.map((a) => a.sub));
  return members.filter((m) => m.sub !== team.owner.sub && !seated.has(m.sub));
}

/** Whether `login` already holds a seat: by GitHub id where the manifest's
 *  members were read, else by login (a seat holder's login as the server has
 *  it). The owner always holds one. */
export function holdsSeat(team: TeamView, login: string, members: readonly TeamAccount[] | null): boolean {
  const lower = login.trim().toLowerCase();
  if (team.owner.login.toLowerCase() === lower) return true;
  if (team.assigned.some((a) => a.login.toLowerCase() === lower)) return true;
  const sub = members?.find((m) => m.login.toLowerCase() === lower)?.sub;
  return sub !== undefined && team.assigned.some((a) => a.sub === sub);
}

/** `holdsSeat` where the ids can decide it, for a line that states a fact: `null`
 *  when the members' ids weren't read or GitHub gave none for `login`, since
 *  the login alone misses a renamed holder. */
export function seatEvidence(
  team: TeamView,
  login: string,
  ids: { members: readonly TeamAccount[]; unresolved: readonly string[] } | null,
): boolean | null {
  const lower = login.trim().toLowerCase();
  if (!ids || ids.unresolved.some((u) => u.toLowerCase() === lower)) return null;
  return holdsSeat(team, login, ids.members);
}

/** N14 walk F7: adding `login` would take a seat, and none is free (every
 *  seat bought is held, or more are held than bought after a decrease).
 *  Review says so instead of a plan, unless GitHub has no such account; the
 *  backend still takes the seat first on send, so GitHub is never touched
 *  without one. */
export function noFreeSeatFor(team: TeamView, login: string, members: readonly TeamAccount[] | null): boolean {
  if (holdsSeat(team, login, members)) return false;
  return team.assigned.length >= team.seats;
}

/** F7: what Review says when no seat is free. A comp team's seats are set by
 *  Plyloft (the words of `team_billing::seat_limit_words`), so it offers no
 *  billing. */
export function noFreeSeatWords(seats: number, login: string, comp: boolean): { title: string; body: string } {
  const title = `All ${seats} seats are taken.`;
  return comp
    ? {
        title,
        body: `The team's seats are set by Plyloft, so ${login} can't be added until a seat is free. Nothing was sent to GitHub.`,
      }
    : {
        title,
        body: `Add a seat in billing to add ${login}; Plyloft checks again when you come back. Nothing was sent to GitHub.`,
      };
}

/** The server's team, only when it is this Mac's team: the same repository,
 *  or — before the bind — the owner's own unbound team. */
export function teamForThisMac(team: TeamView | null, macTeamRepo: string | null, accountSub: string | null): TeamView | null {
  if (!team) return null;
  if (team.teamRepo === null) return accountSub !== null && team.owner.sub === accountSub ? team : null;
  return macTeamRepo !== null && team.teamRepo.toLowerCase() === macTeamRepo.toLowerCase() ? team : null;
}

/** A lapse the Portal fixes (a payment to settle), not a new Checkout. */
export function lapseNeedsPortal(status: string): boolean {
  return ["unpaid", "paused", "incomplete"].includes(status);
}

/** D12: the plan stays while Stripe retries; anything else has ended. */
export function teamLapsed(team: Pick<TeamView, "status"> | null | undefined): boolean {
  return !!team && !["active", "trialing", "past_due"].includes(team.status);
}

/** What the lapsed notice says to the owner and to everybody else. */
export function lapsedText(owner: boolean, ownerLogin: string): string {
  return owner
    ? "Team features are paused for everyone on it. Renew to bring them back: the repository, its members and their seats stay as they are."
    : `Team features are paused. Ask ${ownerLogin} to renew it.`;
}

/** The owner's words for a lapse the Portal fixes. */
export function lapsedPortalText(): string {
  return "The team's payment needs attention. Settle it in billing: the repository, its members and their seats stay as they are.";
}

/** The words of a stage that has no form of its own, or null. */
export function stageNotice(stage: CreateStage): { title: string; text: string } | null {
  switch (stage.stage) {
    case "sign_in":
      return {
        title: "Sign in to Plyloft first.",
        text: "A team runs on the Team plan of your Plyloft account, so Plyloft needs to know who is paying for it.",
      };
    case "member":
      return {
        title: stage.teamRepo ? `You hold a seat on ${stage.teamRepo}.` : "You hold a seat on a team.",
        // 1.175.0 D5: the member can give the seat up themselves (Settings › Plan).
        text: "One team per account. Join that team in Settings › Team › Members and library instead, or give up the seat.",
      };
    case "lapsed":
      return stage.owner ? null : { title: LAPSED_TITLE, text: lapsedText(false, stage.ownerLogin) };
    default:
      return null;
  }
}

/** The label of the sign-in button of Create team's `sign_in` stage and of
 *  the joined-team notice (A3 D20, D21). */
export const SIGN_IN_ACTION = "Sign in with GitHub";

/** A3 D21: a joined team while signed out of Plyloft. */
export const SIGNED_OUT_SEAT_NOTICE = {
  title: "Sign in to use your seat",
  text: "Team features run on the seat the team's owner gives your GitHub account. Sign in to Plyloft with GitHub so Plyloft can find it.",
};

/** A3 D21, for the team's own owner (signed out of Plyloft): the seat is not
 *  given to them, their Team plan is found by the sign-in. */
export const SIGNED_OUT_OWNER_NOTICE = {
  title: "Sign in to use your Team plan",
  text: "Sign in to Plyloft with the GitHub account you use for this team.",
};

/** The signed-out notice for who is reading it: the owner, or a member. */
export function signedOutTeamNotice(isOwner: boolean): { title: string; text: string } {
  return isOwner ? SIGNED_OUT_OWNER_NOTICE : SIGNED_OUT_SEAT_NOTICE;
}

/** A3 D14 / D15 titles (the Plan page says the rest): the notice only
 *  points to it. `state` is `AccountInfo.team.state`; `here` says nothing. */
export function teamPlanPointer(
  team: { state: "here" | "elsewhere" | "nowhere"; device: string | null; teamRepo: string | null; role: "owner" | "member" | null } | null | undefined,
): string | null {
  return teamPointerTitle(team);
}

/** A refused Checkout, said for the Create team panel. */
export function checkoutErrorText(e: AccountError): string {
  switch (e.code) {
    case "already_subscribed":
      return `Your account already has a subscription. One subscription per account: manage it in billing, or contact ${SUPPORT_CONTACT}.`;
    case "network":
    case "rate_limited":
    case "server":
      return `${e.message} Nothing was charged.`;
    default:
      return e.message;
  }
}
