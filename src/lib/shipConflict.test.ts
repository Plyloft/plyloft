// UX P1 point 7 (P-E): the ship conflict's words and the press's steps.
import assert from "node:assert/strict";
import type { KanbanCard, ShipConflictMessage } from "../ipc.ts";
import {
  askBuilderOffered,
  askBuilderToResolve,
  conflictMergeStarted,
  shipConflictOf,
  shipConflictSentence,
  shipConflictToast,
  type ResolveDeps,
} from "./shipConflict.ts";

const builder = { vendor: "claude", bypass: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"];
const conflict = { paths: ["a.ts", "b.ts"], targetSha: "def", at: 1, branch: "staging" };
const card = (patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "c",
    workspaceId: "ws",
    title: "c",
    columnId: "complete",
    createdAt: 1,
    updatedAt: 1,
    reviewStatus: "conflict_blocked",
    shipConflict: conflict,
    builder,
    ...patch,
  }) as KanbanCard;

// The record counts only beside its status.
assert.equal(shipConflictOf(card({ reviewStatus: "merged" })), null);
assert.deepEqual(shipConflictOf(card()), conflict);
assert.equal(askBuilderOffered(card()), true);
assert.equal(askBuilderOffered(card({ builder: null })), false);
assert.equal(askBuilderOffered(card({ shipConflict: null })), false);
assert.equal(askBuilderOffered(card({ archived: true })), false);
assert.equal(conflictMergeStarted(card()), false);
assert.equal(conflictMergeStarted(card({ shipConflict: { ...conflict, mergeStartedAt: 2 } })), true);

// The sentence: the branch, the count, nothing merged; by hand without a Builder.
assert.equal(shipConflictSentence(card()), "staging changed the same lines as this card in 2 files. Nothing was merged.");
assert.equal(
  shipConflictSentence(card({ shipConflict: { ...conflict, paths: ["a.ts"] } })),
  "staging changed the same lines as this card in 1 file. Nothing was merged.",
);
assert.equal(
  shipConflictSentence(card({ builder: null, shipConflict: null })),
  "The last ship stopped on a conflict. Nothing was merged. Resolve it in the card's copy, then ship again.",
);

// One toast: with a Builder its action asks it; without, the body says how.
const asked: string[] = [];
const t = shipConflictToast(["a.ts", "b.ts"], "main", () => asked.push("ask"));
assert.equal(t.title, "Ship stopped: main changed the same lines");
assert.equal(t.body, "Nothing was merged, and the card's work is safe. Press Fix with the Builder, then ship again.");
assert.equal(t.details, "a.ts\nb.ts");
assert.equal(t.action?.label, "Ask the Builder");
t.action!.onClick();
assert.deepEqual(asked, ["ask"]);
const alone = shipConflictToast(["a.ts"], "", null);
assert.equal(alone.title, "Ship stopped: your main branch changed the same lines");
assert.equal(alone.body, "Nothing was merged, and the card's work is safe. Resolve it in the card's copy, then ship again.");
assert.equal(alone.action, undefined);

// The press: the session first, then the merge, then the message.
const sent: ShipConflictMessage = { message: "[Plyloft] x\u001b[31m", paths: ["a.ts"], branch: "main", alreadyStarted: false };
function deps(over: Partial<ResolveDeps> = {}) {
  const steps: string[] = [];
  const notes: string[] = [];
  const d: ResolveDeps = {
    start: async () => {
      steps.push("start");
      return sent;
    },
    sessionOpen: () => false,
    sessionRecorded: () => false,
    resume: async () => {
      steps.push("resume");
    },
    reveal: () => steps.push("reveal"),
    waitForSession: async () => {
      steps.push("wait");
      return true;
    },
    deliver: (text) => {
      steps.push(`deliver:${text}`);
      return Promise.resolve();
    },
    queued: () => steps.push("queued"),
    notify: (_kind, title, body) => notes.push(`${title} — ${body}`),
    ...over,
  };
  return { d, steps, notes };
}

{
  const { d, steps, notes } = deps();
  assert.equal(await askBuilderToResolve(d), "sent");
  // The paste is cleaned of control characters.
  assert.deepEqual(steps, ["resume", "reveal", "wait", "start", "deliver:[Plyloft] x[31m"]);
  assert.equal(
    notes[notes.length - 1],
    "Sent to the Builder — Plyloft started merging main; the Builder resolves 1 file. When it has resolved the conflict, press Finish and check. Ship waits until then.",
  );
}
{
  // The session didn't open: nothing is merged.
  const { d, steps, notes } = deps({ waitForSession: async () => false });
  assert.equal(await askBuilderToResolve(d), "failed");
  assert.ok(!steps.includes("start"));
  assert.equal(notes[0], "The Builder session didn't open — Nothing was merged or sent. Resume the session on the card, then ask again.");
}
{
  // Plyloft's refusal (uncommitted work, no Builder) is said as it is.
  const { d, notes } = deps({
    sessionOpen: () => true,
    start: async () => {
      throw "The card's copy has changes since the last Finish and check. Press Finish and check first, then ask again.";
    },
  });
  assert.equal(await askBuilderToResolve(d), "failed");
  assert.equal(
    notes[0],
    "The merge didn't start — The card's copy has changes since the last Finish and check. Press Finish and check first, then ask again.",
  );
}
{
  // Started but not delivered: it says the merge is under way.
  const { d, notes } = deps({ sessionOpen: () => true, deliver: () => Promise.reject(new Error("ended")) });
  assert.equal(await askBuilderToResolve(d), "failed");
  assert.equal(
    notes[0],
    "The message didn't reach the Builder — The merge is started in the card's copy. Send the message again from the card.",
  );
}

console.log("shipConflict: words and the press's steps");
