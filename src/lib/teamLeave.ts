/**
 * 1.175.0 D5 (review SRV-2; owner D5-a, D5-b): the words of **Leave this
 * team** for a member who holds a seat, and of **Give up the seat…** in
 * Settings › Plan for a seat on a team this computer never joined
 * (`team_leave_seat.rs`). One action: the seat first, then this computer;
 * nothing on GitHub.
 *
 * Pure, so node runs it (`teamLeave.test.ts`); the calls are in
 * `teamLeaveIpc.ts`. "this Mac" goes through `machineWords` where shown.
 */

import type { AccountInfo } from "../ipc";

/** `team_leave_seat::LeftSeat`. */
export interface LeftSeat {
  /** A seat was held and is free now; false: it was already free. */
  left: boolean;
  /** This computer no longer follows the team. */
  local: boolean;
}

/** `team_leave_seat::LeaveRefused`: nothing changed, here or on the server. */
export interface LeaveRefused {
  kind: "offline" | "signIn" | "unsupported" | "other";
  message: string;
}

/** 1.178.0: the seat is read from `AccountInfo.team` (unsigned, shown only):
 *  whether it is active on this computer or on another one does not change
 *  that the account holds it. Where `team` is null on a verified Team plan
 *  (nothing should leave it so, but a Team account is never read as "no
 *  seat" silently) the signed `plan` with its `teamRole` / `teamRepo` stands
 *  in: the same role and repository, only the state is unknown. */
type Info = Pick<AccountInfo, "signedIn" | "comp"> & {
  team?: Pick<NonNullable<AccountInfo["team"]>, "role" | "teamRepo"> | null;
  plan?: AccountInfo["plan"];
  teamRole?: AccountInfo["teamRole"];
  teamRepo?: AccountInfo["teamRepo"];
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The seat the account holds: `team`, else the signed Team plan's own. */
function seatOf(info: Info): { role: "owner" | "member" | null; teamRepo: string | null } | null {
  if (info.team) return info.team;
  if (info.plan === "team") return { role: info.teamRole ?? null, teamRepo: info.teamRepo ?? null };
  return null;
}

/** `comp` says a comp gave the plan signed for THIS computer. While the
 *  account's Team is on another computer (or on none yet) that signed plan
 *  is the one without Team, so a member who also has a comp reads `comp`
 *  here and still holds a seat: the server's `team` field says so (walk on
 *  Windows, 2026-11-26: *Give up the seat…* was hidden in that state). */
function compWithoutSeat(info: Info): boolean {
  return info.comp === true && info.team?.role !== "member";
}

/** This account holds a seat on the team this computer is in: Leave gives
 *  it up. The owner, a member without a seat and a comp keep today's Leave. */
export function holdsSeatHere(info: Info | null | undefined, macTeamRepo: string | null | undefined): boolean {
  if (!info?.signedIn || compWithoutSeat(info)) return false;
  const seat = seatOf(info);
  return seat?.role === "member" && same(seat.teamRepo, macTeamRepo);
}

/** A seat on a team this computer isn't in (Settings › Plan): its
 *  `owner/name`, or null. */
export function seatElsewhere(info: Info | null | undefined, macTeamRepo: string | null | undefined): string | null {
  if (!info?.signedIn || compWithoutSeat(info)) return null;
  const seat = seatOf(info);
  if (seat?.role !== "member") return null;
  const repo = seat.teamRepo;
  if (!repo || same(repo, macTeamRepo)) return null;
  return repo;
}

export const LEAVE_HINT_TODAY =
  "This Mac stops following the team. Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.";
export const LEAVE_OFFLINE = "Can't be done while offline — Plyloft needs your Plyloft account.";

/** The Danger zone row's hint. */
export function leaveRowHint(teamRepo: string, seat: boolean, offline: boolean): string {
  if (!seat) return LEAVE_HINT_TODAY;
  const gives = `You give up your seat on ${teamRepo}'s Team plan, and this Mac stops following the team.`;
  return offline
    ? `${gives} ${LEAVE_OFFLINE}`
    : `${gives} Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.`;
}

export const LEAVE_LEDE_TODAY =
  "This Mac stops following the team: its members, workspaces and library no longer show here. The team repository's clone and every team workspace stay on this Mac exactly as they are, and nothing changes on GitHub — the team goes on for everyone else.";
export const LEAVE_LEDE_SEAT =
  "You give up your seat on its Team plan, on every computer you use, and this Mac stops following the team.";

/** The sheet's two lists and its closing line. `owner`: the team owner's
 *  login, "the owner" when it isn't known. */
export function leaveSheetLists(owner: string | null | undefined): { lose: string[]; stays: string[]; hint: string } {
  const who = owner?.trim() || "the owner";
  return {
    lose: [
      "Team features: a board on GitHub Issues becomes read-only for you, and the team library stops updating.",
      `Your seat: ${who} can give it to someone else. Coming back needs a seat from them.`,
    ],
    stays: [
      "The team repository's clone and every team workspace stay on this Mac exactly as they are.",
      `Nothing changes on GitHub: your access to the repositories, your issues and your pull requests stay until ${who} removes you.`,
    ],
    hint: "Your plan goes back to Free: everything for one person keeps working. The team goes on for everyone else.",
  };
}

const STILL_HERE = "Its workspaces and clones are still here. Join or create a team whenever you like.";

/** The toast once the seat is free. */
export function leftToast(teamRepo: string, out: LeftSeat): { kind: "info" | "warn"; title: string; body: string } {
  if (!out.local) {
    return {
      kind: "warn",
      title: "Your seat is free, but this Mac still follows the team",
      body: "Plyloft couldn't save that here. Press Leave again; it is safe.",
    };
  }
  return {
    kind: "info",
    title: `You left ${teamRepo}`,
    body: out.left
      ? `Your seat is free, and this Mac no longer follows the team. ${STILL_HERE}`
      : `Your seat was already free, and this Mac no longer follows the team. ${STILL_HERE}`,
  };
}

export const COULD_NOT_LEAVE = "Couldn't leave the team";

function refusal(value: unknown): LeaveRefused {
  if (value && typeof value === "object" && "kind" in value && "message" in value) return value as LeaveRefused;
  return { kind: "other", message: typeof value === "string" ? value : value instanceof Error ? value.message : "" };
}

/** Why it didn't go through, said inside the sheet. `giveUp`: the Plan
 *  page's sheet, where nothing on this computer was at stake. */
export function refusedWords(cause: unknown, giveUp = false): string {
  const refused = refusal(cause);
  const nothing = giveUp ? "so your seat is still yours" : "so your seat is still yours and nothing changed on this Mac";
  switch (refused.kind) {
    case "offline":
      return `Plyloft couldn't reach your Plyloft account, ${nothing}. Check the connection and try again.`;
    case "signIn":
      return `Your Plyloft sign-in ran out, ${nothing}. Sign in again in Settings › Setup and account › Profile, then try again.`;
    case "unsupported":
      // A server older than 1.175: it can't free the seat yet.
      return `Plyloft's account service couldn't free your seat yet, ${nothing}. Try again later.`;
    default: {
      const said = refused.message.trim();
      return said ? `${/[.!?]$/.test(said) ? said : `${said}.`} Your seat is still yours${giveUp ? "" : ", and nothing changed on this Mac"}.` : `Your seat is still yours${giveUp ? "" : ", and nothing changed on this Mac"}. Try again in a moment.`;
    }
  }
}

// ── Settings › Plan: a seat on a team this computer isn't in ──

export function seatElsewhereNotice(teamRepo: string): { title: string; text: string } {
  return {
    title: `You hold a seat on ${teamRepo}.`,
    text: "One team per account. Join that team in Settings › Team › Members and library instead, or give up the seat.",
  };
}

export const GIVE_UP_ACTION = "Give up the seat…";
export const GIVE_UP_CONFIRM = "Give up the seat";

/** Giving the seat up frees it on every computer of the account, so the
 *  sheet says so (review, 2026-11-26): it matters most to a member whose
 *  Team is active on another computer. */
export function giveUpSheet(teamRepo: string): { title: string; lede: string } {
  return {
    title: `Give up your seat on ${teamRepo}?`,
    lede: "You hold a seat on its Team plan, and this Mac isn't in that team. Giving it up lets you join another team or start your own. This frees your seat on this team across all your computers. Nothing on this Mac or on GitHub changes.",
  };
}

export function gaveUpToast(teamRepo: string): { title: string; body: string } {
  return { title: `Your seat on ${teamRepo} is free`, body: "You can join a team or start your own now." };
}
