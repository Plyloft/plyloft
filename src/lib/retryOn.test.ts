import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { retryActivityEntries, retryActivityWords, retryOffered } from "./retryOn.ts";
import { cardTimeline, reviewRoundText } from "./cardPage.ts";

// 1.169.0 (A3, owner D): offered after real work that ended or failed, never
// while it runs, never on a lost session (Resume's) or a record no session ran in.
const worked = { vendor: "codex", bypass: false, startedAt: 10, snapshots: [{ n: 1, sha: "a", at: 11 }], sessionLost: false, ptyId: null };
const card = (builder: object | null, extra: object = {}) => ({ builder, ...extra }) as never;
assert.equal(retryOffered(card(null), "builder"), false);
assert.equal(retryOffered(card(worked), "builder"), true, "closed after work");
assert.equal(retryOffered(card({ ...worked, ptyId: "p1" }), "builder"), false, "still working");
assert.equal(retryOffered(card({ ...worked, sessionLost: true }), "builder"), true, "ended on its own while the app ran");
assert.equal(retryOffered(card({ ...worked, sessionLost: true, lostOnRestart: true }), "builder"), false, "lost on a restart: Resume's");
assert.equal(retryOffered(card({ ...worked, startedAt: 0 }), "builder"), false, "never started");
assert.equal(retryOffered(card({ ...worked, snapshots: [] }), "builder"), false, "no work and no copy");
assert.equal(retryOffered(card({ ...worked, snapshots: [] }, { worktreePath: "/w" }), "builder"), true, "Rust checks the copy's changes");
assert.equal(retryOffered(card(worked, { prReview: { number: 1 } }), "builder"), false, "not on a pull request's card");
assert.equal(retryOffered(card(worked, { buildBoth: { startedAt: 1, lanes: [] } }), "builder"), false, "built by both");
assert.equal(retryOffered(card(worked, { archived: true }), "builder"), false);
assert.equal(retryOffered(card(worked), "challenger"), false, "no review yet");
for (const [status, ok] of [["running", false], ["queued", false], ["done", true], ["failed", true], ["skipped", true]] as const) {
  assert.equal(retryOffered(card({ ...worked, review: { status, snapshotN: 1 } }), "challenger"), ok, status);
}
assert.equal(
  retryOffered(card({ ...worked, snapshots: [...worked.snapshots, { n: 2, sha: "b", at: 12 }], review: { status: "done", snapshotN: 1 } }), "challenger"),
  false,
  "a newer snapshot is waiting for its review",
);
assert.equal(retryOffered(card({ ...worked, review: { status: "done", snapshotN: 1 } }, { prReview: { number: 1 } }), "challenger"), false);
assert.equal(retryOffered(card({ ...worked, review: { status: "done" } }, { archived: true }), "challenger"), false);

// Owner C: the Builder's two attempts, each with its model and outcome.
assert.deepEqual(
  retryActivityEntries({ role: "builder", at: 20, model: "gpt-6-luna xhigh", fromModel: "gpt-6-astra high", fromOutcome: "stopped", fromStartedAt: 10 }),
  [
    { at: 10, text: "Builder attempt on gpt-6-astra with high effort · stopped", earlier: true },
    { at: 20, text: "Retried the Builder on gpt-6-luna with xhigh effort · running", earlier: false },
  ],
);
assert.equal(
  retryActivityWords({ role: "builder", at: 20, model: null, outcome: "finished" }),
  "Retried the Builder on the tool's default · finished",
);
assert.equal(
  retryActivityWords({ role: "challenger", at: 30, model: "gpt-6-luna high", outcome: "approve", fromModel: "gpt-6-astra medium" }),
  "Retried the Reviewer on gpt-6-luna with high effort · approved",
);
assert.equal(
  reviewRoundText({ round: 2, verdict: "approve", new: 0, notes: 0, closed: 1, stillOpen: 0, provider: "codex", model: "gpt-6-luna high" }),
  "Round 2 · Codex on gpt-6-luna with high effort · approved · 1 closed",
);
assert.equal(
  reviewRoundText({ round: 1, verdict: "approve", new: 0, notes: 0, closed: 0, stillOpen: 0, provider: "claude" }),
  "Round 1 · Claude · approved",
);

// 1.169.0 walk: a Builder retry doesn't move the first start's time.
{
  const timeline = cardTimeline({
    createdAt: 1,
    updatedAt: 1,
    notes: "x",
    builder: { vendor: "codex", bypass: false, startedAt: 2600, snapshots: [], sessionLost: false, ptyId: "p2" },
    modelRetries: [{ role: "builder", vendor: "codex", at: 2600, fromStartedAt: 1700, fromModel: "gpt-6-astra high", fromOutcome: "stopped", model: "gpt-6-luna high" }],
  } as never);
  const start = timeline.find((i) => i.id === "builder-start");
  assert.equal(start?.at, 1700, "the first start keeps its time");
  assert.equal(start?.text, "Codex started building");
  assert.ok(timeline.some((i) => i.text === "Retried the Builder on gpt-6-luna with high effort · running" && i.at === 2600));
}

// CH-4 (1.174.0): held to the same fixtures as `retry_on.rs::retryable`
// (src/lib/retryOn.fixtures.json).
{
  const fixtures: { cases: { name: string; card: object; role: "builder" | "challenger"; offered: boolean }[] } = JSON.parse(
    readFileSync(new URL("./retryOn.fixtures.json", import.meta.url), "utf8"),
  );
  assert.ok(fixtures.cases.length >= 15);
  for (const c of fixtures.cases) {
    const card = { builder: null, ...c.card } as never;
    assert.equal(retryOffered(card, c.role), c.offered, c.name);
  }
}

console.log("retryOn: ok");
