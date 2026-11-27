// Unit tests for the "wants you" attention layer (src/lib/attention.ts).
//
// Atelier has no JS test runner (see docs/PPVP.md Tier 3): this file is a
// self-contained, dependency-free test module — it type-checks under
// `tsc --noEmit` and runs standalone:
//
//     node --experimental-strip-types src/lib/attention.test.ts
//
// It exits non-zero on the first failed assertion (an uncaught throw).
// Migrating to vitest later is mechanical: delete the harness block below
// and `import { describe, it, expect } from "vitest"`.

import type { Tile } from "../store/tileStore";
import type { KanbanCard } from "../ipc";
import ATTENTION_FIXTURES from "./attention.fixtures.json" with { type: "json" };
import P1_DETAIL_FIXTURES from "./p1Detail.fixtures.json" with { type: "json" };
import {
  changesRequestedDetail,
  openP1Findings,
  RESIZE_REDRAW_MS,
  SILENCE_MS,
  cardWantsYou,
  countWorkspaceWantsYou,
  deriveTileAttention,
  outputRestartsSilence,
  matchesClaudePromptBox,
  codexComposerRows,
  codexOverlayOpen,
  matchesCodexComposerIdle,
  matchesCodexPromptBox,
  promptBoxMatcherFor,
  turnIdleMatcherFor,
  turnRunningMatcherFor,
  turnInterruptedMatcherFor,
  matchesClaudePromptIdle,
  claudeTurnRunning,
  claudeComposerEscaped,
  codexComposerEscaped,
  composerEscapedMatcherFor,
  scanTail,
  settledTail,
  codexAwaitingDecision,
  claudeAwaitingDecision,
  decisionMatcherFor,
} from "./attention.ts";
import type { AttentionTile } from "./attention.ts";
import { setPlatformForTests } from "./platform.ts";

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

// --- matchesClaudePromptBox ------------------------------------------------

// A captured-shape idle Claude REPL box: rounded border + framed "> " line
// + the idle hint. The exact glyphs are confirmed against a live tail in
// the Tier-4 walk; the degrade rule keeps a mistuned regex safe.
const IDLE_BOX = [
  "╭────────────────────────────────────────╮",
  "│ >                                      │",
  "╰────────────────────────────────────────╯",
  "  ? for shortcuts",
].join("\n");

// A box from a tool-output panel — has borders but no "> " input line.
const BORDER_ONLY = [
  "╭─ Tool output ──────────────╮",
  "│ ran 3 tests, all passed    │",
  "╰────────────────────────────╯",
].join("\n");

const PROSE =
  "The function returns a promise that resolves once the file has\n" +
  "been written to disk. Nothing here resembles a prompt box.";

// v1.114 (2026-09-10, Mac mini Builder stuck "Quiet" with 3 Challenger
// messages pending forever): Claude Code 2.1.267 draws the idle input
// between two flat rules, with a `❯` chevron and a placeholder, and its
// footer is the mode line — none of which the pre-2.1 regexes matched, so
// promptBoxIdle never flipped and pending injections never flushed.
const IDLE_BOX_2_1 = [
  "✻ Cogitated for 23m 21s · done 12:12",
  "",
  "────────────────────────────────────────────────────────────",
  '❯ Try "fix lint errors"',
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const IDLE_BOX_2_1_NO_FOOTER = [
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
].join("\n");

describe("matchesClaudePromptBox", () => {
  it("matches a full idle prompt box (border + input line)", () => {
    expect(matchesClaudePromptBox(IDLE_BOX)).toBe(true);
  });

  it("matches the idle hint on its own", () => {
    expect(matchesClaudePromptBox("\n? for shortcuts\n")).toBe(true);
  });

  it("matches the Claude Code 2.1.x idle input (flat rules + ❯ + mode footer)", () => {
    expect(matchesClaudePromptBox(IDLE_BOX_2_1)).toBe(true);
    expect(matchesClaudePromptBox(IDLE_BOX_2_1_NO_FOOTER)).toBe(true);
  });

  it("matches the 2.1.x mode footer on its own", () => {
    expect(
      matchesClaudePromptBox("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"),
    ).toBe(true);
  });

  it("rejects a ❯ chevron in prose with no rule around it", () => {
    expect(matchesClaudePromptBox("run it with ❯ make test and see")).toBe(false);
  });

  it("rejects a short dash run (a markdown separator is not a rule)", () => {
    expect(matchesClaudePromptBox("---\n❯ quoted\n---")).toBe(false);
  });

  it("rejects mid-stream assistant prose", () => {
    expect(matchesClaudePromptBox(PROSE)).toBe(false);
  });

  it("rejects a box border with no input line", () => {
    expect(matchesClaudePromptBox(BORDER_ONLY)).toBe(false);
  });

  it("rejects a bare input line with no border", () => {
    expect(matchesClaudePromptBox("> some pasted text")).toBe(false);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(matchesClaudePromptBox("")).toBe(false);
    expect(matchesClaudePromptBox("   \n  ")).toBe(false);
  });
});

// --- matchesCodexPromptBox / promptBoxMatcherFor (v1.105.0) ----------------

describe("matchesCodexPromptBox", () => {
  it("accepts the idle composer chevron", () => {
    expect(matchesCodexPromptBox("Done.\n\n› \n")).toBe(true);
    expect(matchesCodexPromptBox("│ › Ask Codex to do anything")).toBe(true);
  });

  it("accepts the idle footer hint", () => {
    expect(matchesCodexPromptBox("  ? for shortcuts")).toBe(true);
  });

  it("accepts an approval prompt", () => {
    expect(matchesCodexPromptBox("Allow command? [y/n]")).toBe(true);
    expect(matchesCodexPromptBox("Would you like to run this command?")).toBe(true);
  });

  it("rejects streaming output and empty input", () => {
    expect(matchesCodexPromptBox("Running tests...\ncompiling foo")).toBe(false);
    expect(matchesCodexPromptBox("")).toBe(false);
  });
});

describe("promptBoxMatcherFor", () => {
  it("routes claude and codex to their matchers, by basename", () => {
    expect(promptBoxMatcherFor("claude")).toBe(matchesClaudePromptIdle);
    expect(promptBoxMatcherFor("/Users/x/.npm-global/bin/codex")).toBe(matchesCodexPromptBox);
  });

  it("knows Windows paths and launchers (W5)", () => {
    setPlatformForTests("windows");
    try {
    expect(promptBoxMatcherFor("C:\\Users\\x\\.local\\bin\\claude.exe")).toBe(matchesClaudePromptIdle);
    expect(promptBoxMatcherFor("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd")).toBe(matchesClaudePromptIdle);
    expect(promptBoxMatcherFor("C:/tools/codex.EXE")).toBe(matchesCodexPromptBox);
    expect(promptBoxMatcherFor("C:\\Windows\\System32\\cmd.exe")("? for shortcuts\n> ")).toBe(false);
    } finally {
      setPlatformForTests(null);
    }
    // The Mac reads a command as it always has.
    expect(promptBoxMatcherFor("/usr/local/bin/claude.cmd")("? for shortcuts\n> ")).toBe(false);
  });

  it("never matches for a shell", () => {
    expect(promptBoxMatcherFor("/bin/zsh")("? for shortcuts\n> ")).toBe(false);
  });
});

// --- deriveTileAttention ---------------------------------------------------

const NOW = 1_700_000_000_000;

function tile(over: Partial<AttentionTile>): AttentionTile {
  return {
    kind: "claude",
    status: "running",
    startedAt: NOW,
    ...over,
  };
}

describe("deriveTileAttention", () => {
  it("returns null for a shell tile", () => {
    expect(deriveTileAttention(tile({ kind: "shell" }), NOW)).toBe(null);
  });

  // v1.105.0: the Codex CLI TUI is silence-derived exactly like Claude.
  it("is 'working' for a codex tile with recent output", () => {
    const t = tile({ kind: "codex", lastOutputAt: NOW - 2_000 });
    expect(deriveTileAttention(t, NOW)).toBe("working");
  });

  it("is 'wants-you' for a codex tile silent past the threshold", () => {
    const t = tile({ kind: "codex", lastOutputAt: NOW - (SILENCE_MS + 1) });
    expect(deriveTileAttention(t, NOW)).toBe("wants-you");
  });

  it("upgrades a silent codex tile to 'asking-you' on promptBoxIdle", () => {
    const t = tile({
      kind: "codex",
      lastOutputAt: NOW - (SILENCE_MS + 1),
      promptBoxIdle: true,
    });
    expect(deriveTileAttention(t, NOW)).toBe("asking-you");
  });

  it("returns null for a non-running codex tile", () => {
    const t = tile({ kind: "codex", status: "killed", lastOutputAt: NOW - 60_000 });
    expect(deriveTileAttention(t, NOW)).toBe(null);
  });

  // v1.105.0: codex-chat is authoritative (App Server events), not silent.
  it("is 'working' for a codex-chat session that never completed a turn", () => {
    const t = tile({ kind: "codex-chat", startedAt: NOW - 60_000 });
    expect(deriveTileAttention(t, NOW)).toBe("working");
  });

  it("is 'working' for a codex-chat session with a turn in flight", () => {
    const t = tile({ kind: "codex-chat", sessionBusy: true, startedAt: NOW - 60_000 });
    expect(deriveTileAttention(t, NOW)).toBe("working");
  });

  it("is 'asking-you' immediately once a codex-chat turn completes", () => {
    const t = tile({ kind: "codex-chat", sessionBusy: false, sessionIdleSince: NOW });
    expect(deriveTileAttention(t, NOW)).toBe("asking-you");
  });

  it("is 'asking-you' for a codex-chat approval even mid-turn", () => {
    const t = tile({ kind: "codex-chat", sessionBusy: true, sessionApprovalPending: true });
    expect(deriveTileAttention(t, NOW)).toBe("asking-you");
  });

  it("returns null for a codex-chat session whose process died", () => {
    const t = tile({ kind: "codex-chat", status: "killed", sessionIdleSince: NOW });
    expect(deriveTileAttention(t, NOW)).toBe(null);
  });

  it("returns null for an agent-run tile", () => {
    expect(deriveTileAttention(tile({ kind: "agent-run" }), NOW)).toBe(null);
  });

  it("returns null for a non-running claude tile", () => {
    expect(deriveTileAttention(tile({ status: "killed" }), NOW)).toBe(null);
  });

  it("is 'working' when output is recent", () => {
    const t = tile({ lastOutputAt: NOW - 2_000 });
    expect(deriveTileAttention(t, NOW)).toBe("working");
  });

  it("falls back to startedAt when lastOutputAt is undefined", () => {
    const t = tile({ startedAt: NOW - 2_000, lastOutputAt: undefined });
    expect(deriveTileAttention(t, NOW)).toBe("working");
  });

  it("is 'wants-you' once silent past the threshold with no prompt box", () => {
    const t = tile({ lastOutputAt: NOW - (SILENCE_MS + 5_000) });
    expect(deriveTileAttention(t, NOW)).toBe("wants-you");
  });

  it("is 'wants-you' at exactly the silence threshold", () => {
    const t = tile({ lastOutputAt: NOW - SILENCE_MS });
    expect(deriveTileAttention(t, NOW)).toBe("wants-you");
  });

  it("upgrades to 'asking-you' when silent and promptBoxIdle is true", () => {
    const t = tile({
      lastOutputAt: NOW - (SILENCE_MS + 5_000),
      promptBoxIdle: true,
    });
    expect(deriveTileAttention(t, NOW)).toBe("asking-you");
  });

  it("stays 'wants-you' when silent and promptBoxIdle is false", () => {
    const t = tile({
      lastOutputAt: NOW - (SILENCE_MS + 5_000),
      promptBoxIdle: false,
    });
    expect(deriveTileAttention(t, NOW)).toBe("wants-you");
  });
});

// --- cardWantsYou ----------------------------------------------------------

function card(
  over: Partial<
    Pick<
      KanbanCard,
      | "lastRunStatus"
      | "reviewStatus"
      | "verifyStatus"
      | "shipStatus"
      | "columnId"
      | "archived"
    >
  >,
): Pick<
  KanbanCard,
  | "lastRunStatus"
  | "reviewStatus"
  | "verifyStatus"
  | "shipStatus"
  | "columnId"
  | "archived"
> {
  return {
    lastRunStatus: null,
    reviewStatus: null,
    verifyStatus: "none",
    shipStatus: "unshipped",
    columnId: "todo",
    archived: false,
    ...over,
  };
}

describe("cardWantsYou", () => {
  it("matches the shared TypeScript/Rust attention fixture matrix", () => {
    for (const fixture of ATTENTION_FIXTURES) {
      // 1.169.1 (R1): `cardWantsYou` doesn't read pull requests; the
      // fixtures with one hold Rust's rows and the Inbox group
      // (`inbox.rs`, `surfaceAgreement.test.ts`) to the same answer.
      if ("pr" in fixture) continue;
      // 1.173.0 (F1): nor a Builder's session (paused when Plyloft closed);
      // Rust's rows and the Inbox group hold those fixtures.
      if ("builder" in fixture) continue;
      // 1.175.0 (D3): nor the questions on its issue's title or brief; the
      // Board's column and the Inbox row hold those (`cardPresentation.ts`).
      if ("editConflicts" in fixture) continue;
      const actual = cardWantsYou(
        card({
          lastRunStatus: fixture.lastRunStatus as KanbanCard["lastRunStatus"],
          reviewStatus: fixture.reviewStatus as KanbanCard["reviewStatus"],
          verifyStatus: fixture.verifyStatus as KanbanCard["verifyStatus"],
          shipStatus: fixture.shipStatus as KanbanCard["shipStatus"],
          columnId: fixture.columnId as KanbanCard["columnId"],
          archived: fixture.archived,
          ...("shipConflict" in fixture ? { shipConflict: fixture.shipConflict as KanbanCard["shipConflict"] } : {}),
        }),
      );
      expect(actual).toEqual({
        wants: fixture.expectedWants,
        reason: fixture.expectedReason as ReturnType<
          typeof cardWantsYou
        >["reason"],
      });
    }
  });

  it("wants you on a failed run", () => {
    expect(cardWantsYou(card({ lastRunStatus: "failed" }))).toEqual({
      wants: true,
      reason: "failed — needs you",
    });
  });

  it("wants you on an aborted run", () => {
    expect(cardWantsYou(card({ lastRunStatus: "aborted" }))).toEqual({
      wants: true,
      reason: "failed — needs you",
    });
  });

  it("says a closed Builder session's aborted run ended, not failed (F11)", () => {
    const builder = { vendor: "claude", bypass: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"];
    expect(cardWantsYou({ ...card({ lastRunStatus: "aborted" }), builder })).toEqual({
      wants: true,
      reason: "session ended — needs you",
    });
    expect(cardWantsYou({ ...card({ lastRunStatus: "aborted" }), builder, linkedSwarmId: "s1" })).toEqual({
      wants: true,
      reason: "failed — needs you",
    });
  });

  it("wants you on a rate_limited run", () => {
    expect(cardWantsYou(card({ lastRunStatus: "rate_limited" }))).toEqual({
      wants: true,
      reason: "failed — needs you",
    });
  });

  it("wants review on success that was never reviewed (null)", () => {
    expect(
      cardWantsYou(card({ lastRunStatus: "success", reviewStatus: null })),
    ).toEqual({ wants: true, reason: "done — review" });
  });

  it("wants review on success with a pending review", () => {
    expect(
      cardWantsYou(card({ lastRunStatus: "success", reviewStatus: "pending" })),
    ).toEqual({ wants: true, reason: "done — review" });
  });

  it("does not want you on a merged success", () => {
    expect(
      cardWantsYou(card({ lastRunStatus: "success", reviewStatus: "merged" })),
    ).toEqual({ wants: false, reason: null });
  });

  it("wants you when a review requests changes outside Complete", () => {
    expect(
      cardWantsYou(
        card({ lastRunStatus: "success", reviewStatus: "changes_requested" }),
      ),
    ).toEqual({ wants: true, reason: "changes requested — needs you" });
  });

  it("manual Complete still wants a decision after changes were requested", () => {
    expect(
      cardWantsYou(
        card({
          columnId: "complete",
          lastRunStatus: "success",
          reviewStatus: "changes_requested",
        }),
      ),
    ).toEqual({ wants: true, reason: "changes requested — needs you" });
  });

  it("wants you when verification failed", () => {
    expect(cardWantsYou(card({ verifyStatus: "failed" }))).toEqual({
      wants: true,
      reason: "verification failed",
    });
  });

  it("wants you on a manual Complete without landing", () => {
    expect(cardWantsYou(card({ columnId: "complete", verifyStatus: "passed" }))).toEqual({
      wants: true,
      reason: "complete — decide",
    });
  });

  // GH #243: closed on GitHub — no run, no checks — is history.
  it("does not want you for a card closed without work", () => {
    expect(cardWantsYou(card({ columnId: "complete" }))).toEqual({
      wants: false,
      reason: null,
    });
  });

  it("landing resolves every workflow-attention clause", () => {
    for (const landed of [
      { shipStatus: "shipped" as const },
      { reviewStatus: "merged" as const },
    ]) {
      expect(
        cardWantsYou(
          card({
            ...landed,
            columnId: "complete",
            lastRunStatus: "failed",
            verifyStatus: "failed",
          }),
        ),
      ).toEqual({ wants: false, reason: null });
    }
  });

  // GH #104 (ADR 0005): the post-ship lesson is retired, and the Challenger's
  // improvement proposal is deliberately **not** a card signal — it is about a
  // skill or the instructions, so it lives on the Library page, in the Inbox and
  // in the Ship step, and no landed card's chip changes because one exists.
  it("a landed card wants nothing, whatever the Library is waiting on", () => {
    expect(
      cardWantsYou(
        card({
          shipStatus: "shipped",
          reviewStatus: "merged",
          columnId: "complete",
        }),
      ),
    ).toEqual({ wants: false, reason: null });
  });

  it("does not want you while a run is still running", () => {
    expect(cardWantsYou(card({ lastRunStatus: "running" }))).toEqual({
      wants: false,
      reason: null,
    });
  });

  it("does not want you when the card has never run", () => {
    expect(cardWantsYou(card({ lastRunStatus: null }))).toEqual({
      wants: false,
      reason: null,
    });
  });

  it("does not want you on an archived success with null reviewStatus", () => {
    expect(
      cardWantsYou(
        card({ archived: true, lastRunStatus: "success", reviewStatus: null }),
      ),
    ).toEqual({ wants: false, reason: null });
  });

  it("does not want you on an archived failed card", () => {
    expect(
      cardWantsYou(card({ archived: true, lastRunStatus: "failed" })),
    ).toEqual({ wants: false, reason: null });
  });

  it("does not want you on an archived merged success", () => {
    expect(
      cardWantsYou(
        card({ archived: true, lastRunStatus: "success", reviewStatus: "merged" }),
      ),
    ).toEqual({ wants: false, reason: null });
  });
});

// --- countWorkspaceWantsYou ------------------------------------------------

describe("countWorkspaceWantsYou", () => {
  it("sums wants-you tiles and cards, ignoring working tiles", () => {
    const tiles = [
      tile({ lastOutputAt: NOW - 1_000 }), // working
      tile({ lastOutputAt: NOW - (SILENCE_MS + 1_000) }), // wants-you
      tile({
        lastOutputAt: NOW - (SILENCE_MS + 1_000),
        promptBoxIdle: true,
      }), // asking-you
      tile({ kind: "shell" }), // null — ignored
    ] as Tile[];
    const cards = [
      card({ lastRunStatus: "failed" }), // wants
      card({ lastRunStatus: "success", reviewStatus: "merged" }), // no
    ] as KanbanCard[];
    expect(countWorkspaceWantsYou(tiles, cards, NOW)).toEqual({
      tiles: 2,
      cards: 1,
      total: 3,
    });
  });

  it("is zero for an empty workspace", () => {
    expect(countWorkspaceWantsYou([], [], NOW)).toEqual({
      tiles: 0,
      cards: 0,
      total: 0,
    });
  });
});

// --- #47: Codex composer idle (dictation gate) -----------------------------
// Screens captured from codex-cli 0.154.0 in a headless xterm, 2026-09-14.

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
const CODEX_TYPED = [...CODEX_HEADER, "› hello there", "", FOOTER, ...BLANK_ROWS];
const CODEX_WORKING = [
  ...CODEX_HEADER,
  "› Without using any tools, count slowly from 1 to 40 in words, one per line.",
  "",
  "• Working (2s • esc to interrupt)",
  "",
  "",
  "› Ask Codex to do anything",
  "",
  `${FOOTER} · renaming... ⠇`,
];
const CODEX_STREAMING = [
  "› Write the numbers from 1 to 120 in Italian words, one per line.",
  "",
  "• uno",
  "  due",
  "  tre",
  "  cinque",
  "",
  "",
  "› Ask Codex to do anything",
  "",
  `${FOOTER} · Scrivi i numeri da 1 a 120`,
];
const CODEX_APPROVAL_SCREEN = [
  "• Running touch /tmp/ply-probe.txt",
  "",
  "",
  "  Would you like to run the following command?",
  "",
  "  Reason: Allow creating /tmp/ply-probe.txt with the exact requested command?",
  "",
  "  $ touch /tmp/ply-probe.txt",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `touch /tmp/ply-probe.txt` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];
const CODEX_PAST_PROMPT_ONLY = [
  "› fix the build",
  "",
  "• Ran cargo build",
  "  line 1",
  "  line 2",
  "  line 3",
  "  line 4",
  "  line 5",
  "  line 6",
  "  line 7",
  "  line 8",
];

// GH #67: Codex 0.154's animated composer, as the tile showed it on the
// owner's MacBook (2026-09-15): starfield glyphs on the composer rows, one of
// them right after the chevron, the placeholder gone.
const CODEX_STARFIELD = [
  ...CODEX_HEADER,
  "  ·      .         ·     .            ·",
  "›·    .        ·        .     ·",
  "",
  FOOTER,
  ...BLANK_ROWS,
];
const CODEX_STARFIELD_SPACED = [
  ...CODEX_HEADER,
  "     .    ·           .        ·",
  "› .     ·     .           ·",
  "",
  FOOTER,
  ...BLANK_ROWS,
];
// A whitespace-only draft (a few Space taps): xterm's translateToString(true)
// trims the row to the bare chevron.
const CODEX_WHITESPACE_DRAFT = [...CODEX_HEADER, "›", "", FOOTER, ...BLANK_ROWS];

describe("settledTail", () => {
  it("drops trailing blank rows before taking the tail", () => {
    expect(settledTail(["a", "b", "c", "", "  ", ""], 2)).toEqual(["b", "c"]);
    expect(settledTail(["", ""], 5)).toEqual([]);
    expect(settledTail(["a"], 5)).toEqual(["a"]);
  });

  it("finds a fresh Codex composer that the last 20 raw rows miss", () => {
    const raw = CODEX_FRESH.slice(-20).join("\n");
    expect(matchesCodexPromptBox(raw)).toBe(false);
    expect(matchesCodexPromptBox(settledTail(CODEX_FRESH, 20).join("\n"))).toBe(true);
  });
});

describe("matchesCodexComposerIdle", () => {
  const idle = (screen: string[]) => matchesCodexComposerIdle(settledTail(screen, 20).join("\n"));

  it("is idle at a fresh or a typed-into composer", () => {
    expect(idle(CODEX_FRESH)).toBe(true);
    expect(idle(CODEX_TYPED)).toBe(true);
  });

  it("is idle at the animated starfield composer, glyph after the chevron or not (GH #67)", () => {
    expect(idle(CODEX_STARFIELD)).toBe(true);
    expect(idle(CODEX_STARFIELD_SPACED)).toBe(true);
    const prompt = (screen: string[]) => matchesCodexPromptBox(settledTail(screen, 20).join("\n"));
    expect(prompt(CODEX_STARFIELD)).toBe(true);
    expect(prompt(CODEX_STARFIELD_SPACED)).toBe(true);
    // A cursor block drawn right after the chevron is no evidence of a turn.
    expect(idle([...CODEX_HEADER, "›█", "", FOOTER])).toBe(true);
  });

  it("is idle at a whitespace-only draft, read back as a bare chevron (GH #67)", () => {
    expect(idle(CODEX_WHITESPACE_DRAFT)).toBe(true);
    expect(matchesCodexPromptBox(settledTail(CODEX_WHITESPACE_DRAFT, 20).join("\n"))).toBe(true);
  });

  it("still refuses a starfield composer while a turn or a modal is in view (GH #67)", () => {
    const working = [...CODEX_WORKING.slice(0, -3), "›·   .    ·", "", `${FOOTER} · renaming... ⠇`];
    expect(idle(working)).toBe(false);
    const choice = CODEX_APPROVAL_SCREEN.slice(0, -2).filter((line) => !/would you like/i.test(line));
    expect(idle(choice)).toBe(false);
  });

  it("names the rows it judged: the last 12 settled rows", () => {
    const rows = codexComposerRows(CODEX_STARFIELD.join("\n"));
    expect(rows.length).toBe(12);
    expect(rows[rows.length - 1]).toBe(FOOTER);
  });

  it("is not idle while a turn shows its working status", () => {
    expect(idle(CODEX_WORKING)).toBe(false);
    // …which the attention matcher, by design, still calls a prompt.
    expect(matchesCodexPromptBox(CODEX_WORKING.join("\n"))).toBe(true);
  });

  it("accepts the composer while an answer streams (typing is queued, not sent)", () => {
    expect(idle(CODEX_STREAMING)).toBe(true);
  });

  it("is not idle at an approval, where › marks a numbered choice", () => {
    expect(idle(CODEX_APPROVAL_SCREEN)).toBe(false);
    const withoutFooter = CODEX_APPROVAL_SCREEN.slice(0, -2);
    expect(idle(withoutFooter.filter((line) => !/would you like/i.test(line)))).toBe(false);
  });

  it("does not mistake a past prompt far above for the composer", () => {
    expect(idle(CODEX_PAST_PROMPT_ONLY)).toBe(false);
    expect(matchesCodexComposerIdle("")).toBe(false);
    expect(matchesCodexComposerIdle("$ ls\nfoo bar\n")).toBe(false);
  });
});

// --- report ----------------------------------------------------------------

// --- turnIdleMatcherFor (ADR 0006 third card, GH #111) ---------------------
// The self-check's "back at its prompt": never while a turn runs or a
// question waits, whatever the prompt-box refinement says.

const CLAUDE_WORKING_2_1 = [
  "✻ Running the tests… (42s · ↓ 1.2k tokens · esc to interrupt)",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const CLAUDE_PERMISSION = [
  "╭────────────────────────────────────────────────────────╮",
  "│ Bash command                                           │",
  "│   cargo test --workspace --lib                         │",
  "│ Do you want to proceed?                                │",
  "│ ❯ 1. Yes                                               │",
  "│   2. No, and tell Claude what to do differently (esc)  │",
  "╰────────────────────────────────────────────────────────╯",
].join("\n");

describe("turnIdleMatcherFor", () => {
  const claude = turnIdleMatcherFor("claude");
  const codex = turnIdleMatcherFor("codex");
  it("claude: idle boxes are turn-idle", () => {
    expect(claude(IDLE_BOX_2_1)).toBe(true);
    expect(claude(IDLE_BOX)).toBe(true);
  });
  it("claude: a running turn is not, though its box is drawn", () => {
    expect(matchesClaudePromptBox(CLAUDE_WORKING_2_1)).toBe(true);
    expect(claude(CLAUDE_WORKING_2_1)).toBe(false);
  });
  it("claude: a permission question is not", () => {
    expect(claude(CLAUDE_PERMISSION)).toBe(false);
    expect(claude(CLAUDE_PERMISSION + "\n" + IDLE_BOX_2_1)).toBe(false);
  });
  it("codex: an approval question or a running turn is not, the composer is", () => {
    expect(matchesCodexPromptBox(CODEX_APPROVAL_SCREEN.join("\n"))).toBe(true);
    expect(codex(CODEX_APPROVAL_SCREEN.join("\n"))).toBe(false);
    expect(codex(CODEX_WORKING.join("\n"))).toBe(false);
    expect(codex(CODEX_FRESH.join("\n"))).toBe(true);
  });
  it("any other vendor never is", () => {
    expect(turnIdleMatcherFor("bash")(IDLE_BOX)).toBe(false);
  });
});

// --- outputRestartsSilence: a resize's redraw is not activity -------------

describe("outputRestartsSilence", () => {
  const T = 1_000_000;
  const waiting = { lastOutputAt: T - 60_000 };
  it("output with no resize restarts the clock", () => {
    expect(outputRestartsSilence(waiting, T)).toBe(true);
  });
  it("the redraw right after a resize does not: a waiting tile stays waiting", () => {
    const resized = { ...waiting, resizedAt: T - 200 };
    expect(outputRestartsSilence(resized, T)).toBe(false);
    expect(outputRestartsSilence(resized, T - 200 + RESIZE_REDRAW_MS - 1)).toBe(false);
    // …so the derived state is still the one from before the redraw.
    const tile: AttentionTile = {
      kind: "claude",
      status: "running",
      startedAt: T - 120_000,
      lastOutputAt: outputRestartsSilence(resized, T) ? T : waiting.lastOutputAt,
      promptBoxIdle: true,
    };
    expect(deriveTileAttention(tile, T)).toBe("asking-you");
  });
  it("real output after the window restarts it: the tile is working again", () => {
    const resized = { ...waiting, resizedAt: T - RESIZE_REDRAW_MS };
    expect(outputRestartsSilence(resized, T)).toBe(true);
    const tile: AttentionTile = {
      kind: "claude",
      status: "running",
      startedAt: T - 120_000,
      lastOutputAt: T,
      promptBoxIdle: true,
    };
    expect(deriveTileAttention(tile, T + 1)).toBe("working");
  });
  it("a session's first output always counts, resize or not", () => {
    expect(outputRestartsSilence({ resizedAt: T - 10 }, T)).toBe(true);
  });
});

// --- v1.154.1 walk H1: Claude's input box while a turn still runs ----------
// Re-walk R3 (2026-09-29, report 2026-09-29-144737, shot s9): a foreground
// `node -e setTimeout(…, 50000)` running; Claude 2.1 kept its input box and
// mode line drawn, so the prompt-box matcher said "idle" and Plyloft pasted a
// review comment mid-turn (Claude queued it itself). The screen as recorded:
const R3_TOOL_RUNNING_QUEUED = [
  "● Background command \"Wait 45 seconds\" completed (exit code 0)",
  "",
  "● ok",
  "",
  "✻ Baked for 1s · done 2:54 PM",
  "",
  "❯ Walk test 3: run exactly this command in the foreground and wait for it: node -e",
  "  \"setTimeout(()=>console.log('ok'),50000)\" — then reply only \"ok\". Do not edit anything.",
  "",
  "● Bash(node -e \"setTimeout(()=>console.log('ok'),50000)\")",
  "  ⎿  Running… (12s · timeout 1m 30s)",
  "     (ctrl+b to run in background)",
  "",
  "❯ [Plyloft] Review comments on this card's changes (1). Please address it in this",
  "  worktree. Line numbers are from the card's last committed version of each file; removed",
  "  lines are numbered in the base version. If the code has moved since, find the place by",
  "  the quoted lines.",
  "",
  "  1. sum.js, line 3",
  "   }",
  "  Comment: c4 (retry): mid-turn check",
  "  ctrl+x ctrl+s to send now",
  "",
  "✳ Processing… (16s · ↓ 129 tokens)",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ Press up to edit queued messages",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents",
].join("\n");

// The moment before (the report's first read, "Running… (6s …)"): no
// message queued yet, the box empty.
const R3_TOOL_RUNNING = [
  "● Bash(node -e \"setTimeout(()=>console.log('ok'),50000)\")",
  "  ⎿  Running… (6s · timeout 1m 30s)",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

// The same session once the command ended: "⏺ ok … ✻ Worked for 55s · done".
const R3_TURN_OVER = [
  "● ok",
  "",
  "✻ Worked for 55s · done 2:55 PM",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const SPINNER_ONLY = [
  "● Reading the diff",
  "",
  "✢ Honking… (3s)",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

describe("matchesClaudePromptIdle (walk H1)", () => {
  it("the input box drawn during a running tool is not idle (R3's screens)", () => {
    expect(matchesClaudePromptBox(R3_TOOL_RUNNING_QUEUED)).toBe(true);
    expect(matchesClaudePromptIdle(R3_TOOL_RUNNING_QUEUED)).toBe(false);
    expect(matchesClaudePromptBox(R3_TOOL_RUNNING)).toBe(true);
    expect(claudeTurnRunning(R3_TOOL_RUNNING)).toBe(true);
    expect(matchesClaudePromptIdle(R3_TOOL_RUNNING)).toBe(false);
    expect(promptBoxMatcherFor("claude")(R3_TOOL_RUNNING)).toBe(false);
  });

  it("the spinner line alone, or esc to interrupt, is a running turn", () => {
    expect(matchesClaudePromptIdle(SPINNER_ONLY)).toBe(false);
    expect(matchesClaudePromptIdle(CLAUDE_WORKING_2_1)).toBe(false);
  });

  it("the turn over is idle: the finished line has no ellipsis", () => {
    expect(claudeTurnRunning(R3_TURN_OVER)).toBe(false);
    expect(matchesClaudePromptIdle(R3_TURN_OVER)).toBe(true);
    expect(matchesClaudePromptIdle(IDLE_BOX_2_1)).toBe(true);
    expect(turnIdleMatcherFor("claude")(R3_TURN_OVER)).toBe(true);
  });

  it("a Running… of the transcript far above the box is not the turn", () => {
    const old = [
      "  ⎿  Running… (2s)",
      ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
      R3_TURN_OVER,
    ].join("\n");
    expect(matchesClaudePromptIdle(old)).toBe(true);
  });

  it("an answer or a diff that mentions the busy words is not a running turn (Reviewer)", () => {
    const diffIdle = [
      "● Update(src/lib/attention.ts)",
      "  ⎿  Updated src/lib/attention.ts with 2 additions",
      "      125 +  /esc to interrupt|press up to edit queued messages/i;",
      "      126 +  // ctrl+b to run in background",
      "",
      "● Done: the matcher now knows Claude's busy lines.",
      "",
      "✻ Worked for 12s · done 3:10 PM",
      "",
      "────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(claudeTurnRunning(diffIdle)).toBe(false);
    expect(matchesClaudePromptIdle(diffIdle)).toBe(true);
  });

  it("an echoed prompt ending in an ellipsis is not the spinner", () => {
    const echoIdle = [
      "❯ Keep going…",
      "",
      "● All three are done.",
      "",
      "────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────",
    ].join("\n");
    expect(claudeTurnRunning(echoIdle)).toBe(false);
    expect(matchesClaudePromptIdle(echoIdle)).toBe(true);
    const echoLast = [
      "● All three are done.",
      "",
      "❯ Keep going…",
      "",
      "────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────",
    ].join("\n");
    expect(claudeTurnRunning(echoLast)).toBe(false);
  });

  it("the spinner counts only as the last row above the box", () => {
    const spinnerOlder = [
      "✢ Honking… (3s)",
      "● Then it answered.",
      "",
      "────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────",
    ].join("\n");
    expect(claudeTurnRunning(spinnerOlder)).toBe(false);
  });

  it("a question with numbered choices still counts for the tile (asking-you)", () => {
    expect(matchesClaudePromptIdle(CLAUDE_PERMISSION)).toBe(matchesClaudePromptBox(CLAUDE_PERMISSION));
  });
});


// --- v1.154.1 round 4 (RW-C2): the self-check at a fresh session's first turn ---
// Claude 2.1 draws inline from the top of a fresh screen. After the first
// turn (RW-C2: "✻ Sautéed for 15s · done") its box sat mid-screen with blank
// rows below; the Builder's scan read the buffer's last 20 raw rows — blank —
// so the turn never read over and the self-check waited its 10 minutes.
const RULE = "─".repeat(100);
const FIRST_TURN = [
  " ▐▛███▜▌   Claude Code v2.1.267",
  "▝▜█████▛▘  Opus 5.5 (1M context) · Claude Max",
  "  ▘▘ ▝▝    ~/…/sandboxes/ship-loop/app/.atelier-worktrees/card-mumw0r9d-0",
  "",
  "❯ You are the Builder for the Plyloft card \"Add a mod function\".",
  "  Task:",
  "  Add a mod function",
  "",
  "⏺ Bash(cat sum.js; ls; cat package.json 2>/dev/null)",
  "  ⎿  export function sum(a, b) {",
  "     … +31 lines (ctrl+o to expand)",
  "",
  "⏺ Bash(npm test 2>&1 | grep -E \"^(✔|✖|ℹ)\"; git add sum.js && git commit -qm \"Add a mod function…)",
  "  ⎿  ✔ sum adds (0.263833ms)",
  "     ✖ sandbox switch (0.47825ms)",
  "     … +11 lines (ctrl+o to expand)",
  "",
  "⏺ I added `mod(a, b)` to `sum.js` and committed it as 7708084, but `npm test` fails.",
  "  As you asked, I didn't touch `FAIL_CI` or the tests. Build done.",
  "",
  "✻ Sautéed for 15s · done 6:25 PM",
  "",
  RULE,
  "❯",
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];
function fakeBuffer(screen: string[], viewRows: number, scrollback: string[] = []) {
  const lines = [...scrollback, ...screen, ...Array.from({ length: viewRows - screen.length }, () => "")];
  return {
    buf: {
      baseY: scrollback.length,
      getLine: (i: number) => (i < lines.length ? { translateToString: () => lines[i] } : undefined),
    },
    lines,
  };
}
const lastRaw = (lines: string[], n: number) => lines.slice(-n).join("\n");

describe("the Builder's scan at a fresh session's first turn (round 4)", () => {
  it("the buffer's last raw rows are blank below the box: the old scan missed the idle prompt", () => {
    const { lines } = fakeBuffer(FIRST_TURN, 50);
    expect(turnIdleMatcherFor("claude")(lastRaw(lines, 20))).toBe(false);
  });

  it("the settled tail of the screen reads the turn over, promptly", () => {
    const { buf } = fakeBuffer(FIRST_TURN, 50);
    const tail = scanTail(buf, 50, 20);
    expect(tail.endsWith("auto mode on (shift+tab to cycle)")).toBe(true);
    expect(turnIdleMatcherFor("claude")(tail)).toBe(true);
    expect(promptBoxMatcherFor("claude")(tail)).toBe(true);
  });

  it("a full screen with scrollback reads the same", () => {
    const { buf } = fakeBuffer(FIRST_TURN.slice(-22), 22, ["old", "rows"]);
    expect(turnIdleMatcherFor("claude")(scanTail(buf, 22, 20))).toBe(true);
  });

  it("H1 still holds on a fresh screen: a running tool reads busy", () => {
    const running = [
      ...FIRST_TURN.slice(0, 16),
      "⏺ Bash(node -e \"setTimeout(()=>console.log('ok'),50000)\")",
      "  ⎿  Running… (6s · timeout 1m 30s)",
      "     (ctrl+b to run in background)",
      "",
      "✳ Processing… (8s · ↓ 40 tokens)",
      "",
      RULE,
      "❯",
      RULE,
      "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
    ];
    const { buf } = fakeBuffer(running, 50);
    const tail = scanTail(buf, 50, 20);
    expect(claudeTurnRunning(tail)).toBe(true);
    expect(turnIdleMatcherFor("claude")(tail)).toBe(false);
    expect(promptBoxMatcherFor("claude")(tail)).toBe(false);
  });
});

describe("CL-3: the Inbox names an open P1 (mirror of inbox.rs)", () => {
  it("says the shared fixtures' words", () => {
    for (const fixture of P1_DETAIL_FIXTURES) {
      const review = fixture.review as unknown as NonNullable<KanbanCard["builder"]>["review"];
      expect(changesRequestedDetail({ builder: { review } as KanbanCard["builder"] })).toEqual(fixture.expected);
    }
  });

  it("names the open P1s in the review's order, with their place", () => {
    const review = {
      findings: [
        { severity: "P2", title: "Slow", body: "", preExisting: false, pass: null },
        { severity: "P1", title: "Deletes user data", body: "", preExisting: false, pass: null, location: "src/migrate.rs:40" },
      ],
    } as unknown as NonNullable<KanbanCard["builder"]>["review"];
    expect(openP1Findings(review)).toEqual([{ title: "Deletes user data", location: "src/migrate.rs:40" }]);
    expect(changesRequestedDetail({ builder: null })).toEqual("changes requested — needs you");
  });
});

// CL-11 (walk): a Codex self-check sat six minutes on a `git commit`
// approval while the card said it was checking its own work. An approval in
// view is asking you at once, whatever its output does.
describe("a decision in view (CL-11)", () => {
  const codexApproval = [
    "• I'll commit the fixes now.",
    "",
    "Would you like to run the following command?",
    "",
    "Reason: The sandbox blocked writing this worktree's Git index in the shared Git metadata directory",
    "",
    "$ git add src/billing.js && git commit -m 'self-check: fix'",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for this command (a)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
  ].join("\n");
  const codexComposer = ["• Done.", "", "› Write tests for @filename", "", "  ? for shortcuts"].join("\n");
  const codexWorking = ["• Working (12s • esc to interrupt)", "", "› 1. something typed"].join("\n");
  const claudePermission = [
    "⏺ Bash(git commit -m 'fix')",
    "",
    " Bash command",
    "   git commit -m 'fix'",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for git commit commands in this project",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n");
  const claudeIdle = ["⏺ Done.", "────────────────", "❯ ", "────────────────", "  ? for shortcuts"].join("\n");

  it("reads a Codex approval, not its composer or a running turn", () => {
    expect(codexAwaitingDecision(codexApproval)).toBe(true);
    expect(codexAwaitingDecision(codexComposer)).toBe(false);
    expect(codexAwaitingDecision(codexWorking)).toBe(false);
    expect(codexAwaitingDecision("")).toBe(false);
  });

  // Round 2 (F1): an echoed past prompt "› 1. …" and a reply that says
  // "approve", mid-stream, is no approval; nor is the screen once answered.
  it("does not read an echoed numbered prompt as an approval", () => {
    const echoed = [
      "› 1. fix X",
      "",
      "• I'll rename it so the Reviewer will approve the change.",
      "  Editing src/billing.js",
    ].join("\n");
    expect(codexAwaitingDecision(echoed)).toBe(false);
    const draft = ["• Would you like to run the tests too?", "", "› 1. yes please", "", "  ? for shortcuts"].join("\n");
    expect(codexAwaitingDecision(draft)).toBe(false);
    const answered = [codexApproval, "✔ You approved codex to run git add … this time", "", "• Committed.", "", "› ", "", "  ? for shortcuts"].join("\n");
    expect(codexAwaitingDecision(answered)).toBe(false);
  });

  it("reads a Claude permission question, not its idle box", () => {
    expect(claudeAwaitingDecision(claudePermission)).toBe(true);
    expect(claudeAwaitingDecision(claudeIdle)).toBe(false);
    // A numbered list in an answer is not a question.
    expect(claudeAwaitingDecision("⏺ Steps:\n 1. Add the export\n 2. Run the tests")).toBe(false);
  });

  // Round 2 (F2): a draft "❯ 1. …" in the input box is not a question.
  it("does not read a draft in Claude's input box as a question", () => {
    const draft = ["⏺ Do you want to keep the alias?", "────────────────", "❯ 1. keep it", "────────────────", "  ? for shortcuts"].join("\n");
    expect(claudeAwaitingDecision(draft)).toBe(false);
  });

  // UX P-B Mac walk 2: Claude's own question (its AskUserQuestion picker)
  // has no "Do you want to"; read only by silence, any redraw (a focus
  // change when the person leaves the card) made it "working" again.
  it("reads Claude's question picker as a question, not a draft or an answer listing choices", () => {
    const picker = [
      "⏺ I created note.txt with the line one.",
      "",
      "────────────────────────────────────────",
      " ☐ Second line",
      "",
      "Should I add a second line to note.txt?",
      "",
      "❯ 1. No, leave it",
      "     Keep note.txt as it is.",
      "  2. Yes, add a line",
      "     Append a second line.",
      "  3. Type something.",
      "────────────────────────────────────────",
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(claudeAwaitingDecision(picker)).toBe(true);
    const typedDraft = ["⏺ Options:", " 1. a", "────────────────", "❯ 1. no", "────────────────", "  ? for shortcuts"].join("\n");
    expect(claudeAwaitingDecision(typedDraft)).toBe(false);
    const answered = ["⏺ User answered Claude's questions:", "  ⎿ · Should I add a second line? → No, leave it", "", "────────────────", "❯ ", "────────────────", "  ? for shortcuts"].join("\n");
    expect(claudeAwaitingDecision(answered)).toBe(false);
  });

  it("picks the matcher by vendor", () => {
    expect(decisionMatcherFor("codex")(codexApproval)).toBe(true);
    expect(decisionMatcherFor("claude")(claudePermission)).toBe(true);
    expect(decisionMatcherFor("shell")(codexApproval)).toBe(false);
  });

  it("is asking you at once, even while output arrives", () => {
    expect(deriveTileAttention(tile({ kind: "codex", lastOutputAt: NOW, questionInView: true }), NOW)).toBe("asking-you");
    expect(deriveTileAttention(tile({ kind: "codex", lastOutputAt: NOW }), NOW)).toBe("working");
    expect(deriveTileAttention(tile({ kind: "shell", questionInView: true }), NOW)).toBe(null);
  });
});

// 2026-10-15: a member's draft that starts with `!` (bash mode) or `/` keeps
// the box from counting as idle, so Plyloft's paste waits instead of
// landing after the `!` and running in the shell.
describe("composer escaped by the member's draft", () => {
  const RULE = "────────────────────────────────────────────────────────────";
  const claudeBox = (input: string) =>
    [
      "✻ Worked for 12s · done 3:10 PM",
      "",
      RULE,
      input,
      RULE,
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

  it("a Claude draft starting with ! or / is not idle", () => {
    for (const input of ["❯ !ls", "❯ !", "❯ /review", "❯  !x"]) {
      expect(claudeComposerEscaped(claudeBox(input))).toBe(true);
      expect(matchesClaudePromptIdle(claudeBox(input))).toBe(false);
      expect(promptBoxMatcherFor("claude")(claudeBox(input))).toBe(false);
      expect(turnIdleMatcherFor("claude")(claudeBox(input))).toBe(false);
    }
  });

  it("bash mode drawn with ! in place of the chevron is not idle", () => {
    expect(claudeComposerEscaped(claudeBox("! ls"))).toBe(true);
    expect(claudeComposerEscaped(["╭──────────────", "│ ! ls          │", "╰──────────────"].join("\n"))).toBe(true);
  });

  it("an empty box, the placeholder or an ordinary draft stays idle", () => {
    expect(claudeComposerEscaped(IDLE_BOX_2_1)).toBe(false);
    expect(matchesClaudePromptIdle(IDLE_BOX_2_1)).toBe(true);
    expect(claudeComposerEscaped(IDLE_BOX_2_1_NO_FOOTER)).toBe(false);
    expect(matchesClaudePromptIdle(claudeBox("❯ fix the !important rule"))).toBe(true);
  });

  it("a ! or / line in the transcript above the box is not the draft", () => {
    const screen = ["❯ /review", "", "! ran: ls", "● Done.", "", claudeBox("❯ ")].join("\n");
    expect(claudeComposerEscaped(screen)).toBe(false);
    expect(matchesClaudePromptIdle(screen)).toBe(true);
  });

  it("an empty box read back as a bare ❯ is idle, whatever was echoed above it (Reviewer round 2)", () => {
    const screen = [
      "❯ /compact",
      "  ⎿  Compacted.",
      "",
      "❯ !ls",
      "  ⎿  README.md",
      "",
      "✻ Sautéed for 15s · done 6:25 PM",
      "",
      RULE,
      "❯",
      RULE,
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");
    expect(claudeComposerEscaped(screen)).toBe(false);
    expect(matchesClaudePromptIdle(screen)).toBe(true);
    expect(turnIdleMatcherFor("claude")(screen)).toBe(true);
  });

  it("only the draft's first row counts: a later !important or /path line does not hold", () => {
    const multi = (lines: string[]) =>
      ["✻ Worked for 12s · done 3:10 PM", "", RULE, ...lines, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    expect(claudeComposerEscaped(multi(["❯ make the rule", "!important", "/src/app.css too"]))).toBe(false);
    expect(matchesClaudePromptIdle(multi(["❯ make the rule", "!important"]))).toBe(true);
    expect(claudeComposerEscaped(multi(["❯ !ls", "second line"]))).toBe(true);
  });

  it("a / draft with Claude's slash menu ~30 rows below the box is escaped (walk F1)", () => {
    const menu = [
      "  ❯ /ply:release-notes                  (ply) Writes the release note and the status line",
      "                                        the same way every time. Use when a change is rea…",
      "    /ply-team:team-style                (ply-team) Use when writing or changing exported",
      "                                        functions.",
      "    /hello                              Walk check for Plyloft Verify (project)",
      "    /claude-in-chrome                   Automates your Chrome browser to interact with web",
      ...Array.from({ length: 24 }, (_, i) => `    /cmd-${i}                              Does thing ${i}`),
    ];
    const screen = [
      "⏺ HELD-ONE",
      "",
      "✻ Cooked for 3s · done 4:50 PM",
      "",
      RULE,
      "❯ /",
      RULE,
      ...menu,
    ];
    expect(claudeComposerEscaped(screen.join("\n"))).toBe(true);
    // The 20-row tail the prompt-box scan reads holds only the menu: still escaped.
    expect(composerEscapedMatcherFor("claude")(settledTail(screen, 20).join("\n"))).toBe(true);
    expect(matchesClaudePromptIdle(settledTail(screen, 20).join("\n"))).toBe(false);
    // A short filtered menu right below the box.
    expect(claudeComposerEscaped(claudeBox("❯ /he") + "\n    /hello      Walk check for Plyloft Verify (project)")).toBe(true);
    // A path or a lone slash line in an answer is not the menu.
    expect(composerEscapedMatcherFor("claude")("  /tmp/ply-bang-test\n  see /etc/hosts\n  /")).toBe(null);
  });

  it("no box in view is no escaped draft, and says nothing about the draft (null)", () => {
    expect(claudeComposerEscaped("❯ !ls\n  ⎿  README.md")).toBe(false);
    expect(composerEscapedMatcherFor("claude")("❯ !ls\n  ⎿  README.md")).toBe(null);
    expect(composerEscapedMatcherFor("claude")(claudeBox("❯ !ls"))).toBe(true);
    expect(composerEscapedMatcherFor("claude")(claudeBox("❯"))).toBe(false);
    expect(composerEscapedMatcherFor("codex")("Select a model\n  1. gpt")).toBe(null);
    expect(composerEscapedMatcherFor("codex")("› !ls")).toBe(true);
  });

  it("the Codex turn-idle gate (the self-check's) refuses a ! or / draft; dictation's does not", () => {
    const at = (line: string) => settledTail([...CODEX_HEADER, line, "", FOOTER], 20).join("\n");
    expect(turnIdleMatcherFor("codex")(at("› !ls"))).toBe(false);
    expect(turnIdleMatcherFor("codex")(at("› /model"))).toBe(false);
    expect(turnIdleMatcherFor("codex")(at("› Ask Codex to do anything"))).toBe(true);
    expect(matchesCodexComposerIdle(at("› !ls"))).toBe(true);
  });

  it("a Codex draft starting with ! or / holds the paste; the placeholder does not", () => {
    const at = (line: string) => [...CODEX_HEADER, line, "", FOOTER].join("\n");
    expect(codexComposerEscaped(at("› !ls"))).toBe(true);
    expect(codexComposerEscaped(at("› /model"))).toBe(true);
    expect(matchesCodexPromptBox(at("› !ls"))).toBe(false);
    expect(promptBoxMatcherFor("codex")(at("› !ls"))).toBe(false);
    expect(codexComposerEscaped(CODEX_FRESH.join("\n"))).toBe(false);
    expect(matchesCodexPromptBox(settledTail(CODEX_FRESH, 20).join("\n"))).toBe(true);
    expect(codexComposerEscaped(CODEX_TYPED.join("\n"))).toBe(false);
  });
});

// 1.172.0 E2 (Windows walk 2026-10-28, shots/02b): after Plyloft's review
// was typed in, Codex showed its transcript search under the composer and
// the end of the message sat in its query.
describe("codexOverlayOpen (E2)", () => {
  const WALK = [
    "• Understood. I'll wait for any requested changes.",
    "",
    "  Worked for 2s • 07:06",
    "",
    "› Ask Codex to do anything",
    "",
    "  GPT-6.1-Sol default · C:\\ply-test\\sandboxes\\n170\\.plyloft-worktrees\\card-mvr…",
    "Find: and settles case handling.",
    "No matches · full transcript · esc cancel",
    "",
  ];
  it("the walk's screen: the search is open", () => {
    expect(codexOverlayOpen(WALK.join("\n"))).toBe(true);
  });
  it("the bar as codex-cli 0.164.0 draws it before and while typing (measured on the Mac)", () => {
    const base = WALK.slice(0, 7);
    expect(codexOverlayOpen([...base, "  Find: ", "  Type to find · full transcript · esc cancel"].join("\n"))).toBe(true);
    expect(
      codexOverlayOpen([...base, "  Find: a", "  enter accept · ⌃p older · ⌃n newer · full transcript · esc cancel"].join("\n")),
    ).toBe(true);
    // A long query wraps onto a second row above the footer.
    expect(codexOverlayOpen([...base, "Find: a long query", "that wraps", "No matches · full transcript · esc cancel"].join("\n"))).toBe(true);
  });
  it("the plain composer is not an overlay", () => {
    expect(codexOverlayOpen(WALK.slice(0, 7).join("\n"))).toBe(false);
    expect(codexOverlayOpen("")).toBe(false);
  });
  it("a Find: in the transcript, or a footer alone, is not", () => {
    // The text "Find:" in an answer above the composer.
    expect(codexOverlayOpen(["Find: the bug in sort()", "", ...WALK.slice(4, 7)].join("\n"))).toBe(false);
    // A modal's footer without the search row.
    expect(codexOverlayOpen([...WALK.slice(0, 7), "  Press the key now. Esc cancel"].join("\n"))).toBe(false);
    expect(codexOverlayOpen([...WALK.slice(0, 7), "No matches · full transcript · esc cancel"].join("\n"))).toBe(false);
    // The search row with something drawn under its footer.
    expect(codexOverlayOpen([...WALK.slice(0, 9), "› typed later"].join("\n"))).toBe(false);
  });
});

describe("turnRunningMatcherFor (1.174.3)", () => {
  const says = (got: boolean, want: boolean, what: string) => {
    if (got !== want) throw new Error(`${what}: ${got}`);
  };
  it("only the CLI's own status line counts as a turn seen running", () => {
    says(turnRunningMatcherFor("codex")("• Working (4s • esc to interrupt)\n\n› \n\n  100% context left"), true, "codex working");
    says(turnRunningMatcherFor("codex")("• Added walk-note.txt (+1 -0)\n\n› Ask Codex to do anything\n\n  100% context left"), false, "codex idle");
    says(turnRunningMatcherFor("codex")(""), false, "nothing drawn yet");
    says(turnRunningMatcherFor("claude")("✻ Pondering… (4s · esc to interrupt)\n────────\n❯ \n────────"), true, "claude working");
    says(turnRunningMatcherFor("claude")(""), false, "claude nothing");
    says(turnRunningMatcherFor("shell")("esc to interrupt"), false, "a shell");
  });
});

// 1.174.3: Codex's line for a turn cut off, as the Windows walk's terminal drew
// it: the last thing above the composer, and only that.
describe("turnInterruptedMatcherFor (1.174.3)", () => {
  const footer = "  GPT-6.1-Sol default · C:\\ply-test\\card";
  const cut = ["• Ran npm test", "", "■ Conversation interrupted - use /feedback if something went wrong", "", "› Ask Codex to do anything", "", footer].join("\n");
  const after = ["■ Conversation interrupted - use /feedback if something went wrong", "", "› carry on", "", "• Done, the tests pass.", "", "› Ask Codex to do anything", "", footer].join("\n");
  const codex = turnInterruptedMatcherFor("codex");
  it("reads only the line right above the composer", () => {
    expect(codex(cut)).toBe(true);
    expect(codex(cut.replace("Ask Codex to do anything", "carry"))).toBe(true);
    expect(codex(after)).toBe(false);
    expect(codex("■ Conversation interrupted")).toBe(false);
    expect(turnInterruptedMatcherFor("claude")(cut)).toBe(false);
    // Claude, as the Mac walk's terminal drew it: the person's message, no answer.
    const rule = "─".repeat(40);
    const box = ["", rule, "❯ ", rule, "  ⏵⏵ accept edits on"];
    const claude = turnInterruptedMatcherFor("claude");
    expect(claude(["⏺ Wrote it.", "", "❯ Now add three files,", "  each in a command.", ...box].join("\n"))).toBe(true);
    expect(claude(["❯ Add a file", "", "⏺ Write(a.txt)", "  ⎿  Wrote 1 line to a.txt", ...box].join("\n"))).toBe(false);
    expect(claude(["⏺ Done.", "  Nothing else to do.", ...box].join("\n"))).toBe(false);
    expect(claude("❯ alone")).toBe(false);
    // A `❯` in Claude's own reply isn't the person's message.
    expect(claude(["⏺ Run it like this:", "  ❯ npm test", "  then check the output.", ...box].join("\n"))).toBe(false);
    expect(claude(["⏺ Bash(git status --short)", "  ⎿  Interrupted · What should Claude do instead?", ...box].join("\n"))).toBe(true);
  });
});

console.log(`attention.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  throw new Error(`${failed} attention test(s) failed`);
}
