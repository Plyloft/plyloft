// 1.171.0 C2 (CF3, CF16): Now's title while the card waits after Finish and
// check — the state word with how long it has run, never the session's
// "Claude · working" — and its sentence: what is happening, and that the
// person can leave. Run with Node 22+:
//   node --experimental-strip-types src/lib/waitLine.test.ts
import assert from "node:assert/strict";
import { waitLine } from "./waitLine.ts";
import { waitTitle } from "./deliveryWords.ts";
import { cardLive, presentCard } from "./cardPresentation.ts";
import { PRESENTATION_FIXTURES, NOW, fixtureCard } from "./cardPresentation.fixtures.ts";

const builder = (patch: Record<string, unknown> = {}) =>
  ({ vendor: "claude", bypass: false, sessionLost: false, startedAt: 1, snapshots: [{ n: 2, sha: "a", at: NOW - 40_000 }], ...patch }) as never;

// The self-check: from when it started, and (1.175.0 F9) who does what.
assert.deepEqual(
  waitLine({ rule: "finishing", state: "running", headline: "Re-reading its work", card: { builder: builder() }, selfCheck: { since: NOW - 80_000, delivered: true } }),
  { what: "Claude is re-reading its work", since: NOW - 80_000 },
);
assert.deepEqual(
  waitLine({ rule: "finishing", state: "running", headline: "Re-reading its work", card: { builder: builder({ vendor: "codex" }) }, selfCheck: { since: NOW - 5_000, delivered: false } }),
  { what: "Codex re-reads its work once it's done with what it's doing", since: NOW - 5_000 },
);
// No self-check (switched off, or after it): no time known.
assert.deepEqual(
  waitLine({ rule: "finishing", state: "running", headline: "Re-reading its work", card: { builder: builder() }, selfCheck: null }),
  { what: "Re-reading its work", since: null },
);
// The review: from its start. The checks: from the save that started them.
const review = { snapshotN: 2, provider: "codex", degraded: false, status: "running", at: NOW - 180_000 };
assert.deepEqual(
  waitLine({ rule: "base", state: "challenger-reviewing", headline: "Reviewing", card: { builder: builder({ review }) } }),
  { what: "Reviewing", since: NOW - 180_000 },
);
assert.deepEqual(
  waitLine({ rule: "base", state: "checking", headline: "Running checks", card: { builder: builder() } }),
  { what: "Running checks", since: NOW - 40_000 },
);
// Another rule speaking, or no wait: nothing.
assert.equal(waitLine({ rule: "handed-over", state: "challenger-reviewing", headline: "x", card: { builder: builder({ review }) } }), null);
assert.equal(waitLine({ rule: "base", state: "running", headline: "Working", card: { builder: builder() } }), null);
assert.equal(waitLine({ rule: "base", state: "ready-to-ship", headline: "Ready to ship", card: { builder: builder() } }), null);

// The fixture: the word for the live region and the Board, the word with
// its time for the title, what happens in the sentence.
const f = PRESENTATION_FIXTURES.find((x) => x.name === "Finish and check pressed, its Builder re-reads its work")!;
const p = presentCard(f.card, f.live);
// 1.175.0 F9 (words.html §1): the title says who does what, the sentence
// what comes next; the Board's word is "Re-reading its work".
assert.equal(p.headline, "Re-reading its work");
assert.equal(
  p.sentence,
  "Then your checks run and the Reviewer reviews it. You can leave this; Plyloft tells you when it's done.",
);
const line = waitLine({ rule: p.rule, state: p.state, headline: p.headline, card: f.card, selfCheck: f.live.session?.selfCheck ?? null })!;
assert.equal(waitTitle(line.what, NOW - line.since!), "Claude is re-reading its work · 1m 20s");
assert.ok(!/\d/.test(p.headline), "no time in what is announced");
// Saving (no self-check): what Plyloft does.
const saving = presentCard(f.card, cardLive({ ...f.live, session: { ...f.live.session!, selfCheck: null } }));
assert.equal(saving.headline, "Re-reading its work");
assert.match(saving.sentence, /^Plyloft is saving this version/);
// A question in the session still says so (rule 9), Finish and check or not.
const asked = presentCard(f.card, cardLive({ ...f.live, session: { ...f.live.session!, state: "question" } }));
assert.equal(asked.rule, "builder-waiting");
assert.equal(asked.headline, "Asks you something");
// The session at its prompt while the checklist waits to go in: still the
// wait, never "Your turn" (rule 9's stopped would offer the press again).
const between = presentCard(f.card, cardLive({ ...f.live, session: { ...f.live.session!, state: "stopped" } }));
assert.equal(between.rule, "finishing");

// The review: who reviews whose work, the checks beside it, and leave.
const reviewing = fixtureCard("reviewing", {
  columnId: "in_progress",
  lastRunStatus: "success",
  builder: builder({ ptyId: "pty-1", review }),
});
const r = presentCard(reviewing, cardLive({ now: NOW, verificationActive: true }));
assert.equal(r.headline, "Reviewing");
assert.equal(
  r.sentence,
  "Codex is reviewing Claude's work without changing it, and your checks are running. You can leave this; Plyloft tells you when it's done.",
);

console.log("waitLine: ok");
