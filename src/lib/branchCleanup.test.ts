// N18: the words of the card-branch cleanup. Run with:
//
//     node --experimental-strip-types src/lib/branchCleanup.test.ts

import assert from "node:assert/strict";
import {
  KEPT_AFTER_ARCHIVE,
  KEPT_AFTER_SHIP,
  KEPT_BEHIND,
  answerToast,
  askWords,
  backlogWords,
  branchDeletedText,
  branchList,
  githubBranchSettingsUrl,
  githubRepoOf,
  keptBranches,
  keptLabel,
} from "./branchCleanup.ts";
import type { BranchBacklogItem, BranchCleanup, KanbanCard } from "../ipc";

const rec = (over: Partial<BranchCleanup>): BranchCleanup => ({
  branch: "plyloft/card-abc-tidy",
  tip: "0123456789abcdef",
  reason: "shipped",
  since: 1,
  ...over,
});

// ── The card's Activity row ──────────────────────────────────────────
assert.equal(
  branchDeletedText(rec({ outcome: "deleted" })),
  "Branch plyloft/card-abc-tidy deleted (was 0123456)",
);
assert.equal(branchDeletedText(rec({})), null, "waiting: no row");
assert.equal(branchDeletedText(rec({ outcome: "movedOn" })), null);
assert.equal(branchDeletedText(rec({ outcome: "gone" })), null, "already gone: nothing Plyloft did");
assert.equal(branchDeletedText(null), null);
assert.equal(branchDeletedText(rec({ outcome: "restarted" })), "Branch kept: the card started again");

// ── The Worktrees page's kept branches ───────────────────────────────
const card = (id: string, cleanup?: BranchCleanup, over: Partial<KanbanCard> = {}): KanbanCard =>
  ({ id, title: `Card ${id}`, columnId: "complete", branchCleanup: cleanup, ...over }) as KanbanCard;
assert.deepEqual(
  keptBranches([
    card("a", rec({ outcome: "movedOn" })),
    card("b", rec({ outcome: "deleted" })),
    card("c"),
    card("d", rec({ outcome: "behind", reason: "prMerged" })),
    // In use again: not listed as kept.
    card("e", rec({ outcome: "movedOn" }), { branchName: "plyloft/card-abc-tidy" }),
    card("f", rec({ outcome: "movedOn" }), { columnId: "in_progress" }),
  ]),
  [
    { cardId: "a", title: "Card a", branch: "plyloft/card-abc-tidy", label: KEPT_AFTER_SHIP },
    { cardId: "d", title: "Card d", branch: "plyloft/card-abc-tidy", label: KEPT_BEHIND },
  ],
);
assert.equal(KEPT_AFTER_SHIP, "Has commits after it shipped — kept");
assert.equal(keptLabel(rec({ outcome: "movedOn", reason: "archived" })), KEPT_AFTER_ARCHIVE);
assert.equal(keptLabel(rec({ outcome: "movedOn", reason: "merged" })), KEPT_AFTER_SHIP);
assert.equal(keptLabel(rec({ outcome: "declined" })), null);

// ── Lists ────────────────────────────────────────────────────────────
assert.equal(branchList(["a"]), "a");
assert.equal(branchList(["a", "b"]), "a and b");
assert.equal(branchList(["a", "b", "c"]), "a, b and c");
assert.equal(branchList(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");

// ── The Inbox ask ────────────────────────────────────────────────────
const ask = (branch: string) => ({ cardId: branch, title: branch, branch, at: 1 });
// 1.171.0 A3 (BI-2): Keep them is the press; Delete them… asks first.
assert.deepEqual(askWords([ask("x"), ask("y"), ask("z")]), {
  title: "3 archived cards' work is only on their branches",
  detail:
    "Their cards were archived without shipping, so the work is only on these branches, not on the main branch: x, y and z",
  keep: "Keep them",
  remove: "Delete them…",
  deleteAsk: {
    title: "Delete these 3 branches?",
    body: "The work on them is only there: x, y and z. Once deleted, it's gone.",
    confirmLabel: "Delete them",
    cancelLabel: "Keep them",
    destructive: true,
  },
});
assert.equal(askWords([ask("x")]).title, "An archived card's work is only on its branch");
assert.doesNotMatch(askWords([ask("x")]).title, /due to be deleted/);
assert.equal(askWords([ask("x")]).deleteAsk.title, "Delete this branch?");
assert.equal(
  askWords([ask("x")]).detail,
  "Its card was archived without shipping, so the work is only on this branch, not on the main branch: x",
);
// A card that shipped, started again and was archived: its *last* work.
assert.equal(
  askWords([{ ...ask("x"), shipped: true }]).detail,
  "Its card was archived; its last work is only on this branch, not on the main branch: x",
);
assert.equal(
  askWords([ask("x"), { ...ask("y"), shipped: true }]).detail,
  "Their cards were archived; their last work is only on these branches, not on the main branch: x and y",
);
assert.equal(branchDeletedText(rec({ outcome: "restored" })), null, "the archive row already says restored");

// ── The backlog offer ────────────────────────────────────────────────
const item = (branch: string, archived = false): BranchBacklogItem => ({
  cardId: branch,
  title: branch,
  branch,
  tip: "t",
  archived,
  since: 1,
});
const both = backlogWords([item("a"), item("b"), item("old", true)]);
assert.equal(both.title, "2 branches of cards that already shipped can be deleted");
assert.equal(both.detail, "a and b · 1 archived card's branch will be asked about here");
assert.equal(both.yes, "Delete 2 branches");
assert.equal(both.notNow, "Not now");
assert.equal(both.never, "Never");
assert.equal(backlogWords([item("a")]).yes, "Delete 1 branch");
const archivedOnly = backlogWords([item("x", true), item("y", true)]);
assert.equal(archivedOnly.yes, "Ask about them", "archived ones are never deleted from the offer");
assert.equal(archivedOnly.title, "2 branches of archived cards can be cleaned up");

// ── Toasts ───────────────────────────────────────────────────────────
assert.equal(answerToast({ deleted: 2, kept: 0, queued: 0 }), "2 branches deleted.");
assert.equal(
  answerToast({ deleted: 1, kept: 1, queued: 1 }),
  "1 branch deleted, 1 branch kept (in use, or with commits after it shipped), 1 branch of archived cards to ask about.",
);
assert.equal(answerToast({ deleted: 0, kept: 0, queued: 0 }), "Nothing to delete.");

// ── The GitHub suggestion's link ─────────────────────────────────────
assert.equal(githubBranchSettingsUrl("MatteoB-adv/atelier"), "https://github.com/MatteoB-adv/atelier/settings");
assert.equal(githubBranchSettingsUrl(" o/r "), "https://github.com/o/r/settings");
assert.equal(githubBranchSettingsUrl(null), null);
assert.equal(githubBranchSettingsUrl("not a repo"), null);
assert.equal(githubBranchSettingsUrl("o/r/../x"), null);
assert.equal(githubRepoOf("acme/board", "acme/origin"), "acme/board", "the board's repository first");
assert.equal(githubRepoOf(null, "acme/origin"), "acme/origin", "a local board's GitHub origin");
assert.equal(githubRepoOf(null, null), null);

console.log("branchCleanup.test.ts: ok");
