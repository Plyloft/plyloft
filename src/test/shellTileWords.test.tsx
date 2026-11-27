// Owner decision (2026-10-19): a shell tile says shell words — "Running"
// while a command runs, "Ready" at its prompt — never an agent's playful verb
// ("Cooking", "Sautéed", "Working for Ns"). Claude and Codex tiles say "Working · 4m" (1.171.0 C2).
//
// Seen on Windows PowerShell: "Working for Ns" while the prompt was already
// back. PowerShell under ConPTY has no line-editor probe and no command
// blocks, so output quiet says the prompt is back; a ConPTY repaint that
// leaves the prompt as it was (a resize) is not a command running.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { tileStatusLine } from "../lib/tileStatusLine";
import {
  FRESH_SCAN_MEMORY,
  foldScan,
  nextReadiness,
  shellVerdict,
  type Readiness,
  type ReadinessKind,
  type ScanMemory,
} from "../lib/tileHeaderStatus";
import {
  readinessNotedOnScreenChange,
  readinessNotesDraw,
  screenChangeTracker,
  visibleScreen,
  watchContentScroll,
} from "../lib/screenChange";
import conptyIdle from "./fixtures/claudeConptyIdle.json";
import { RESIZE_REDRAW_MS } from "../lib/attention";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const PLAYFUL = /Working|Cooking|Sautéed|Churning|Crunching|Vibing/;

function line(kind: string, readiness: Readiness | undefined, now: number, lastOutputAt = T0) {
  return tileStatusLine({ kind, status: "running", startedAt: T0, readiness, lastOutputAt, now });
}

describe("the words a live tile's header says, by kind and state", () => {
  const busy: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
  const idle: Readiness = { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 };

  it("a shell: Running while busy, Ready at its prompt, at any age", () => {
    for (const age of [5000, 45_000, 3 * MIN, 9 * MIN]) {
      expect(line("shell", busy, T0 + age, T0 + age)).toEqual({
        text: "Running",
        tone: "running",
        live: true,
      });
      expect(line("shell", idle, T0 + age).text).toBe("Ready");
    }
    // Not judged yet (no scan): working since it started — Running.
    expect(line("shell", undefined, T0 + 5000, T0 + 5000).text).toBe("Running");
  });

  // 1.171.0 C2 (CF8): Claude and Codex say the session words — Working with
  // this turn's time, Your turn at the prompt.
  it("Claude and Codex say Working with its time, and Your turn", () => {
    // Ready once, then at work again (QoL 1.168: until its first Ready a
    // session says Starting…).
    const again: Readiness = { ...busy, leftReadyAt: T0 + 1 };
    for (const kind of ["claude", "codex"]) {
      expect(line(kind, busy, T0 + 5000, T0 + 5000).text).toBe("Starting…");
      expect(line(kind, undefined, T0 + 5000, T0 + 5000).text).toBe("Starting…");
      expect(line(kind, again, T0 + 5001, T0 + 5001).text).toBe("Working · 5s");
      expect(line(kind, busy, T0 + 45_000, T0 + 45_000).text).toBe("Working · 45s");
      expect(line(kind, busy, T0 + 3 * MIN, T0 + 3 * MIN).text).toBe("Working · 3m 0s");
      expect(line(kind, idle, T0 + 5000).text).toBe("Your turn");
    }
    // A chat session between turns and in one: unchanged.
    expect(
      tileStatusLine({ kind: "codex-chat", status: "running", startedAt: T0, sessionBusy: true, sessionTurnStartedAt: T0, now: T0 + 45_000 }).text,
    ).toBe("Working · 45s");
  });

  it("a shell silent for 10m still says so, in shell words", () => {
    expect(line("shell", busy, T0 + 11 * MIN).text).toBe("No output for 11m");
    expect(line("shell", busy, T0 + 11 * MIN).text).not.toMatch(PLAYFUL);
  });
});

describe("a PowerShell prompt under ConPTY", () => {
  it("notes a shell's output on screen change on Windows only, and agents' never", () => {
    expect(readinessNotedOnScreenChange(true, "shell")).toBe(true);
    expect(readinessNotedOnScreenChange(false, "shell")).toBe(false);
    expect(readinessNotedOnScreenChange(true, "claude")).toBe(false);
    expect(readinessNotedOnScreenChange(true, "codex")).toBe(false);
    expect(readinessNotedOnScreenChange(true, undefined)).toBe(false);
  });

  it("reads Ready through a repaint that leaves the prompt as it was, and Running for real output", async () => {
    const kind: ReadinessKind = "shell";
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((r) => term.write(data, r));
    const screen = () => visibleScreen(term.buffer.active, term.rows);
    const tracker = screenChangeTracker();

    // The PTY at the prompt: ConPTY says PowerShell is alone in its job, but
    // no line-editor probe, so `pty_prompt_state` is null. No command block.
    const verdict = shellVerdict(null, false);
    expect(verdict).toBeNull();

    let memory: ScanMemory = { ...FRESH_SCAN_MEMORY, activityAt: T0 };
    let readiness: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
    const scan = (sawData: boolean, at: number) => {
      memory = foldScan(memory, {
        idle: verdict,
        status: null,
        signature: "",
        sawData,
        dataAt: at,
        rebaselining: false,
        now: at,
      });
      readiness = nextReadiness(kind, readiness, {
        lastOutputAt: memory.activityAt,
        matcherIdle: memory.lastVerdict ?? null,
      }, at);
    };

    await write("PowerShell 7.5.2\r\nPS C:\\Users\\me> ");
    expect(tracker.changed(screen())).toBe(true);
    scan(true, T0 + 100);
    expect(line(kind, readiness, T0 + 200, T0 + 100).text).toBe("Running");
    scan(false, T0 + 2200);
    expect(line(kind, readiness, T0 + 2200, T0 + 100).text).toBe("Ready");

    // ConPTY repaints the same screen (a same-size resize): bytes arrive,
    // nothing on screen changed, so nothing is noted and it stays Ready.
    await write("\x1b[?25l\x1b[H\x1b[2B\x1b[1;1HPowerShell 7.5.2\x1b[K\r\nPS C:\\Users\\me> \x1b[K\x1b[?25h");
    const changed = tracker.changed(screen());
    expect(changed).toBe(false);
    for (let at = T0 + 3000; at <= T0 + 30_000; at += 1000) {
      scan(changed, at);
      const header = line(kind, readiness, at, T0 + 100);
      expect(header.text).toBe("Ready");
      expect(header.text).not.toMatch(PLAYFUL);
    }

    // A command that prints: Running while it prints, Ready 2 s after.
    await write("dir\r\n\r\n    Directory: C:\\Users\\me\r\n");
    expect(tracker.changed(screen())).toBe(true);
    scan(true, T0 + 31_000);
    expect(line(kind, readiness, T0 + 31_100, T0 + 31_000).text).toBe("Running");
    await write("PS C:\\Users\\me> ");
    tracker.changed(screen());
    scan(true, T0 + 31_500);
    scan(false, T0 + 33_600);
    expect(line(kind, readiness, T0 + 33_600, T0 + 31_500).text).toBe("Ready");
    term.dispose();
  });

  // Challenger: output that scrolls is output even when the screen it
  // leaves reads as before; a ConPTY repaint never scrolls.
  it("counts a scroll that leaves the same screen, and no ConPTY repaint scrolls", async () => {
    const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
    const write = (data: string | Uint8Array) => new Promise<void>((r) => term.write(data, r));
    const screen = () => visibleScreen(term.buffer.active, term.rows);
    let scrolled = false;
    const sub = watchContentScroll(term, () => (scrolled = true));
    const tracker = screenChangeTracker();
    await write("tick\r\ntick\r\ntick\r\ntick");
    tracker.changed(screen());
    scrolled = false;
    await write("\r\ntick");
    expect(screen()).toBe("tick\ntick\ntick");
    expect(tracker.changed(screen())).toBe(false); // the screen alone: no change
    expect(scrolled).toBe(true);
    expect(tracker.changed(screen(), scrolled)).toBe(true);
    sub.dispose();
    term.dispose();

    // The measured ConPTY session (focus reports, same-size resizes, a
    // narrower one): its repaints never scroll the buffer. (Its entry to the
    // alternate screen fires xterm 6's onScroll; the tile does not count it.)
    const conpty = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    let scrolls = 0;
    watchContentScroll(conpty, () => scrolls++);
    for (const chunk of (conptyIdle as { chunks: { b64: string }[] }).chunks) {
      await new Promise<void>((r) =>
        conpty.write(Uint8Array.from(atob(chunk.b64), (c) => c.charCodeAt(0)), r),
      );
    }
    expect(scrolls).toBe(0);
    conpty.dispose();
  });

  // 1.169.0 (B1): xterm 6 fires onScroll when a program enters or leaves
  // the alternate screen. That is no output scrolling: only the scrolls
  // within one buffer reach the tile.
  it("a buffer switch's scroll event is not output scrolling", async () => {
    const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((r) => term.write(data, r));
    let raw = 0;
    let counted = 0;
    term.onScroll(() => raw++);
    watchContentScroll(term, () => counted++);
    await write("\u001b[?1049h");
    await write("\u001b[?1049l");
    expect(raw).toBe(2);
    expect(counted).toBe(0);
    await write("a\r\nb\r\nc\r\nd");
    expect(counted).toBe(1);
    term.dispose();
  });

  // Windows walk (2026-10-20): a layout change re-wraps a long line at an
  // idle prompt — the drawn screen changes with no command running.
  it("a resize's re-wrap of a long line at the prompt is no output; output after the window is", async () => {
    const term = new Terminal({ cols: 60, rows: 6, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((r) => term.write(data, r));
    const screen = () => visibleScreen(term.buffer.active, term.rows);
    const tracker = screenChangeTracker();
    await write("PS C:\\Users\\me> git log --oneline --graph --decorate --all --max-count 20\r\n");
    await write("PS C:\\Users\\me> ");
    tracker.changed(screen());
    const resizedAt = T0;
    const resizedUntil = resizedAt + RESIZE_REDRAW_MS;
    term.resize(30, 6); // Single → Split
    await write(""); // the repaint's batch, drawn after the reflow
    const changed = tracker.changed(screen());
    expect(changed).toBe(true); // the re-wrap did change the drawn screen…
    expect(readinessNotesDraw(changed, resizedAt + 50, resizedUntil)).toBe(false); // …not output
    term.resize(60, 6); // Single again
    await write("");
    const back = tracker.changed(screen());
    expect(back).toBe(true);
    expect(readinessNotesDraw(back, resizedAt + 400, resizedUntil + 400)).toBe(false);
    // Past the window, a command's output on screen is output.
    await write("dir\r\n    Directory: C:\\Users\\me\r\n");
    expect(readinessNotesDraw(tracker.changed(screen()), resizedUntil + 500, resizedUntil + 400)).toBe(true);
    term.dispose();
  });
});
