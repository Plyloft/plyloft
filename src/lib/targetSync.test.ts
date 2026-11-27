// 1.170.0 (G6): Behind main / Conflict ahead, and Bring in main's changes.
import assert from "node:assert/strict";
import type { CardTargetSync, KanbanCard } from "../ipc.ts";
import {
  askBuilderOnLine,
  behindLabel,
  bringInLabel,
  bringInOffered,
  bringInToast,
  cardTarget,
  CONFLICT_AHEAD_LABEL,
  targetSyncBadge,
  targetSyncSentence,
} from "./targetSync.ts";
import { leaveOutLabel, shipConflictSentence, syncConflictBeside, syncConflictHeadline } from "./shipConflict.ts";
import { shipConflictHeadline, SHIP_CONFLICT_HEADLINE } from "./cardPresentation.ts";

const builder = { vendor: "claude", bypass: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"];
const card = (patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "c",
    workspaceId: "ws",
    title: "c",
    columnId: "complete",
    createdAt: 1,
    updatedAt: 1,
    lastRunStatus: "success",
    worktreePath: "/w",
    builder,
    ...patch,
  }) as KanbanCard;
const prCard = (pr: Partial<NonNullable<KanbanCard["pr"]>>, patch: Partial<KanbanCard> = {}) =>
  card({
    reviewStatus: "merged",
    prUrl: "https://github.com/a/b/pull/7",
    pr: { number: 7, state: "open", ...pr } as NonNullable<KanbanCard["pr"]>,
    ...patch,
  });
const sync = (patch: Partial<CardTargetSync> = {}): CardTargetSync => ({ behind: 0, conflict: false, merging: false, ...patch });

// Words: the target's real name.
assert.equal(behindLabel("develop"), "Behind develop");
assert.equal(bringInLabel("main"), "Bring in main's changes");
assert.equal(CONFLICT_AHEAD_LABEL, "Conflict ahead");

// Up to date, or nothing read yet: no badge, no line, no press.
assert.equal(targetSyncBadge(card(), sync(), "main"), null);
assert.equal(targetSyncBadge(card(), undefined, "main"), null);
assert.equal(targetSyncSentence(card(), sync(), "main"), null);
assert.equal(bringInOffered(card(), sync(), "main"), false);

// Behind: the count, and the press.
const behind = targetSyncBadge(card(), sync({ behind: 3 }), "main");
assert.deepEqual(behind?.kind, "behind");
assert.equal(behind?.label, "Behind main");
// 1.171.0 E3 (DL-22): quiet, and the tooltip says it's usually nothing to do.
assert.equal(
  behind?.title,
  "main on GitHub has 3 commits this card doesn't have. Nothing to do unless GitHub asks for them or they clash with this card's changes.",
);
assert.equal(behind?.urgent, false);
assert.equal(targetSyncBadge(card(), sync({ behind: 2, conflict: true }), "main")?.urgent, true, "a conflict asks");
assert.equal(
  targetSyncSentence(card(), sync({ behind: 1 }), "main"),
  "main on GitHub has 1 commit this card doesn't have. Bring them in to keep the card up to date.",
);
assert.equal(bringInOffered(card(), sync({ behind: 3 }), "main"), true);

// Conflict ahead outranks behind; the press is still offered (the conflict
// then goes to the Builder).
assert.equal(targetSyncBadge(card(), sync({ behind: 2, conflict: true }), "main")?.label, "Conflict ahead");
assert.equal(bringInOffered(card(), sync({ behind: 2, conflict: true }), "main"), true);
assert.match(targetSyncSentence(card(), sync({ behind: 2, conflict: true }), "main")!, /ask the Builder to resolve the conflict/);

// Never while the Builder works, without a Builder, without a copy, on an
// archived, landed or conflict-stopped card, or a pull request review.
assert.equal(bringInOffered(card({ lastRunStatus: "running" }), sync({ behind: 1 }), "main"), false);
assert.equal(bringInOffered(card({ builder: null }), sync({ behind: 1 }), "main"), false);
assert.equal(bringInOffered(card({ worktreePath: null }), sync({ behind: 1 }), "main"), false);
// (Challenger) With no button, the line doesn't send the person to one.
assert.equal(
  targetSyncSentence(card({ builder: null }), sync({ behind: 1 }), "main"),
  "main on GitHub has 1 commit this card doesn't have.",
);
assert.equal(
  targetSyncSentence(card({ lastRunStatus: "running" }), sync({ behind: 2, conflict: true }), "main"),
  "main on GitHub changed the same lines as this card.",
);
for (const patch of [
  { archived: true },
  { shipStatus: "shipped" },
  { reviewStatus: "conflict_blocked" },
  { reviewStatus: "merged" },
  { prReview: {} },
] as Partial<KanbanCard>[]) {
  assert.equal(targetSyncBadge(card(patch), sync({ behind: 1 }), "main"), null, JSON.stringify(patch));
}

// An open pull request: GitHub's own merge state counts too.
assert.equal(targetSyncBadge(prCard({ mergeState: "behind" }), undefined, "main")?.label, "Behind main");
assert.equal(
  targetSyncBadge(prCard({ mergeState: "behind" }), undefined, "main")?.title,
  "main on GitHub has changes this card doesn't have. GitHub needs them in before it merges the pull request: open the card to bring them in.",
);
// GitHub requires it up to date: the chip is accented.
assert.equal(targetSyncBadge(prCard({ mergeState: "behind" }), undefined, "main")?.urgent, true);
assert.equal(targetSyncBadge(prCard({ mergeState: "clean" }), sync({ behind: 1 }), "main")?.urgent, false);
assert.equal(targetSyncBadge(prCard({ mergeState: "dirty" }), undefined, "main")?.label, "Conflict ahead");
assert.equal(targetSyncBadge(prCard({ mergeable: "conflicting" }), sync(), "main")?.kind, "conflict");
assert.equal(bringInOffered(prCard({ mergeState: "behind" }), sync({ behind: 1 }), "main"), true);
// A conflict GitHub reports goes through Fix with the Builder, not this
// press; one only the dry merge sees is brought in (orchestrator #8).
assert.equal(bringInOffered(prCard({ mergeable: "conflicting" }), sync({ behind: 1, conflict: true }), "main"), false);
assert.match(targetSyncSentence(prCard({ mergeable: "conflicting" }), sync(), "main")!, /Fix with the Builder/);
assert.equal(bringInOffered(prCard({ mergeState: "dirty" }), sync({ behind: 1, conflict: true }), "main"), true);
assert.doesNotMatch(targetSyncSentence(prCard({}), sync({ behind: 1, conflict: true }), "main")!, /Fix with the Builder/);
assert.match(targetSyncSentence(prCard({}), sync({ behind: 1, conflict: true }), "main")!, /Bring in its changes/);
// A merged pull request: landed.
assert.equal(targetSyncBadge(prCard({ state: "merged", mergeState: "behind" }), sync({ behind: 1 }), "main"), null);

// Brought in, not committed yet: no badge; the line says Finish and check
// (and Push update on an open pull request).
assert.equal(targetSyncBadge(card(), sync({ behind: 2, merging: true }), "main"), null);
assert.equal(
  targetSyncSentence(card(), sync({ behind: 2, merging: true }), "main"),
  "main's changes are merged in the card's copy, not committed yet. Press Finish and check to commit them and run the checks.",
);
assert.match(targetSyncSentence(prCard({}), sync({ behind: 2, merging: true }), "main")!, /Then Send the fixes to GitHub sends them/);
assert.equal(bringInOffered(card(), sync({ behind: 2, merging: true }), "main"), false);

// The press's toasts.
assert.equal(bringInToast({ kind: "up_to_date", target: "main", paths: [], recorded: false }, false, null).title, "Already up to date");
const merged = bringInToast({ kind: "merged", target: "main", paths: [], recorded: false }, true, null);
assert.equal(merged.title, "main's changes are in the card's copy");
assert.match(merged.body, /Press Finish and check.*Then Send the fixes to GitHub/);
let asked = 0;
const conflict = bringInToast({ kind: "conflict", target: "main", paths: ["a.ts"], recorded: true }, false, () => asked++);
assert.equal(conflict.kind, "warn");
assert.equal(conflict.details, "a.ts");
assert.equal(conflict.action?.label, "Fix with the Builder");
conflict.action!.onClick();
assert.equal(asked, 1);

// Orchestrator #8: an open pull request's bring-in conflict, recorded
// beside its status — Ask the Builder on the line, then Finish and check
// and Push update; never "Ship stopped".
const beside = prCard(
  {},
  { shipConflict: { paths: ["a.ts"], targetSha: "d", at: 1, branch: "main", sync: true, reviewBefore: "merged" } },
);
assert.ok(syncConflictBeside(beside));
assert.equal(syncConflictBeside(card({ reviewStatus: "conflict_blocked", shipConflict: beside.shipConflict })), null);
assert.equal(askBuilderOnLine(beside), true);
assert.equal(askBuilderOnLine({ ...beside, lastRunStatus: "running" }), false);
assert.equal(bringInOffered(beside, sync({ behind: 1, conflict: true }), "main"), false);
const prConflict = targetSyncSentence(beside, sync({ behind: 1, conflict: true }), "main")!;
assert.equal(prConflict, "main on GitHub changed the same lines as this card. Press Fix with the Builder.");
const started = { ...beside, shipConflict: { ...beside.shipConflict!, mergeStartedAt: 5 } };
assert.equal(askBuilderOnLine(started), false);
assert.equal(
  targetSyncSentence(started, sync({ behind: 1, merging: true }), "main"),
  "The Builder is resolving the conflict with main. When it's done, press Finish and check, then Send the fixes to GitHub sends it to the pull request.",
);
assert.equal(leaveOutLabel("main"), "Leave main's changes out");

// A bring-in's conflict, in its own words on the card.
const met = card({
  reviewStatus: "conflict_blocked",
  shipConflict: { paths: ["a.ts"], targetSha: "d", at: 1, branch: "main", sync: true },
});
assert.equal(shipConflictHeadline(met), "Conflict with main");
assert.equal(syncConflictHeadline(""), "Conflict with your main branch");
assert.equal(shipConflictHeadline(card({ shipConflict: { paths: [], targetSha: "d", at: 1 } })), SHIP_CONFLICT_HEADLINE);
assert.equal(shipConflictSentence(met), "main on GitHub changed the same lines as this card in 1 file. Nothing was merged.");

// The copy passes the app's vocabulary (no developer words).
for (const words of [
  behind!.title,
  targetSyncSentence(card(), sync({ behind: 2, conflict: true }), "main")!,
  targetSyncSentence(prCard({}), sync({ merging: true }), "main")!,
  merged.body,
  conflict.body,
  prConflict,
]) {
  assert.doesNotMatch(words, /\b(rebase|origin|worktree|upstream|HEAD|into main)\b/i, words);
}

// 1.173.0 (B3): a card is measured against its area's branch when the
// reading names one, else the workspace's.
{
  const report = { target: "staging", cards: { a: sync({ target: "main" }), b: sync() } };
  assert.equal(cardTarget(report, "a"), "main");
  assert.equal(cardTarget(report, "b"), "staging");
  assert.equal(cardTarget(report, "gone"), "staging");
  assert.equal(bringInLabel(cardTarget(report, "a")), "Bring in main's changes");
}

console.log("targetSync: ok");
