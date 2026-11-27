// Unit tests for the tile header chip (src/lib/tileHeaderStatus.ts, GH #70).
//
// Self-contained and dependency-free, like attention.test.ts:
//
//     node --experimental-strip-types src/lib/tileHeaderStatus.test.ts

import {
  FRESH_SCAN_MEMORY,
  READINESS_SCAN_MS,
  READY_QUIET_MS,
  createScanScheduler,
  isSubmission,
  memberInput,
  noteLayoutRefit,
  lastLayoutRefitAt,
  refitRebaselining,
  rebaselineEndsAt,
  questionGoneWhileWorking,
  headerTurnsReadyAt,
  RESIZE_SETTLE_MS,
  shellVerdict,
  foldScan,
  nextReadiness,
  readinessProbe,
  readinessRecheckMs,
  SHELL_BUSY_RECHECK_MS,
  STATUS_STALE_MS,
  tileHeaderStatus,
  tileHeaderStatusFor,
} from "./tileHeaderStatus.ts";
import type { Readiness, ReadinessKind, ScanMemory } from "./tileHeaderStatus.ts";
import { readFileSync } from "node:fs";

// --- minimal harness -------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${currentSuite} › ${name}: ${(e as Error).message}`);
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      if (actual !== expected) {
        throw new Error(
          `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`,
        );
      }
    },
    toEqual(expected: T): void {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`expected ${a} to equal ${b}`);
    },
  };
}

const KINDS: ReadinessKind[] = ["claude", "codex", "shell"];
const T0 = 1_000_000;

// --- tileHeaderStatus -------------------------------------------------------

describe("tileHeaderStatus", () => {
  it("is Ready for every kind once the matcher has held idle for the quiet window", () => {
    for (const kind of KINDS) {
      expect(tileHeaderStatus(kind, T0, true, T0 - 5000, T0 + READY_QUIET_MS)).toEqual({
        ready: true,
      });
    }
  });

  it("is working inside the quiet window, counting from when the tile left Ready", () => {
    for (const kind of KINDS) {
      expect(tileHeaderStatus(kind, T0, true, T0 - 5000, T0 + READY_QUIET_MS - 1)).toEqual({
        ready: false,
        workingSince: T0 - 5000,
      });
    }
  });

  it("is working for every kind while the matcher says busy, however quiet the output", () => {
    for (const kind of KINDS) {
      expect(tileHeaderStatus(kind, T0, false, T0, T0 + 60_000)).toEqual({
        ready: false,
        workingSince: T0,
      });
    }
  });

  it("falls back to output quiet for a shell whose prompt probe cannot answer", () => {
    expect(tileHeaderStatus("shell", T0, null, T0, T0 + READY_QUIET_MS).ready).toBe(true);
    expect(tileHeaderStatus("shell", T0, null, T0, T0 + 500).ready).toBe(false);
  });

  it("lets output quiet decide for every kind when the matcher cannot answer", () => {
    for (const kind of KINDS) {
      expect(tileHeaderStatus(kind, T0, null, T0, T0 + READY_QUIET_MS).ready).toBe(true);
      expect(tileHeaderStatus(kind, T0, null, T0, T0 + READY_QUIET_MS - 1).ready).toBe(false);
    }
  });

  it("never calls an unscanned tile Ready", () => {
    for (const kind of KINDS) {
      expect(tileHeaderStatusFor(kind, undefined, T0, T0 + 60_000).ready).toBe(false);
    }
  });

  it("renders a store tile: unscanned is working, a null shell verdict keeps its fallback", () => {
    expect(tileHeaderStatusFor("shell", undefined, T0, T0 + 60_000)).toEqual({
      ready: false,
      workingSince: T0,
    });
    const unanswered: Readiness = { lastOutputAt: T0 + 1000, matcherIdle: null, leftReadyAt: T0 };
    expect(tileHeaderStatusFor("shell", unanswered, T0, T0 + 1000 + READY_QUIET_MS)).toEqual({
      ready: true,
    });
    expect(tileHeaderStatusFor("shell", unanswered, T0, T0 + 1500).ready).toBe(false);
  });

  it("never counts from the future", () => {
    expect(tileHeaderStatus("claude", T0, false, T0 + 10, T0)).toEqual({
      ready: false,
      workingSince: T0,
    });
  });
});

// --- nextReadiness ------------------------------------------------------------

describe("nextReadiness", () => {
  const readyTile: Readiness = { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 - 9000 };

  it("restarts the counter when a Ready tile leaves Ready", () => {
    const now = T0 + 30_000;
    for (const kind of KINDS) {
      const next = nextReadiness(kind, readyTile, { lastOutputAt: now - 250, matcherIdle: false }, now);
      expect(next.leftReadyAt).toBe(now - 250);
      const status = tileHeaderStatus(kind, next.lastOutputAt, next.matcherIdle, next.leftReadyAt, now);
      expect(status).toEqual({ ready: false, workingSince: now - 250 });
    }
  });

  it("restarts it on activity with the matcher still idle (Codex streaming)", () => {
    const now = T0 + 30_000;
    const next = nextReadiness("codex", readyTile, { lastOutputAt: now - 100, matcherIdle: true }, now);
    expect(next.leftReadyAt).toBe(now - 100);
  });

  it("does not restart it when the tile had not reached Ready yet", () => {
    // Idle for 1.5 s, then busy again: one working stretch, one counter.
    const notYet: Readiness = { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 - 9000 };
    const now = T0 + READY_QUIET_MS - 500;
    const next = nextReadiness("claude", notYet, { lastOutputAt: now, matcherIdle: false }, now);
    expect(next.leftReadyAt).toBe(T0 - 9000);
  });

  it("never dates leaving Ready before the tile became Ready", () => {
    const now = T0 + 10_000;
    const next = nextReadiness("shell", readyTile, { lastOutputAt: T0 + 1000, matcherIdle: false }, now);
    expect(next.leftReadyAt).toBe(T0 + READY_QUIET_MS);
  });

  it("returns the same object when the header would not change", () => {
    const busy: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
    expect(nextReadiness("codex", busy, { lastOutputAt: T0 + 900, matcherIdle: false }, T0 + 1000)).toBe(busy);
    expect(nextReadiness("codex", readyTile, { lastOutputAt: T0, matcherIdle: true }, T0 + 5000)).toBe(readyTile);
  });

  it("takes the activity stamp when a busy tile's matcher turns idle", () => {
    const busy: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
    const next = nextReadiness("claude", busy, { lastOutputAt: T0 + 7000, matcherIdle: true }, T0 + 7300);
    expect(next).toEqual({ lastOutputAt: T0 + 7000, matcherIdle: true, leftReadyAt: T0 });
    expect(tileHeaderStatus("claude", next.lastOutputAt, true, next.leftReadyAt, T0 + 8999).ready).toBe(false);
    expect(tileHeaderStatus("claude", next.lastOutputAt, true, next.leftReadyAt, T0 + 9000).ready).toBe(true);
  });
});

// --- screens -----------------------------------------------------------------
// Codex frames as captured from codex-cli 0.154.0 in attention.test.ts.

const CODEX_HEADER = [
  "",
  "╭───────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                │",
  "│                                           │",
  "│ model:     gpt-6-astra   /model to change │",
  "│ directory: ~/code/atelier                 │",
  "╰───────────────────────────────────────────╯",
  "",
  "  Tip: Try the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex",
  "",
];
const FOOTER = "  gpt-6-astra default · ~/code/atelier";
const BLANK_ROWS = Array.from({ length: 20 }, () => "");

const CODEX_FRESH = [...CODEX_HEADER, "› Ask Codex to do anything", "", FOOTER, ...BLANK_ROWS];
const CODEX_STARFIELD_A = [
  ...CODEX_HEADER,
  "  ·      .         ·     .            ·",
  "›·    .        ·        .     ·",
  "",
  FOOTER,
  ...BLANK_ROWS,
];
const CODEX_STARFIELD_B = [
  ...CODEX_HEADER,
  "     .    ·           .        ·",
  "› .     ·     .           ·",
  "",
  FOOTER,
  ...BLANK_ROWS,
];
const CODEX_WORKING = [
  ...CODEX_HEADER,
  "› count slowly from 1 to 40",
  "",
  "• Working (2s • esc to interrupt)",
  "",
  "",
  "› Ask Codex to do anything",
  "",
  `${FOOTER} · renaming... ⠇`,
];
const codexStreaming = (words: string[]) => [
  "› Write the numbers from 1 to 120 in Italian words, one per line.",
  "",
  ...words.map((w, i) => (i === 0 ? `• ${w}` : `  ${w}`)),
  "",
  "",
  "› Ask Codex to do anything",
  "",
  FOOTER,
];
const CODEX_APPROVAL = [
  "• Running touch /tmp/ply-probe.txt",
  "",
  "  Would you like to run the following command?",
  "",
  "  $ touch /tmp/ply-probe.txt",
  "",
  "› 1. Yes, proceed (y)",
  "  2. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

const CLAUDE_TRANSCRIPT = ["> fix the build", "", "⏺ Fixed: the import was missing.", ""];
const CLAUDE_RULE = "─".repeat(60);
// Rows as Terminal reads them: `translateToString(true)` trims trailing
// whitespace, so an empty prompt is a bare `❯`.
const trimmedRows = (rows: string[]) => rows.map((row) => row.trimEnd());
const claudeIdle = (draft: string) =>
  trimmedRows([
    ...CLAUDE_TRANSCRIPT,
    CLAUDE_RULE,
    `❯ ${draft}`,
    CLAUDE_RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ]);
const claudeWorking = (spinner: string) =>
  trimmedRows([
    ...CLAUDE_TRANSCRIPT,
    `${spinner} Pondering… (4s · ↑ 120 tokens · esc to interrupt)`,
    "",
    CLAUDE_RULE,
    "❯ ",
    CLAUDE_RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ]);

describe("readinessProbe", () => {
  it("reads an idle Codex composer as idle, animated or not, with one signature", () => {
    const fresh = readinessProbe("codex", CODEX_FRESH);
    const a = readinessProbe("codex", CODEX_STARFIELD_A);
    const b = readinessProbe("codex", CODEX_STARFIELD_B);
    expect(fresh.idle).toBe(true);
    expect(a.idle).toBe(true);
    expect(b.idle).toBe(true);
    expect(a.signature).toBe(fresh.signature);
    expect(b.signature).toBe(fresh.signature);
  });

  it("reads a Codex turn with its working status as busy", () => {
    expect(readinessProbe("codex", CODEX_WORKING).status).toBe("• Working (2s • esc to interrupt)");
  });

  it("changes the signature while Codex streams an answer under an idle-looking composer", () => {
    const one = readinessProbe("codex", codexStreaming(["uno", "due"]));
    const two = readinessProbe("codex", codexStreaming(["uno", "due", "tre"]));
    expect(one.idle).toBe(true);
    expect(two.idle).toBe(true);
    expect(one.signature === two.signature).toBe(false);
  });

  it("reads a long unsent Codex draft as idle, with the signature it had when empty", () => {
    const draft = Array.from({ length: 24 }, (_, i) => `  draft line ${i + 1}`);
    const long = [...CODEX_HEADER, "› start of a long draft", ...draft, "", FOOTER, ...BLANK_ROWS];
    const p = readinessProbe("codex", long);
    expect(p.idle).toBe(true);
    expect(p.signature).toBe(readinessProbe("codex", CODEX_FRESH).signature);
  });

  it("still reads a past prompt above transcript output as busy, and a long draft under a turn", () => {
    const pastPrompt = [
      "› fix the build",
      "",
      ...Array.from({ length: 12 }, (_, i) => (i === 0 ? "• Ran cargo build" : `  line ${i}`)),
    ];
    expect(readinessProbe("codex", pastPrompt).idle).toBe(false);
    const draft = Array.from({ length: 12 }, (_, i) => `  draft line ${i + 1}`);
    const underTurn = [
      "• Working (3s • esc to interrupt)",
      "",
      "› start of a long draft",
      ...draft,
      "",
      FOOTER,
    ];
    expect(readinessProbe("codex", underTurn).status).toBe("• Working (3s • esc to interrupt)");
  });

  it("reads a Codex approval as waiting for input", () => {
    expect(readinessProbe("codex", CODEX_APPROVAL).idle).toBe(true);
  });

  it("reads Claude's prompt box as idle, and a draft does not change the signature", () => {
    const empty = readinessProbe("claude", claudeIdle(""));
    const typed = readinessProbe("claude", claudeIdle("add a test for the parser"));
    expect(empty.idle).toBe(true);
    expect(typed.idle).toBe(true);
    expect(typed.signature).toBe(empty.signature);
  });

  it("anchors on an empty Claude prompt read back as a bare ❯, not an older prompt above", () => {
    const empty = claudeIdle("");
    expect(empty.includes("❯")).toBe(true);
    const sig = readinessProbe("claude", empty).signature;
    expect(sig).toBe("> fix the build\n⏺ Fixed: the import was missing.");
    expect(sig.includes("auto mode")).toBe(false);
    // Typing a draft and clearing it again keeps the signature.
    expect(readinessProbe("claude", claudeIdle("x")).signature).toBe(sig);
    expect(readinessProbe("claude", claudeIdle("")).signature).toBe(sig);
  });

  it("reads Claude as busy while its spinner says a turn is running", () => {
    const a = readinessProbe("claude", claudeWorking("✻"));
    const b = readinessProbe("claude", claudeWorking("✽"));
    expect(a.status !== null && b.status !== null).toBe(true);
    // The spinner glyph cycles: a live status changes between frames.
    expect(a.status === b.status).toBe(false);
  });

  it("reads Claude as busy with a todo list drawn between its spinner and the box", () => {
    const todos = trimmedRows([
      ...CLAUDE_TRANSCRIPT,
      "✶ Cogitating… (12s · esc to interrupt · ctrl+t to hide todos)",
      "  ⎿  ☒ Read the parser",
      "     ☐ Add the failing test",
      "     ☐ Fix the tokenizer",
      "     ☐ Run the suite",
      "",
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
    ]);
    expect(readinessProbe("claude", todos).status !== null).toBe(true);
  });

  it("reads Claude as busy under a todo list taller than any fixed window", () => {
    const todoRows = Array.from({ length: 18 }, (_, i) => `     ☐ Step ${i + 1} of the migration`);
    const tall = trimmedRows([
      "> migrate the store",
      "",
      "⏺ Planning the migration.",
      "",
      "✶ Cogitating… (40s · esc to interrupt · ctrl+t to hide todos)",
      "  ⎿  ☒ Read the store",
      ...todoRows,
      "",
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
    ]);
    expect(readinessProbe("claude", tall).status !== null).toBe(true);
    // The same screen once the turn ends and the spinner is gone.
    const done = tall.filter((row) => !row.includes("esc to interrupt"));
    expect(readinessProbe("claude", done).idle).toBe(true);
    expect(readinessProbe("claude", done).status).toBe(null);
  });

  it("cannot call Claude idle when a tall todo list pushes the turn's start off the visible page", () => {
    const todoRows = Array.from({ length: 18 }, (_, i) => `     ☐ Step ${i + 1} of the migration`);
    const full = trimmedRows([
      "> migrate the store",
      "",
      "⏺ Planning the migration.",
      "",
      "✶ Cogitating… (40s · esc to interrupt · ctrl+t to hide todos)",
      "  ⎿  ☒ Read the store",
      ...todoRows,
      "",
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
    ]);
    // What Terminal's screenRows returns for a 20-row tile: the bottom page.
    const page = full.slice(-20);
    expect(page.some((row) => row.includes("esc to interrupt"))).toBe(false);
    expect(readinessProbe("claude", page).idle).toBe(null);
    expect(readinessProbe("claude", page).status).toBe(null);
    // The turn's start in view again (a short answer, a tall tile): judged.
    expect(readinessProbe("claude", full).status !== null).toBe(true);
    expect(readinessProbe("claude", claudeIdle("")).idle).toBe(true);
  });

  it("does not take a status row from a finished turn above the prompt that started this one", () => {
    const codex = [
      "• Working (2s • esc to interrupt)",
      "",
      "› next question",
      "",
      "• An answer.",
      "",
      "› Ask Codex to do anything",
      "",
      FOOTER,
    ];
    expect(readinessProbe("codex", codex).idle).toBe(true);
    expect(readinessProbe("codex", codex).status).toBe(null);
  });

  it("is not fooled by `esc to interrupt` typed into a draft or written in an answer", () => {
    const claudeDraft = claudeIdle("why does the spinner say (esc to interrupt)");
    expect(readinessProbe("claude", claudeDraft).idle).toBe(true);
    const claudeAnswer = trimmedRows([
      "> what does the footer mean",
      "",
      "⏺ While a turn runs, the status line reads esc to interrupt: press Esc.",
      "",
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
    ]);
    expect(readinessProbe("claude", claudeAnswer).idle).toBe(true);
    const codexDraft = [...CODEX_HEADER, "› the footer said (esc to interrupt)", "  and then stopped", "", FOOTER];
    expect(readinessProbe("codex", codexDraft).idle).toBe(true);
    const codexAnswer = [
      "› what does the status mean",
      "",
      "• It reads Working (2s • esc to interrupt) while a turn runs,",
      "  and Esc stops it.",
      "",
      "› Ask Codex to do anything",
      "",
      FOOTER,
    ];
    expect(readinessProbe("codex", codexAnswer).idle).toBe(true);
  });

  it("reads a Claude permission prompt as waiting for input, box or no box", () => {
    const framed = trimmedRows([
      "> add a test",
      "",
      "⏺ I'll run the suite.",
      "",
      "╭──────────────────────────────────────────╮",
      "│ Bash command                             │",
      "│                                          │",
      "│ npm test                                 │",
      "│                                          │",
      "│ Do you want to proceed?                  │",
      "│ ❯ 1. Yes                                 │",
      "│   2. Yes, and don't ask again            │",
      "│   3. No, and tell Claude what to do      │",
      "╰──────────────────────────────────────────╯",
    ]);
    expect(readinessProbe("claude", framed).idle).toBe(true);
    // The same dialog drawn without a box, and with this turn's start off
    // the visible page.
    const bare = trimmedRows([
      "  Edit file src/lib/parser.ts",
      "",
      "  Do you want to make this edit?",
      "  ❯ 1. Yes",
      "    2. No, and tell Claude what to do differently",
    ]);
    expect(readinessProbe("claude", bare).idle).toBe(true);
  });

  it("keeps a Claude turn that quotes a decision question Working while its status is live", () => {
    const quoting = trimmedRows([
      "> what does the permission prompt say",
      "",
      "⏺ It asks: Do you want to proceed?",
      "",
      "✻ Pondering… (8s · esc to interrupt)",
      "",
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
    ]);
    const p = readinessProbe("claude", quoting);
    expect(p.idle).toBe(true); // the text alone reads as waiting…
    const { seen } = simulate("claude", T0, [
      { at: T0, idle: p.idle, status: p.status, signature: p.signature },
      { at: T0 + 1000, idle: p.idle, status: "✽ Pondering… (9s · esc to interrupt)", signature: p.signature },
    ]);
    // …but the live spinner above the box decides.
    expect(seen).toEqual(["Working 0s", "Working 1s"]);
  });

  it("reads a screen with no prompt at all as busy", () => {
    expect(readinessProbe("claude", ["$ claude", "Loading…"]).idle).toBe(false);
    expect(readinessProbe("codex", ["$ codex", "Starting…"]).idle).toBe(false);
  });
});

// --- foldScan, end to end with the store fold ---------------------------------

type Frame = {
  at: number;
  idle: boolean | null;
  status?: string | null;
  signature?: string;
  sawData?: boolean;
  rebaselining?: boolean;
};

/** Run scans through foldScan + nextReadiness the way Terminal and the tile
 *  store do, sampling the header at each scan (a scan lands 300 ms after
 *  the output it follows). */
function simulate(kind: ReadinessKind, startedAt: number, frames: Frame[]) {
  // As Terminal: activity starts at the spawn.
  let memory: ScanMemory = { ...FRESH_SCAN_MEMORY, activityAt: startedAt };
  let readiness: Readiness = { lastOutputAt: startedAt, matcherIdle: false, leftReadyAt: startedAt };
  const header = (now: number) =>
    tileHeaderStatus(kind, readiness.lastOutputAt, readiness.matcherIdle, readiness.leftReadyAt, now);
  const seen: string[] = [];
  for (const f of frames) {
    const scanAt = f.at + 300;
    memory = foldScan(memory, {
      idle: f.idle,
      status: f.status ?? null,
      signature: f.signature ?? "",
      sawData: f.sawData ?? true,
      // As Terminal: with no output since the last scan, the scan's own time.
      dataAt: f.sawData === false ? scanAt : f.at,
      rebaselining: f.rebaselining ?? false,
      now: scanAt,
    });
    readiness = nextReadiness(
      kind,
      readiness,
      { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null },
      scanAt,
    );
    const h = header(scanAt);
    seen.push(h.ready ? "Ready" : `Working ${Math.floor((scanAt - h.workingSince) / 1000)}s`);
  }
  return { seen, header };
}

describe("foldScan", () => {
  it("does not flicker while an idle Codex composer animates", () => {
    const sig = readinessProbe("codex", CODEX_FRESH).signature;
    const frames: Frame[] = [{ at: T0, idle: true, signature: sig }];
    for (let t = 400; t <= 20_000; t += 400) {
      const screen = t % 800 === 0 ? CODEX_STARFIELD_A : CODEX_STARFIELD_B;
      const p = readinessProbe("codex", screen);
      frames.push({ at: T0 + t, idle: p.idle, signature: p.signature });
    }
    const { seen } = simulate("codex", T0 - 1000, frames);
    const firstReady = seen.indexOf("Ready");
    expect(firstReady > 0).toBe(true);
    expect(seen.slice(firstReady).every((s) => s === "Ready")).toBe(true);
  });

  it("goes working for a Codex answer streamed under an idle-looking composer, then Ready 2 s after it lands", () => {
    const idleSig = readinessProbe("codex", CODEX_FRESH).signature;
    const words = ["uno", "due", "tre", "quattro", "cinque", "sei"];
    const frames: Frame[] = [
      { at: T0, idle: true, signature: idleSig },
      { at: T0 + 5000, idle: true, signature: idleSig },
    ];
    words.forEach((_, i) => {
      const p = readinessProbe("codex", codexStreaming(words.slice(0, i + 1)));
      frames.push({ at: T0 + 10_000 + i * 400, idle: p.idle, signature: p.signature });
    });
    const done = readinessProbe("codex", codexStreaming(words));
    const lastWordAt = T0 + 10_000 + (words.length - 1) * 400;
    const { seen, header } = simulate("codex", T0 - 1000, frames);
    expect(seen[1]).toBe("Ready");
    expect(seen[2]).toBe("Working 0s");
    expect(seen[seen.length - 1]).toBe("Working 2s");
    expect(done.idle).toBe(true);
    expect(header(lastWordAt + READY_QUIET_MS - 1).ready).toBe(false);
    expect(header(lastWordAt + READY_QUIET_MS).ready).toBe(true);
  });

  it("times `sleep 5` in a shell: working from Enter, Ready 2 s after the prompt returns", () => {
    const enterAt = T0 + 10_000;
    const promptAt = enterAt + 5000;
    const { seen, header } = simulate("shell", T0, [
      { at: T0, idle: true }, // the first prompt
      { at: T0 + 4000, idle: true }, // typing `sleep 5`: echo, still at the prompt
      { at: enterAt, idle: false }, // Enter: sleep holds the foreground
      { at: promptAt, idle: true }, // the prompt is back
    ]);
    expect(seen).toEqual(["Working 0s", "Ready", "Working 0s", "Working 5s"]);
    expect(header(promptAt + READY_QUIET_MS - 1)).toEqual({ ready: false, workingSince: enterAt });
    expect(header(promptAt + READY_QUIET_MS).ready).toBe(true);
  });

  it("rechecks only a busy shell without output", () => {
    expect(readinessRecheckMs("shell", false, false)).toBe(SHELL_BUSY_RECHECK_MS);
    // Unknown is rechecked too: `read -t 5` times out into the next command
    // with no output. Only the line editor holding the prompt stops it, and
    // that ends with a submitted line, which schedules its own scan.
    expect(readinessRecheckMs("shell", null, false)).toBe(SHELL_BUSY_RECHECK_MS);
    expect(readinessRecheckMs("shell", true, false)).toBe(null);
    expect(readinessRecheckMs("claude", false, false)).toBe(null);
    expect(readinessRecheckMs("codex", true, false)).toBe(null);
  });

  it("rechecks a Claude or Codex screen once a status row on it would be stale", () => {
    expect(readinessRecheckMs("claude", false, true)! > STATUS_STALE_MS).toBe(true);
    expect(readinessRecheckMs("codex", false, true)! > STATUS_STALE_MS).toBe(true);
  });

  it("times `sleep 5; read answer`: a silent turn into `read` reaches Ready through the recheck", () => {
    const enterAt = T0 + 10_000;
    // The recheck that finds `read` (no output since) runs 300 ms after its
    // frame and is stamped at its own time.
    const readFoundAt = enterAt + 6000 + 300;
    const { seen, header } = simulate("shell", T0, [
      { at: T0, idle: true },
      { at: enterAt, idle: false }, // Enter: sleep holds the foreground
      { at: enterAt + 1000, idle: false, sawData: false }, // rechecks while sleep runs
      { at: enterAt + 4000, idle: false, sawData: false },
      { at: enterAt + 6000, idle: null, sawData: false }, // read: the probe cannot say
    ]);
    expect(seen.slice(0, 4)).toEqual(["Working 0s", "Working 0s", "Working 1s", "Working 4s"]);
    expect(header(readFoundAt + READY_QUIET_MS - 1)).toEqual({ ready: false, workingSince: enterAt });
    expect(header(readFoundAt + READY_QUIET_MS).ready).toBe(true);
  });

  it("keeps a Claude turn with its spinner off the page Working while the spinner writes, then Ready", () => {
    // The page holds the box and the todo list only: the probe cannot say.
    // The spinner above the page keeps writing until the turn ends.
    const frames: Frame[] = [{ at: T0, idle: false }];
    for (let t = 400; t <= 12_000; t += 400) frames.push({ at: T0 + t, idle: null });
    const { seen, header } = simulate("claude", T0 - 5000, frames);
    expect(seen.every((label) => label.startsWith("Working"))).toBe(true);
    expect(header(T0 + 12_000 + READY_QUIET_MS - 1).ready).toBe(false);
    expect(header(T0 + 12_000 + READY_QUIET_MS).ready).toBe(true);
  });

  it("keeps a Codex turn Working while its status counts seconds", () => {
    const frames: Frame[] = [];
    for (let sec = 0; sec <= 20; sec++) {
      const screen = [...CODEX_WORKING.slice(0, 12), `• Working (${sec}s • esc to interrupt)`, ...CODEX_WORKING.slice(13)];
      const p = readinessProbe("codex", screen);
      frames.push({ at: T0 + sec * 1000, idle: p.idle, status: p.status, signature: p.signature });
      // The idle-looking composer animates in between.
      frames.push({ at: T0 + sec * 1000 + 500, idle: p.idle, status: p.status, signature: p.signature });
    }
    const { seen } = simulate("codex", T0, frames);
    expect(seen.every((label) => label.startsWith("Working"))).toBe(true);
  });

  it("reaches Ready under a Codex answer that quotes a status row, as the composer animates", () => {
    const answer = [
      "› what does the status mean",
      "",
      "• The status reads Working (2s • esc to interrupt)",
      "",
      "›·   .     ·",
      "",
      FOOTER,
    ];
    const p = readinessProbe("codex", answer);
    expect(p.status).toBe("• The status reads Working (2s • esc to interrupt)");
    expect(p.idle).toBe(true);
    const frames: Frame[] = [];
    for (let t = 0; t <= 10_000; t += 400) {
      frames.push({ at: T0 + t, idle: p.idle, status: p.status, signature: p.signature });
    }
    const { seen } = simulate("codex", T0 - 1000, frames);
    expect(seen[0]).toBe("Working 1s");
    const firstReady = seen.indexOf("Ready");
    // Stale after 3 s, then the 2 s quiet window: Ready about 5 s in.
    expect(firstReady > 0 && T0 + firstReady * 400 <= T0 + STATUS_STALE_MS + READY_QUIET_MS + 400).toBe(true);
    expect(seen.slice(firstReady).every((label) => label === "Ready")).toBe(true);
  });

  it("reaches Ready under a silent Claude answer that quotes a status row, through the recheck", () => {
    const answer = trimmedRows([
      "> what does the spinner say",
      "",
      "⏺ It reads ✻ Pondering… (esc to interrupt)",
      "",
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
    ]);
    const p = readinessProbe("claude", answer);
    expect(p.status).toBe("⏺ It reads ✻ Pondering… (esc to interrupt)");
    expect(p.idle).toBe(true);
    const recheckAfter = readinessRecheckMs("claude", false, true)!;
    const { seen, header } = simulate("claude", T0 - 1000, [
      { at: T0, idle: p.idle, status: p.status, signature: p.signature },
      // No more output: the recheck scans the same screen on its own.
      { at: T0 + recheckAfter, idle: p.idle, status: p.status, signature: p.signature, sawData: false },
    ]);
    expect(seen).toEqual(["Working 1s", "Working 4s"]);
    const recheckAt = T0 + recheckAfter + 300;
    expect(header(recheckAt + READY_QUIET_MS - 1).ready).toBe(false);
    expect(header(recheckAt + READY_QUIET_MS).ready).toBe(true);
  });

  it("judges a shell whose first prompt was printed before Plyloft could listen", () => {
    // Terminal scans once after binding the PTY, with no output to go on.
    const { seen, header } = simulate("shell", T0, [{ at: T0 + 40, idle: true, sawData: false }]);
    expect(seen).toEqual(["Working 0s"]);
    expect(header(T0 + 340 + READY_QUIET_MS - 1).ready).toBe(false);
    expect(header(T0 + 340 + READY_QUIET_MS).ready).toBe(true);
    // The same first scan when the probe cannot say: quiet decides, and the
    // window runs from the spawn, not from zero.
    const unknown = simulate("shell", T0, [{ at: T0 + 40, idle: null, sawData: false }]);
    expect(unknown.header(T0 + READY_QUIET_MS - 1).ready).toBe(false);
    expect(unknown.header(T0 + READY_QUIET_MS).ready).toBe(true);
  });

  it("reads a shell's PTY state with its command block", () => {
    for (const open of [false, true]) {
      expect(shellVerdict("running", open)).toBe(false);
      expect(shellVerdict("editing", open)).toBe(true);
      // A builtin `read` waits for input inside an open block (GH #70): the
      // block must not pin it to Working, so quiet decides here too.
      expect(shellVerdict("canonical", open)).toBe(null);
    }
    // The PTY cannot answer: the open block is the only busy signal left.
    expect(shellVerdict(null, true)).toBe(false);
    expect(shellVerdict(null, false)).toBe(null);
  });

  it("times `read answer` under shell integration: Ready while it waits", () => {
    // The block opens on Enter and only closes when the prompt returns.
    const enterAt = T0 + 10_000;
    const { seen, header } = simulate("shell", T0, [
      { at: T0, idle: shellVerdict("editing", false) },
      { at: enterAt, idle: shellVerdict("canonical", true), sawData: false },
      { at: enterAt + 1000, idle: shellVerdict("canonical", true), sawData: false },
    ]);
    expect(seen).toEqual(["Working 0s", "Ready", "Ready"]);
    expect(header(enterAt + 60_000).ready).toBe(true);
  });

  it("scans after a submitted line, not after every keystroke", () => {
    expect(isSubmission("\r")).toBe(true);
    expect(isSubmission("ls -la\r")).toBe(true);
    expect(isSubmission("\n")).toBe(true);
    expect(isSubmission("a")).toBe(false);
    expect(isSubmission("\x1b[A")).toBe(false);
    expect(isSubmission("")).toBe(false);
  });

  it("times a silent `read -s answer; sleep 30`: the answer starts the counter", () => {
    // Nothing is echoed and `sleep` prints nothing: the scans come from the
    // submission and from the busy recheck, not from output.
    const answerAt = T0 + 20_000;
    const { seen, header } = simulate("shell", T0, [
      { at: T0, idle: true }, // the prompt, before `read -s` was started
      { at: T0 + 5000, idle: null, sawData: false }, // `read -s`: no line editor
      { at: answerAt, idle: false, sawData: false }, // the answer submitted: sleep runs
      { at: answerAt + 1000, idle: false, sawData: false }, // rechecks
      { at: answerAt + 30_000, idle: true }, // the prompt is back
    ]);
    // Ready at the silent read — the shell is waiting for the user there.
    expect(seen).toEqual(["Working 0s", "Ready", "Working 0s", "Working 1s", "Working 30s"]);
    expect(header(answerAt + 30_300 + READY_QUIET_MS).ready).toBe(true);
  });

  it("times `read -t 5 answer; sleep 30` left unanswered: the recheck finds `sleep`", () => {
    const readAt = T0 + 10_000;
    const timeoutAt = readAt + 5000;
    const { seen, header } = simulate("shell", T0, [
      { at: T0, idle: true }, // the prompt
      { at: readAt, idle: null, sawData: false }, // the submitted line starts `read -t 5`
      { at: readAt + 1000, idle: null, sawData: false }, // rechecks while it waits
      { at: readAt + 4000, idle: null, sawData: false },
      { at: timeoutAt, idle: false, sawData: false }, // it timed out: `sleep` runs
      { at: timeoutAt + 1000, idle: false, sawData: false },
    ]);
    expect(seen).toEqual(["Working 0s", "Ready", "Ready", "Ready", "Working 0s", "Working 1s"]);
    expect(header(timeoutAt + 10_000)).toEqual({ ready: false, workingSince: timeoutAt + 300 });
  });

  it("keeps a shell Ready through output at its prompt", () => {
    const { seen } = simulate("shell", T0, [
      { at: T0, idle: true },
      { at: T0 + 3000, idle: true },
      { at: T0 + 3100, idle: true },
      { at: T0 + 9000, idle: true },
    ]);
    expect(seen.slice(1)).toEqual(["Ready", "Ready", "Ready"]);
  });

  it("counts every output as activity when the shell probe cannot answer", () => {
    const { seen, header } = simulate("shell", T0, [
      { at: T0, idle: null },
      { at: T0 + 5000, idle: null },
      { at: T0 + 5400, idle: null, sawData: false },
    ]);
    expect(seen).toEqual(["Working 0s", "Working 0s", "Working 0s"]);
    expect(header(T0 + 5000 + READY_QUIET_MS).ready).toBe(true);
  });

  it("does not count a resize redraw as activity", () => {
    const { seen } = simulate("claude", T0, [
      { at: T0, idle: true, signature: "a" },
      { at: T0 + 5000, idle: true, signature: "a reflowed", rebaselining: true },
      { at: T0 + 5400, idle: true, signature: "a reflowed" },
    ]);
    expect(seen.slice(1)).toEqual(["Ready", "Ready"]);
  });

  // Block 10 Mac walk: after a zoom, a Claude tile read "Working for 1s".
  it("does not read a prompt box missed mid-redraw as a turn", () => {
    const { seen } = simulate("claude", T0, [
      { at: T0, idle: true, signature: "a" },
      { at: T0 + 5000, idle: true, signature: "a" },
      { at: T0 + 9000, idle: false, signature: "half drawn", rebaselining: true },
      // Still inside the 1.5 s window: the redraw has finished.
      { at: T0 + 9400, idle: true, signature: "a reflowed", rebaselining: true },
    ]);
    expect(seen.slice(1)).toEqual(["Ready", "Ready", "Ready"]);
  });

  it("still reads a real status line during a resize as working", () => {
    const busy = readinessProbe("claude", claudeWorking("✻"));
    const { seen } = simulate("claude", T0, [
      { at: T0, idle: true, signature: "a" },
      { at: T0 + 5000, idle: true, signature: "a" },
      { at: T0 + 9000, idle: busy.idle, status: busy.status, signature: busy.signature, rebaselining: true },
    ]);
    expect(seen[2].startsWith("Working")).toBe(true);
  });

  it("runs a Claude turn: Ready, working from the prompt, Ready after the answer", () => {
    const idle = readinessProbe("claude", claudeIdle(""));
    const busy = readinessProbe("claude", claudeWorking("✻"));
    const { seen, header } = simulate("claude", T0, [
      { at: T0, idle: idle.idle, signature: idle.signature },
      { at: T0 + 4000, idle: idle.idle, signature: idle.signature },
      { at: T0 + 20_000, idle: busy.idle, status: busy.status, signature: busy.signature },
      { at: T0 + 26_000, idle: busy.idle, status: readinessProbe("claude", claudeWorking("✽")).status, signature: busy.signature },
      { at: T0 + 30_000, idle: idle.idle, signature: idle.signature },
    ]);
    expect(seen).toEqual(["Working 0s", "Ready", "Working 0s", "Working 6s", "Working 10s"]);
    expect(header(T0 + 31_999).ready).toBe(false);
    expect(header(T0 + 32_000).ready).toBe(true);
  });
});

// --- createScanScheduler -----------------------------------------------------

/** A fake clock whose timers run as time advances. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout: (run: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout: (timer: unknown) => {
        timers.delete(timer as number);
      },
    },
    /** Advance to `to`, running due timers in deadline order. */
    advance(to: number) {
      for (;;) {
        let due: [number, { at: number; run: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= to && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (due === null) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = to;
    },
    pending: () => timers.size,
  };
}

describe("createScanScheduler", () => {
  it("lets parsed output pull a pending recheck forward", () => {
    const t = fakeClock();
    const runs: number[] = [];
    const scans = createScanScheduler(() => runs.push(t.clock.now()), t.clock);
    scans.request(STATUS_STALE_MS + 50);
    t.advance(100);
    scans.request(READINESS_SCAN_MS);
    t.advance(10_000);
    expect(runs).toEqual([100 + READINESS_SCAN_MS]);
  });

  it("never lets a recheck push back a scan output asked for, nor stacks timers", () => {
    const t = fakeClock();
    const runs: number[] = [];
    const scans = createScanScheduler(() => runs.push(t.clock.now()), t.clock);
    scans.request(READINESS_SCAN_MS);
    scans.request(STATUS_STALE_MS + 50);
    scans.request(READINESS_SCAN_MS);
    expect(t.pending()).toBe(1);
    t.advance(10_000);
    expect(runs).toEqual([READINESS_SCAN_MS]);
  });

  it("cancels its pending scan", () => {
    const t = fakeClock();
    let ran = false;
    const scans = createScanScheduler(() => {
      ran = true;
    }, t.clock);
    scans.request(READINESS_SCAN_MS);
    scans.cancel();
    t.advance(10_000);
    expect(ran).toBe(false);
  });

  it("keeps scanning streamed output every 300 ms while a status row asks for rechecks, and never flashes Ready", () => {
    // Terminal's loop: each parse asks for a scan in 300 ms; each scan that
    // sees a status-shaped row asks for a recheck once it would be stale.
    // The answer streams under an unchanged quoted status row for 12 s.
    const t = fakeClock();
    const quoted = "• The status reads Working (2s • esc to interrupt)";
    let memory: ScanMemory = FRESH_SCAN_MEMORY;
    let readiness: Readiness = { lastOutputAt: 0, matcherIdle: false, leftReadyAt: 0 };
    let lastDataAt = 0;
    let dataSinceScan = false;
    let words = 0;
    const scanTimes: number[] = [];
    const labels: string[] = [];
    const scans = createScanScheduler(() => {
      const now = t.clock.now();
      scanTimes.push(now);
      const sawData = dataSinceScan;
      dataSinceScan = false;
      memory = foldScan(memory, {
        idle: true,
        status: quoted,
        signature: `answer with ${words} words`,
        sawData,
        dataAt: sawData ? lastDataAt : now,
        rebaselining: false,
        now,
      });
      readiness = nextReadiness(
        "codex",
        readiness,
        { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null },
        now,
      );
      scans.request(readinessRecheckMs("codex", memory.lastVerdict ?? null, true)!);
    }, t.clock);
    for (let at = 0; at <= 12_000; at += 200) {
      t.advance(at);
      words++;
      lastDataAt = at;
      dataSinceScan = true;
      scans.request(READINESS_SCAN_MS); // the parse callback
      const h = tileHeaderStatus("codex", readiness.lastOutputAt, readiness.matcherIdle, readiness.leftReadyAt, at);
      labels.push(h.ready ? "Ready" : "Working");
    }
    const gaps = scanTimes.slice(1).map((time, i) => time - scanTimes[i]);
    expect(gaps.every((gap) => gap <= READINESS_SCAN_MS + 200)).toBe(true);
    expect(labels.includes("Ready")).toBe(false);
    // The stream stops: stale, quiet, Ready.
    t.advance(12_000 + STATUS_STALE_MS + READY_QUIET_MS + 1000);
    const end = t.clock.now();
    expect(tileHeaderStatus("codex", readiness.lastOutputAt, readiness.matcherIdle, readiness.leftReadyAt, end).ready).toBe(true);
  });
});

// --- report ----------------------------------------------------------------

// --- QoL 1.168 (M2, M3): what closing a tile must know -----------------------

describe("readinessProbe › waiting and background (QoL 1.168)", () => {
  it("a Claude permission prompt is idle for the header but waiting", () => {
    const screen = trimmedRows([
      ...CLAUDE_TRANSCRIPT,
      " Do you want to make this edit to sum.js?",
      " ❯ 1. Yes",
      "   2. No, and tell Claude what to do differently",
    ]);
    const p = readinessProbe("claude", screen);
    expect(p.idle).toBe(true);
    expect(p.waiting).toBe(true);
  });
  it("Codex's folder-trust screen is waiting: 0.171's wording and 0.158's (1.176.2)", () => {
    // Recorded from a Codex 0.171 tile (walk 2026-11-22): "enter continue",
    // with no "press" and no "to". The tile read "Your turn".
    const v171 = trimmedRows([
      "Folder access",
      "/Users/o/my-site",
      "",
      "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run",
      "code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.",
      "",
      "› 1. Trust and continue",
      "  2. Back to Agent Command Center",
      "",
      "  enter continue · esc back",
    ]);
    expect(readinessProbe("codex", v171).waiting).toBe(true);
    const v158 = v171.map((r) => r.replace("Back to Agent Command Center", "Quit").replace("esc back", "esc quit"));
    expect(readinessProbe("codex", v158).waiting).toBe(true);
    // Codex's own composer is not a decision.
    expect(readinessProbe("codex", trimmedRows(["› Ask Codex to do anything", "", "  ⏎ send   ⌃J newline"])).waiting).toBe(false);
  });
  it("a plain Claude prompt is neither waiting nor busy in the background", () => {
    const p = readinessProbe("claude", claudeIdle(""));
    expect(p.waiting).toBe(false);
    expect(p.background).toBe(false);
  });
  it("background work in the footer below the prompt counts", () => {
    const screen = trimmedRows([
      ...CLAUDE_TRANSCRIPT,
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
      "  ⏵⏵ auto mode on (shift+tab to cycle) · 1 background task",
    ]);
    expect(readinessProbe("claude", screen).background).toBe(true);
    // A finished background command above the prompt does not.
    const done = trimmedRows([
      '● Background command "Wait 45 seconds" completed (exit code 0)',
      ...CLAUDE_TRANSCRIPT,
      CLAUDE_RULE,
      "❯ ",
      CLAUDE_RULE,
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ]);
    expect(readinessProbe("claude", done).background).toBe(false);
  });
  it("nextReadiness carries the flags, and drops them when they clear", () => {
    const prev: Readiness = { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 };
    const waiting = nextReadiness("claude", prev, { lastOutputAt: T0, matcherIdle: true, waiting: true }, T0 + 10);
    expect(waiting.waiting).toBe(true);
    const cleared = nextReadiness("claude", waiting, { lastOutputAt: T0, matcherIdle: true }, T0 + 20);
    expect(cleared.waiting).toBe(undefined);
    expect(nextReadiness("claude", cleared, { lastOutputAt: T0, matcherIdle: true }, T0 + 30) === cleared).toBe(true);
  });
});

// 1.169.0 (B3): typing into an idle Claude tile read "Working"
// (src/test/tileTypingConpty.test.tsx replays the recording).
describe("B3: typing is no activity on a TUI screen", () => {
  const BOX = "─".repeat(60);
  const screenWith = (aboveBox: string, draft: string) => [
    " ▐▛███▛█   Claude Code v2.1.308",
    "‼ Your login expires in 1 day · run /login to renew",
    "",
    aboveBox,
    BOX,
    `> ${draft}`,
    BOX,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ];
  it("Claude's right-aligned line above the box is not in the signature", () => {
    const effort = readinessProbe("claude", screenWith(" ".repeat(40) + "◐ medium · /effort", 'Try "edit <filepath> to..."'));
    const notice = readinessProbe("claude", screenWith(" ".repeat(30) + "Your login expires in 1 day · run /login to renew", "Get-Chi"));
    expect(notice.signature).toBe(effort.signature);
    // The conversation's own last row, left-aligned, still is.
    const answered = readinessProbe("claude", screenWith("⏺ Done.", ""));
    expect(answered.signature === effort.signature).toBe(false);
  });

  it("xterm's own replies are no typing and never a submitted line", () => {
    for (const report of ["\x1b[?1;2c", "\x1b[I", "\x1b[O", "\x1b[?997;1n", "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\", "\x1b[12;40R", "\x1b[<0;10;5M"]) {
      expect(memberInput(report)).toEqual({ typed: false, submitted: false });
    }
    expect(memberInput("a")).toEqual({ typed: true, submitted: false });
    expect(memberInput("\r")).toEqual({ typed: true, submitted: true });
    // A key typed with a report in the same chunk is typing.
    expect(memberInput("\x1b[Ix")).toEqual({ typed: true, submitted: false });
  });

  const scan = (memory: ScanMemory, over: Partial<Parameters<typeof foldScan>[1]>) =>
    foldScan(memory, { idle: null, status: null, signature: "s", sawData: true, dataAt: T0 + 500, rebaselining: false, now: T0 + 800, ...over });
  const settled = { ...FRESH_SCAN_MEMORY, activityAt: T0, lastVerdict: null, lastSignature: "s" } as ScanMemory;

  it("with no verdict, output that leaves a TUI's signature as it was does not count", () => {
    expect(scan(settled, { screen: true }).activityAt).toBe(T0);
    // A shell (no signature) still counts its output.
    expect(scan(settled, {}).activityAt).toBe(T0 + 500);
  });

  // Recorded at 60 and 40 columns (bundled ConPTY, Claude 2.1.308): the
  // effort hint right-aligned to the rule, and the notice cut with "…".
  it("the chrome row is found against the rule's end in narrow tiles too", () => {
    const at = (cols: number, chrome: string, draft: string) => [
      " ▐▛███▛█   Claude Code v2.1.308",
      "‼ Your login expires in 1 day · run /login to renew",
      "",
      chrome,
      "─".repeat(cols),
      `> ${draft}`,
      "─".repeat(cols),
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ];
    const sig60 = readinessProbe("claude", at(60, " ".repeat(40) + "◐ medium · /effort", 'Try "create a util logging.py that..."')).signature;
    expect(readinessProbe("claude", at(60, " ".repeat(8) + "Your login expires in 1 day · run /login to renew", "Get")).signature).toBe(sig60);
    const sig40 = readinessProbe("claude", at(40, " ".repeat(20) + "◐ medium · /effort", 'Try "fix typecheck errors"')).signature;
    expect(readinessProbe("claude", at(40, "  Your login expires in 1 day · run /…", "Get")).signature).toBe(sig40);
    // A left-aligned row, or one that stops well short of the edge, is the
    // conversation's.
    expect(readinessProbe("claude", at(40, "⏺ Done.", "")).signature === sig40).toBe(false);
    expect(readinessProbe("claude", at(40, "  short answer", "")).signature === sig40).toBe(false);
  });

  it("a turn the screen shows running counts its output with no verdict, whatever the signature", () => {
    // Its prompt scrolled off under a tall todo list: no verdict, the eight
    // signature rows (todo items) still; the footer says esc to interrupt.
    expect(scan(settled, { screen: true, running: true }).activityAt).toBe(T0 + 500);
    expect(scan(settled, { screen: true, running: false }).activityAt).toBe(T0);
  });

  it("a running turn still counts at once: its signature changes, or its verdict says busy", () => {
    expect(scan(settled, { screen: true, signature: "✻ Pondering… (3s)" }).activityAt).toBe(T0 + 500);
    expect(scan(settled, { screen: true, idle: false }).activityAt).toBe(T0 + 500);
  });
});

// 1.169.0 (B3 walk, Windows step 8): a long read-only turn, its prompt
// scrolled off under a todo list, read Ready mid-turn. Claude 2.1.309's
// screen (the walk's shot 08e): the spinner with its timer, a tip under it,
// the footer's "esc to interrupt", no status row of the old shape.
describe("B3 walk: a long Claude turn whose prompt scrolled off", () => {
  const RULE60 = "─".repeat(60);
  const turn = (timer: string, footer = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt") => [
    "  1. ☐ Read README",
    "  2. ☐ Read package.json",
    "  3. ☐ List and skim the source files",
    "",
    "● Reading README, package.json, and listing tracked files",
    "  └ $ cd \"C:/ply-test/sandboxes/tutorial-tu4/notes-app\" &&",
    "",
    `· Stewing… (${timer} · ↓ 324 tokens)`,
    "  └ Tip: Use /btw to ask a quick side question without",
    "    interrupting Claude's current work",
    "",
    RULE60,
    "> ",
    RULE60,
    footer,
  ];
  it("reads busy from the footer, and from the spinner's timer alone", () => {
    const p = readinessProbe("claude", turn("58s"));
    expect(p.running).toBe(true);
    expect(p.idle).toBe(false);
    const noFooter = readinessProbe("claude", turn("1m 26s", "  ⏵⏵ auto mode on (shift+tab to cycle)"));
    expect(noFooter.running).toBe(true);
    expect(noFooter.idle).toBe(false);
  });

  it("stays Working through a quiet stretch and a repaint, Ready only once it is done", () => {
    const sig = (timer: string) => readinessProbe("claude", turn(timer)).signature;
    const { seen, header } = simulate("claude", T0, [
      { at: T0 + 1_000, idle: false, signature: sig("28s") },
      // A resize repaint (its own, or another tile's refit) with no change.
      { at: T0 + 2_000, idle: false, signature: sig("28s"), rebaselining: true },
      { at: T0 + 3_000, idle: false, signature: sig("29s"), rebaselining: true },
      // Then nothing at all for 30 s (thinking): no scan, still busy.
      { at: T0 + 33_000, idle: false, signature: sig("58s") },
    ]);
    expect(seen.every((h) => h.startsWith("Working"))).toBe(true);
    expect(header(T0 + 20_000).ready).toBe(false);
    const done = readinessProbe("claude", [
      "✻ Crunched for 1m 29s · done 11:55 AM",
      "",
      RULE60,
      "> ",
      RULE60,
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ]);
    expect(done.running).toBe(false);
  });
});

describe("B3 walk: another tile's refit is not activity", () => {
  const W = 1_500;
  const RULE60 = "─".repeat(60);
  it("a tile resized early in a layout change rebaselines through the latest refit's window", () => {
    // Tile B refitted at T0 (its own window ends at T0 + W); tile A kept
    // refitting until T0 + 1200 (a transition).
    const b = { ownUntil: T0 + W, sizeChangedAt: T0, layoutAt: T0 + 1200, windowMs: W };
    expect(refitRebaselining({ ...b, now: T0 + 1000 })).toBe(true);
    expect(refitRebaselining({ ...b, now: T0 + 2000 })).toBe(true); // past its own window
    expect(refitRebaselining({ ...b, now: T0 + 1200 + W })).toBe(false);
  });
  it("a tile whose size did not change, or changed long before, is not covered", () => {
    expect(refitRebaselining({ now: T0 + 2000, ownUntil: 0, sizeChangedAt: 0, layoutAt: T0 + 1200, windowMs: W })).toBe(false);
    expect(refitRebaselining({ now: T0 + 2000, ownUntil: 0, sizeChangedAt: T0 - 60_000, layoutAt: T0 + 1200, windowMs: W })).toBe(false);
  });
  it("the stamp only moves forward", () => {
    noteLayoutRefit(T0 + 5000);
    noteLayoutRefit(T0 + 4000);
    expect(lastLayoutRefitAt()).toBe(T0 + 5000);
  });
  const prompt = (draw: string) => [draw, "", RULE60, "> ", RULE60, "  ? for shortcuts"];
  it("an idle Claude tile's late repaint stays Ready; a running one stays Working", () => {
    const b = { ownUntil: T0 + W, sizeChangedAt: T0, layoutAt: T0 + 1200, windowMs: W };
    const idleMemory = { ...FRESH_SCAN_MEMORY, activityAt: T0 - 10_000, lastVerdict: true, lastSignature: "before" } as ScanMemory;
    const repaint = readinessProbe("claude", prompt("⏺ Done, reflowed at the new width."));
    const after = foldScan(idleMemory, {
      ...repaint, sawData: true, dataAt: T0 + 2000, now: T0 + 2100,
      rebaselining: refitRebaselining({ ...b, now: T0 + 2100 }), screen: true,
    });
    expect(after.activityAt).toBe(T0 - 10_000);
    // Without the layout window the same repaint would count (the flash).
    const flash = foldScan(idleMemory, {
      ...repaint, sawData: true, dataAt: T0 + 2000, now: T0 + 2100,
      rebaselining: T0 + 2100 < b.ownUntil, screen: true,
    });
    expect(flash.activityAt).toBe(T0 + 2000);
    // A running turn: its status row still says Working through the window.
    const busy = readinessProbe("claude", [
      "✻ Stewing… (58s · ↓ 324 tokens · esc to interrupt)", "", RULE60, "> ", RULE60, "  esc to interrupt",
    ]);
    const running = foldScan({ ...idleMemory, lastVerdict: false }, {
      ...busy, sawData: true, dataAt: T0 + 2000, now: T0 + 2100,
      rebaselining: refitRebaselining({ ...b, now: T0 + 2100 }), screen: true,
    });
    expect(running.lastVerdict).toBe(false);
    expect(running.activityAt).toBe(T0 + 2000);
  });
});

describe("B3 walk: an idle tile's own expand, its repaint landing late", () => {
  const RULE60 = "─".repeat(60);
  const idleScreen = (extra: string) =>
    trimmedRows([
      "> list the files",
      "",
      "⏺ The table has 12 entries.",
      "",
      "✻ Churned for 17s · done 1:51 PM",
      extra,
      RULE60,
      "❯ ",
      RULE60,
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ]);
  it("a repaint past the 1.5 s window but within the settle stays Ready; a turn started then is Working", () => {
    // Expand at T0: the window ends at T0 + 1500; Claude's reflow lands at T0 + 2200.
    const refitAt = T0;
    const settling = (now: number) =>
      refitRebaselining({ now, ownUntil: refitAt + RESIZE_SETTLE_MS, sizeChangedAt: T0, layoutAt: T0, windowMs: RESIZE_SETTLE_MS });
    const idle = { ...FRESH_SCAN_MEMORY, activityAt: T0 - 30_000, lastVerdict: true, lastSignature: "narrow" } as ScanMemory;
    const late = readinessProbe("claude", idleScreen("  (reflowed at 120 columns)"));
    expect(late.idle).toBe(true);
    const after = foldScan(idle, {
      ...late, sawData: true, dataAt: T0 + 2200, now: T0 + 2500, screen: true,
      rebaselining: refitRebaselining({ now: T0 + 2500, ownUntil: T0 + 1500, sizeChangedAt: T0, layoutAt: T0, windowMs: 1500 }),
      settling: settling(T0 + 2500),
    });
    expect(after.activityAt).toBe(T0 - 30_000);
    expect(tileHeaderStatus("claude", after.activityAt, after.lastVerdict ?? null, T0 - 30_000, T0 + 2600).ready).toBe(true);
    // Without the settle it is the walk's "Working for 0s".
    const flash = foldScan(idle, { ...late, sawData: true, dataAt: T0 + 2200, now: T0 + 2500, screen: true, rebaselining: false });
    expect(tileHeaderStatus("claude", flash.activityAt, flash.lastVerdict ?? null, T0 - 30_000, T0 + 2600).ready).toBe(false);
    // A turn started inside the settle still says Working.
    const busy = readinessProbe("claude", trimmedRows([
      "✻ Stewing… (3s · ↓ 12 tokens · esc to interrupt)", "", RULE60, "❯ ", RULE60, "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ]));
    const turn = foldScan(after, { ...busy, sawData: true, dataAt: T0 + 3000, now: T0 + 3300, screen: true, rebaselining: false, settling: settling(T0 + 3300) });
    expect(turn.activityAt).toBe(T0 + 3000);
    expect(tileHeaderStatus("claude", turn.activityAt, turn.lastVerdict ?? null, T0, T0 + 3400).ready).toBe(false);
    // Past the settle, a changed idle screen counts again.
    expect(settling(T0 + RESIZE_SETTLE_MS + 1)).toBe(false);
  });
  it("the prompt scrolled off (no verdict): the late repaint of an idle tile settles too", () => {
    const quiet = { ...FRESH_SCAN_MEMORY, activityAt: T0 - 30_000, lastVerdict: null, lastSignature: "narrow" } as ScanMemory;
    const repaint = foldScan(quiet, { idle: null, status: null, signature: "wide", sawData: true, dataAt: T0 + 2200, now: T0 + 2500, screen: true, rebaselining: false, settling: true });
    expect(repaint.activityAt).toBe(T0 - 30_000);
    const unarmed = foldScan(quiet, { idle: null, status: null, signature: "wide", sawData: true, dataAt: T0 + 2200, now: T0 + 2500, screen: true, rebaselining: false });
    expect(unarmed.activityAt).toBe(T0 + 2200);
  });
  it("a screen that turned not-idle since the refit counts again", () => {
    const busy = { ...FRESH_SCAN_MEMORY, activityAt: T0, lastVerdict: false, lastSignature: "a" } as ScanMemory;
    const next = foldScan(busy, { idle: false, status: null, signature: "b", sawData: true, dataAt: T0 + 800, now: T0 + 900, screen: true, rebaselining: false, settling: true });
    expect(next.activityAt).toBe(T0 + 800);
  });
});

describe("B3 walk: a stale Working never outlives the turn", () => {
  it("names the moment the header turns Ready by time alone", () => {
    const ended = { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 - 17_000 };
    expect(headerTurnsReadyAt(ended)).toBe(T0 + READY_QUIET_MS);
    expect(tileHeaderStatusFor("claude", ended, T0 - 60_000, T0 + READY_QUIET_MS - 1).ready).toBe(false);
    expect(tileHeaderStatusFor("claude", ended, T0 - 60_000, headerTurnsReadyAt(ended)!).ready).toBe(true);
    // No verdict (a shell that can't say) falls back to quiet too.
    expect(headerTurnsReadyAt({ ...ended, matcherIdle: null })).toBe(T0 + READY_QUIET_MS);
    // Still working, or never scanned: only a scan can say Ready.
    expect(headerTurnsReadyAt({ ...ended, matcherIdle: false })).toBe(null);
    expect(headerTurnsReadyAt({ ...ended, running: true })).toBe(null);
    expect(headerTurnsReadyAt(undefined)).toBe(null);
  });
});

describe("Quit-guard Reviewer: a running turn is never a redraw", () => {
  it("inside the refit window, a screen showing its turn running is not kept idle", () => {
    const idle = { ...FRESH_SCAN_MEMORY, activityAt: T0 - 30_000, lastVerdict: true, lastSignature: "a" } as ScanMemory;
    const next = foldScan(idle, { idle: false, status: null, signature: "b", sawData: true, dataAt: T0 + 300, now: T0 + 400, rebaselining: true, screen: true, running: true });
    expect(next.lastVerdict).toBe(false);
    expect(next.activityAt).toBe(T0 + 300);
    // A half-drawn screen with no turn on it still keeps the verdict.
    const half = foldScan(idle, { idle: false, status: null, signature: "b", sawData: true, dataAt: T0 + 300, now: T0 + 400, rebaselining: true, screen: true });
    expect(half.lastVerdict).toBe(true);
  });
});

// 1.177.1 (capture walk 2026-11-26, step 13, Claude Code 2.1.332, real
// frames): a 1 s turn ended while the grid refitted (the Compare bar's reason
// row went away). The scan inside the redraw window held "working", nothing
// printed after it, and the header read "Working · 22s" on an idle tile. The
// scan Terminal asks for when the window ends lets it go.
describe("a verdict held through a redraw window is judged again when it ends", () => {
  const frame = (name: string): string[] =>
    readFileSync(new URL(`../../src-tauri/src/compare_fixtures/screens/${name}`, import.meta.url), "utf8")
      .split(/^# ----\n/m)[1]
      .replace(/\n$/, "")
      .split("\n");
  const working = frame("claude-working-named.txt");
  const finished = frame("claude-after-count-header-stale.txt");
  it("the window's end is known while it is open, and null otherwise", () => {
    expect(rebaselineEndsAt({ now: 1_000, ownUntil: 2_500, sizeChangedAt: 0, layoutAt: 0, windowMs: 1_500 })).toBe(2_500);
    expect(rebaselineEndsAt({ now: 3_000, ownUntil: 2_500, sizeChangedAt: 0, layoutAt: 0, windowMs: 1_500 })).toBe(null);
    expect(rebaselineEndsAt({ now: 1_200, ownUntil: 0, sizeChangedAt: 900, layoutAt: 1_000, windowMs: 1_500 })).toBe(2_500);
    expect(rebaselineEndsAt({ now: 1_200, ownUntil: 0, sizeChangedAt: 0, layoutAt: 1_000, windowMs: 1_500 })).toBe(null);
  });
  it("on the real frames: stuck without the scan at the window's end, Ready with it", () => {
    const T0 = 1_000_000;
    const scan = (memory: ScanMemory, rows: string[], at: number, rebaselining: boolean, sawData = true) => {
      const p = readinessProbe("claude", rows);
      return foldScan(memory, { idle: p.idle, status: p.status, signature: p.signature, sawData, dataAt: at, now: at, rebaselining, screen: true, running: p.running });
    };
    let m = scan({ ...FRESH_SCAN_MEMORY, activityAt: T0 - 60_000 }, working, T0, false);
    expect(m.lastVerdict).toBe(false);
    // The last frame of the turn, drawn inside the refit window: held.
    m = scan(m, finished, T0 + 1_000, true);
    expect(m.lastVerdict).toBe(false);
    const held: Readiness = { lastOutputAt: m.activityAt, matcherIdle: m.lastVerdict ?? null, leftReadyAt: T0 };
    expect(tileHeaderStatusFor("claude", held, 0, T0 + 22_000).ready).toBe(false);
    // The scan at the window's end, no output since: the screen can't say,
    // the busy verdict ends, Ready after the quiet window.
    const end = rebaselineEndsAt({ now: T0 + 1_000, ownUntil: T0 + 2_200, sizeChangedAt: 0, layoutAt: 0, windowMs: 1_500 })!;
    m = scan(m, finished, end + 50, false, false);
    expect(m.lastVerdict).toBe(null);
    const after: Readiness = { lastOutputAt: m.activityAt, matcherIdle: m.lastVerdict ?? null, leftReadyAt: T0 };
    expect(tileHeaderStatusFor("claude", after, 0, end + 50 + READY_QUIET_MS).ready).toBe(true);
  });
});

// 1.177.1 (capture walk 2026-11-26, step 11, real frames): a menu answered
// gives way to the work it started; a menu up never does.
describe("the header's 'asks' leaves once the screen shows the turn running", () => {
  const frame = (name: string): string[] =>
    readFileSync(new URL(`../../src-tauri/src/compare_fixtures/screens/${name}`, import.meta.url), "utf8")
      .split(/^# ----\n/m)[1]
      .replace(/\n$/, "")
      .split("\n");
  it("working after the answer: gone", () => {
    expect(questionGoneWhileWorking(readinessProbe("claude", frame("claude-working-named.txt")))).toBe(true);
  });
  it("the question menu, the /model picker, an idle box: stays", () => {
    for (const n of ["claude-choice-question-named.txt", "claude-model-picker-named.txt", "claude-named-idle-after-turn.txt"]) {
      expect(questionGoneWhileWorking(readinessProbe("claude", frame(n)))).toBe(false);
    }
  });
});

console.log(`tileHeaderStatus.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  throw new Error(`${failed} tileHeaderStatus test(s) failed`);
}
