// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/sessionRows.test.ts
import assert from "node:assert/strict";
import {
  cardSessionLinks,
  terminalsEmptyWords,
  capSessionRows,
  SESSION_ROW_CAP,
  sessionRows,
  terminalsCount,
  type SessionCardInput,
  type SessionTileInput,
} from "./sessionRows.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

const NOW = 1_000_000_000;
// At its prompt, as Terminal's scans leave an idle shell: the header reads
// Ready.
const shell: SessionTileInput = {
  id: "t-shell",
  kind: "shell",
  label: "zsh",
  status: "running",
  startedAt: NOW - 60_000,
  readiness: { lastOutputAt: NOW - 30_000, matcherIdle: true, leftReadyAt: NOW - 60_000 },
};
// Working: output just now, the prompt matcher busy.
const claude: SessionTileInput = {
  id: "t-claude",
  kind: "claude",
  label: "claude",
  status: "running",
  startedAt: NOW - 60_000,
  readiness: { lastOutputAt: NOW - 500, matcherIdle: false, leftReadyAt: NOW - 60_000 },
};
const builder88: SessionCardInput = {
  id: "c-88",
  title: "rollback tests",
  ghIssueNumber: 88,
  builder: { ptyId: "pty-88" },
};
const builder87: SessionCardInput = {
  id: "c-87",
  title: "deploy notes",
  ghIssueNumber: 87,
  builder: { ptyId: "pty-87" },
};

test("nothing live → no rows", () => {
  const rows = sessionRows([], [
    { id: "c", title: "idle", builder: null },
    { id: "d", title: "lost", builder: { ptyId: null } },
  ]);
  assert.deepEqual(rows, []);
  assert.deepEqual(capSessionRows(rows, false), { visible: [], hidden: 0 });
});

test("kinds, names, dots and click targets", () => {
  const rows = sessionRows([shell, claude], [builder88, builder87], NOW);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.name, r.dot, r.plainShell]),
    [
      ["builder", "Card #88 · rollback tests", "running", false],
      ["builder", "Card #87 · deploy notes", "running", false],
      ["tile", "zsh", "empty", true],
      ["tile", "claude", "running", false],
    ],
  );
  assert.deepEqual(rows[0].target, { kind: "card", cardId: "c-88" });
  assert.deepEqual(rows[2].target, {
    kind: "terminals",
    tileId: "t-shell",
  });
  assert.equal(new Set(rows.map((r) => r.key)).size, 4);
});

test("a local card without an issue number", () => {
  const rows = sessionRows([], [
    { id: "c", title: "draft", builder: { ptyId: "p" } },
  ]);
  assert.equal(rows[0].name, "Card · draft");
});

// GH #293: the row reads what the tile header reads (`tileStatusLine`).
test("tile states follow the header", () => {
  const row = (kind: string, status: string) =>
    sessionRows([{ id: "t", kind, label: "x", status, startedAt: NOW }], [], NOW)[0];
  const dot = (kind: string, status: string) => row(kind, status).dot;
  assert.equal(dot("claude", "pending"), "empty");
  assert.equal(dot("codex", "done"), "empty", "Exited, as the header says");
  assert.equal(dot("agent-run", "done"), "done");
  assert.equal(dot("agent-run", "killed"), "empty", "Ended by Plyloft");
  // QoL 1.168 (block 10, A6): a real crash (no exit code; Claude or Codex
  // ending abnormally) is the filled red; a shell's error keeps the ring.
  assert.equal(dot("claude", "crashed"), "crashed");
  assert.equal(dot("shell", "error"), "error");
  const exited = (kind: string, exitCode: number | null) =>
    sessionRows([{ id: "t", kind, label: "x", status: "crashed", exitCode, startedAt: NOW }], [], NOW)[0].dot;
  assert.equal(exited("shell", 1), "error", "a shell's ordinary non-zero exit");
  assert.equal(exited("shell", null), "crashed", "stopped with no code");
  assert.equal(exited("codex", 1), "crashed", "a session ending abnormally");
  assert.equal(exited("claude", 130), "empty", "Ctrl-C is calm");
  assert.equal(dot("shell", "done"), "empty");
  assert.equal(dot("shell", "pending"), "empty");
  assert.equal(row("claude", "crashed").state, "stopped unexpectedly");
  // QoL 1.168 (block 10 Mac walk): the row says its header's words.
  assert.equal(row("shell", "error").state, "errored after 0s");
  const said = (kind: string, exitCode: number | null) =>
    sessionRows([{ id: "t", kind, label: "x", status: "crashed", exitCode, startedAt: NOW }], [], NOW)[0].state;
  assert.equal(said("shell", 1), "ended · error code 1");
  assert.equal(said("claude", 1), "stopped unexpectedly", "a kill -9 of Claude reads as code 1");
  assert.equal(said("codex", null), "stopped unexpectedly");
});

test("a Ready session is not running; a silent one is amber", () => {
  const at = (tile: Partial<SessionTileInput>) =>
    sessionRows([{ id: "t", kind: "claude", label: "claude 1", status: "running", startedAt: NOW - 60 * 60_000, ...tile }], [], NOW)[0];
  const ready = at({
    readiness: { lastOutputAt: NOW - 5_000, matcherIdle: true, leftReadyAt: NOW - 60 * 60_000 },
  });
  assert.equal(ready.dot, "empty");
  // 1.171.0 C2 (CF8): an AI at its prompt is the person's turn.
  assert.equal(ready.state, "your turn");
  const chatIdle = at({ kind: "codex-chat", sessionBusy: false });
  assert.equal(chatIdle.dot, "empty");
  const chatBusy = at({ kind: "codex-chat", sessionBusy: true, sessionTurnStartedAt: NOW - 1_000 });
  assert.equal(chatBusy.dot, "running");
  const quiet = at({
    kind: "shell",
    readiness: { lastOutputAt: NOW - 11 * 60_000, matcherIdle: false, leftReadyAt: NOW - 20 * 60_000 },
  });
  assert.equal(quiet.dot, "error");
  assert.equal(quiet.state, "no output for a while");
  assert.equal(at({ readiness: claude.readiness }).dot, "running");
});

// Owner (2026-10-19): a shell says shell words — "running" in its row
// (tooltip, accessible name), never an agent's "working".
test("a busy shell's row says running; Claude and Codex keep working", () => {
  const busy = { lastOutputAt: NOW - 500, matcherIdle: false, leftReadyAt: NOW - 60_000 };
  const row = (kind: string) =>
    sessionRows([{ id: "t", kind, label: "x", status: "running", startedAt: NOW - 60_000, readiness: busy, lastOutputAt: NOW - 500 }], [], NOW)[0];
  assert.equal(row("shell").state, "running");
  assert.equal(row("shell").spokenState, "running");
  assert.equal(row("shell").dot, "running");
  assert.equal(row("claude").state, "working");
  assert.equal(row("codex").state, "working");
  const ready = sessionRows([{ id: "t", kind: "shell", label: "x", status: "running", startedAt: NOW - 60_000, readiness: { ...busy, matcherIdle: true, lastOutputAt: NOW - 5_000 } }], [], NOW)[0];
  assert.equal(ready.state, "ready");
});

test("more than 8 collapse to the first 8 and +N more", () => {
  const tiles = Array.from({ length: 11 }, (_, i) => ({
    id: `t${i}`,
    kind: "claude",
    label: `claude ${i}`,
    status: "running",
  }));
  const rows = sessionRows(tiles, [builder88]);
  const view = capSessionRows(rows, false);
  assert.equal(SESSION_ROW_CAP, 8);
  assert.equal(view.visible.length, 8);
  assert.equal(view.visible[0].kind, "builder");
  assert.equal(view.visible[7].name, "claude 6");
  assert.equal(view.hidden, 4);
  // Expanding shows every session, and only in the sidebar: each row keeps
  // its own target.
  const all = capSessionRows(rows, true);
  assert.equal(all.visible.length, 12);
  assert.equal(all.hidden, 0);
});

// GH #95 (review 2): a Builder session lives in its card, not the tile grid,
// so the overflow must keep every hidden Builder reachable by its own target.
test("builder-only overflow expands to reachable rows", () => {
  const cards = Array.from({ length: 9 }, (_, i) => ({
    id: `c-${i}`,
    title: `card ${i}`,
    ghIssueNumber: 80 + i,
    builder: { ptyId: `pty-${i}` },
  }));
  const rows = sessionRows([], cards);
  const collapsed = capSessionRows(rows, false);
  assert.equal(collapsed.visible.length, 8);
  assert.equal(collapsed.hidden, 1);
  const expanded = capSessionRows(rows, true);
  assert.equal(expanded.visible.length, 9);
  assert.deepEqual(expanded.visible[8].target, {
    kind: "card",
    cardId: "c-8",
  });
  assert.equal(
    expanded.visible.every((r) => r.target.kind === "card"),
    true,
  );
});

test("exactly 8 → no +N more", () => {
  const tiles = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`,
    kind: "shell",
    label: `zsh ${i}`,
    status: "running",
  }));
  const view = capSessionRows(sessionRows(tiles, []), false);
  assert.equal(view.visible.length, 8);
  assert.equal(view.hidden, 0);
});

test("GH #117: the Terminals count is the rows listed under it", () => {
  // One tile and two live Builder sessions: three rows, so `Terminals 3`.
  const cards: SessionCardInput[] = [
    { id: "c-1", title: "One", builder: { ptyId: "p-1" } },
    { id: "c-2", title: "Two", ghIssueNumber: 117, builder: { ptyId: "p-2" } },
    { id: "c-3", title: "No session", builder: null },
  ];
  const rows = sessionRows([shell], cards);
  assert.equal(rows.length, 3);
  assert.equal(terminalsCount(rows), rows.length);
  // A finished tile is still listed, so it is still counted.
  const doneTile = { ...claude, status: "done" };
  const withDone = sessionRows([shell, doneTile], [cards[0]]);
  assert.equal(terminalsCount(withDone), 3);
  assert.equal(terminalsCount(sessionRows([], [])), 0);
});

// CL-7: a Builder row says who is working, from the live runtime.
test("a Builder row names its vendor and what its session is doing", () => {
  const card: SessionCardInput = {
    id: "c-88",
    title: "rollback tests",
    ghIssueNumber: 88,
    lastRunStatus: "running",
    builder: { ptyId: "pty-88", vendor: "claude", startedAt: NOW - 30 * 60_000, snapshots: [] },
  };
  const rt = { ptyId: "pty-88", vendor: "claude" as const, startedAt: NOW - 30 * 60_000 };
  const busy = sessionRows([], [card], NOW, {
    byKey: { "c-88": { ...rt, lastOutputAt: NOW - 500 } },
    submittedAt: { "c-88": NOW - 4 * 60_000 },
  })[0];
  assert.equal(busy.name, "Card #88 · rollback tests");
  assert.equal(busy.state, "Claude · working · 4m");
  assert.equal(busy.spokenState, "Claude · working");
  assert.equal(busy.dot, "running");
  const idle = sessionRows([], [card], NOW, {
    byKey: { "c-88": { ...rt, lastOutputAt: NOW - 60_000, promptBoxIdle: true, turnIdle: true } },
  })[0];
  assert.equal(idle.state, "Claude · your turn");
  assert.equal(idle.dot, "done");
  // P-B: a Builder waiting on the person says the card's word (rule 9),
  // held as the card holds it — even while its output says building.
  const held = (headline: string) =>
    sessionRows([], [card], NOW, {
      byKey: { "c-88": { ...rt, lastOutputAt: NOW - 500 } },
      presentOf: () => ({
        rule: "builder-waiting",
        headline,
        // (Challenger) decided on the state, never on the headline's words.
        waiting: headline === "Builder stopped" ? "stopped" : headline === "Needs your answer" ? "question" : "quiet",
        dot: { state: headline === "Builder stopped" ? "done" : "aborted", live: false },
      }),
    })[0];
  assert.deepEqual([held("Builder stopped").state, held("Builder stopped").dot, held("Builder stopped").rule], ["Claude · your turn", "done", "builder-waiting"]);
  assert.deepEqual([held("Needs your answer").state, held("Needs your answer").dot], ["Claude · asks you something", "error"]);
  assert.equal(held("Maybe waiting for you").state, "Claude · your turn");
  // Not attached here: only what is known.
  assert.equal(sessionRows([], [card], NOW)[0].state, "Claude · session open");
  assert.equal(sessionRows([], [builder88], NOW)[0].state, "session open");
  // The Challenger reviewing.
  const reviewing = sessionRows([], [{
    ...card,
    builder: { ...card.builder, review: { snapshotN: 1, provider: "codex", degraded: false, status: "running", at: NOW - 2 * 60_000 } },
  }], NOW)[0];
  assert.equal(reviewing.state, "Codex · reviewing · 2m");
  // Plyloft's checks.
  assert.equal(sessionRows([], [{ ...card, verifyStatus: "running" }], NOW)[0].state, "Running checks");
});

test("Build with both lists each build's session, named by its vendor", () => {
  const card: SessionCardInput = {
    id: "c-9",
    title: "both",
    ghIssueNumber: 9,
    builder: null,
    buildBoth: {
      startedAt: NOW - 10 * 60_000,
      lanes: [
        { lane: "a", vendor: "claude", worktreePath: "/a", branchName: "a", ptyId: "pa", startedAt: NOW - 10 * 60_000 },
        { lane: "b", vendor: "codex", worktreePath: "/b", branchName: "b", ptyId: "pb", startedAt: NOW - 10 * 60_000 },
      ],
    },
  };
  const rows = sessionRows([], [card], NOW, {
    byKey: {
      "c-9#both-a": { ptyId: "pa", vendor: "claude", startedAt: NOW - 10 * 60_000, lastOutputAt: NOW },
      "c-9#both-b": { ptyId: "pb", vendor: "codex", startedAt: NOW - 10 * 60_000, lastOutputAt: NOW - 60_000, promptBoxIdle: true, turnIdle: true },
    },
  });
  assert.deepEqual(
    rows.map((r) => [r.name, r.state, r.lane, r.target]),
    [
      ["Card #9 · both · Claude's build", "Claude · working · 10m", "a", { kind: "card", cardId: "c-9" }],
      ["Card #9 · both · Codex's build", "Codex · your turn", "b", { kind: "card", cardId: "c-9" }],
    ],
  );
  // Picked: the card's own Builder only.
  assert.equal(sessionRows([], [{ ...card, buildBoth: { ...card.buildBoth!, outcome: { kind: "picked", at: NOW } } }], NOW).length, 0);
});

// SP-7: the empty Terminals page names the card sessions and where they are.
// Windows parity walk: "Its 2 card sessions" over one link — one link per
// session now, each build of a card built by both with its lane.
test("the empty Terminals page names its card sessions, one link per session", () => {
  const both: SessionCardInput = {
    id: "c-9",
    title: "both",
    ghIssueNumber: 9,
    builder: null,
    buildBoth: {
      startedAt: NOW,
      lanes: [
        { lane: "a", vendor: "claude", worktreePath: "/a", branchName: "a", ptyId: "pa", startedAt: NOW },
        { lane: "b", vendor: "codex", worktreePath: "/b", branchName: "b", ptyId: "pb", startedAt: NOW },
      ],
    },
  };
  const one: SessionCardInput = { id: "c-1", title: "Fix login", builder: { ptyId: "p1", vendor: "claude", startedAt: NOW } };
  const idle: SessionCardInput = { id: "c-2", title: "Not started", builder: null };
  assert.deepEqual(cardSessionLinks([both, one, idle]), [
    { key: "builder-c-9#both-a", cardId: "c-9", lane: "a", name: "Card #9 · both · Claude's build" },
    { key: "builder-c-9#both-b", cardId: "c-9", lane: "b", name: "Card #9 · both · Codex's build" },
    { key: "builder-c-1", cardId: "c-1", name: "Card · Fix login" },
  ]);
  assert.deepEqual(cardSessionLinks([idle]), []);
  // 1.174.0 E7 (G16): no project name (the breadcrumb has it), no "Start one here".
  assert.equal(terminalsEmptyWords(3), "No sessions of your own here yet. 3 card sessions open on their cards.");
  assert.equal(terminalsEmptyWords(1), "No sessions of your own here yet. 1 card session opens on its card.");
  assert.equal(terminalsEmptyWords(0), "No sessions here yet.");
});

test("UX P-A Mac walk 4: a card that outranks its session says the card's words, with its dot", () => {
  const card: SessionCardInput = {
    id: "c-3",
    title: "Ship me",
    lastRunStatus: "success",
    builder: { ptyId: "p3", vendor: "claude", startedAt: NOW - 60_000, snapshots: [{ n: 1, sha: "a", at: NOW - 30_000 } as never] },
  };
  // Build done went through and the session is idle: its own words would be
  // "Claude · build done" — the card is stopped on a ship conflict.
  const live = {
    byKey: { "c-3": { ptyId: "p3", vendor: "claude" as const, startedAt: NOW - 60_000, lastOutputAt: NOW - 50_000, promptBoxIdle: true, turnIdle: true } },
    presentOf: () => ({ rule: "ship-conflict" as const, headline: "Ship stopped on a conflict", dot: { state: "aborted" as const, live: false } }),
  };
  const [row] = sessionRows([], [card], NOW, live);
  assert.equal(row.state, "Claude · ship stopped on a conflict");
  assert.equal(row.dot, "error");
  assert.equal(row.rule, "ship-conflict");
  // The trust question: the card's words and its amber dot.
  const [trust] = sessionRows([], [card], NOW, {
    ...live,
    presentOf: () => ({ rule: "session-block" as const, headline: "Asks to trust the folder", dot: { state: "aborted" as const, live: false } }),
  });
  assert.equal(trust.state, "Claude · asks to trust the folder");
  assert.equal(trust.dot, "error");
  // A rule that does not outrank the session: the session speaks.
  const [plain] = sessionRows([], [card], NOW, {
    ...live,
    presentOf: () => ({ rule: "base" as const, headline: "Ready to ship", dot: { state: "done" as const, live: false } }),
  });
  assert.equal(plain.state, "Claude · your turn");
});

test("TI-2: a card's Try session is listed with the card's sessions", () => {
  const tryOf = (id: string, cardId: string): SessionTileInput => ({
    ...shell,
    id,
    label: `Try · ${cardId}`,
    tryOf: { cardId },
  });
  const rows = sessionRows(
    [shell, tryOf("t-try-87", "c-87"), tryOf("t-try-1", "c-none"), claude],
    [builder88, builder87],
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => [r.key, r.plainShell]),
    [
      ["builder-c-88", false],
      ["builder-c-87", false],
      ["tile-t-try-87", false],
      // A card with no live Builder: after the Builders, before other tiles.
      ["tile-t-try-1", false],
      ["tile-t-shell", true],
      ["tile-t-claude", false],
    ],
  );
  assert.deepEqual(rows[2].target, { kind: "terminals", tileId: "t-try-87" });
  // Without Try sessions the order is what it was.
  assert.deepEqual(
    sessionRows([shell, claude], [builder88], NOW).map((r) => r.key),
    ["builder-c-88", "tile-t-shell", "tile-t-claude"],
  );
});

// Challenger round 1: a waiting tile's row has its own short words after
// "Claude · " and the Inbox's filled amber, never a failure's ring.
test("a tile that waits on the member says what for, with the amber dot", () => {
  const asking = (question: SessionTileInput["question"], kind: "claude" | "codex" = "claude", resetsAt?: string) =>
    sessionRows([{ ...claude, kind, question, questionResetsAt: resetsAt ?? null }], [], NOW)[0];
  assert.deepEqual([asking("decision").state, asking("decision").dot], ["Claude · asks you something", "warn"]);
  assert.equal(asking("trust", "codex").state, "Codex · asks to trust the folder");
  assert.equal(asking("usageLimit", "claude", "6pm").state, "Claude · paused · your plan's limit resets at 6pm");
  assert.equal(asking("bypass").state, "Claude · asks to work without asking");
});

// QoL 1.168 (D7, terminals S2-5): those words are drawn on the row, not only
// in its tooltip; a working or plain tile keeps one line.
test("a waiting tile's row draws its words as a second line", () => {
  const row = sessionRows([{ ...claude, question: "usageLimit", questionResetsAt: "6pm" }], [], NOW)[0];
  assert.equal(row.stateLine, true);
  assert.equal(sessionRows([shell], [], NOW)[0].stateLine, undefined);
  assert.equal(sessionRows([{ ...claude, question: null }], [], NOW)[0].stateLine === true, false);
});

console.log(`sessionRows: ${passed}/17 passed`);
