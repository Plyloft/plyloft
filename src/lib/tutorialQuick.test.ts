// Getting started TU-6 (docs/tutorial/TUTORIAL_SPEC.md §6.4, §6.5): the
// Quick tour's marks and the first-visit tips, Tier 3. The marks in order,
// with a card and without, solo and team; the tips switch and its
// level default; seen sections kept, unknown ones too. Run by
// scripts/ppvp-pure-contracts.sh under node --experimental-strip-types.
import assert from "node:assert/strict";
import type { TutorialProgress } from "./settingsShape.ts";
import { TOUR_ANCHORS } from "./tutorial/manifest.ts";
import {
  QUICK_LAST_BODY,
  QUICK_FEW_READY_LINE,
  TIP_SECTIONS,
  quickMarks,
  sectionOnScreen,
  sectionTip,
  tipSeen,
  tipsOn,
  withSectionSeen,
  withTips,
} from "./tutorial/quickTour.ts";
import { startQuickTour, tourRunning } from "./tutorial/tutorialEngine.ts";

const CARD = { workspaceId: "ws-1", cardId: "card-1" };

// ── The marks (§6.4) ─────────────────────────────────────────────────────

{
  const marks = quickMarks({ card: CARD, team: false });
  assert.deepEqual(
    marks.map((m) => m.id),
    ["board", "card", "terminals", "code", "library", "inbox", "all-skills", "ship-batch", "help"],
    "nine marks, in §6.4's order",
  );
  const card = marks[1];
  assert.equal(card.anchor, "card-primary", "an existing card: its page's main button");
  assert.deepEqual(card.navigate, { openCard: CARD });
  assert.equal(marks[marks.length - 1]?.anchor, "help");
  assert.ok(marks[marks.length - 1]?.body.endsWith(QUICK_LAST_BODY), "the last mark says where the full tour is");
  for (const m of marks) {
    assert.ok((TOUR_ANCHORS as readonly string[]).includes(m.anchor), `${m.id}: a real anchor`);
    assert.ok(m.title.length > 0 && m.body.length > 0, `${m.id}: words`);
    assert.doesNotMatch(m.body, /worktree|snapshot|\bCLI\b|sandbox/i, `${m.id}: plain words`);
  }
}

{
  const marks = quickMarks({ card: null, team: false });
  assert.equal(marks[1].anchor, "board-new-card", "no card yet: the Board's New card");
  assert.deepEqual(marks[1].navigate, { mode: "board" });
  assert.equal(marks[1].title, "New card");
}

{
  const solo = quickMarks({ card: null, team: false });
  const team = quickMarks({ card: null, team: true });
  assert.equal(team.length, solo.length + 1, "a team gets one more mark");
  assert.equal(team[team.findIndex((m) => m.id === "library") + 1].id, "team", "right after the Library");
  assert.ok(!solo.some((m) => m.id === "team"), "solo never sees a team mark (D7)");
}

{
  const unknown = quickMarks({ card: null, team: false });
  const batch = (ms: typeof unknown) => ms.find((m) => m.id === "ship-batch")!.body;
  // 1.171.0 E3 (owner D5): with fewer than two ready, it says why the row isn't there.
  const few = quickMarks({ card: null, team: false, shipReady: 1 });
  const two = quickMarks({ card: null, team: false, shipReady: 2 });
  assert.ok(batch(few).endsWith(QUICK_FEW_READY_LINE));
  assert.ok(!batch(two).includes(QUICK_FEW_READY_LINE));
  assert.ok(!batch(unknown).includes(QUICK_FEW_READY_LINE), "unknown count: nothing said");
  assert.ok(!/\bPro\b|Free/.test(batch(unknown)), "no plan is named");
}

// ── The record: the Quick tour is not a full tour ────────────────────────

{
  const r = startQuickTour(null);
  assert.equal(r.path, "quick");
  assert.equal(tourRunning(r), false, "the Quick tour starts no full tour");
  const keep: TutorialProgress = { startedAt: "2026-10-21T09:00:00.000Z", done: { "base.open-board": "x", "future.step": "y" } };
  const q = startQuickTour(keep);
  assert.equal(q.startedAt, keep.startedAt, "a full tour under way stays as it was");
  assert.deepEqual(q.done, keep.done);
}

// ── First-visit tips (§6.5) ──────────────────────────────────────────────

assert.equal(tipsOn(null, "guided"), true, "unset: on for step by step");
assert.equal(tipsOn(null, "fast"), false, "unset: off for just the essentials (D15)");
assert.equal(tipsOn(null, null), false, "unset and no level: off");
assert.equal(tipsOn({ tips: true }, "fast"), true, "the switch wins");
assert.equal(tipsOn({ tips: false }, "guided"), false, "the switch wins");

assert.equal(sectionOnScreen("terminals", false), "terminals");
assert.equal(sectionOnScreen("activity", false), "history");
assert.equal(sectionOnScreen("board", false), null, "the Board is the full tour's own");
assert.equal(sectionOnScreen("board", true), "all-skills", "All skills over the page");
assert.equal(sectionOnScreen(null, false), null);

for (const section of TIP_SECTIONS) {
  const tip = sectionTip(section);
  assert.ok((TOUR_ANCHORS as readonly string[]).includes(tip.anchor), `${section}: a real anchor`);
  assert.ok(tip.body.length > 0);
}

{
  const r: TutorialProgress = { tips: true, seenSections: ["code", "a-section-from-a-newer-app"] };
  const once = withSectionSeen(r, "terminals");
  assert.deepEqual(once.seenSections, ["code", "a-section-from-a-newer-app", "terminals"], "unknown sections kept");
  assert.equal(once.tips, true, "spread, never rebuilt");
  assert.equal(withSectionSeen(once, "terminals"), once, "seen twice: no change");
  assert.equal(tipSeen(once, "terminals"), true);
  assert.equal(tipSeen(null, "terminals"), false);
  assert.deepEqual(withTips(r, false), { ...r, tips: false });
  assert.deepEqual(withSectionSeen({ seenSections: "bad" as unknown as string[] }, "code").seenSections, ["code"]);
}

console.log("tutorialQuick.test.ts: marks, tips and the record");
