// Tier 3 pure-function test (launch T1–T3). Run with Node 22+:
//   node --experimental-strip-types src/lib/teamBilling.test.ts
import assert from "node:assert/strict";
import {
  checkoutErrorText,
  clampSeats,
  euros,
  intervalLabel,
  isSeatLimit,
  lapseNeedsPortal,
  lapsedText,
  holdsSeat,
  membersWithoutSeat,
  noFreeSeatFor,
  noFreeSeatWords,
  SUPPORT_CONTACT,
  teamForThisMac,
  seatCountLabel,
  seatsOutsideTheTeam,
  stageNotice,
  SIGN_IN_ACTION,
  SIGNED_OUT_SEAT_NOTICE,
  teamPlanPointer,
  signedOutTeamNotice,
  teamLapsed,
  totalLine,
} from "./teamBilling.ts";
import type { TeamView } from "../ipc.ts";

const TEAM: TeamView = {
  teamRepo: "boss/team",
  owner: { sub: "1", login: "boss" },
  seats: 3,
  assigned: [
  { sub: "1", login: "boss" },
  { sub: "2", login: "Member" },
  { sub: "3", login: "stray" },
  ],
  status: "active",
  periodEnd: null,
};

// ── prices
{
  // are €9 a month and €86.40 a year per member, VAT included
  assert.equal(intervalLabel("month"), "Monthly · €9 per member a month");
  assert.equal(intervalLabel("year"), "Yearly · €86.40 per member a year");
  assert.equal(totalLine(2, "month"), "2 seats · €18 a month, VAT included.");
  assert.equal(totalLine(5, "year"), "5 seats · €432 a year, VAT included.");
  assert.equal(totalLine(3, "year"), "3 seats · €259.20 a year, VAT included.");
  assert.equal(euros(172_800), "€1,728");
}

{
  // seats stay between 2 and 50, the owner's included
  assert.equal(clampSeats(1), 2);
  assert.equal(clampSeats(0), 2);
  assert.equal(clampSeats(51), 50);
  assert.equal(clampSeats(7.4), 7);
  assert.equal(clampSeats(Number.NaN), 2);
  assert.equal(totalLine(99, "month"), "50 seats · €450 a month, VAT included.");
}

// ── seats
{
  // counts holders of seats bought
  assert.equal(seatCountLabel(TEAM), "3 of 3 seats");
}

{
  // knows the server's every-seat-taken words, wrapped or not
  assert.equal(isSeatLimit("All 2 seats are taken. Add seats in billing, then add b again."), true);
  assert.equal(isSeatLimit("join failed: All seats are taken. Add seats…"), true);
  assert.equal(isSeatLimit("b is already on another team."), false);
  assert.equal(isSeatLimit(null), false);
}

{
  // finds seat holders the manifest doesn't list by GitHub id, never the owner
  const boss = { sub: "1", login: "boss" };
  const member = { sub: "2", login: "member-renamed" };
  assert.deepEqual(seatsOutsideTheTeam(TEAM, [boss, member]), [{ sub: "3", login: "stray" }]);
  // A login the manifest lists that is someone else's id: still outside.
  assert.deepEqual(seatsOutsideTheTeam(TEAM, [boss, member, { sub: "99", login: "stray" }]), [{ sub: "3", login: "stray" }]);
  assert.deepEqual(seatsOutsideTheTeam(TEAM, null), [], "nothing said before the ids are read");
  // Listed members with no seat.
  assert.deepEqual(membersWithoutSeat(TEAM, [boss, member, { sub: "7", login: "new" }]), [{ sub: "7", login: "new" }]);
  assert.deepEqual(membersWithoutSeat(TEAM, null), []);
}

{
  // the server's team is used only when it is this Mac's
  assert.equal(teamForThisMac(TEAM, "BOSS/Team", "2"), TEAM);
  assert.equal(teamForThisMac(TEAM, "other/team", "1"), null);
  assert.equal(teamForThisMac(TEAM, null, "1"), null);
  const unbound = { ...TEAM, teamRepo: null };
  assert.equal(teamForThisMac(unbound, "boss/team", "1"), unbound, "the owner's own unbound team");
  assert.equal(teamForThisMac(unbound, "boss/team", "2"), null);
  assert.equal(teamForThisMac(null, "boss/team", "1"), null);
}

{
  // a lapse the Portal fixes, and comp seat words
  for (const s of ["unpaid", "paused", "incomplete"]) assert.equal(lapseNeedsPortal(s), true);
  for (const s of ["canceled", "incomplete_expired"]) assert.equal(lapseNeedsPortal(s), false);
  assert.equal(isSeatLimit("All 10 seats are taken — the team's seats are set by Plyloft."), true);
  assert.ok(checkoutErrorText({ code: "already_subscribed", message: "x" }).includes(SUPPORT_CONTACT));
}

// ── the team's plan
{
  // lapses on anything but active, trialing and past_due
  for (const status of ["active", "trialing", "past_due"]) assert.equal(teamLapsed({ status }), false);
  for (const status of ["canceled", "unpaid", "incomplete_expired"]) assert.equal(teamLapsed({ status }), true);
  assert.equal(teamLapsed(null), false);
}

{
  // says Renew to the owner and the owner's name to everybody else
  assert.ok((lapsedText(true, "boss") ?? "").includes("Renew"));
  assert.equal(lapsedText(false, "boss"), "Team features are paused. Ask boss to renew it.");
}

{
  // explains the stages without a form
  assert.equal(stageNotice({ stage: "member", teamRepo: "boss/team" })?.title, "You hold a seat on boss/team.");
  assert.equal(stageNotice({ stage: "sign_in" })?.title, "Sign in to Plyloft first.");
  // A3 D20: the words stay; the button is drawn by the panel
  assert.equal(stageNotice({ stage: "sign_in" })?.text, "A team runs on the Team plan of your Plyloft account, so Plyloft needs to know who is paying for it.");
  assert.equal(SIGN_IN_ACTION, "Sign in with GitHub");
  assert.ok((stageNotice({ stage: "lapsed", owner: false, ownerLogin: "boss", teamRepo: null, seats: 2 })?.text ?? "").includes("Ask boss to renew it."));
  assert.equal(stageNotice({ stage: "lapsed", owner: true, ownerLogin: "me", teamRepo: null, seats: 2 }), null);
  assert.equal(stageNotice({ stage: "choose" }), null);
  assert.equal(stageNotice({ stage: "create", comp: false }), null);
}

{
  // A3 D21 and the pointer to the Plan page (D14 / D15 titles)
  assert.equal(SIGNED_OUT_SEAT_NOTICE.title, "Sign in to use your seat");
  assert.equal(
    SIGNED_OUT_SEAT_NOTICE.text,
    "Team features run on the seat the team's owner gives your GitHub account. Sign in to Plyloft with GitHub so Plyloft can find it.",
  );
  assert.deepEqual(signedOutTeamNotice(false), SIGNED_OUT_SEAT_NOTICE, "a member reads D21 as approved");
  assert.deepEqual(signedOutTeamNotice(true), {
    title: "Sign in to use your Team plan",
    text: "Sign in to Plyloft with the GitHub account you use for this team.",
  }, "the team's owner has no seat given to them");
  const t = (state: "here" | "elsewhere" | "nowhere", over = {}) => ({ state, device: null, teamRepo: "boss/team", role: "member" as "owner" | "member", ...over });
  assert.equal(teamPlanPointer(null), null);
  assert.equal(teamPlanPointer(t("here")), null);
  assert.equal(teamPlanPointer(t("elsewhere", { device: "MacBook Pro" })), "Team is on another computer (MacBook Pro)");
  assert.equal(teamPlanPointer(t("elsewhere")), "Team is on another computer");
  assert.equal(teamPlanPointer(t("nowhere")), "Your seat on boss/team is ready");
  assert.equal(teamPlanPointer(t("nowhere", { role: "owner" })), "Your Team plan is ready");
}

{
  // words a refused Checkout
  assert.ok((checkoutErrorText({ code: "already_subscribed", message: "x" }) ?? "").includes("One subscription per account"));
  assert.equal(checkoutErrorText({ code: "network", message: "Plyloft couldn't reach its server." }), "Plyloft couldn't reach its server. Nothing was charged.");
}

{
  // N14 F7: Review checks the seats first — a login holding none needs a free one
  assert.equal(holdsSeat(TEAM, "boss", null), true);
  assert.equal(holdsSeat(TEAM, "member", null), true); // by login, any case
  assert.equal(holdsSeat(TEAM, "renamed", [{ sub: "2", login: "renamed" }]), true); // by id
  assert.equal(holdsSeat(TEAM, "newbie", null), false);
  assert.equal(noFreeSeatFor(TEAM, "newbie", null), true); // 3 of 3 held
  assert.equal(noFreeSeatFor(TEAM, "Member", null), false); // already seated
  assert.equal(noFreeSeatFor({ ...TEAM, seats: 4 }, "newbie", null), false);
  // after a decrease more are held than bought: still none free
  assert.equal(noFreeSeatFor({ ...TEAM, seats: 2 }, "newbie", null), true);
  const paid = noFreeSeatWords(3, "newbie", false);
  assert.equal(paid.title, "All 3 seats are taken.");
  assert.ok(paid.body.includes("Add a seat in billing"));
  const comp = noFreeSeatWords(3, "newbie", true);
  assert.equal(comp.title, "All 3 seats are taken.");
  assert.ok(comp.body.includes("set by Plyloft"));
  assert.ok(!comp.body.includes("billing"));
}

console.log("teamBilling: ok");
