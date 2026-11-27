// QoL 1.168 (Windows walk): a Claude tile nobody typed into was listed as
// "Claude finished · see what it did". On ConPTY the CLI's own start-up, and
// the repaint a resize makes, take the tile out of Ready and back with
// nobody typing. A finished turn now needs the member's own line since the
// tile started (`ptyTurnEpisode`). The stream is Claude Code's own, captured
// in a ConPTY on the Windows VM (fixtures/claudeConptyIdle.json).
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import fixture from "./fixtures/claudeConptyIdle.json";
import { screenChangeTracker, visibleScreen } from "../lib/screenChange";
import { matchesClaudePromptBox } from "../lib/attention";
import { nextReadiness, type Readiness } from "../lib/tileHeaderStatus";
import { ptyTurnEpisode, tileTurnEpisode } from "../lib/needsYou";

type Chunk = { at: number; b64: string };
const chunks = (fixture as { chunks: Chunk[] }).chunks.map((c) => ({
  at: c.at,
  data: Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0)),
}));

const write = (term: Terminal, data: Uint8Array) => new Promise<void>((r) => term.write(data, r));

/** Replays the capture as Terminal folds it on Windows: activity is a screen
 *  change, the matcher is Claude's prompt box; a resize at 50 s (110 cols). */
async function replay(T0: number): Promise<{ readiness: Readiness; end: number }> {
  const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  const tracker = screenChangeTracker();
  let readiness: Readiness = { lastOutputAt: T0, matcherIdle: null, leftReadyAt: T0 };
  let lastActivity = T0;
  let resized = false;
  for (const c of chunks) {
    if (!resized && c.at >= 50_000) {
      term.resize(110, 32);
      resized = true;
    }
    await write(term, c.data);
    const screen = visibleScreen(term.buffer.active, term.rows);
    const now = T0 + c.at;
    if (tracker.changed(screen)) lastActivity = now;
    // Terminal's settled scan, a moment after the output.
    readiness = nextReadiness("claude", readiness, { lastOutputAt: lastActivity, matcherIdle: matchesClaudePromptBox(screen) }, now + 2_500);
  }
  const end = T0 + chunks[chunks.length - 1].at + 30_000;
  term.dispose();
  return { readiness, end };
}

describe("a Claude tile in a ConPTY", () => {
  it("nobody typed: no finished turn, through its start-up and a resize", async () => {
    const T0 = 1_000_000;
    const { readiness, end } = await replay(T0);
    const t = { id: "t1", kind: "claude", label: "Claude", status: "running", startedAt: T0, readiness };
    // What the old rule went by: the capture leaves Ready after it started.
    expect(readiness.leftReadyAt).toBeGreaterThan(T0);
    expect(ptyTurnEpisode(t, end)).toBeNull();
    expect(tileTurnEpisode(t as never, end)).toBeNull();
  });

  it("the member's line, answered, is the turn — one, whatever repaints after it", async () => {
    const T0 = 1_000_000;
    const { readiness, end } = await replay(T0);
    // The capture's one turn: the member's line at the start of it.
    const t = { id: "t1", kind: "claude", label: "Claude", status: "running", startedAt: T0, readiness, submittedAt: T0 + 1_000 };
    expect(readiness.lastOutputAt).toBeGreaterThan(T0 + 1_000);
    expect(ptyTurnEpisode(t, end)).toBe(`ready@${T0 + 1_000}`);
    // A line sent after everything on screen: nothing answered it yet.
    expect(ptyTurnEpisode({ ...t, submittedAt: end - 1 }, end)).toBeNull();
  });
});
