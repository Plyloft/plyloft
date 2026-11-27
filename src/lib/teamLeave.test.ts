// 1.175.0 D5 (SRV-2): who gives up a seat by leaving, and the words of the
// row, the sheet, the toasts and the refusals (`STRINGS-sharing.md`, D5).
import assert from "node:assert/strict";
import {
  COULD_NOT_LEAVE,
  GIVE_UP_ACTION,
  LEAVE_HINT_TODAY,
  LEAVE_LEDE_SEAT,
  gaveUpToast,
  giveUpSheet,
  holdsSeatHere,
  leaveRowHint,
  leaveSheetLists,
  leftToast,
  refusedWords,
  seatElsewhere,
  seatElsewhereNotice,
} from "./teamLeave.ts";
import { stageNotice } from "./teamBilling.ts";

const seat = (over: Record<string, unknown> = {}) => ({
  state: "here" as const,
  device: null,
  teamRepo: "mbadv/plyloft-team" as string | null,
  role: "member" as "owner" | "member" | null,
  ...over,
});
const member = { signedIn: true, comp: false, team: seat() };

// ── Who holds a seat here, and who holds one elsewhere ──
assert.equal(holdsSeatHere(member, "mbadv/plyloft-team"), true);
assert.equal(holdsSeatHere(member, "MBADV/Plyloft-Team "), true, "a repository's name is not case-sensitive");
assert.equal(holdsSeatHere({ ...member, team: seat({ role: "owner" }) }, "mbadv/plyloft-team"), false, "the owner's seat isn't left from here");
assert.equal(holdsSeatHere({ signedIn: true, comp: true, team: null, plan: "team" as const, teamRole: "owner" as const, teamRepo: "mbadv/plyloft-team" }, "mbadv/plyloft-team"), false, "a comp's own team has no seat to give up");
assert.equal(
  holdsSeatHere({ ...member, comp: true }, "mbadv/plyloft-team"),
  true,
  "a member whose Team is on another computer reads the comp's plan here, and still holds the seat",
);
assert.equal(holdsSeatHere({ ...member, team: null }, "mbadv/plyloft-team"), false, "listed, without a seat");
assert.equal(holdsSeatHere(member, "other/team"), false);
assert.equal(holdsSeatHere({ ...member, team: seat({ state: "elsewhere", device: "MacBook Pro" }) }, "mbadv/plyloft-team"), true, "the seat is held while Team is active on another computer");
assert.equal(holdsSeatHere({ ...member, team: seat({ state: "nowhere" }) }, "mbadv/plyloft-team"), true, "and while it is not chosen anywhere yet");
// A Team plan whose `team` is null is never read as "no seat" silently.
const planOnly = { signedIn: true, comp: false, team: null, plan: "team" as const, teamRole: "member" as const, teamRepo: "mbadv/plyloft-team" };
assert.equal(holdsSeatHere(planOnly, "mbadv/plyloft-team"), true, "signed Team plan, team null: the plan's own role and repository");
assert.equal(holdsSeatHere({ ...planOnly, teamRole: "owner" as const }, "mbadv/plyloft-team"), false);
assert.equal(holdsSeatHere({ ...planOnly, plan: "free" as const }, "mbadv/plyloft-team"), false, "no Team plan, no seat");
assert.equal(seatElsewhere(planOnly, null), "mbadv/plyloft-team");
assert.equal(seatElsewhere({ ...planOnly, plan: "free" as const }, null), null);
assert.equal(holdsSeatHere({ ...member, signedIn: false }, "mbadv/plyloft-team"), false);
assert.equal(holdsSeatHere(null, "mbadv/plyloft-team"), false);
assert.equal(seatElsewhere(member, null), "mbadv/plyloft-team");
assert.equal(seatElsewhere(member, "other/team"), "mbadv/plyloft-team");
assert.equal(seatElsewhere(member, "mbadv/plyloft-team"), null, "this Mac is in it: Leave is in Settings › Team");
assert.equal(seatElsewhere({ ...member, team: seat({ role: "owner" }) }, null), null);
assert.equal(seatElsewhere({ ...member, comp: true }, null), "mbadv/plyloft-team", "Team elsewhere, a comp's plan signed here: the seat is still theirs to give up");
assert.equal(seatElsewhere({ signedIn: true, comp: true, team: null }, null), null);

// ── The row ──
assert.equal(
  leaveRowHint("mbadv/plyloft-team", true, false),
  "You give up your seat on mbadv/plyloft-team's Team plan, and this Mac stops following the team. Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.",
);
assert.equal(
  leaveRowHint("mbadv/plyloft-team", true, true),
  "You give up your seat on mbadv/plyloft-team's Team plan, and this Mac stops following the team. Can't be done while offline — Plyloft needs your Plyloft account.",
);
// The owner and a member without a seat: today's row, offline or not.
assert.equal(leaveRowHint("mbadv/plyloft-team", false, false), LEAVE_HINT_TODAY);
assert.equal(leaveRowHint("mbadv/plyloft-team", false, true), LEAVE_HINT_TODAY);
assert.equal(
  LEAVE_HINT_TODAY,
  "This Mac stops following the team. Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.",
);

// ── The sheet ──
assert.equal(
  LEAVE_LEDE_SEAT,
  "You give up your seat on its Team plan, on every computer you use, and this Mac stops following the team.",
);
const lists = leaveSheetLists("test-owner");
assert.deepEqual(lists.lose, [
  "Team features: a board on GitHub Issues becomes read-only for you, and the team library stops updating.",
  "Your seat: test-owner can give it to someone else. Coming back needs a seat from them.",
]);
assert.deepEqual(lists.stays, [
  "The team repository's clone and every team workspace stay on this Mac exactly as they are.",
  "Nothing changes on GitHub: your access to the repositories, your issues and your pull requests stay until test-owner removes you.",
]);
assert.equal(
  lists.hint,
  "Your plan goes back to Free: everything for one person keeps working. The team goes on for everyone else.",
);
assert.match(leaveSheetLists(null).lose[1], /^Your seat: the owner can give it to someone else\./);

// ── The toasts ──
assert.deepEqual(leftToast("mbadv/plyloft-team", { left: true, local: true }), {
  kind: "info",
  title: "You left mbadv/plyloft-team",
  body: "Your seat is free, and this Mac no longer follows the team. Its workspaces and clones are still here. Join or create a team whenever you like.",
});
assert.equal(
  leftToast("mbadv/plyloft-team", { left: false, local: true }).body,
  "Your seat was already free, and this Mac no longer follows the team. Its workspaces and clones are still here. Join or create a team whenever you like.",
);
assert.deepEqual(leftToast("mbadv/plyloft-team", { left: true, local: false }), {
  kind: "warn",
  title: "Your seat is free, but this Mac still follows the team",
  body: "Plyloft couldn't save that here. Press Leave again; it is safe.",
});

// ── Refusals, inside the sheet: nothing changed ──
assert.equal(COULD_NOT_LEAVE, "Couldn't leave the team");
assert.equal(
  refusedWords({ kind: "offline", message: "connection refused" }),
  "Plyloft couldn't reach your Plyloft account, so your seat is still yours and nothing changed on this Mac. Check the connection and try again.",
);
assert.equal(
  refusedWords({ kind: "signIn", message: "Sign in again." }),
  "Your Plyloft sign-in ran out, so your seat is still yours and nothing changed on this Mac. Sign in again in Settings › Setup and account › Profile, then try again.",
);
// A server older than 1.175 (404 for the route): a failure, never "already free".
const old = refusedWords({ kind: "unsupported", message: "Not found." });
assert.match(old, /so your seat is still yours and nothing changed on this Mac\./);
assert.doesNotMatch(old, /already free|Not found/);
// The server's own sentence (the owner's seat) is said, with what stands.
assert.equal(
  refusedWords({ kind: "other", message: "You own this team, and the owner's seat can't be left." }),
  "You own this team, and the owner's seat can't be left. Your seat is still yours, and nothing changed on this Mac.",
);
assert.match(refusedWords("boom"), /^boom\. Your seat is still yours/);
assert.match(refusedWords({ kind: "offline", message: "" }, true), /so your seat is still yours\. Check the connection/);

// ── Settings › Plan ──
assert.deepEqual(seatElsewhereNotice("acme/widgets-team"), {
  title: "You hold a seat on acme/widgets-team.",
  text: "One team per account. Join that team in Settings › Team › Members and library instead, or give up the seat.",
});
assert.equal(GIVE_UP_ACTION, "Give up the seat…");
assert.deepEqual(giveUpSheet("acme/widgets-team"), {
  title: "Give up your seat on acme/widgets-team?",
  lede: "You hold a seat on its Team plan, and this Mac isn't in that team. Giving it up lets you join another team or start your own. This frees your seat on this team across all your computers. Nothing on this Mac or on GitHub changes.",
});
assert.deepEqual(gaveUpToast("acme/widgets-team"), {
  title: "Your seat on acme/widgets-team is free",
  body: "You can join a team or start your own now.",
});
// The Create-team panel's notice says the same way out.
assert.equal(
  stageNotice({ stage: "member", teamRepo: "acme/widgets-team" } as never)?.text,
  "One team per account. Join that team in Settings › Team › Members and library instead, or give up the seat.",
);

console.log("teamLeave: ok");
