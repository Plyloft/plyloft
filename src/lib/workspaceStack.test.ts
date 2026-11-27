// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/workspaceStack.test.ts
import assert from "node:assert/strict";
import type { InboxEvent } from "../ipc";
import {
  needsYouByWorkspace,
  waitingSessions,
  type WaitingTileInput,
} from "./needsYou.ts";
import {
  capStack,
  idleWorkspacesLabel,
  STACK_CAP,
  stackSummary,
  capStackSummary,
  holdOrder,
  EMPTY_ORDER,
  itemStateWord,
  REORDER_HOLD_MS,
  recentWorkspaces,
  stackSlots,
  workspaceStack,
  type StackTileInput,
  type WorkspaceStackInput,
} from "./workspaceStack.ts";

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

const NOW = 1_000_000_000;

function event(p: Partial<InboxEvent> & Pick<InboxEvent, "id" | "workspaceId">): InboxEvent {
  return {
    kind: "review_needed",
    group: "needs_you",
    workspaceName: p.workspaceId,
    cardId: null,
    runId: null,
    title: "A card",
    detail: null,
    url: null,
    at: NOW - 60_000,
    seenAt: null,
    seenEligible: true,
    ...p,
  };
}

/** A Claude tile back at its prompt for a minute after a turn: waiting for
 *  its person (QoL 1.168 D7: a turn it finished, not just quiet). */
function quietClaude(id: string, label = "claude"): StackTileInput & WaitingTileInput {
  return {
    id,
    kind: "claude",
    label,
    status: "running",
    startedAt: NOW - 120_000,
    lastOutputAt: NOW - 60_000,
    readiness: { lastOutputAt: NOW - 60_000, matcherIdle: true, leftReadyAt: NOW - 90_000 },
    submittedAt: NOW - 90_000,
  };
}

/** A Claude tile printing right now, its header working. */
function busyClaude(id: string, label = "claude"): StackTileInput & WaitingTileInput {
  return {
    id,
    kind: "claude",
    label,
    status: "running",
    startedAt: NOW - 120_000,
    lastOutputAt: NOW - 500,
    readiness: { lastOutputAt: NOW - 500, matcherIdle: false, leftReadyAt: NOW - 60_000 },
  };
}

/** A shell at its prompt: nothing going on. */
function idleShell(id: string): StackTileInput & WaitingTileInput {
  return {
    id,
    kind: "shell",
    label: "zsh",
    status: "running",
    startedAt: NOW - 120_000,
    readiness: { lastOutputAt: NOW - 30_000, matcherIdle: true, leftReadyAt: NOW - 60_000 },
  };
}

function input(over: Partial<WorkspaceStackInput> & {
  tiles?: Record<string, (StackTileInput & WaitingTileInput)[]>;
}): WorkspaceStackInput {
  const tilesByWorkspace: WorkspaceStackInput["tilesByWorkspace"] = {};
  for (const [ws, tiles] of Object.entries(over.tiles ?? {})) tilesByWorkspace[ws] = { tiles };
  const cardsByWorkspace = over.cardsByWorkspace ?? {};
  const waiting =
    over.waiting ??
    waitingSessions({
      tilesByWorkspace: tilesByWorkspace as Record<string, { tiles: WaitingTileInput[] }>,
      builders: {},
      cardTitle: () => null,
      now: NOW,
    });
  return {
    workspaces: over.workspaces ?? [],
    activeId: over.activeId ?? null,
    events: over.events ?? [],
    waiting,
    tilesByWorkspace,
    cardsByWorkspace,
    lastActiveAt: over.lastActiveAt,
    ...(over.presentOf ? { presentOf: over.presentOf } : {}),
    now: NOW,
  };
}

const WS = [
  { id: "a", name: "alpha", lastOpenedAt: 50 },
  { id: "b", name: "beta", lastOpenedAt: 40 },
  { id: "c", name: "gamma", lastOpenedAt: 30 },
  { id: "d", name: "delta", lastOpenedAt: 20 },
  { id: "e", name: "epsilon", lastOpenedAt: 10 },
];

test("only other workspaces with something going on; never the current one", () => {
  const stack = workspaceStack(
    input({
      workspaces: WS,
      activeId: "a",
      tiles: {
        a: [quietClaude("a1")], // current: its own section shows it
        b: [busyClaude("b1")],
        c: [idleShell("c1")], // idle: stays in the switcher
      },
    }),
  );
  assert.deepEqual(stack.map((e) => e.workspaceId), ["b"]);
  assert.equal(stack[0].working, 1);
});

test("needs you first, then working, each by recency", () => {
  const stack = workspaceStack(
    input({
      workspaces: WS,
      activeId: "a",
      tiles: {
        b: [busyClaude("b1")], // working, most recent
        c: [quietClaude("c1")], // waiting
        e: [quietClaude("e1")], // waiting, least recent
        d: [busyClaude("d1")], // working
      },
    }),
  );
  assert.deepEqual(stack.map((e) => e.workspaceId), ["c", "e", "b", "d"]);
});

test("a failed feed row puts the workspace in the first tier too", () => {
  const stack = workspaceStack(
    input({
      workspaces: WS,
      activeId: "a",
      tiles: { b: [busyClaude("b1")] },
      events: [event({ id: "f1", workspaceId: "d", group: "needs_you", kind: "card_failed", cardId: "k1" })],
    }),
  );
  assert.deepEqual(stack.map((e) => e.workspaceId), ["d", "b"]);
  assert.equal(stack[0].failed, 1);
  assert.equal(stack[0].items[0].words, "The run failed");
  assert.deepEqual(stack[0].items[0].target, { kind: "card", cardId: "k1" });
});

test("needs you + failed is the switcher's one count for that workspace", () => {
  const tiles = { b: [quietClaude("b1"), busyClaude("b2")], c: [quietClaude("c1")] };
  const events = [
    event({ id: "n1", workspaceId: "b", cardId: "k1" }),
    event({ id: "f1", workspaceId: "b", group: "needs_you", kind: "run_failed", runId: "r1" }),
    // F1 (BI-14): seen is still to do — counted and listed until resolved.
    event({ id: "s1", workspaceId: "b", cardId: "k2", seenAt: NOW }),
    // Not markable, or another group: not counted, not listed as waiting.
    event({ id: "x1", workspaceId: "c", seenEligible: false }),
    event({ id: "sh", workspaceId: "c", group: "shipped", kind: "shipped" }),
  ];
  const inp = input({ workspaces: WS, activeId: "a", tiles, events });
  const counts = needsYouByWorkspace(
    { generatedAt: 0, windowDays: 7, events, costRollup: [], eligibilityProof: {} as never },
    inp.waiting,
  );
  for (const entry of workspaceStack(inp)) {
    assert.equal(entry.needsYou + entry.failed, counts[entry.workspaceId] ?? 0, entry.workspaceId);
  }
  const b = workspaceStack(inp).find((e) => e.workspaceId === "b")!;
  assert.deepEqual([b.needsYou, b.failed, b.working], [3, 1, 1]);
  // Waiting first, then failed, then working.
  assert.deepEqual(b.items.map((i) => i.state), ["needs-you", "needs-you", "needs-you", "failed", "working"]);
  // A run row with no card opens through the Inbox's jump.
  assert.deepEqual(b.items[3].target, { kind: "event", eventId: "f1" });
});

test("a waiting tile is listed once, as needing you — not also as working", () => {
  // QoL 1.168 (D7): a tile quiet while its header says working waits only
  // when it asks (a decision in view).
  const tile = { ...quietClaude("b1", "api"), readiness: busyClaude("x").readiness, question: "decision" as const };
  const [b] = workspaceStack(input({ workspaces: WS, activeId: "a", tiles: { b: [tile] } }));
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].state, "needs-you");
  assert.equal(b.items[0].name, "api");
  assert.equal(b.items[0].words, "Claude · Asks you something");
  assert.deepEqual(b.items[0].target, { kind: "tile", tileId: "b1" });
});

test("QoL 1.168 (D7): a fresh tile, a seen turn and a usage limit are not needs you", () => {
  const fresh = { ...quietClaude("b1"), readiness: { lastOutputAt: NOW - 60_000, matcherIdle: true, leftReadyAt: NOW - 120_000 }, submittedAt: undefined };
  const turned = quietClaude("b2");
  const waiting = waitingSessions({
    tilesByWorkspace: { b: { tiles: [fresh, turned] } },
    builders: {},
    cardTitle: () => null,
    now: NOW,
    tileSeen: { b2: `ready@${NOW - 90_000}` },
  });
  assert.equal(waiting.length, 0, "a fresh tile and a seen turn are not listed");
  const stack = workspaceStack(input({ workspaces: WS, activeId: "a", tiles: { b: [fresh, turned] }, waiting }));
  assert.equal(stack.find((e) => e.workspaceId === "b")?.needsYou ?? 0, 0);
});

test("QoL 1.168 (D7): a Builder at its usage limit is grey, never working", () => {
  const cards = { b: { cards: [{ id: "k1", title: "Login fix", builder: { ptyId: "p1", vendor: "claude" } }] } };
  const waiting = waitingSessions({
    tilesByWorkspace: {},
    builders: { k1: { workspaceId: "b", vendor: "claude", startedAt: NOW - 120_000, lastOutputAt: NOW - 500 } },
    cardTitle: () => "Login fix",
    now: NOW,
    sessionBlocks: { k1: { workspaceId: "b", vendor: "claude", kind: "usageLimit", resetsAt: "6pm" } as never },
  });
  assert.equal(waiting[0].muted, "usage-limit");
  const [b] = workspaceStack(input({ workspaces: WS, activeId: "a", waiting, cardsByWorkspace: cards as never }));
  assert.deepEqual(b.items.map((i) => i.state), ["limit"]);
  assert.equal(b.items[0].dot, "empty");
  assert.deepEqual([b.needsYou, b.failed, b.working], [0, 0, 0]);
});

test("Builders: waiting from its session, working otherwise; a feed run of the same card is not listed twice", () => {
  const cards = {
    b: {
      cards: [
        { id: "k1", title: "rollback", ghIssueNumber: 88, builder: { ptyId: "p1" } },
        { id: "k2", title: "docs", builder: { ptyId: "p2" } },
      ],
    },
  };
  const waiting = [
    {
      id: "builder:k2",
      workspaceId: "b",
      agent: "Codex" as const,
      where: "docs",
      since: NOW - 60_000,
      target: { kind: "card" as const, cardId: "k2" },
    },
  ];
  const events = [
    event({ id: "r1", workspaceId: "b", group: "running", kind: "card_running", cardId: "k1", seenEligible: false }),
    event({ id: "r2", workspaceId: "b", group: "running", kind: "card_running", cardId: "k3", title: "Cold card", seenEligible: false }),
    event({ id: "q1", workspaceId: "b", group: "running", kind: "card_queued", cardId: "k4", seenEligible: false }),
  ];
  const [b] = workspaceStack(
    input({ workspaces: WS, activeId: "a", cardsByWorkspace: cards, waiting, events }),
  );
  assert.deepEqual(
    b.items.map((i) => [i.state, i.name]),
    [
      ["needs-you", "docs"],
      ["working", "Card #88 · rollback"],
      ["working", "Cold card"],
    ],
  );
  assert.equal(b.items[2].words, "Working");
});

test("a cold workspace shows its running agent runs from the feed; a run with its own tile is not listed twice", () => {
  const events = [
    event({ id: "rr1", workspaceId: "c", group: "running", kind: "run_running", runId: "run-1", title: "Nightly", seenEligible: false }),
    event({ id: "rr2", workspaceId: "b", group: "running", kind: "run_running", runId: "run-2", seenEligible: false }),
  ];
  const runTile: StackTileInput & WaitingTileInput = {
    id: "t-run",
    kind: "agent-run",
    label: "Reviewer",
    status: "running",
    startedAt: NOW - 5_000,
    runId: "run-2",
  };
  const stack = workspaceStack(
    input({ workspaces: WS, activeId: "a", tiles: { b: [runTile] }, events }),
  );
  const b = stack.find((e) => e.workspaceId === "b")!;
  const c = stack.find((e) => e.workspaceId === "c")!;
  assert.deepEqual(b.items.map((i) => i.name), ["Reviewer"]);
  assert.deepEqual(c.items.map((i) => [i.name, i.words]), [["Nightly", "Running"]]);
  assert.deepEqual(c.items[0].target, { kind: "event", eventId: "rr1" });
});

test("a failed or finished tile is not working; a quiet one still is", () => {
  const failed: StackTileInput & WaitingTileInput = { ...busyClaude("b1"), kind: "agent-run", status: "error" };
  const exited: StackTileInput & WaitingTileInput = { ...idleShell("b2"), status: "done", exitCode: 0 };
  const quietShell: StackTileInput & WaitingTileInput = {
    ...idleShell("b3"),
    lastOutputAt: NOW - 11 * 60_000,
    readiness: { lastOutputAt: NOW - 11 * 60_000, matcherIdle: false, leftReadyAt: NOW - 12 * 60_000 },
  };
  const [b] = workspaceStack(
    input({ workspaces: WS, activeId: "a", tiles: { b: [failed, exited, quietShell] } }),
  );
  assert.deepEqual(b.items.map((i) => [i.key, i.words]), [["tile-b3", "no output for a while"]]);
});

// Owner (2026-10-19): a shell says shell words — its row too.
test("a busy shell's item says running, an agent's working", () => {
  const busyShell: StackTileInput & WaitingTileInput = {
    ...idleShell("b1"),
    lastOutputAt: NOW - 500,
    readiness: { lastOutputAt: NOW - 500, matcherIdle: false, leftReadyAt: NOW - 60_000 },
  };
  const [b] = workspaceStack(
    input({ workspaces: WS, activeId: "a", tiles: { b: [busyShell, busyClaude("b2")] } }),
  );
  assert.deepEqual(b.items.map((i) => [i.key, i.state, i.words, i.shell]), [
    ["tile-b1", "working", "running", true],
    ["tile-b2", "working", "working", undefined],
  ]);
  // The row counts the shell as running, not working (Windows walk,
  // 2026-10-20: "ghpr, 2 need you, 1 working" with only a busy shell).
  assert.equal(b.working, 1);
  assert.equal(b.running, 1);
  assert.deepEqual(stackSummary(b).map((p) => p.text), ["1 working", "1 running"]);
  const [shellOnly] = workspaceStack(input({ workspaces: WS, activeId: "a", tiles: { b: [busyShell] } }));
  assert.deepEqual(stackSummary(shellOnly).map((p) => [p.text, p.dot]), [["1 running", "running"]]);
  assert.equal(itemStateWord(shellOnly, shellOnly.items[0]), null);
});

test("the cap: five, then 'N more active'; shown in full on request", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, name: `w${i}`, lastOpenedAt: i }));
  const tiles: Record<string, (StackTileInput & WaitingTileInput)[]> = {};
  for (const w of many) tiles[w.id] = [busyClaude(`${w.id}-t`)];
  const stack = workspaceStack(input({ workspaces: many, activeId: null, tiles }));
  assert.equal(stack.length, 8);
  const capped = capStack(stack, false);
  assert.equal(capped.visible.length, STACK_CAP);
  assert.equal(capped.hidden, 3);
  assert.deepEqual(capStack(stack, true), { visible: stack, hidden: 0 });
  assert.equal(capStack(stack.slice(0, 5), false).hidden, 0);
});

test("the row's words: the app's own — needs you, failed, working", () => {
  assert.deepEqual(stackSummary({ needsYou: 1, failed: 0, working: 2 }), [
    { state: "needs-you", text: "1 needs you", dot: "done" },
    { state: "working", text: "2 working", dot: "running" },
  ]);
  assert.deepEqual(stackSummary({ needsYou: 3, failed: 2, working: 0 }), [
    { state: "needs-you", text: "3 need you", dot: "done" },
    { state: "failed", text: "2 failed", dot: "aborted" },
  ]);
  assert.equal(idleWorkspacesLabel(1), "1 more workspace");
  assert.equal(idleWorkspacesLabel(4), "4 more workspaces");
});

test("an item's own state word only when its row mixes states", () => {
  assert.equal(itemStateWord({ needsYou: 2, failed: 0, working: 0 }, { state: "needs-you" }), null);
  assert.equal(itemStateWord({ needsYou: 1, failed: 0, working: 1 }, { state: "needs-you" }), "needs you");
  assert.equal(itemStateWord({ needsYou: 1, failed: 0, working: 1 }, { state: "working" }), "working");
  // A shell tile says "running" itself: no "working" beside it.
  assert.equal(itemStateWord({ needsYou: 1, failed: 0, working: 1 }, { state: "working", shell: true }), null);
});

test("a card is listed once: its waiting Builder, not also its Needs you row", () => {
  const cards = { b: { cards: [{ id: "k1", title: "rollback", builder: { ptyId: "p1" } }] } };
  const waiting = [
    { id: "builder:k1", workspaceId: "b", agent: "Claude" as const, where: "rollback", since: NOW - 60_000, target: { kind: "card" as const, cardId: "k1" } },
  ];
  const events = [event({ id: "n1", workspaceId: "b", cardId: "k1", title: "rollback" })];
  const [b] = workspaceStack(input({ workspaces: WS, activeId: "a", cardsByWorkspace: cards, waiting, events }));
  assert.deepEqual(b.items.map((i) => i.key), ["builder:k1"]);
  assert.equal(b.needsYou, 1);
});

test("(P-A, Reviewer) an item says what the Inbox row says: the card's words, the trust question", () => {
  const cards = { b: { cards: [{ id: "k1", title: "rollback", builder: { ptyId: "p1" } }] } };
  const waiting = [
    {
      id: "builder:k1",
      workspaceId: "b",
      agent: "Claude" as const,
      where: "rollback",
      since: NOW - 60_000,
      target: { kind: "card" as const, cardId: "k1" },
      question: "trust" as const,
    },
  ];
  const events = [
    {
      ...event({ id: "card:ship-failed:k2:1", workspaceId: "c", cardId: "k2", title: "ship it" }),
      presented: { detail: "Ship didn't go through", action: "Open card" },
    },
  ];
  const stack = workspaceStack(input({ workspaces: WS, activeId: "a", cardsByWorkspace: cards, waiting, events }));
  const words = stack.flatMap((w) => w.items.map((i) => i.words));
  assert.ok(words.includes("Claude asks to trust the folder"), JSON.stringify(words));
  assert.ok(words.includes("Ship didn't go through"), JSON.stringify(words));
});

test("recency is this session's last active time, then lastOpenedAt", () => {
  const tiles = { b: [busyClaude("b1")], c: [busyClaude("c1")], d: [busyClaude("d1")] };
  const base = workspaceStack(input({ workspaces: WS, activeId: "a", tiles }));
  assert.deepEqual(base.map((e) => e.workspaceId), ["b", "c", "d"]);
  const touched = workspaceStack(input({ workspaces: WS, activeId: "a", tiles, lastActiveAt: { d: NOW } }));
  assert.deepEqual(touched.map((e) => e.workspaceId), ["d", "b", "c"]);
});

test("rows hold their places while a new order settles; new and gone rows at once", () => {
  let h = holdOrder(EMPTY_ORDER, ["b", "c"], 0);
  assert.deepEqual(h.shown, ["b", "c"]);
  // c jumps ahead: held for REORDER_HOLD_MS.
  h = holdOrder(h, ["c", "b"], 1_000);
  assert.deepEqual(h.shown, ["b", "c"]);
  h = holdOrder(h, ["c", "b"], 1_000 + REORDER_HOLD_MS - 1);
  assert.deepEqual(h.shown, ["b", "c"]);
  h = holdOrder(h, ["c", "b"], 1_000 + REORDER_HOLD_MS);
  assert.deepEqual(h.shown, ["c", "b"]);
  // A flicker back and forth never moves them.
  h = holdOrder(h, ["b", "c"], 10_000);
  h = holdOrder(h, ["c", "b"], 11_000);
  h = holdOrder(h, ["b", "c"], 12_000);
  h = holdOrder(h, ["c", "b"], 13_000);
  assert.deepEqual(h.shown, ["c", "b"]);
  // A new row takes its place at once; a gone one leaves at once.
  h = holdOrder(h, ["d", "c", "b"], 14_000);
  assert.deepEqual(h.shown, ["d", "c", "b"]);
  h = holdOrder(h, ["d", "b"], 15_000);
  assert.deepEqual(h.shown, ["d", "b"]);
});

test("recent: this session's active ones, most recent first; never the current one, never one with a state", () => {
  const recent = recentWorkspaces({
    workspaces: WS,
    activeId: "a",
    // alpha is current; epsilon was opened at an earlier launch only.
    lastActiveAt: { a: NOW, b: NOW - 3_000, c: NOW - 1_000, d: NOW - 2_000 },
    exclude: new Set(["d"]),
  });
  assert.deepEqual(recent, [
    { workspaceId: "c", name: "gamma" },
    { workspaceId: "b", name: "beta" },
  ]);
  // Nothing active yet this session: nothing recent, whatever lastOpenedAt says.
  assert.deepEqual(
    recentWorkspaces({ workspaces: WS, activeId: "a", exclude: new Set() }),
    [],
  );
});

test("one cap: stateful rows win the slots, recent ones fill the rest", () => {
  const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  // 2 with a state + 4 recent: 2 + 3 shown, one recent left to "N more".
  assert.deepEqual(stackSlots(ids(2, "s"), ids(4, "r"), false), {
    wanted: ["s0", "s1", "r0", "r1", "r2"],
    hiddenActive: 0,
    recentShown: 3,
  });
  // Five with a state: no room for recent.
  assert.deepEqual(stackSlots(ids(5, "s"), ids(2, "r"), false), {
    wanted: ids(5, "s"),
    hiddenActive: 0,
    recentShown: 0,
  });
  // Seven with a state: five and "2 more active"; shown in full, still none recent.
  assert.equal(stackSlots(ids(7, "s"), ids(2, "r"), false).hiddenActive, 2);
  assert.deepEqual(stackSlots(ids(7, "s"), ids(2, "r"), true), {
    wanted: ids(7, "s"),
    hiddenActive: 0,
    recentShown: 0,
  });
  // Only recent ones: five of them.
  assert.equal(stackSlots([], ids(6, "r"), false).recentShown, STACK_CAP);
});

test("a recent row that starts working moves into the stateful group once the order holds", () => {
  const lastActiveAt = { b: NOW - 1_000, c: NOW - 2_000, d: NOW - 3_000 };
  const wantedFor = (tiles: Record<string, (StackTileInput & WaitingTileInput)[]>) => {
    const stack = workspaceStack(input({ workspaces: WS, activeId: "a", tiles, lastActiveAt }));
    const recent = recentWorkspaces({
      workspaces: WS,
      activeId: "a",
      lastActiveAt,
      exclude: new Set(stack.map((e) => e.workspaceId)),
    });
    return { stack, slots: stackSlots(stack.map((e) => e.workspaceId), recent.map((r) => r.workspaceId), false) };
  };
  const before = wantedFor({ d: [quietClaude("d1")] });
  assert.deepEqual(before.slots.wanted, ["d", "b", "c"]);
  let h = holdOrder(EMPTY_ORDER, before.slots.wanted, 0);
  // gamma starts working: it joins the stateful group, after delta (needs you).
  const after = wantedFor({ d: [quietClaude("d1")], c: [busyClaude("c1")] });
  assert.deepEqual(after.stack.map((e) => e.workspaceId), ["d", "c"]);
  assert.deepEqual(after.slots.wanted, ["d", "c", "b"]);
  h = holdOrder(h, after.slots.wanted, 1_000);
  assert.deepEqual(h.shown, ["d", "b", "c"]); // stays put a while…
  h = holdOrder(h, after.slots.wanted, 1_000 + REORDER_HOLD_MS);
  assert.deepEqual(h.shown, ["d", "c", "b"]); // …then moves up.
});

test("UX P-A Mac walk 5: a feed row of a loaded card has its card's dot, as the Inbox row does", () => {
  const stack = workspaceStack(
    input({
      workspaces: WS.slice(0, 2),
      activeId: "a",
      events: [
        event({ id: "conflict:k1:r1", workspaceId: "b", cardId: "k1", title: "Conflicted", detail: "ship stopped on a conflict" }),
        event({ id: "review:k2:manual", workspaceId: "b", cardId: "k2", title: "Cold one" }),
      ],
      presentOf: (ws, cardId) =>
        ws === "b" && cardId === "k1"
          ? { rule: "ship-conflict", headline: "Ship stopped on a conflict", dot: { state: "aborted", live: false } }
          : null,
    }),
  );
  const items = stack[0].items;
  const conflict = items.find((i) => i.key === "event:conflict:k1:r1")!;
  assert.equal(conflict.dot, "aborted");
  assert.equal(conflict.words, "Ship stopped on a conflict");
  // A card this window has not loaded keeps its state's dot.
  assert.equal(items.find((i) => i.key === "event:review:k2:manual")!.dot, undefined);
});

test("UX P-A Windows walk 2: one item per card — its Inbox row, not also its Builder session as working", () => {
  const cards = { b: { cards: [{ id: "k1", title: "Walk: README line", builder: { ptyId: "p1" } }] } };
  const events = [
    {
      ...event({ id: "review:k1:r1", workspaceId: "b", cardId: "k1", title: "Walk: README line" }),
      presented: { detail: "Ready to ship · no checks set up", action: "Ship it" },
    },
  ];
  const [b] = workspaceStack(input({ workspaces: WS, activeId: "a", cardsByWorkspace: cards, events }));
  assert.deepEqual(
    b.items.map((i) => [i.state, i.words]),
    [["needs-you", "Ready to ship · no checks set up"]],
  );
  assert.deepEqual([b.needsYou, b.working], [1, 0]);
});

test("UX P-A Windows walk 3: a summary's dot is its worst item's — the trust question is amber", () => {
  const cards = { b: { cards: [{ id: "k1", title: "Add a line", builder: { ptyId: "p1" } }] } };
  const trust = (present: boolean) =>
    workspaceStack(
      input({
        workspaces: WS.slice(0, 2),
        activeId: "a",
        cardsByWorkspace: cards,
        waiting: [
          {
            id: "builder:k1",
            workspaceId: "b",
            agent: "Claude" as const,
            where: "Add a line",
            since: NOW - 60_000,
            target: { kind: "card" as const, cardId: "k1" },
            question: "trust" as const,
          },
        ],
        ...(present
          ? {
              presentOf: () => ({
                rule: "session-block" as const,
                headline: "Asks to trust the folder",
                dot: { state: "aborted" as const, live: false },
              }),
            }
          : {}),
      }),
    )[0];
  for (const present of [true, false]) {
    const b = trust(present);
    assert.equal(b.items[0].dot, "aborted", `presented: ${present}`);
    assert.deepEqual(stackSummary(b), [{ state: "needs-you", text: "1 needs you", dot: "aborted" }]);
  }
  // A green item beside it does not make the summary green.
  const mixed = stackSummary({
    needsYou: 2,
    failed: 0,
    working: 0,
    items: [
      { key: "x", name: "x", state: "needs-you", words: "", target: { kind: "card", cardId: "x" } },
      { key: "y", name: "y", state: "needs-you", words: "", target: { kind: "card", cardId: "y" }, dot: "aborted" },
    ],
  });
  assert.equal(mixed[0].dot, "aborted");
});

// QoL 1.168 (block 10, A8): two chips and "+N", never a third cut mid-word.
test("the row shows at most two chips and +N for the rest", () => {
  const three = stackSummary({ needsYou: 1, failed: 1, working: 1, running: 1, items: [] });
  assert.equal(three.length, 4);
  const capped = capStackSummary(three);
  assert.deepEqual(capped.shown.map((p) => p.text), ["1 needs you", "1 failed"]);
  assert.equal(capped.more, 2);
  const two = capStackSummary(stackSummary({ needsYou: 0, failed: 0, working: 2, running: 1, items: [] }));
  assert.deepEqual([two.shown.length, two.more], [2, 0]);
});

console.log(`workspaceStack: ${passed}/25 passed`);
