// Block 10 Windows walk: after a text-size change a Claude tile showed
// "Working for 1s" before Ready. The refit resizes the PTY; ConPTY repaints
// the whole screen and Claude redraws, half-drawn for a scan or two. Replayed
// from Claude Code's own ConPTY stream (fixtures/claudeConptyIdle.json): idle
// at its prompt, a resize to a narrower grid, the repaint — the header stays
// Ready through it. And a fresh tile that has drawn nothing says Starting…,
// in its header and its sidebar row alike.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import fixture from "./fixtures/claudeConptyIdle.json";
import { visibleScreen } from "../lib/screenChange";
import {
  FRESH_SCAN_MEMORY,
  foldScan,
  nextReadiness,
  readinessProbe,
  RESIZE_SETTLE_MS,
  type Readiness,
  type ScanMemory,
} from "../lib/tileHeaderStatus";
import { RESIZE_REDRAW_MS } from "../lib/attention";
import { STARTING, tileStatusLine } from "../lib/tileStatusLine";
import { sessionRows } from "../lib/sessionRows";

type Chunk = { at: number; b64: string };
const chunks = (fixture as { chunks: Chunk[] }).chunks.map((c) => ({
  at: c.at,
  data: Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0)),
}));
const write = (term: Terminal, data: Uint8Array | string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const T0 = 1_700_000_000_000;

describe("a Claude tile in a ConPTY through a resize", () => {
  it("stays Ready while the refit's repaint is drawn", async () => {
    const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    const rows = () => visibleScreen(term.buffer.active, term.rows).split("\n");
    let memory: ScanMemory = { ...FRESH_SCAN_MEMORY, activityAt: T0 };
    let readiness: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
    let resizedUntil = 0;
    const scan = (at: number, sawData: boolean) => {
      const probe = readinessProbe("claude", rows());
      memory = foldScan(memory, {
        idle: probe.idle,
        status: probe.status,
        signature: probe.signature,
        sawData,
        dataAt: at,
        rebaselining: at < resizedUntil,
        now: at,
      });
      readiness = nextReadiness("claude", readiness, { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null }, at);
      return tileStatusLine({ kind: "claude", status: "running", startedAt: T0, readiness, lastOutputAt: T0 + 100, now: at }).text;
    };

    // Start-up, one turn, back at the prompt (the capture's first 20 s).
    for (const c of chunks.filter((c) => c.at < 20_000)) await write(term, c.data);
    scan(T0 + 20_000, true);
    expect(scan(T0 + 23_000, false)).toBe("Your turn");

    // The text got bigger: the refit makes the grid narrower and ConPTY
    // repaints. Scans land on the reflowed screen, then on a half-drawn one
    // (the repaint cleared it), then on the repaint done.
    const at = T0 + 30_000;
    resizedUntil = at + RESIZE_REDRAW_MS;
    term.resize(100, 28);
    expect(scan(at + 50, true)).toBe("Your turn");
    await write(term, "\x1b[2J\x1b[H");
    expect(scan(at + 300, true)).toBe("Your turn");
    for (const c of chunks.filter((c) => c.at >= 20_000 && c.at <= 45_002)) await write(term, c.data);
    expect(scan(at + 700, true)).toBe("Your turn");
    // Past the window, nothing new: still Ready.
    expect(scan(at + RESIZE_REDRAW_MS + 500, false)).toBe("Your turn");
    expect(scan(at + RESIZE_REDRAW_MS + 3000, false)).toBe("Your turn");
    term.dispose();
  });

  // 1.169.0 Mac walk (B3): an idle tile's own expand, its repaint landing
  // past the 1.5 s window, read "Working for 0s". The repaint settles.
  it("stays Ready when an expand's repaint lands late", async () => {
    for (const settles of [true, false]) {
      const term = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
      const rows = () => visibleScreen(term.buffer.active, term.rows).split("\n");
      let memory: ScanMemory = { ...FRESH_SCAN_MEMORY, activityAt: T0 };
      let readiness: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
      let resizedUntil = 0;
      let settleUntil = 0;
      const scan = (at: number, sawData: boolean) => {
        const probe = readinessProbe("claude", rows());
        memory = foldScan(memory, {
          ...probe,
          sawData,
          dataAt: at,
          rebaselining: at < resizedUntil,
          settling: at < settleUntil,
          screen: true,
          now: at,
        });
        readiness = nextReadiness("claude", readiness, { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null }, at);
        return tileStatusLine({ kind: "claude", status: "running", startedAt: T0, readiness, lastOutputAt: T0 + 100, now: at }).text;
      };
      for (const c of chunks.filter((c) => c.at < 20_000)) await write(term, c.data);
      scan(T0 + 20_000, true);
      expect(scan(T0 + 23_000, false)).toBe("Your turn");
      // Expand: a wider, taller grid; nothing redrawn inside the window.
      const at = T0 + 30_000;
      resizedUntil = at + RESIZE_REDRAW_MS;
      if (settles) settleUntil = at + RESIZE_SETTLE_MS;
      term.resize(160, 40);
      expect(scan(at + 50, true)).toBe("Your turn");
      // Claude's repaint arrives 2.2 s later: cleared, then drawn again.
      await write(term, "\x1b[2J\x1b[H");
      for (const c of chunks.filter((c) => c.at >= 20_000 && c.at <= 45_002)) await write(term, c.data);
      const late = scan(at + 2200, true);
      if (settles) expect(late).toBe("Your turn");
      else expect(late).not.toBe("Your turn");
      term.dispose();
    }
  });

  it("says Starting… before it has drawn anything, in its header and its sidebar row", () => {
    // A scan of the empty screen happened (whatever it said).
    const readiness: Readiness = { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 };
    const header = tileStatusLine({ kind: "claude", status: "running", startedAt: T0, readiness, now: T0 + 4000 });
    expect(header.text).toBe(STARTING);
    const [row] = sessionRows([{ id: "t", kind: "claude", label: "claude 1", status: "running", startedAt: T0, readiness }], [], T0 + 4000);
    expect(row.state).toBe("starting…");
    // Once it has drawn, the scans decide again.
    expect(tileStatusLine({ kind: "claude", status: "running", startedAt: T0, readiness, lastOutputAt: T0 + 100, now: T0 + 4000 }).text).toBe("Your turn");
  });
});
