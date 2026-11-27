// 1.169.0 (B3): a Claude tile read "Working" from typing alone (seen on
// Windows). Recorded in the Windows 11 VM (fixtures/claudeTypingConpty.json):
// typing into a fresh, idle Claude session, never submitted, on the system
// ConPTY and on the bundled one. The system ConPTY delivers the first keys'
// echo 250–420 ms late (and Claude re-sends its modes on the first key), past
// the tile's 250 ms echo window. With no earlier prompt on screen the Claude
// matcher can't tell a turn from its box (`null`), and then every output
// counted: the tile left Ready while the member was only typing.
//
// The replay folds the capture as Terminal does for a Claude tile: output
// stamped on arrival unless it is the echo of input, a scan 300 ms after
// output (`readinessProbe` → `foldScan` → `nextReadiness`), the header from
// `tileHeaderStatus`.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import fixture from "./fixtures/claudeTypingConpty.json";
import turnFixture from "./fixtures/claudeConptyIdle.json";
import {
  FRESH_SCAN_MEMORY,
  READINESS_SCAN_MS,
  foldScan,
  memberInput,
  nextReadiness,
  readinessProbe,
  tileHeaderStatus,
  type Readiness,
} from "../lib/tileHeaderStatus";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";

type Ev = { at: number; dir: "in" | "out"; b64: string };
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const INPUT_ECHO_MS = 250;

function rows(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = buf.baseY; i < buf.baseY + term.rows; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out;
}

/** The header over the capture: every 100 ms from the first key to 3 s after
 *  the last, whether it read Ready, and whether it did just before. */
async function replay(events: Ev[], screen = true) {
  const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 120, rows: 30 });
  installWideChars(term);
  let lastInputAt = 0;
  let lastDataAt = 0;
  let dataSinceScan = false;
  let memory = { ...FRESH_SCAN_MEMORY, activityAt: 0 };
  let readiness: Readiness | undefined;
  let scanAt: number | null = null;
  const scan = (now: number) => {
    const sawData = dataSinceScan;
    dataSinceScan = false;
    const probe = readinessProbe("claude", rows(term));
    memory = foldScan(memory, {
      idle: probe.idle,
      status: probe.status,
      signature: probe.signature,
      sawData,
      dataAt: sawData ? lastDataAt : now,
      rebaselining: false,
      now,
      screen,
      running: probe.running,
    });
    const observed = { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null };
    readiness = readiness
      ? nextReadiness("claude", readiness, observed, now)
      : { ...observed, leftReadyAt: 0 };
  };
  // The typing: every key before the Ctrl+C that ends the recording (which
  // is the member's own action, and Claude answers it).
  const keyEvents = events.filter((e) => e.dir === "in");
  const quitAt = keyEvents.find((e) => atob(e.b64) === "\x03")?.at ?? Infinity;
  const keys = keyEvents.map((e) => e.at).filter((at) => at < quitAt);
  const last = events[events.length - 1].at;
  const from = keys[0] ?? 0;
  const to = keys.length > 0 ? Math.min(keys[keys.length - 1] + 3_000, quitAt - 10) : last + 3_000;
  const ticks: Array<{ at: number; ready: boolean }> = [];
  let next = 0;
  for (let t = 0; t <= to; t += 10) {
    if (scanAt !== null && t >= scanAt) {
      scanAt = null;
      scan(t);
    }
    while (next < events.length && events[next].at <= t) {
      const e = events[next++];
      if (e.dir === "in") {
        const input = memberInput(new TextDecoder().decode(bytes(e.b64)));
        // As Terminal.tsx's onData.
        if (input.typed) lastInputAt = e.at;
        if (input.submitted) scanAt = Math.min(scanAt ?? Infinity, e.at + READINESS_SCAN_MS);
      } else {
        await new Promise<void>((r) => term.write(bytes(e.b64), r));
        if (e.at - lastInputAt >= INPUT_ECHO_MS) {
          lastDataAt = e.at;
          dataSinceScan = true;
        }
        scanAt = Math.min(scanAt ?? Infinity, e.at + READINESS_SCAN_MS);
      }
    }
    if (t >= from && t % 100 === 0 && readiness) {
      ticks.push({ at: t, ready: tileHeaderStatus("claude", readiness.lastOutputAt, readiness.matcherIdle, readiness.leftReadyAt, t).ready });
    }
  }
  term.dispose();
  return { ticks, readyBefore: ticks.length > 0 && ticks[0].ready };
}

/** The Working stretches of a timeline, as [from, to] tick times. */
function stretches(ticks: Array<{ at: number; ready: boolean }>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const t of ticks) {
    if (t.ready) continue;
    const last = out[out.length - 1];
    if (last && t.at - last[1] <= 100) last[1] = t.at;
    else out.push([t.at, t.at]);
  }
  return out;
}

describe("typing into an idle Claude tile, never submitted", () => {
  for (const host of ["system", "bundled"] as const) {
    it(`stays Ready on the ${host} ConPTY`, async () => {
      const { ticks, readyBefore } = await replay((fixture as unknown as Record<string, Ev[]>)[host]);
      expect(readyBefore, "Ready when the first key is typed").toBe(true);
      const working = ticks.filter((t) => !t.ready).map((t) => t.at);
      expect(working, "never Working while only typing").toEqual([]);
    });
  }

  // The fix must not hide a real turn: the earlier recording (start, then
  // one turn from ~0.9 s). (Its later focus and resize repaints, which
  // Terminal rebaselines, are not modelled here: 40 s is before them.)
  it("a real turn reads as it did before: Working, then Ready", async () => {
    const events = (turnFixture as { chunks: { at: number; b64: string }[] }).chunks.map((c) => ({ ...c, dir: "out" as const }));
    const ticks = (await replay(events)).ticks.filter((t) => t.at <= 40_000);
    // One stretch: Working from the first scan through the turn (its
    // "esc to interrupt" at ~0.9 s, the spinner, the answer, until ~2.9 s
    // after it ended), Ready from then to 40 s.
    expect(stretches(ticks)).toEqual([[400, 4900]]);
  });

  // B3 Challenger: a long turn whose prompt scrolled off under a tall todo
  // list — no verdict, the eight signature rows (todo items) still, only
  // the footer's "esc to interrupt" and the spinner's seconds above the page
  // say it runs. Its output keeps the tile Working.
  it("a turn whose prompt scrolled off under a tall todo list stays Working", async () => {
    const enc = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
    const todo = Array.from({ length: 12 }, (_, i) => `  ⎿ ☐ Step ${i + 1} of the plan`);
    const frame = (n: number) =>
      "\x1b[H\x1b[2J" +
      [`✻ Pondering… (${n}s)`, ...todo, "─".repeat(60), "> ", "─".repeat(60), "  esc to interrupt"].join("\r\n");
    const events: Ev[] = [];
    for (let i = 0; i < 20; i++) events.push({ at: 1_000 + i * 1_000, dir: "out", b64: enc(frame(i)) });
    const ticks = (await replay(events)).ticks.filter((t) => t.at >= 3_000 && t.at <= 20_000);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.filter((t) => t.ready).map((t) => t.at)).toEqual([]);
  });
});
