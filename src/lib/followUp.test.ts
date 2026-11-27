// N19: Follow up on a shipped card — its offer, the new card's title and
// brief, and the link's title. Run with:
//
//     node --experimental-strip-types src/lib/followUp.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FOLLOW_UP_ASK,
  cutText,
  existingFollowUpWords,
  followLinkTitle,
  followUpAskEmpty,
  followUpBaseTitle,
  openFollowUp,
  followUpContextHeading,
  followUpDraft,
  followUpOffered,
  followUpChosen,
  followUpAskLeft,
  cardIsDone,
  doneBriefLine,
  sentBriefLine,
} from "./followUp.ts";
import { cardTimeline } from "./cardPage.ts";
import type { KanbanCard } from "../ipc";

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const card = (over: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "c1",
  workspaceId: "ws",
  title: "Search",
  notes: "Find cards by title.\n\nFast.",
  columnId: "complete",
  shipStatus: "shipped",
  shipHistory: [{ commitSha: "abc", shippedVersion: "1.161.0", releaseKind: "local", shippedAt: NOW - 3_600_000 }],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

// ── The offer ─────────────────────────────────────────────────────────
assert.equal(followUpOffered(card(), "shipped", false), true);
assert.equal(followUpOffered(card(), "archived", false), true, "an archived shipped card");
assert.equal(followUpOffered(card({ shipStatus: "unshipped", reviewStatus: "merged" }), "shipped", false), true, "a merged pull request");
assert.equal(followUpOffered(card(), "shipped", true), false, "a board the person can't write to");
assert.equal(followUpOffered(card({ shipStatus: "unshipped" }), "ready-to-ship", false), false);
assert.equal(followUpOffered(card({ shipStatus: "unshipped" }), "archived", false), false, "archived, never shipped");

// ── The draft ─────────────────────────────────────────────────────────
const draft = followUpDraft(card(), NOW);
assert.equal(draft.title, "Follow-up: Search");
assert.equal(
  draft.notes,
  [
    FOLLOW_UP_ASK,
    "",
    "---",
    followUpContextHeading("Search"),
    "Shipped in v1.161.0 on 6 Oct.",
    "Its brief:",
    "> Find cards by title.\n>\n> Fast.",
  ].join("\n"),
);
assert.ok(draft.notes.startsWith("What should change now: "), "the line the person fills in comes first");
assert.ok(draft.notes.includes("edit or remove it before you start"), "the context is marked as such");

// A merged pull request, the plan as the brief when there are no notes.
const pr = followUpDraft(
  card({
    shipStatus: "unshipped",
    reviewStatus: "merged",
    shipHistory: [],
    notes: null,
    dispatchPrompt: "Plan: add an index.",
    prUrl: "https://github.com/a/b/pull/42",
  }),
  NOW,
);
assert.ok(pr.notes.includes("Its pull request #42 was opened on GitHub."), pr.notes);
assert.ok(pr.notes.includes("> Plan: add an index."), pr.notes);

// No brief at all: the facts alone.
const bare = followUpDraft(card({ notes: "  " }), NOW);
assert.ok(!bare.notes.includes("Its brief:"), bare.notes);

// A long title is cut to 120 characters; a long brief is cut too.
const long = followUpDraft(card({ title: "x".repeat(200), notes: "y".repeat(5000) }), NOW);
assert.equal([...long.title].length, 120);
assert.ok(long.title.endsWith("…"));
assert.ok(long.notes.length < 2000, String(long.notes.length));

// A follow-up of a follow-up: one prefix, the context naming the card as is.
const again = followUpDraft(card({ title: "Follow-up: Follow-up: Search" }), NOW);
assert.equal(again.title, "Follow-up: Search");
assert.ok(again.notes.includes("“Follow-up: Follow-up: Search”"));
assert.equal(followUpBaseTitle("follow-up:Search"), "Search");
assert.equal(followUpBaseTitle("Follow-up: "), "Follow-up:", "nothing else: kept");

// Cut on what a person sees as one character: an emoji or an accented
// letter is never split.
const family = "👨‍👩‍👧";
const accented = "e\u0301"; // é as e + combining accent
assert.equal(cutText(`${"a".repeat(3)}${family}${family}${family}`, 5), `aaa${family}…`);
assert.equal(cutText(`ab${accented}${accented}${accented}`, 4), `ab${accented}…`);
assert.equal(cutText("short", 5), "short");
const emojiTitle = followUpDraft(card({ title: family.repeat(200) }), NOW).title;
assert.ok(emojiTitle.endsWith(`${family}…`), "the cut ends on a whole emoji");
// Without Intl.Segmenter: code points, still never half a surrogate pair.
const Segmenter = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
delete (Intl as unknown as { Segmenter?: unknown }).Segmenter;
try {
  assert.equal(cutText("😀😀😀", 2), "😀…");
} finally {
  (Intl as unknown as { Segmenter?: unknown }).Segmenter = Segmenter;
}

// ── GitHub boards ─────────────────────────────────────────────────────
const gh = followUpDraft(card({ ghIssueNumber: 21 }), NOW);
assert.ok(gh.notes.includes("Follows up #21."), gh.notes);
// A teammate shipped it: Complete with a done issue, never shipped here.
const teammate = card({ shipStatus: "unshipped", shipHistory: [], ghIssueNumber: 21 });
assert.equal(followUpOffered(teammate, "closed", false), true);
assert.equal(followUpOffered(teammate, "archived", false), true);
assert.equal(followUpOffered({ ...teammate, columnId: "todo" }, "ready", false), false, "an open issue");
assert.equal(followUpOffered({ ...teammate, ghIssueNumber: null }, "closed", false), false, "a local card closed by hand");
assert.ok(followUpDraft(teammate, NOW).notes.includes("Issue #21 is closed."));

// ── The empty ask ─────────────────────────────────────────────────────
const follow = { followsUp: { cardId: "c1", title: "Search", at: 1 }, archived: false, columnId: "todo" as const };
assert.equal(followUpAskEmpty(follow, draft.notes), true, "nothing written yet");
assert.equal(followUpAskEmpty(follow, `What should change now:\n\n---`), true, "trailing space removed");
assert.equal(followUpAskEmpty(follow, draft.notes.replace(FOLLOW_UP_ASK, `${FOLLOW_UP_ASK}add a filter`)), false);
assert.equal(followUpAskEmpty(follow, "Rewritten from scratch"), false);
assert.equal(followUpAskEmpty({ ...follow, followsUp: null }, draft.notes), false, "not a follow-up");
assert.equal(followUpAskEmpty({ ...follow, columnId: "in_progress" }, draft.notes), false, "started");

// ── One waiting follow-up at a time ───────────────────────────────────
const f = (id: string, over: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  workspaceId: "ws",
  title: `Follow-up ${id}`,
  columnId: "todo",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const linkTo = (id: string) => ({ cardId: id, title: id, at: 1 });
const started = f("f1", { columnId: "in_progress" });
const waiting = f("f2");
assert.equal(openFollowUp(card({ followedUpBy: [linkTo("f1"), linkTo("f2")] }), [started, waiting])?.id, "f2");
assert.equal(openFollowUp(card({ followedUpBy: [linkTo("f1")] }), [started]), null, "all started: make a new one");
assert.equal(
  openFollowUp(card({ followedUpBy: [linkTo("f2")] }), [f("f2", { archived: true })]),
  null,
  "archived",
);
assert.equal(openFollowUp(card({ followedUpBy: [linkTo("f2")] }), [f("f2", { shipStatus: "shipped" })]), null, "shipped");
assert.equal(openFollowUp(card({ followedUpBy: [linkTo("gone")] }), []), null, "deleted");
// Ship with follow-up's card counts too.
const swf = card({
  builder: {
    vendor: "claude",
    bypass: false,
    ptyId: null,
    sessionLost: false,
    startedAt: 1,
    snapshots: [],
    followUp: { cardId: "f3", cardRef: "#9", findingIds: [], shipped: true },
  } as KanbanCard["builder"],
});
assert.equal(openFollowUp(swf, [f("f3")])?.id, "f3");
assert.equal(existingFollowUpWords("Follow-up: Search"), "This card already has a follow-up: Follow-up: Search");

// ── The link's title ──────────────────────────────────────────────────
const link = { cardId: "c1", title: "Search", at: 5 };
assert.deepEqual(followLinkTitle(link, [{ id: "c1", title: "Search v2" }]), { title: "Search v2", exists: true });
assert.deepEqual(followLinkTitle(link, []), { title: "Search", exists: false });

// ── The shipped card's Activity ───────────────────────────────────────
const items = cardTimeline(
  card({ followedUpBy: [{ cardId: "c2", title: "Follow-up: Search", at: NOW }] }),
  { cardExists: (id) => id === "c2" },
);
const row = items.find((i) => i.id === "followed-up-c2")!;
assert.equal(row.text, "Followed up by “Follow-up: Search”");
assert.deepEqual(row.link, { kind: "card", label: "Open it", ariaLabel: "Open “Follow-up: Search”", cardId: "c2" });
assert.equal(items[items.length - 1].id, "followed-up-c2", "after the ship, in time order");
const gone = cardTimeline(card({ followedUpBy: [{ cardId: "c2", title: "F", at: NOW }] }), { cardExists: () => false });
assert.equal(gone.find((i) => i.id === "followed-up-c2")!.link, undefined, "a deleted card has no link");
assert.equal(gone.find((i) => i.id === "followed-up-c2")!.text, "Followed up by “F” (deleted)");
assert.equal(cardTimeline(card()).some((i) => i.id.startsWith("followed-up")), false, "no row on a card never followed up");

// 1.171.0 (E2): Follow up's sheet — the suggestion kept, or the person's
// title and words put after the ask.
{
  const draft = { title: "Follow-up: Search", notes: `${FOLLOW_UP_ASK}\n\n---\nContext` };
  assert.deepEqual(followUpChosen(draft, "Follow-up: Search", ""), draft, "nothing changed: the suggestion as it was");
  assert.deepEqual(followUpChosen(draft, "  ", "  "), draft, "an emptied title keeps the suggestion");
  const chosen = followUpChosen(draft, " Search by tag ", " add tags \n and colours ");
  assert.equal(chosen.title, "Search by tag");
  assert.equal(chosen.notes, "What should change now: add tags \n and colours\n\n---\nContext");
  assert.equal(followUpAskLeft(draft.notes), true);
  assert.equal(followUpAskLeft(chosen.notes), false);
  assert.equal(followUpChosen(draft, "x".repeat(200), "").title.length, 120, "as short as the suggestion's cap");
  assert.equal(followUpChosen({ title: "T", notes: "No ask" }, "T", "more").notes, "No ask", "a brief without the ask is left alone");
}

// 1.171.0 (E2): a done card — landed, or closed on a GitHub board.
assert.equal(cardIsDone(card(), "shipped"), true);
assert.equal(cardIsDone(card({ shipStatus: "unshipped", reviewStatus: "merged" }), "shipped"), true);
assert.equal(cardIsDone(card({ shipStatus: "unshipped", ghIssueNumber: 7 }), "closed"), true, "its issue closed");
assert.equal(cardIsDone(card({ shipStatus: "unshipped" }), "closed"), false, "finished by hand, no issue");
assert.equal(cardIsDone(card({ shipStatus: "unshipped" }), "ready-to-ship"), false);
assert.match(doneBriefLine(card(), true), /use Follow up\.$/);
assert.doesNotMatch(doneBriefLine(card(), false), /Follow up/);

// 1.174.0 A2 (P7): sent is not landed — a pull request still open (or
// closed without merging) is not done, offers no Follow up, and its brief
// line says why it can still change.
{
  const url = "https://github.com/o/r/pull/138";
  const open = card({
    shipStatus: "unshipped",
    reviewStatus: "merged",
    prUrl: url,
    pr: { number: 138, state: "open" } as KanbanCard["pr"],
  });
  const closed = card({
    shipStatus: "unshipped",
    reviewStatus: "pending",
    prUrl: url,
    pr: { number: 138, state: "closed" } as KanbanCard["pr"],
  });
  const merged = card({ reviewStatus: "merged", prUrl: url, pr: { number: 138, state: "merged" } as KanbanCard["pr"] });
  assert.equal(cardIsDone(open, "shipped"), false, "open: not done");
  assert.equal(followUpOffered(open, "shipped", false), false, "open: no Follow up");
  assert.equal(cardIsDone(closed, "ready-to-ship"), false);
  assert.equal(followUpOffered(closed, "ready-to-ship", false), false);
  assert.equal(cardIsDone(merged, "shipped"), true);
  assert.equal(followUpOffered(merged, "shipped", false), true);
  assert.equal(
    sentBriefLine(open),
    "Pull request #138 is still open, so this card can still change. Edit this, then Fix with the Builder; Send the fixes to GitHub adds the new build to the pull request.",
  );
  assert.equal(sentBriefLine(closed), "The card isn't done: change what you want, then ship it again.");
  assert.equal(sentBriefLine(merged), null);
  assert.equal(sentBriefLine(card({ shipStatus: "unshipped" })), null, "never shipped");
  assert.equal(doneBriefLine(merged, true), "This card is done: pull request #138 merged. For more changes, use Follow up.");
  assert.equal(doneBriefLine(merged, false), "This card is done: pull request #138 merged.");
  assert.equal(doneBriefLine(card(), true), "This card is done: it shipped on this Mac. For more changes, use Follow up.");
  // Round 1: "on this Mac" only for a ship that landed here.
  assert.equal(
    doneBriefLine(card({ shipHistory: [{ commitSha: "a", shippedVersion: "1.0.0", releaseKind: "github", shippedAt: 1 }] as never }), false),
    "This card is done, so what it asked for stays as it was.",
    "a release on GitHub",
  );
  assert.equal(doneBriefLine(card({ shipHistory: [] }), false), "This card is done, so what it asked for stays as it was.", "no ship recorded");
  assert.equal(
    doneBriefLine(card({ reviewStatus: "merged", prUrl: url, pr: { number: 138, state: "merged" } as KanbanCard["pr"] }), false),
    "This card is done: pull request #138 merged.",
    "merged on GitHub (its history entry is local)",
  );
  // A GitHub Issues card in Complete: no Follow up while its pull request is open.
  const issueOpen = card({ shipStatus: "unshipped", ghIssueNumber: 7, columnId: "complete", reviewStatus: "merged", prUrl: url, pr: { number: 138, state: "open" } as KanbanCard["pr"] });
  assert.equal(followUpOffered(issueOpen, "archived", false), false);
  assert.equal(followUpOffered({ ...issueOpen, prUrl: null, pr: null, reviewStatus: null }, "archived", false), true);
  assert.equal(
    doneBriefLine(card({ shipStatus: "unshipped", ghIssueNumber: 7 }), false),
    "This card is done, so what it asked for stays as it was.",
    "its issue closed",
  );
  assert.equal(
    doneBriefLine(card({ reviewStatus: "merged", prUrl: url }), true),
    "This card is done, so what it asked for stays as it was. For more changes, use Follow up.",
    "a pull request Plyloft never read back",
  );
}

// 1.174.0 A2: Follow up held to the shared delivery fixtures (state archived,
// where both the landed and the GitHub Issues rule apply).
{
  const fixtures: { cases: { name: string; card: Partial<KanbanCard>; delivery: string; followUp?: boolean }[] } = JSON.parse(
    readFileSync(new URL("./cardDelivery.fixtures.json", import.meta.url), "utf8"),
  );
  for (const c of fixtures.cases) {
    const fc = { shipStatus: "unshipped", reviewStatus: null, ...c.card } as KanbanCard;
    assert.equal(followUpOffered(fc, "archived", false), c.followUp ?? c.delivery === "landed", c.name);
  }
}

// 1.174.0 (DR2 round 2): a card landed on this Mac and carried by a later
// release made through GitHub still says it shipped here — its own ship,
// not the release's entry.
{
  const landedHere = card({
    shipStatus: "shipped",
    prUrl: null,
    pr: null,
    commitSha: "l1",
    shipHistory: [
      { commitSha: "l1", shippedVersion: "1.0.0", releaseKind: "local", shippedAt: 1 },
      { commitSha: "r1", shippedVersion: "1.0.1", releaseKind: "github", shippedAt: 2, tag: "v1.0.1" },
    ],
  });
  assert.match(doneBriefLine(landedHere, false), /it shipped on this Mac/);
}

console.log("followUp.test.ts: ok");
