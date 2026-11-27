// Windows walk (group B, 2026-09-30): a Claude Builder idle at its prompt kept
// "last output just now" and held the self-check for minutes. The stream is
// Claude Code 2.1.286's own, captured in a ConPTY on the Windows VM
// (fixtures/claudeConptyIdle.json): its answer to focus and mouse reports,
// and ConPTY's repaint on a same-size resize, arrive as bytes and leave the
// screen as it was.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import fixture from "./fixtures/claudeConptyIdle.json";
import { screenChangeTracker, stampsOnScreenChange, visibleScreen } from "../lib/screenChange";

type Chunk = { at: number; b64: string };
const chunks = (fixture as { chunks: Chunk[] }).chunks.map((c) => ({
  at: c.at,
  data: Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0)),
}));

function write(term: Terminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("a Claude Builder idle in a ConPTY", () => {
  it("prints bytes on focus, mouse and a same-size resize that leave its screen unchanged", async () => {
    const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    const screen = () => visibleScreen(term.buffer.active, term.rows);
    const tracker = screenChangeTracker();
    // Start-up, one turn, back at the prompt (the capture's first 20 s).
    for (const c of chunks.filter((c) => c.at < 20_000)) await write(term, c.data);
    expect(screen()).toContain("ready");
    tracker.changed(screen());

    // 25–45 s: focus in/out, mouse motion, then a resize to the same size.
    const idleNoise = chunks.filter((c) => c.at >= 20_000 && c.at <= 45_002);
    expect(idleNoise.length).toBeGreaterThanOrEqual(5);
    let arrivals = 0;
    let changes = 0;
    for (const c of idleNoise) {
      await write(term, c.data);
      arrivals += 1;
      if (tracker.changed(screen())) changes += 1;
    }
    // The old rule stamped every one of these as the Builder working.
    expect(arrivals).toBe(idleNoise.length);
    expect(changes).toBe(0);
    term.dispose();
  });

  it("still sees a turn's spinner and answer as output", async () => {
    const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    const screen = () => visibleScreen(term.buffer.active, term.rows);
    const tracker = screenChangeTracker();
    const turn = chunks.filter((c) => c.at < 3_000);
    let changes = 0;
    for (const c of turn) {
      await write(term, c.data);
      if (tracker.changed(screen())) changes += 1;
    }
    expect(changes).toBeGreaterThan(5);
    term.dispose();
  });

  it("judges by the screen on Windows only; the Mac stamps on arrival as before", () => {
    expect(stampsOnScreenChange(true)).toBe(true);
    expect(stampsOnScreenChange(false)).toBe(false);
  });
});
