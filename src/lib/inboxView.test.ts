// GH #269 / #310: what an Inbox row says. Run with
// `node --experimental-strip-types src/lib/inboxView.test.ts`.
import assert from "node:assert/strict";
import type { InboxEvent } from "../ipc.ts";
import {
  CLEAR_THE_NEWS_TITLE,
  INBOX_GROUPS,
  ideasRowDetail,
  needsYouOrder,
  isIdeasRow,
  onNewsShelf,
  isFailureRow,
  isNewsRow,
  newsRowIds,
  nextImprovementRowWords,
  pausedRowWords,
  prOpenedWords,
  checksFailedDetail,
  feedForMode,
  inboxChipName,
  inboxRowWords,
  inboxSectionCount,
  inboxSummary,
  needsOkSkillOf,
} from "./inboxView.ts";

function ev(over: Partial<InboxEvent>): InboxEvent {
  return {
    id: "e",
    kind: "review_needed",
    group: "needs_you",
    workspaceId: "ws",
    workspaceName: "Ply",
    cardId: "c",
    runId: null,
    title: "Fix login redirect",
    detail: null,
    url: null,
    at: 1,
    seenAt: null,
    seenEligible: true,
    ...over,
  };
}

// GH #269: "Checks failed" once, plus at most one short fact.
const failed = (detail: string | null) =>
  inboxRowWords(ev({ kind: "verify_failed", group: "needs_you", detail })).detail!;
assert.equal(failed("verify failed: Tier 2 (cargo test) failed: 2 tests failed in kanban::tests"), "Checks failed");
assert.equal(failed("Checks failed: Tier 2 (cargo test) failed"), "Checks failed");
assert.equal(failed("Rust tests"), "Checks failed · Rust tests");
assert.equal(failed("2 of 14"), "Checks failed · 2 of 14");
assert.equal(failed(null), "Checks failed");
assert.equal(
  failed("ppvp.sh failed at check #3 because the harness could not reach the window"),
  "Checks failed",
);
for (const d of ["verify failed: x", "Checks failed: y", "Rust tests", null]) {
  const words = checksFailedDetail(d);
  assert.equal(words.match(/checks failed/gi)?.length, 1, words);
  assert.ok(words.split(" · ").length <= 2, words);
}

console.log("inboxView: row words passed");

// GH #310: a review row whose card can ship offers Ship it; otherwise
// Review. 1.174.0 (A5, P16): Ship it is bordered like every row action.
const ready = inboxRowWords(ev({ detail: "7 files changed" }), { ship: "passed" });
assert.deepEqual(ready, { detail: "Ready to ship · checks passed", action: "Ship it", ship: true });
assert.equal(inboxRowWords(ev({}), { ship: "skipped" }).detail, "Ready to ship · checks skipped");
// GH #333: a card whose project has no checks never reads "checks passed".
assert.equal(inboxRowWords(ev({}), { ship: "none" }).detail, "Ready to ship · no checks set up");
const review = inboxRowWords(ev({}), { ship: null });
assert.equal(review.action, "See the review");
assert.equal(review.ship, undefined);
assert.equal(inboxRowWords(ev({ kind: "run_done", group: "needs_you" }), { ship: "passed" }).action, "See the review");
console.log("inboxView: Ship it passed");

// OB-9 (onboarding §10 row 6): solo mode leaves the review-requested pull
// requests out of the feed it draws and counts; team mode keeps the same feed.
{
  const feed = { events: [ev({ id: "a" }), ev({ id: "pr", kind: "pr_review" })] };
  assert.equal(feedForMode(feed, false), feed);
  assert.deepEqual(
    feedForMode(feed, true)?.events.map((e) => e.id),
    ["a"],
  );
  const plain = { events: [ev({ id: "a" })] };
  assert.equal(feedForMode(plain, true), plain, "nothing to leave out: the same feed");
  assert.equal(feedForMode(null, true), null);
  console.log("inboxView: solo feed passed");
}

// v1.154.1 (G2): a card recorded as running whose session ended (after a
// relaunch) reads as the Board does.
{
  const ended = inboxRowWords(ev({ kind: "card_running", group: "needs_you", detail: "session ended" }));
  // F1: the Board's headline and press.
  assert.deepEqual(ended, { detail: "Session closed", action: "Resume" });
  // F1 (BI-7): Plyloft's quit paused it — On hold, with Resume.
  assert.deepEqual(
    inboxRowWords(ev({ kind: "card_running", group: "on_hold", detail: "paused when Plyloft closed" })),
    { detail: "Paused when Plyloft closed", action: "Resume" },
  );
  assert.equal(inboxRowWords(ev({ kind: "card_running", group: "running" })).detail, "Working");
  // Round 3: a card built by both waiting for the pick, in the Board's words.
  assert.equal(
    inboxRowWords(ev({ kind: "card_running", group: "needs_you", detail: "Pick one of the two builds" })).detail,
    "Pick one of the two builds",
  );
}

// CL-3: an open P1 is said in the row's words and weight; the plain request
// for changes keeps its words and no weight.
{
  const p1 = inboxRowWords(ev({ kind: "review_needed", group: "needs_you", detail: "1 serious issue · changes requested" }));
  assert.deepEqual(p1, { detail: "1 serious issue · changes requested", action: "See the review", serious: true });
  assert.equal(
    inboxRowWords(ev({ kind: "review_needed", group: "needs_you", detail: "3 serious issues · changes requested" })).serious,
    true,
  );
  const plain = inboxRowWords(ev({ kind: "review_needed", group: "needs_you", detail: "changes requested — needs you" }));
  assert.deepEqual(plain, { detail: "Changes requested", action: "See the review" });
}

// Skills hub H6a: a team skill waiting for an OK — its detail and `Review`,
// and the skill its stable id names (`skill_scripts::inbox_id`).
{
  const row = inboxRowWords(
    ev({ kind: "skill_needs_ok", cardId: null, title: "check needs your OK", detail: "A script changed in the team library" }),
  );
  assert.deepEqual(row, { detail: "A script changed in the team library", action: "Decide" });
  assert.equal(needsOkSkillOf("skill:team:acme/team/ply-team/check:needs-ok:0123456789abcdef"), "check");
  assert.equal(needsOkSkillOf("skill:team:acme/team/ply-team/team-style:needs-ok:aa+bb"), "team-style");
  assert.equal(needsOkSkillOf("proposal:ws"), null);
  assert.equal(needsOkSkillOf("skill:team:acme/team/ply-team/check:removed:00"), null);
}

// UX P-F (point 8): a run the provider's limit stopped says the card's and
// the plan pause's word — one word, three places. 1.171.0 C2 (CF8): the
// session word Paused.
{
  const limited = inboxRowWords(ev({ kind: "card_failed", group: "needs_you", detail: "rate-limited" }));
  assert.equal(limited.detail, "Paused · your plan's limit resets soon");
  assert.equal(limited.action, "See what failed");
  assert.equal(inboxRowWords(ev({ kind: "card_failed", group: "needs_you", detail: "aborted" })).detail, "The run was stopped");
}

// F1 (one count): Needs you says the one attention count — never "new of";
// the other groups count their rows; News has no number.
assert.equal(inboxSectionCount("needs_you", 3, 3), "3");
assert.equal(inboxSectionCount("needs_you", 1, 0), null, "a usage limit is listed, not counted");
assert.equal(inboxSectionCount("running", 4, 0), "4");
assert.equal(inboxSectionCount("on_hold", 1, 9), "1");
assert.equal(inboxSectionCount("news", 5, 9), null);
console.log("inboxView: section counts passed");

// F1: the groups, in order — Failed is not one of them any more.
assert.deepEqual(
  INBOX_GROUPS.map((g) => g.label),
  ["Needs you", "Working", "On hold", "Scheduled", "News"],
);
assert.ok(!INBOX_GROUPS.some((g) => (g.key as string) === "failed"));
// A failure is a Needs you row that keeps its amber (and sorts first).
assert.equal(isFailureRow(ev({ kind: "verify_failed" })), true);
assert.equal(isFailureRow(ev({ kind: "pr_checks_failed" })), true);
assert.equal(isFailureRow(ev({ kind: "pr_auto_fix_stopped", detail: "session_closed" })), true);
assert.equal(isFailureRow(ev({ kind: "pr_auto_fix_stopped", detail: "not_shown" })), false);
assert.equal(isFailureRow(ev({ kind: "review_needed" })), false);
console.log("inboxView: groups passed");

// F1: Clear the news takes only news — a merged pull request, a finished
// run — unseen; a to-do row (seen or not) is never news.
{
  const rows = [
    ev({ id: "todo", kind: "verify_failed", group: "needs_you" }),
    ev({ id: "todo-seen", group: "needs_you", seenAt: 5 }),
    ev({ id: "merged", kind: "pr_merged", group: "shipped", detail: "#382" }),
    ev({ id: "shipped", kind: "shipped", group: "shipped" }),
    ev({ id: "run", kind: "run_done", group: "news", cardId: null }),
    ev({ id: "run-seen", kind: "run_done", group: "news", cardId: null, seenAt: 9 }),
    ev({ id: "paused", kind: "card_running", group: "on_hold" }),
  ];
  assert.deepEqual(newsRowIds(rows), ["merged", "run"]);
  assert.equal(isNewsRow(rows[0]), false);
  assert.equal(isNewsRow(rows[1]), false);
  console.log("inboxView: Clear the news passed");
}

// F1 (BI-7): two cards or more paused by Plyloft's quit are one row.
assert.deepEqual(pausedRowWords(["A", "B"]), {
  title: "2 cards paused when Plyloft closed",
  detail: "“A”, “B” · Resume each on its card",
});
assert.equal(pausedRowWords(["A", "B", "C", "D", "E"]).detail, "“A”, “B”, “C” and 2 more · Resume each on its card");

// P-D2 Mac walk: a failed run whose only detail is what started it
// ("manual"), and a run error that named Claude's settings key.
for (const trigger of ["manual", "scheduled", "event-triggered", "swarm", null]) {
  assert.deepEqual(inboxRowWords(ev({ kind: "run_failed", group: "needs_you", cardId: null, detail: trigger })), {
    detail: "The run stopped before it finished · See what failed shows its output",
    action: "See what failed",
  });
}
assert.equal(
  inboxRowWords(
    ev({
      kind: "run_failed",
      group: "needs_you",
      cardId: null,
      detail: "Claude asks you to accept Bypass Permissions mode (your defaultMode) before it starts. Plyloft never answers that questi…",
    }),
  ).detail,
  "Claude asks you to accept Bypass Permissions mode before it starts. Plyloft never answers that questi…",
);
// QoL 14.2 (F7): a review-requested pull request's age.
{
  const now = 10_000_000_000;
  assert.equal(prOpenedWords(null, now), "");
  assert.equal(prOpenedWords(now - 5 * 60_000, now), "opened 5m ago");
  assert.equal(prOpenedWords(now - 3 * 3_600_000, now), "opened 3h ago");
  assert.equal(prOpenedWords(now - 4 * 86_400_000, now), "opened 4d ago");
  assert.equal(prOpenedWords(now - 21 * 86_400_000, now), "opened 3 wk ago");
}
console.log("inboxView: failed run words passed");

// H8 Mac walk: a skill card in a cold workspace's board reads ready to ship.
{
  const words = inboxRowWords(ev({ detail: "skill card ready to ship" }));
  assert.equal(words.detail, "Ready to ship · no checks set up");
  assert.equal(words.action, "Open card");
}

// Block 10 Mac walk: a team-library skill's row names the team library, not
// the workspace that happened to be active.
{
  assert.equal(inboxChipName(ev({ kind: "skill_needs_ok", workspaceName: "notes-app" })), "Team library");
  assert.equal(inboxChipName(ev({ workspaceName: "notes-app" })), "notes-app");
}

// F1 (BI-14): the sentence counts what still needs the person — no "seen".
assert.equal(inboxSummary({ needs: 0, running: 0 }), "Nothing needs you.");
assert.equal(inboxSummary({ needs: 1, running: 0 }), "1 thing needs you.");
assert.equal(inboxSummary({ needs: 3, running: 1, onHold: 2 }), "3 things need you, 1 is working, 2 on hold.");

// 1.173.0 (C3): a shared setting both sides changed asks from the Inbox.
{
  const row = inboxRowWords(
    ev({
      id: "setting-conflict:ws:versionFiles:1700000000",
      kind: "shared_setting_conflict",
      cardId: null,
      title: "A setting both Macs changed: Version files",
      detail: "Choose which value the repository keeps",
    }),
  );
  assert.equal(row.action, "Choose");
  assert.equal(row.detail, "Choose which value the repository keeps");
}

// F1's hook for E3: the Next improvement row's words (mockup scene 1).
assert.deepEqual(nextImprovementRowWords("Site", 3), { title: "Next improvement for Site: 3 ideas", action: "Look at the ideas" });
assert.equal(nextImprovementRowWords(null, 1).title, "Next improvement: 1 idea");
// E3: the row's press is the same words (inbox.rs writes its title).
assert.equal(
  inboxRowWords(ev({ kind: "next_improvement_ideas", group: "news", detail: "Claude proposed" })).action,
  "Look at the ideas",
);
// 1.174.0 (A5, P10, D4 b; inbox.html scene 3): the ideas row is News, never
// counted; "New · " before the byline until seen, then grayed and kept,
// "Seen · waiting for your answer". Clear the news marks it seen.
{
  const byline = "Claude proposed, Codex gave a second opinion";
  const fresh = ev({ id: "ni:r2", kind: "next_improvement_ideas", group: "news", cardId: null, detail: byline, seenAt: null });
  const seen = ev({ id: "ni:r1", kind: "next_improvement_ideas", group: "news", cardId: null, detail: byline, seenAt: 5 });
  assert.equal(inboxRowWords(fresh).detail, `New · ${byline}`);
  assert.equal(inboxRowWords(seen).detail, "Seen · waiting for your answer");
  assert.equal(ideasRowDetail({ detail: null, seenAt: null }), "New");
  assert.equal(isIdeasRow(fresh), true);
  assert.equal(onNewsShelf(fresh), true);
  assert.equal(onNewsShelf(seen), true, "seen, it stays on the shelf");
  assert.equal(onNewsShelf(ev({ kind: "pr_merged", group: "news", seenAt: 5 })), false, "seen news leaves");
  assert.deepEqual(newsRowIds([fresh, seen]), ["ni:r2"], "Clear the news marks the unseen one seen");
  assert.match(CLEAR_THE_NEWS_TITLE, /ideas stay, grayed, until you answer them\.$/);
}

// 1.174.0 (A5, inbox.html scene 1): failures first, then Merge, then Ship it,
// then the rest — stable within each.
{
  const rows = [
    { id: "review" },
    { id: "ship-1", press: "ship" as const },
    { id: "merge", press: "merge" as const },
    { id: "fail", failure: true },
    { id: "ship-2", press: "ship" as const },
  ];
  assert.deepEqual(needsYouOrder(rows).map((r) => r.id), ["fail", "merge", "ship-1", "ship-2", "review"]);
  // Round 1 (scene 5): Bring this computer up to date takes Merge's place,
  // above Ship it (InboxPanel gives it press "merge").
  console.log("inboxView: Needs you order passed");
}

// 1.174.0 (DR4): a release is one News row; a stopped release asks, and its
// press opens the Release sheet.
{
  const released = ev({ id: "release:ws:site-v3.0.2", kind: "released", group: "shipped", cardId: null, title: "site-v3.0.2 released", detail: "5 cards", seenEligible: true, seenAt: null });
  assert.equal(isNewsRow(released), true);
  assert.deepEqual(inboxRowWords(released), { detail: "5 cards", action: null });
  const stopped = ev({ id: "release-stopped:ws:site-v3.0.2", kind: "release_stopped", group: "needs_you", cardId: null, title: "site-v3.0.2 stopped", detail: "Release pull request #391 was closed on GitHub without merging." });
  assert.deepEqual(inboxRowWords(stopped), { detail: "Release pull request #391 was closed on GitHub without merging.", action: "Show it" });
  console.log("inboxView: release rows passed");
}
