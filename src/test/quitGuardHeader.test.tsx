// 1.169.0 Windows walk (step 7): after a relaunch, Inbox › Reopen resumed a
// Claude conversation (no prompt sent). Its header said Ready, but the quit
// asked "1 session is working": the guard read the 10 s output clock, which
// the resumed conversation's repaint had just restarted. The guard now reads
// what the header reads. Replayed from Claude Code's own ConPTY stream.
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import fixture from "./fixtures/claudeConptyIdle.json";
import { visibleScreen } from "../lib/screenChange";
import { FRESH_SCAN_MEMORY, foldScan, nextReadiness, readinessProbe, type Readiness, type ScanMemory } from "../lib/tileHeaderStatus";
import { tileStatusLine } from "../lib/tileStatusLine";
import { sessionQuitState, tileWorkingNow, workingNow } from "../store/quitGuardStore";
import { quitSheetWords, busyForUpdate } from "../lib/quitGuard";
import { NOTHING_RUNNING } from "../lib/closeChoice";
import { updateConfirmBody } from "../lib/updateWords";
import { idleBlocker } from "../lib/updateIdle";
import { isBuilderObserved, pollSessionBlocks, setBuilderObserved, useBuilder } from "../store/builderStore";
import { answerQuit, confirmQuit, offScreenWorkingWhy, peekQuitAsks, quitAsksNow, registerQuitHost, useQuitGuard } from "../store/quitGuardStore";
import { OFF_SCREEN_WORKING_MS } from "../lib/builderScreenState";
import type { BuilderSessionScreen } from "../lib/builderScreensIpc";
import { idleFactsNow } from "../components/UpdatePrompt";
import type { KanbanCard } from "../ipc";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { tauri } from "./render";
import { useTiles, type Tile } from "../store/tileStore";
import { readFileSync } from "node:fs";
import { liveScreenFacts, registerTileScreen, type TileScreenNow } from "../lib/tileScreen";

type Chunk = { at: number; b64: string };
const chunks = (fixture as { chunks: Chunk[] }).chunks.map((c) => ({
  at: c.at,
  data: Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0)),
}));
const write = (term: Terminal, data: Uint8Array) => new Promise<void>((resolve) => term.write(data, resolve));

/** The resumed tile's readiness, as Terminal's scans fold it: the stream
 *  replayed (the resume draws the conversation and its prompt), scanned. */
async function resumedReadiness(startedAt: number): Promise<Readiness> {
  const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  let memory: ScanMemory = { ...FRESH_SCAN_MEMORY, activityAt: startedAt };
  let readiness: Readiness = { lastOutputAt: startedAt, matcherIdle: false, leftReadyAt: startedAt };
  for (const c of chunks.filter((c) => c.at < 20_000)) await write(term, c.data);
  for (const [at, sawData] of [
    [startedAt + 20_000, true],
    [startedAt + 23_000, false],
  ] as const) {
    const probe = readinessProbe("claude", visibleScreen(term.buffer.active, term.rows).split("\n"));
    memory = foldScan(memory, { ...probe, sawData, dataAt: at, rebaselining: false, screen: true, now: at });
    readiness = nextReadiness("claude", readiness, { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null }, at);
  }
  term.dispose();
  return readiness;
}

afterEach(() => useTiles.setState({ byWorkspace: {} }));

describe("the quit guard reads the header's state", () => {
  it("a resumed Claude tile whose header says Ready is not working, however recent its output", async () => {
    const startedAt = Date.now() - 30_000;
    const readiness = await resumedReadiness(startedAt);
    const now = startedAt + 25_000;
    const tile = {
      kind: "claude",
      status: "running",
      startedAt,
      // The repaint a second ago (a focus change, the conversation drawn).
      lastOutputAt: now - 1_000,
      readiness,
    } as Tile;
    const header = tileStatusLine({ kind: "claude", status: "running", startedAt, readiness, lastOutputAt: tile.lastOutputAt, now });
    expect(header.text).toBe("Your turn");
    expect(tileWorkingNow(tile, now)).toBe(false);

    // Through the store, as the quit asks it.
    const t = useTiles.getState().addClaudeTile("w1", "/tmp/w1");
    useTiles.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        w1: { ...s.byWorkspace.w1!, tiles: s.byWorkspace.w1!.tiles.map((x) => (x.id === t.id ? { ...x, ...tile, id: x.id } : x)) },
      },
    }));
    expect(workingNow(now).sessions).toBe(0);
  });

  it("a tile mid-turn is working, as its header says", () => {
    const now = Date.now();
    const tile = {
      kind: "claude",
      status: "running",
      startedAt: now - 60_000,
      lastOutputAt: now - 20_000,
      readiness: { lastOutputAt: now - 20_000, matcherIdle: false, leftReadyAt: now - 30_000 },
    } as Tile;
    expect(tileStatusLine({ kind: "claude", status: "running", startedAt: tile.startedAt, readiness: tile.readiness, lastOutputAt: tile.lastOutputAt, now }).text).not.toBe("Your turn");
    // Quiet past the 10 s clock, still mid-turn by its screen: working.
    expect(tileWorkingNow(tile, now)).toBe(true);
    // A question on screen is the member's to answer: waiting, not working.
    expect(sessionQuitState({ ...tile, questionInView: true }, now)).toBe("waiting");
    expect(sessionQuitState({ ...tile, readiness: { ...tile.readiness!, waiting: true } }, now)).toBe("waiting");
    // Never scanned: the output clock, as before.
    expect(tileWorkingNow({ ...tile, readiness: undefined, lastOutputAt: now - 1_000 }, now)).toBe(true);
    expect(tileWorkingNow({ ...tile, readiness: undefined, lastOutputAt: now - 20_000 }, now)).toBe(false);
  });
});

// 1.177.1 (item 21, final Mac walk step 16): Cmd-Q 2 s after Claude's
// answer was drawn. The header was still in its 2 s quiet window ("Working ·
// 0s"); the live screen proves the turn over, so nothing would be lost. A
// turn running on screen, background work, no screen or no proof: working.
describe("the quit guard and a turn the live screen proves over", () => {
  const rowsOf = (name: string) =>
    readFileSync(`${process.cwd()}/src-tauri/src/compare_fixtures/screens/${name}`, "utf8").split(/^# ----\n/m)[1].replace(/\n$/, "").split("\n");
  const now = Date.now();
  const justAnswered = {
    id: "q1",
    kind: "claude",
    status: "running",
    startedAt: now - 60_000,
    lastOutputAt: now - 500,
    readiness: { lastOutputAt: now - 500, matcherIdle: true, leftReadyAt: now - 2_000 },
  } as Tile;
  const screenOf = (vendor: "claude" | "codex", rows: string[]): TileScreenNow => ({
    ...liveScreenFacts(vendor, rows, null),
    overlay: false,
    lastOutputAt: now - 500,
    lastInputAt: 0,
    holds: () => null,
  });
  it("Claude: the answer's done line over the idle box — not working, though the header is still in its quiet window", () => {
    const un = registerTileScreen("q1", () => screenOf("claude", rowsOf("claude-after-count-header-stale.txt")));
    try {
      expect(tileStatusLine({ kind: "claude", status: "running", startedAt: justAnswered.startedAt, readiness: justAnswered.readiness, lastOutputAt: justAnswered.lastOutputAt, now }).text).not.toBe("Your turn");
      expect(sessionQuitState(justAnswered, now)).toBe(null);
      // Only in the header's quiet window: a busy verdict stands (review round 3, L6).
      expect(sessionQuitState({ ...justAnswered, readiness: { ...justAnswered.readiness!, matcherIdle: false } }, now)).toBe("working");
      // …but background work in its footer, or a turn the readiness scan saw running, still counts.
      expect(sessionQuitState({ ...justAnswered, readiness: { ...justAnswered.readiness!, background: true } }, now)).toBe("working");
      expect(sessionQuitState({ ...justAnswered, readiness: { ...justAnswered.readiness!, running: true } }, now)).toBe("working");
    } finally {
      un();
    }
  });
  it("Claude working on screen, a question, or no screen read: working (or waiting)", () => {
    let un = registerTileScreen("q1", () => screenOf("claude", rowsOf("claude-working-named.txt")));
    expect(sessionQuitState(justAnswered, now)).toBe("working");
    un();
    un = registerTileScreen("q1", () => screenOf("claude", rowsOf("claude-model-picker-named.txt")));
    expect(sessionQuitState(justAnswered, now)).toBe("working");
    un();
    expect(sessionQuitState(justAnswered, now)).toBe("working");
  });
  it("Codex: its Worked-for line over the idle box proves it; a working or streaming screen never does", () => {
    const x = { ...justAnswered, id: "q2", kind: "codex" } as Tile;
    let un = registerTileScreen("q2", () => screenOf("codex", rowsOf("codex-18-rows-after-count.txt")));
    expect(sessionQuitState(x, now)).toBe(null);
    un();
    un = registerTileScreen("q2", () => screenOf("codex", rowsOf("codex-17-rows-working.txt")));
    expect(sessionQuitState(x, now)).toBe("working");
    un();
    // Idle under the /status card: no turn's end in view — no proof, the header decides.
    un = registerTileScreen("q2", () => screenOf("codex", rowsOf("codex-after-status.txt")));
    expect(sessionQuitState(x, now)).toBe("working");
    un();
  });
});

describe("quit guard, Reviewer", () => {
  const now = Date.now();
  const base = {
    kind: "claude",
    status: "running",
    startedAt: now - 60_000,
    lastOutputAt: now - 30_000,
    readiness: { lastOutputAt: now - 30_000, matcherIdle: true, leftReadyAt: now - 40_000 },
  } as Tile;

  it("a turn or background work on screen is working, even while the header's verdict is idle", () => {
    expect(sessionQuitState(base, now)).toBe(null);
    expect(sessionQuitState({ ...base, readiness: { ...base.readiness!, running: true } }, now)).toBe("working");
    expect(sessionQuitState({ ...base, readiness: { ...base.readiness!, background: true } }, now)).toBe("working");
  });

  it("a chat tile: working only mid-turn, waiting on an approval, nothing at Ready", () => {
    const chat = { kind: "codex-chat", status: "running", startedAt: now - 60_000 } as Tile;
    expect(sessionQuitState(chat, now)).toBe(null);
    expect(sessionQuitState({ ...chat, sessionIdleSince: undefined }, now)).toBe(null);
    expect(sessionQuitState({ ...chat, sessionBusy: true }, now)).toBe("working");
    expect(sessionQuitState({ ...chat, sessionBusy: true, sessionApprovalPending: true }, now)).toBe("waiting");
  });

  it("a tile still starting (nothing drawn) has nothing to lose", () => {
    const fresh = { kind: "claude", status: "running", startedAt: now - 2_000 } as Tile;
    expect(sessionQuitState(fresh, now)).toBe(null);
    expect(sessionQuitState({ ...fresh, startedAt: now - 60_000 }, now)).toBe(null); // quiet, never scanned: the clock
    expect(sessionQuitState({ ...fresh, lastOutputAt: now - 500 }, now)).toBe("working");
  });

  it("the sheet names waiting sessions on a line of their own; the updater waits for them", () => {
    const opts = { askWorking: true, workingAcknowledged: false };
    const waitingOnly = quitSheetWords({ files: [], working: { ...NOTHING_RUNNING, waiting: 1 } }, "quit", opts);
    expect(waitingOnly.lede).toBe("1 session asks you something.");
    expect(waitingOnly.workingNote).toBe(
      "Quitting leaves the question unanswered. A Claude or Codex conversation can be resumed afterwards; the turn that asked is lost.",
    );
    const both = quitSheetWords({ files: [], working: { ...NOTHING_RUNNING, sessions: 1, waiting: 2 } }, "quit", opts);
    expect(both.lede).toBe("1 session is working · 2 sessions ask you something.");
    expect(busyForUpdate({ ...NOTHING_RUNNING, waiting: 1 })).toBe(1);
    expect(
      idleBlocker({
        now, lastInputAt: 0, dirtyFiles: 0, working: busyForUpdate({ ...NOTHING_RUNNING, waiting: 1 }),
        shellCommands: [], drafts: 0, quitAsk: false, modalOpen: false, settingsOpen: false, setupOpen: false,
        paletteOpen: false, windowInFront: true,
      }),
    ).toBe("working");
    expect(updateConfirmBody({ ...NOTHING_RUNNING, waiting: 1 }, NOTHING_RUNNING)).toContain(
      "1 session asks you something: the question is left unanswered.",
    );
  });
});

describe("1.174.3: a resumed Builder session and the quit guard", () => {
  afterEach(() => useBuilder.setState({ byCard: {}, sentAt: {}, submittedAt: {} }));

  it("isn't at work until something went in since the Resume", () => {
    const now = Date.now();
    // Its card is shown: read from its terminal (1.176.2).
    setBuilderObserved("c1", true);
    useBuilder.setState({
      byCard: {
        c1: { workspaceId: "w", ptyId: "p", vendor: "codex", startedAt: now - 1_000, lastOutputAt: now - 200, resumedAt: now - 2_000, pending: [] },
      },
    });
    expect(workingNow(now).sessions).toBe(0);
    useBuilder.setState({ sentAt: { c1: now - 500 } });
    expect(workingNow(now).sessions).toBe(1);
    setBuilderObserved("c1", false);
  });
});

// 1.176.2 (A5F-01, A5F-14, A5F-05, review F4, round 2 M1): a Builder whose
// card isn't on screen is at work while its process lives and it printed in
// the last 2 minutes — never "idle" from its screen's text (no real frames
// recorded yet). Both CLIs' trust screens count as waiting.
describe("1.176.2: a Builder no terminal shows", () => {
  let poll = 0;
  const screen = (key: string, lastOutputAt: number | null, exited = false): BuilderSessionScreen => ({
    key,
    vendor: "codex",
    lastOutputAt,
    exited,
  });
  /** One tick of the 2 s poll, the backend answering `blocks` and `screens`. */
  async function backendSays(blocks: unknown[], screens: BuilderSessionScreen[]) {
    tauri().fixture("builder_session_blocks", blocks);
    tauri().fixture("builder_session_screens", screens);
    poll += 10_000;
    await pollSessionBlocks(90_000_000 + poll);
  }
  function buildOn(...ids: string[]) {
    seedBoard(
      ids.map((id) =>
        boardCard(id, {
          columnId: "in_progress",
          builder: { vendor: "codex", bypass: false, ptyId: `pty-${id}`, sessionLost: false, startedAt: Date.now() - 600_000, snapshots: [] },
        } as Partial<KanbanCard>),
      ),
    );
  }
  /** c1's runtime, left behind when its card page went away. */
  function leftBehind(patch: Record<string, unknown> = {}) {
    const now = Date.now();
    useBuilder.setState({
      byCard: { c1: { workspaceId: BOARD_WS, ptyId: "pty-c1", vendor: "codex", startedAt: now - 600_000, lastOutputAt: now - 60_000, turnIdleSettled: true, pending: [], ...patch } },
    });
  }
  afterEach(async () => {
    useBuilder.setState({ byCard: {}, sentAt: {}, submittedAt: {}, trustAsking: {}, sessionBlocks: {} });
    while (isBuilderObserved("c1")) setBuilderObserved("c1", false);
    seedBoard([]);
    // No live Builder: the next tick lets go of the readings kept.
    poll += 10_000;
    await pollSessionBlocks(90_000_000 + poll);
  });

  it("at work while its process lives and it printed in the last 2 minutes, card page gone or never opened", async () => {
    buildOn("c1", "c2");
    // c1's card page went away with its last scan saying the turn was over;
    // c2 was built from the Board and never opened.
    leftBehind();
    const now = Date.now();
    await backendSays([], [screen("c1", now - 30_000), screen("c2", now - 30_000)]);
    expect(workingNow(now).sessions).toBe(2);
    const facts = await idleFactsNow(0, now);
    expect(facts.working).toBeGreaterThan(0);
    expect(idleBlocker({ ...facts, windowInFront: true, modalOpen: false })).toBe("working");
    // Quiet for 3 minutes: not at work.
    await backendSays([], [screen("c1", now - 3 * 60_000), screen("c2", now - 3 * 60_000)]);
    expect(workingNow(now).sessions).toBe(0);
    expect(OFF_SCREEN_WORKING_MS).toBe(2 * 60_000);
    // Process ended (just now printing or not): nothing.
    await backendSays([], [screen("c1", now - 1_000, true), screen("c2", now - 1_000, true)]);
    expect(workingNow(now)).toMatchObject({ sessions: 0, waiting: 0 });
  });

  it("an off-screen Builder with no reading of it yet is at work", async () => {
    buildOn("c1");
    leftBehind();
    // The card page just went away; the backend has not been read since.
    expect(workingNow(Date.now()).sessions).toBe(1);
  });

  it("an attached Builder is read from its terminal, and its key is left out of the read", async () => {
    const now = Date.now();
    buildOn("c1");
    setBuilderObserved("c1", true);
    leftBehind({ lastOutputAt: now - 30_000 });
    await backendSays([], []);
    const reads = tauri().callsOf("builder_session_screens");
    expect(reads[reads.length - 1]?.args).toEqual({ observed: ["c1"] });
    expect(workingNow(now).sessions).toBe(0);
  });

  it("round 2 M1: Cmd-Q decides on a reading taken now; with none, it asks", async () => {
    buildOn("c1");
    leftBehind();
    const now = Date.now();
    // The cached reading (the window hidden, a while ago): quiet for 3 minutes.
    await backendSays([], [screen("c1", now - 3 * 60_000)]);
    expect(peekQuitAsks()).toBe(false);
    // A turn started a second ago.
    tauri().fixture("builder_session_screens", [screen("c1", Date.now() - 1_000)]);
    expect(await quitAsksNow()).toBe(true);
    // The read fails: no reading, the quit asks.
    await backendSays([], [screen("c1", now - 3 * 60_000)]);
    tauri().fixture("builder_session_screens", () => {
      throw new Error("no answer");
    });
    expect(await quitAsksNow()).toBe(true);
    // Quiet for real: no question.
    tauri().fixture("builder_session_screens", [screen("c1", now - 3 * 60_000)]);
    expect(await quitAsksNow()).toBe(false);
  });

  it("F1 review round 3, S3: a read already under way when Cmd-Q comes is followed by a new one", async () => {
    buildOn("c1");
    leftBehind();
    const now = Date.now();
    await backendSays([], [screen("c1", now - 3 * 60_000)]);
    // A poll's read is out, answering what it saw before the turn started.
    let pollAnswer: (screens: BuilderSessionScreen[]) => void = () => {};
    tauri().fixture("builder_session_screens", () => new Promise((resolve) => (pollAnswer = resolve)));
    const pollRead = pollSessionBlocks(90_000_000 + (poll += 10_000));
    const asks = quitAsksNow();
    tauri().fixture("builder_session_screens", [screen("c1", Date.now() - 500)]);
    pollAnswer([screen("c1", now - 3 * 60_000)]);
    await pollRead;
    expect(await asks).toBe(true);
    expect(tauri().callsOf("builder_session_screens").length).toBeGreaterThanOrEqual(3);
  });

  it("the quit sheet and the update read again before they answer; a read that fails or comes late keeps them asking and waiting", async () => {
    buildOn("c1");
    leftBehind();
    const now = Date.now();
    await backendSays([], [screen("c1", now - 3 * 60_000)]);
    expect(workingNow(now).sessions).toBe(0);
    tauri().fixture("builder_session_screens", [screen("c1", now - 500)]);
    expect((await idleFactsNow(0, now)).working).toBeGreaterThan(0);
    const unregister = registerQuitHost();
    try {
      const answer = confirmQuit("quit");
      await waitForAsk();
      expect(useQuitGuard.getState().ask?.loss.working.sessions).toBe(1);
      answerQuit(useQuitGuard.getState().ask!.id, false);
      expect(await answer).toBe(false);
    } finally {
      unregister();
    }
    tauri().fixture("builder_session_screens", () => {
      throw new Error("no answer");
    });
    expect((await idleFactsNow(0, now)).working).toBeGreaterThan(0);
    // Late: the update waits; the late answer still lands.
    let late: (screens: BuilderSessionScreen[]) => void = () => {};
    tauri().fixture("builder_session_screens", () => new Promise((resolve) => (late = resolve)));
    expect((await idleFactsNow(0, now)).working).toBeGreaterThan(0);
    late([screen("c1", now - 3 * 60_000)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(workingNow(now).sessions).toBe(0);
  });

  it("counts every waiting session once: two tiles at their trust screens and Builders the backend reads stopped", async () => {
    const now = Date.now();
    // A Claude tile at its trust question (the backend's read) and a Codex
    // 0.171 tile at its own, read from its screen.
    const codex171 = readinessProbe("codex", [
      "Folder access",
      "",
      "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.",
      "",
      "› 1. Trust and continue",
      "  2. Back to Agent Command Center",
      "",
      "  enter continue · esc back",
    ]);
    expect(codex171.waiting).toBe(true);
    const tiles = [
      { kind: "claude", status: "running", startedAt: now - 60_000, lastOutputAt: now - 30_000, question: "trust" },
      {
        kind: "codex",
        status: "running",
        startedAt: now - 60_000,
        lastOutputAt: now - 30_000,
        readiness: { lastOutputAt: now - 30_000, matcherIdle: true, leftReadyAt: now - 40_000, waiting: true },
      },
    ] as Tile[];
    expect(tiles.map((t) => sessionQuitState(t, now))).toEqual(["waiting", "waiting"]);
    useTiles.setState({ byWorkspace: { w1: { tiles } } } as never);
    expect(workingNow(now).waiting).toBe(2);
    expect(quitSheetWords({ files: [], working: workingNow(now) }, "quit", { askWorking: true, workingAcknowledged: false }).lede).toBe(
      "2 sessions ask you something.",
    );

    // Builders whose cards aren't shown: one at Claude's trust question (no
    // runtime here), one at its usage limit (a runtime), one at the Bypass
    // warning whose process has since ended (review F4); and an intake's
    // trust question, which is no Builder's.
    buildOn("c1", "c2", "c3");
    useBuilder.setState({
      byCard: {
        c2: { workspaceId: BOARD_WS, ptyId: "pty-c2", vendor: "claude", startedAt: now - 600_000, lastOutputAt: now - 60_000, pending: [] },
      },
    });
    await backendSays(
      [
        { key: "c1", workspaceId: BOARD_WS, vendor: "claude", kind: "trust" },
        { key: "c2", workspaceId: BOARD_WS, vendor: "claude", kind: "usageLimit", resetsAt: "3pm" },
        { key: "c3", workspaceId: BOARD_WS, vendor: "claude", kind: "bypass" },
        { key: "c9", workspaceId: BOARD_WS, vendor: "claude", kind: "trust", intake: true },
      ],
      [screen("c1", now - 1_000), screen("c2", now - 1_000), screen("c3", now - 1_000, true)],
    );
    const counts = workingNow(now);
    expect(counts.waiting).toBe(4);
    // Stopped, not at work, though the trust screen was drawn a second ago.
    expect(counts.sessions).toBe(0);
    expect(busyForUpdate(counts)).toBeGreaterThan(0);
    // A Builder asking in its open card and read by the backend is one session.
    setBuilderObserved("c1", true);
    useBuilder.setState((s) => ({
      byCard: {
        ...s.byCard,
        c1: { workspaceId: BOARD_WS, ptyId: "pty-c1", vendor: "claude", startedAt: now - 600_000, lastOutputAt: now - 60_000, questionInView: true, pending: [] },
      },
    }));
    expect(workingNow(now).waiting).toBe(4);
  });
});

// 1.176.3 phase 2: the Builder no terminal shows is judged from its screen
// (the rows the backend draws of it, `builderScreenState.ts`). An idle Codex
// whose output is fresh but whose content above the composer holds still is
// no longer at work (owner decision 1, 2026-11-23); a turn on screen is.
describe("1.176.3: a Builder no terminal shows, judged from its screen", () => {
  let poll = 0;
  const RULE = "─".repeat(60);
  const CODEX_IDLE = ["• f5.txt has 15 lines.", "", "  Worked for 21s • 11:22", "", "", "› Ask Codex to do anything", "", "  ← for agents · ? for shortcuts"];
  const CODEX_WORKING = ["• Explored", "  └ Read f2.txt", "", "• Working (11s • esc to interrupt)", "", "", "› Ask Codex to do anything", "", "  ← for agents · ? for shortcuts"];
  const CLAUDE_RUNNING = ["⏺ Reading 1 file…", "", "✳ Smooshing… (2s · ↓ 79 tokens)", "", RULE, "❯", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"];
  const CODEX_TRUST = ["  Trust this folder? Codex can read, edit, and run files here.", "", "› 1. Trust and continue", "  2. Back to Agent Command Center", "", "  enter continue · esc back"];
  const drawn = (key: string, vendor: string, rows: string[], printedAgo: number, changedAgo: number): BuilderSessionScreen => {
    const now = Date.now();
    return { key, vendor, lastOutputAt: now - printedAgo, exited: false, rows, contentChangedAt: now - changedAgo };
  };
  async function backendSays(screens: BuilderSessionScreen[]) {
    tauri().fixture("builder_session_blocks", []);
    tauri().fixture("builder_session_screens", screens);
    poll += 10_000;
    await pollSessionBlocks(95_000_000 + poll);
  }
  function buildOn(...ids: string[]) {
    seedBoard(
      ids.map((id) =>
        boardCard(id, {
          columnId: "in_progress",
          builder: { vendor: "codex", bypass: false, ptyId: `pty-${id}`, sessionLost: false, startedAt: Date.now() - 600_000, snapshots: [] },
        } as Partial<KanbanCard>),
      ),
    );
  }
  afterEach(async () => {
    useBuilder.setState({ byCard: {}, sentAt: {}, submittedAt: {}, trustAsking: {}, sessionBlocks: {} });
    seedBoard([]);
    poll += 10_000;
    await pollSessionBlocks(95_000_000 + poll);
  });

  it("an idle Codex past its turn-done line, still for 10 s, is not at work: the update may go", async () => {
    buildOn("c1");
    const now = Date.now();
    await backendSays([drawn("c1", "codex", CODEX_IDLE, 30_000, 60_000)]);
    expect(workingNow(now)).toMatchObject({ sessions: 0, waiting: 0 });
    const facts = await idleFactsNow(0, now);
    expect(facts.working).toBe(0);
    // Review p2 MF1: it printed a moment ago (a prompt typed into it): at work.
    await backendSays([drawn("c1", "codex", CODEX_IDLE, 300, 60_000)]);
    expect(workingNow(now).sessions).toBe(1);
    // Its answer still streaming (the same shape, its content moving): at work.
    await backendSays([drawn("c1", "codex", CODEX_IDLE, 300, 500)]);
    expect(workingNow(now).sessions).toBe(1);
    expect(offScreenWorkingWhy()).toMatch(/^Builder c1 codex working: at its prompt, screen changed [01]s ago$/);
  });

  it("a turn on screen is at work on both vendors; a trust screen waits; an older backend keeps the 2-minute rule", async () => {
    buildOn("c1", "c2", "c3", "c4");
    const now = Date.now();
    await backendSays([
      drawn("c1", "codex", CODEX_WORKING, 3 * 60_000, 0),
      drawn("c2", "claude", CLAUDE_RUNNING, 3 * 60_000, 1_000),
      drawn("c3", "codex", CODEX_TRUST, 3 * 60_000, 3 * 60_000),
      // No rows: 1.176.2's answer.
      { key: "c4", vendor: "codex", lastOutputAt: now - 30_000, exited: false },
    ]);
    expect(workingNow(now)).toMatchObject({ sessions: 3, waiting: 1 });
    const why = offScreenWorkingWhy();
    expect(why).toContain("Builder c3 codex waiting: a question in view");
    expect(why).toContain("Builder c4 codex working: screen not read, printed 30s ago");
    // The rows never reach the log line.
    expect(why).not.toMatch(/Trust this folder|esc to interrupt|Smooshing/);
  });

  it("Cmd-Q reads the screens now: a cached idle screen does not answer for a turn that started since", async () => {
    buildOn("c1");
    await backendSays([drawn("c1", "codex", CODEX_IDLE, 60_000, 60_000)]);
    expect(peekQuitAsks()).toBe(false);
    tauri().fixture("builder_session_screens", [drawn("c1", "codex", CODEX_WORKING, 100, 0)]);
    expect(await quitAsksNow()).toBe(true);
    tauri().fixture("builder_session_screens", [drawn("c1", "codex", CODEX_IDLE, 60_000, 60_000)]);
    expect(await quitAsksNow()).toBe(false);
  });
});

async function waitForAsk() {
  for (let i = 0; i < 50 && !useQuitGuard.getState().ask; i++) await new Promise((r) => setTimeout(r, 0));
}
