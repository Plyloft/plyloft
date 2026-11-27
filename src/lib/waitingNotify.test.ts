// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/waitingNotify.test.ts
import assert from "node:assert/strict";
import {
  EMPTY_TRACKER,
  NOTIFY_COOLDOWN_MS,
  sessionsToNotify,
  turnsEnded,
  waitingNotification,
  type TurnEnded,
  type TurnTileInput,
  type WaitingTracker,
} from "./waitingNotify.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
  passed += 1;
}

const T0 = 1_000_000_000;

/** A Claude tile started at T0, with the readiness Terminal folded. */
function claude(
  readiness: TurnTileInput["readiness"],
  id = "t1",
  // QoL 1.168 (Windows walk): a turn is the member's line; by default the
  // one that made the tile leave Ready.
  submittedAt: number | null = readiness && readiness.leftReadyAt > T0 ? readiness.leftReadyAt : null,
): TurnTileInput {
  return { id, kind: "claude", label: "api", status: "running", startedAt: T0, readiness, ...(submittedAt != null ? { submittedAt } : {}) };
}

function ended(tiles: TurnTileInput[], now: number, ws = "b") {
  return turnsEnded({ tilesByWorkspace: { [ws]: { tiles } }, builders: {}, cardTitle: () => null, now });
}

/** Look at `ended` in turn, from a fresh tracker; the notifications sent. */
function run(looks: { ended: TurnEnded[]; now: number; onScreen?: string | null }[]): TurnEnded[][] {
  let t: WaitingTracker = EMPTY_TRACKER;
  const out: TurnEnded[][] = [];
  for (const l of looks) {
    const r = sessionsToNotify(t, l.ended, l.onScreen === undefined ? "a" : l.onScreen, l.now);
    t = r.next;
    out.push(r.notify);
  }
  return out;
}

// Readiness of a tile that was Ready, worked from T0+60s, and came back to
// its prompt (its last activity) at T0+120s.
const afterTurn = { lastOutputAt: T0 + 120_000, matcherIdle: true, leftReadyAt: T0 + 60_000 };

test("a fresh tile nobody has used is never a finished turn", () => {
  // It went quiet at its prompt and reads Ready, but never left Ready.
  const fresh = claude({ lastOutputAt: T0 + 3_000, matcherIdle: true, leftReadyAt: T0 });
  assert.deepEqual(ended([fresh], T0 + 600_000), []);
  // Not judged yet either.
  assert.deepEqual(ended([claude(undefined)], T0 + 600_000), []);
  const sent = run([
    { ended: [], now: T0 },
    { ended: ended([fresh], T0 + 20_000), now: T0 + 20_000 },
    { ended: ended([fresh], T0 + 600_000), now: T0 + 600_000 },
  ]);
  assert.deepEqual(sent.flat(), []);
});

test("QoL 1.168 (Windows walk): the CLI's own startup, and a resize repaint during it, is no turn", () => {
  // ConPTY: Claude draws its prompt, repaints (startup, a resize to the same
  // size), and is back at Ready — it left Ready with nobody typing.
  const startup = claude({ lastOutputAt: T0 + 8_000, matcherIdle: true, leftReadyAt: T0 + 4_000 }, "t1", null);
  assert.deepEqual(ended([startup], T0 + 600_000), []);
  const resized = claude({ lastOutputAt: T0 + 30_000, matcherIdle: true, leftReadyAt: T0 + 25_000 }, "t1", null);
  assert.deepEqual(ended([resized], T0 + 600_000), []);
  // The member's line, answered: a turn, keyed by that line — a repaint
  // after it (a later leftReadyAt) is the same turn.
  const answered = claude({ lastOutputAt: T0 + 90_000, matcherIdle: true, leftReadyAt: T0 + 61_000 }, "t1", T0 + 60_000);
  const repainted = claude({ lastOutputAt: T0 + 200_000, matcherIdle: true, leftReadyAt: T0 + 190_000 }, "t1", T0 + 60_000);
  assert.equal(ended([answered], T0 + 120_000)[0].episode, ended([repainted], T0 + 300_000)[0].episode);
  // A line nothing answered yet (no activity after it) is no turn.
  const unanswered = claude({ lastOutputAt: T0 + 50_000, matcherIdle: true, leftReadyAt: T0 + 40_000 }, "t1", T0 + 60_000);
  assert.deepEqual(ended([unanswered], T0 + 120_000), []);
});

test("a turn that ends is news once, in another workspace", () => {
  const working = claude({ lastOutputAt: T0 + 100_000, matcherIdle: false, leftReadyAt: T0 + 60_000 });
  assert.deepEqual(ended([working], T0 + 101_000), []);
  const sent = run([
    { ended: [], now: T0 },
    { ended: ended([working], T0 + 101_000), now: T0 + 101_000 },
    { ended: ended([claude(afterTurn)], T0 + 125_000), now: T0 + 125_000 },
    { ended: ended([claude(afterTurn)], T0 + 128_000), now: T0 + 128_000 },
  ]);
  assert.deepEqual(sent.map((s) => s.length), [0, 0, 1, 0]);
  assert.equal(sent[2][0].id, "tile:t1");
});

test("a resize redraw of a session waiting for an hour is not news", () => {
  // The redraw stamps lastOutputAt on the tile (the silence rule flips it to
  // working and back), but Terminal rebaselines readiness: unchanged.
  const hourLater = T0 + 3_600_000;
  const before = ended([claude(afterTurn)], hourLater);
  const redrawn = ended(
    [{ ...claude(afterTurn), lastOutputAt: hourLater + 500 } as TurnTileInput],
    hourLater + 1_000,
  );
  const back = ended([claude(afterTurn)], hourLater + 12_000);
  const sent = run([
    { ended: before, now: hourLater },
    { ended: redrawn, now: hourLater + 1_000 },
    { ended: back, now: hourLater + 12_000 },
  ]);
  assert.deepEqual(sent.flat(), []);
  assert.equal(redrawn[0].episode, before[0].episode);
});

test("the next real turn is a new episode", () => {
  const second = { lastOutputAt: T0 + 400_000, matcherIdle: true, leftReadyAt: T0 + 300_000 };
  const a = ended([claude(afterTurn)], T0 + 200_000);
  const b = ended([claude(second)], T0 + 400_000 + NOTIFY_COOLDOWN_MS);
  assert.notEqual(a[0].episode, b[0].episode);
  const sent = run([
    { ended: [], now: T0 },
    { ended: a, now: T0 + 200_000 },
    { ended: [], now: T0 + 300_000 },
    { ended: b, now: T0 + 400_000 + NOTIFY_COOLDOWN_MS },
  ]);
  assert.deepEqual(sent.map((s) => s.length), [0, 1, 0, 1]);
});

test("the workspace on screen says nothing; in the background it does", () => {
  const e = ended([claude(afterTurn)], T0 + 130_000, "a");
  assert.deepEqual(
    run([{ ended: [], now: T0 }, { ended: e, now: T0 + 130_000, onScreen: "a" }]).flat(),
    [],
  );
  // Ply unfocused or hidden: nothing is on screen, the active one notifies too.
  assert.equal(
    run([{ ended: [], now: T0 }, { ended: e, now: T0 + 130_000, onScreen: null }])[1].length,
    1,
  );
});

test("the first look only records; an episode begun on screen is not news after a switch", () => {
  const e = ended([claude(afterTurn)], T0 + 130_000, "a");
  assert.deepEqual(run([{ ended: e, now: T0 + 130_000 }]).flat(), []);
  const sent = run([
    { ended: [], now: T0 },
    { ended: e, now: T0 + 130_000, onScreen: "a" },
    { ended: e, now: T0 + 140_000, onScreen: "b" },
  ]);
  assert.deepEqual(sent.flat(), []);
});

test("turn after turn, at most once a minute per session", () => {
  const e1: TurnEnded[] = [
    { id: "tile:t1", episode: "tile:t1@1", workspaceId: "b", agent: "Claude", where: "api" },
  ];
  const e2: TurnEnded[] = [{ ...e1[0], episode: "tile:t1@2" }];
  const sent = run([
    { ended: [], now: T0 },
    { ended: e1, now: T0 + 1_000 },
    { ended: e2, now: T0 + 20_000 },
  ]);
  assert.deepEqual(sent.map((s) => s.length), [0, 1, 0]);
});

test("Codex chat and Builders: their own turn end", () => {
  const chat: TurnTileInput = { id: "c1", kind: "codex-chat", label: "chat", status: "running", startedAt: T0 };
  assert.deepEqual(ended([chat], T0 + 60_000), []); // never ran a turn
  assert.equal(
    ended([{ ...chat, sessionIdleSince: T0 + 50_000 }], T0 + 60_000)[0].episode,
    `tile:c1@${T0 + 50_000}`,
  );
  assert.equal(
    ended([{ ...chat, sessionApprovalPending: true, sessionTurnStartedAt: 7 }], T0)[0].episode,
    "tile:c1@approval:7",
  );
  const builders = turnsEnded({
    tilesByWorkspace: {},
    builders: {
      k1: { workspaceId: "b", vendor: "codex", turnIdle: true, pending: [] },
      k2: { workspaceId: "b", vendor: "claude", turnIdle: true, pending: ["the brief"] },
      k3: { workspaceId: "b", vendor: "claude", turnIdle: false },
    },
    cardTitle: (_ws, id) => (id === "k1" ? "Rollback" : null),
    now: T0,
  });
  assert.deepEqual(builders.map((b) => [b.id, b.agent, b.where]), [["builder:k1", "Codex", "Rollback"]]);
});

test("the words: the Inbox row's, with the workspace", () => {
  assert.deepEqual(waitingNotification({ agent: "Claude", where: "api tests" }, "beta"), {
    title: "Claude · Asks you something",
    body: "beta · In “api tests”",
  });
});

console.log(`waitingNotify: ${passed}/10 passed`);
