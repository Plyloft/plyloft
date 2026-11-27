// 1.177.0 Compare: real tile screens (Claude Code 2.1.332, Codex 0.172.0,
// Mac, read 2026-11-24; rows as the tile shows them: Claude's blank rows are
// "", Codex's are " ") through the live read and the guard — one verdict each.
//
//     node --experimental-strip-types src/lib/tileScreens.test.ts
import assert from "node:assert/strict";
import type { InputCell } from "./attention.ts";
import { readdirSync, readFileSync } from "node:fs";
import {
  REDRAW_AFTER_RESIZE_MS,
  boxProof,
  claudeBoxProof,
  claudeTurnOver,
  codexBoxProof,
  codexPickerOpen,
  codexScreenFacts,
  codexTurnInBuffer,
  isCodexStartScreen,
  liveScreenFacts,
  outputIsRedraw,
  workStamp,
} from "./tileScreen.ts";
import { claudeTurnEnded, deliveryGate, openTurnStale, type TileFacts } from "./compareView.ts";
import type { CompareAnswer } from "./compareIpc.ts";
import { setPlatformForTests } from "./platform.ts";

const R = "─".repeat(120);
const D = "╌".repeat(120);
const B = " "; // Codex's blank row

type Case = {
  name: string;
  vendor: "claude" | "codex";
  rows: string[];
  /** The input row's cells are drawn plain (typed text) or dim (placeholder). */
  plain: boolean;
  verdict: "ready" | "asking" | "draft" | "working" | "unknown";
  /** The backend's turn for this tile's conversation (default: done). */
  turn?: "open" | "done";
};

const PLAN_TAIL = [
  " 3. Aprire index.html nel browser e controllare che il titolo compaia sopra la lista e ci resti dopo aver aggiunto o rimosso",
  "    una nota.",
  "",
  " File da modificare",
  "",
  " - index.html (unica modifica prevista)",
  "",
  " Verifica",
  "",
  " Servire la cartella (es. python3 -m http.server, necessario perché notes.js è un modulo ES) e controllare la pagina: titolo",
  ' "Notes" sopra la lista, lista funzionante come prima.',
  D,
  "",
  R,
  " Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "",
];
const PLAN_FOOT = ["", " ctrl+g to edit in Vim · ~/.claude/plans/plan-in-at-most-proud-knuth-of-00000000-0000-4000-8000-000000000002.md"];
const boxAbove = [
  "     │ Servire la cartella (es. python3 -m http.server, necessario perché notes.js è un modulo ES) e controllare la pagina:    │",
  '     │ titolo "Notes" sopra la lista, lista funzionante come prima.                                                            │',
  "     ╰" + "─".repeat(113) + "╯",
  "",
];
const sentPrompt = [
  "     ╰" + "─".repeat(113) + "╯",
  "",
  "❯ Create an empty file named probe.txt in this folder." + " ".repeat(64),
  "",
  "⏺ Bash(touch probe.txt && ls -l probe.txt)",
];
const codexBox = (first: string) => [
  first,
  B,
  "  GPT-6.2-Sol default · ~/Library/Application Support/",
  "  com.mbadv.ply.test/app-tester/sandboxes/compare-1177/app",
];

const cases: Case[] = [
  {
    name: "C1 Claude fresh, auto footer",
    vendor: "claude",
    plain: false, // the placeholder is drawn dim
    verdict: "ready",
    rows: [
      " ▐▛███▛█   Claude Code v2.1.332",
      "▝▜██████▀  Fable 5.2 · Claude Ultra",
      " ▝▝   ▝▝   ~/Library/Application Support/com.mbadv.ply.test/app-tester/sandboxes/compare-1177/app",
      "",
      "",
      R,
      '❯ Try "fix lint errors"',
      R,
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents" + " ".repeat(60) + "◐ medium · /effort",
    ],
  },
  { name: "C2 Claude idle, plan mode", vendor: "claude", plain: false, verdict: "ready", rows: ["", R, '❯ Try "fix lint errors"', R, "  ⏸ plan mode on (shift+tab to cycle)"] },
  {
    name: "C3 Claude plan menu",
    vendor: "claude",
    plain: true, // inputRowCells reads the menu's `❯ 1.` row: plain
    verdict: "asking",
    rows: [
      ...PLAN_TAIL,
      " ❯ 1. Yes, and use auto mode",
      "   2. Yes, manually approve edits",
      "   3. Tell Claude what to change",
      "      shift+tab to approve with this feedback",
      ...PLAN_FOOT,
    ],
  },
  {
    name: "C4 Claude plan menu, cursor on row 3",
    vendor: "claude",
    plain: true,
    verdict: "asking",
    rows: [
      ...PLAN_TAIL,
      "   1. Yes, and use auto mode",
      "   2. Yes, manually approve edits",
      " ❯ 3. Tell Claude what to change",
      "      shift+tab to approve with this feedback",
      ...PLAN_FOOT,
    ],
  },
  {
    name: "C5 Claude empty box after Esc, plan mode, plan above",
    vendor: "claude",
    plain: false,
    verdict: "ready",
    rows: [...boxAbove, R, "❯ ", R, "  ⏸ plan mode on (shift+tab to cycle)"],
  },
  {
    name: "C5b the same with the update line under the footer",
    vendor: "claude",
    plain: false,
    verdict: "ready",
    rows: [...boxAbove, R, "❯ ", R, "  ⏸ plan mode on (shift+tab to cycle)", " ".repeat(20) + "✔ Update installed · /restart to apply"],
  },
  {
    name: "C6 Claude command-permission menu",
    vendor: "claude",
    plain: true,
    verdict: "asking",
    rows: [
      ...sentPrompt,
      "  ⎿  Waiting…",
      "",
      R,
      " Bash command",
      ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      " Crea il file vuoto probe.txt",
      D,
      " touch probe.txt && ls -l probe.txt",
      D,
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow access to /Users/plyloft-member0/Library/Application",
      "      Support/com.mbadv.ply.test/app-tester/sandboxes/compare-1177/app from this project",
      "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
      "   4. No",
      "",
      " Esc to cancel · Tab to amend",
    ],
  },
  {
    name: "C7 Claude after a refused command, manual mode",
    vendor: "claude",
    plain: false,
    verdict: "ready",
    rows: [...sentPrompt, "  ⎿  Interrupted · What should Claude do instead?", "", R, "❯ ", R, "  ⏸ manual mode on · ? for shortcuts"],
  },
  {
    name: "C8 Claude, abc typed",
    vendor: "claude",
    plain: true,
    verdict: "draft",
    rows: [...sentPrompt, "  ⎿  Interrupted · What should Claude do instead?", "", R, "❯ abc", R, "  ⏸ manual mode on"],
  },
  // The reviewer's screens: Claude mid-turn, the line that started the turn
  // (and its spinner) off the visible page. Only the backend knows.
  {
    name: "R4 Claude mid-turn, an 18-row todo list above the box, no spinner in view (turn open)",
    vendor: "claude",
    plain: false,
    turn: "open",
    verdict: "working",
    rows: [...Array.from({ length: 18 }, (_, i) => `  ☐ Task number ${i + 1}`), R, "❯ ", R, "  ⏸ manual mode on · ? for shortcuts"],
  },
  {
    name: "R4 Claude mid-turn, a long answer fills the page, no spinner in view (turn open)",
    vendor: "claude",
    plain: false,
    turn: "open",
    verdict: "working",
    rows: [...Array.from({ length: 30 }, (_, i) => `  Some line of the answer being written, number ${i + 1}`), R, "❯ ", R, "  ⏸ manual mode on · ? for shortcuts"],
  },
  {
    name: "C5 with the backend's turn open is not ready",
    vendor: "claude",
    plain: false,
    turn: "open",
    verdict: "working",
    rows: [...boxAbove, R, "❯ ", R, "  ⏸ plan mode on (shift+tab to cycle)"],
  },
  {
    name: "X1 Codex fresh",
    vendor: "codex",
    plain: true, // Codex's placeholder is known by its words
    verdict: "ready",
    rows: [...Array(10).fill(B), "› Ask Codex to do anything", B, "  GPT-6.2-Sol default · ~/Library/Application Support/", "  com.mbadv.ply.test/app-tester/sandboxes/compare-1177/app", "  ← for agents · ? for shortcuts"],
  },
  {
    name: "X2 Codex working",
    vendor: "codex",
    plain: true,
    verdict: "working",
    rows: [
      ...Array(16).fill(B),
      "• Working (1s • esc to interrupt)",
      B,
      B,
      "› Ask Codex to do anything",
      B,
      "  GPT-6.2-Sol default · ~/Library/Application Support/",
      "  com.mbadv.ply.test/app-tester/sandboxes/compare-1177/app ·",
      "  Count to three, one number per line.",
      "  ← for agents · ? for shortcuts",
    ],
  },
  {
    name: "X3 Codex idle after an answer (the answer is above the last 25 rows)",
    vendor: "codex",
    plain: true,
    verdict: "ready",
    rows: [
      B, "  >_ OpenAI Codex (v0.172.0)", "     ~/Library/Application Support/…/compare-1177/app", B, B,
      "› Count to three, one number per line.", B, B, "• 1", "  2", "  3", B, "  Worked for 2s • 23:39", B,
      ...Array(24).fill(B),
      "› Ask Codex to do anything", B, "  GPT-6.2-Sol default · ~/Library/Application Support/", "  com.mbadv.ply.test/app-tester/sandboxes/compare-1177/app ·", "  Count to three, one number per line.", "  ← for agents · ? for shortcuts",
    ].slice(-25),
  },
  {
    name: "X4a Codex /new menu",
    vendor: "codex",
    plain: true, // its `›` row reads as the input row: plain
    verdict: "asking",
    rows: [
      ...Array(15).fill(B),
      "  Where should the new conversation run?", B, B,
      "› 1. Use current Git worktree  Keep using the current working ",
      "                               directory                      ",
      "  2. Create new Git worktree   Create a separate checkout of",
      "                               this repository in another",
      "                               directory",
      B,
      "  enter select · esc back                                     ",
    ],
  },
  {
    name: "X4b Codex after Enter on row 1 (= X1)",
    vendor: "codex",
    plain: true,
    verdict: "ready",
    rows: [...Array(10).fill(B), ...codexBox("› Ask Codex to do anything"), "  ← for agents · ? for shortcuts"],
  },
  {
    name: "X5 Codex, abc typed",
    vendor: "codex",
    plain: true,
    verdict: "draft",
    rows: [...Array(21).fill(B), ...codexBox("› abc")],
  },
];

/** The input row's cells, as the terminal's cell reader would give them. */
function cellsOf(vendor: "claude" | "codex", rows: readonly string[], plain: boolean): InputCell[] | null {
  const chevron = vendor === "claude" ? /^[\s│|]*[>❯]/ : /^[\s│|]*›/;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!chevron.test(rows[i])) continue;
    return [...rows[i]].map((ch) => ({ ch, plain }));
  }
  return null;
}

/** Real tile screens for Compare (`src-tauri/src/compare_fixtures/screens/`):
 *  their header (`# key: value`) and rows. */
const SCREENS = new URL("../../src-tauri/src/compare_fixtures/screens/", import.meta.url);
function screenOf(name: string): { head: Record<string, string>; rows: string[] } {
  const [head, body] = readFileSync(new URL(name, SCREENS), "utf8").split(/^# ----\n/m);
  const h: Record<string, string> = {};
  for (const m of head.matchAll(/^# ([\w-]+): (.*)$/gm)) h[m[1]] = m[2];
  return { head: h, rows: body.replace(/\n$/, "").split("\n") };
}
const screenRowsOf = (name: string) => screenOf(name).rows;

const answer = (vendor: "claude" | "codex", turn: "open" | "done" = "done"): CompareAnswer => ({ vendor, conversation: "known", turn, cut: false });

const words = {
  asking: (to: string) => `${to} is asking you something. Answer it in its tile first.`,
  draft: (to: string) => `${to}'s box has text you typed. Send it or clear it first.`,
  working: (to: string) => `${to} is working. You can pass this when it's done.`,
  unknown: (to: string) => `Can't tell if ${to} is ready. Click its tile and try again.`,
};

const got: string[] = [];
const bad: string[] = [];
for (const c of cases) {
  const to = c.vendor === "claude" ? "Claude" : "Codex";
  const live = liveScreenFacts(c.vendor, c.rows, cellsOf(c.vendor, c.rows, c.plain));
  const facts: TileFacts = {
    id: "t",
    vendor: c.vendor,
    label: "t",
    live: true,
    ended: false,
    question: live.decision,
    draft: live.draft,
    promptIdle: live.promptIdle,
    working: live.working,
    turnOverOnScreen: live.turnOver,
    readyBox: live.readyBox,
    boxDrawn: live.boxDrawn,
  };
  const verdict = deliveryGate(c.vendor, facts, answer(c.vendor, c.turn), "put");
  const sendVerdict = deliveryGate(c.vendor, facts, answer(c.vendor, c.turn), "send");
  if (c.verdict === "ready" || c.verdict === "unknown") assert.equal(sendVerdict, verdict, `${c.name}: Send reads as Put`);
  const expected = c.verdict === "ready" ? null : words[c.verdict](to);
  got.push(`${verdict === expected ? "ok  " : "FAIL"} ${c.name}: ${verdict === null ? "ready" : verdict}`);
  if (verdict !== expected) bad.push(`${c.name}\n  expected ${expected}\n  got      ${verdict}\n  live: ${JSON.stringify({ ...live, tail: undefined, blockTail: undefined })}`);
}
assert.equal(bad.length, 0, "\n" + bad.join("\n"));

// Placeholders are not typed text. Claude's `Try "…"` is told by how it is
// drawn (dim cells), not by its words; Codex's by its words.
{
  const rows = ["", R, '❯ Try "fix lint errors"', R, "  ⏸ plan mode on (shift+tab to cycle)"];
  assert.equal(liveScreenFacts("claude", rows, cellsOf("claude", rows, false)).draft, false);
  assert.equal(liveScreenFacts("claude", rows, cellsOf("claude", rows, true)).draft, true, "typed in the same words is a draft");
  assert.equal(liveScreenFacts("claude", rows, null).draft, null, "text alone can't tell: unknown, never ready");
  const x = [...Array(10).fill(B), "› Ask Codex to do anything", B, "  ← for agents · ? for shortcuts"];
  assert.equal(liveScreenFacts("codex", x, cellsOf("codex", x, true)).draft, false);
}

// The start screen of a Codex tile, on the whole buffer (X1, X3, X4a).
{
  const banner = [B, "  >_ OpenAI Codex (v0.172.0)", "     ~/Library/Application Support/…/compare-1177/app", B];
  const box = ["› Ask Codex to do anything", B, "  GPT-6.2-Sol default · ~/Library/Application Support/", "  ← for agents · ? for shortcuts"];
  const x1 = [...banner, ...Array(10).fill(B), ...box];
  const x3 = [...banner, B, "› Count to three, one number per line.", B, B, "• 1", "  2", "  3", B, "  Worked for 2s • 23:39", B, ...Array(24).fill(B), ...box];
  const x4a = cases.find((c) => c.name.startsWith("X4a"))!.rows;
  assert.equal(isCodexStartScreen(x1), true, "X1 fresh");
  assert.equal(isCodexStartScreen(x3), false, "X3 after an answer");
  assert.equal(codexTurnInBuffer(x3), true);
  assert.equal(isCodexStartScreen(x4a), false, "X4a /new menu: no banner");
  assert.equal(isCodexStartScreen([...banner, ...x4a]), false, "menu over a banner is still no start screen");
  assert.equal(isCodexStartScreen(["", R, "❯ ", R, "  ⏸ plan mode on (shift+tab to cycle)"]), false, "a Claude screen");
  assert.equal(isCodexStartScreen([]), false, "empty buffer");
  assert.equal(isCodexStartScreen(Array(30).fill(B)), false, "blank buffer");
  assert.equal(isCodexStartScreen([...banner, "• Working (1s • esc to interrupt)", ...box]), false, "a running turn");
  assert.equal(isCodexStartScreen([...banner, ...Array(10).fill(B), "› abc", B, "  GPT-6.2-Sol default · ~/x"]), false, "a draft hides the footer row: not known as the start screen");
  assert.equal(codexTurnInBuffer([...banner, ...Array(10).fill(B), "› abc", B, "  GPT-6.2-Sol default · ~/x"]), false, "a draft in the box is no turn");
  // Finding 1: old turns kept in the scrollback above a NEW banner.
  const old = [...banner, "› Print 1 to 200", B, ...Array.from({ length: 200 }, (_, i) => (i === 0 ? "• 1" : `  ${i + 1}`)), "  Worked for 9s • 23:39", B];
  assert.equal(isCodexStartScreen([...old, ...x1]), true, "old turns above, new banner, empty box");
  assert.equal(codexScreenFacts(old.length + x1.length, (i) => [...old, ...x1][i]).turn, false, "old turns above the last banner are no turn");
  assert.equal(isCodexStartScreen([...old, ...banner, ...Array(10).fill(B), "• 1", ...box]), false, "a turn under the last banner");
  // The start shape under the banner: a /status card reusing the title is no start screen.
  assert.equal(isCodexStartScreen([...banner, "  Model: GPT-6.2-Sol", "  Directory: ~/x", B, ...box]), false, "a card with fields");
  // Finding 2: rows that are not a turn.
  const draft = [...banner, ...Array(5).fill(B), "› first line", "  • pasted bullet", "  › quoted", B, "  GPT-6.2-Sol default · ~/x"];
  assert.equal(codexTurnInBuffer(draft), false, "a draft's continuation rows (indented) are no turn");
  assert.equal(codexTurnInBuffer([...banner, "• Working (1s • esc to interrupt)", B, ...box]), false, "the working row");
  assert.equal(codexTurnInBuffer([...banner, "• Booting MCP server: x (2s)", B, ...box]), false, "the booting row");
  const popup = [...banner, ...Array(5).fill(B), "› /", B, "› /model  choose a model", "  /new  start a new chat"];
  assert.equal(codexTurnInBuffer(popup), false, "a slash popup's selected row is no turn");
  assert.deepEqual(codexScreenFacts(0, () => ""), { turn: false, start: false });
  // The cap: a banner out of reach is not the start screen.
  assert.equal(codexScreenFacts(x1.length, (i) => x1[i], 3).start, false, "cap hit: not fresh");
  // Real, Windows walk 2026-11-25, Codex 0.171 (alternate screen, no scrollback).
  // Before `/new`: a pinned user row, the answer's tail, no banner on the buffer.
  const winBefore = [
    "› Write the numbers from 1 to 60, one per line, nothing else.",
    ...Array.from({ length: 31 }, (_, i) => `  ${i + 30}`), " ", "  Worked for 5s • 08:59", " ", " ",
    "› Ask Codex to do anything", " ", "  GPT-6.2-Sol default · C:\\ply-test\\sandboxes\\compare-1177\\app", "  ← for agents · ? for shortcuts",
  ];
  assert.deepEqual(codexScreenFacts(winBefore.length, (i) => winBefore[i]), { turn: true, start: false }, "Windows, after a long answer");
  // After `/new` + Enter on row 1, 26 rows.
  const winFoot = ["› Ask Codex to do anything", " ", "  GPT-6.2-Sol default · C:\\ply-test\\sandboxes\\compare-1177\\app", "  ← for agents · ? for shortcuts"];
  const winHead = [" ", "  >_ OpenAI Codex (v0.171.0)", "     C:\\ply-test\\sandboxes\\compare-1177\\app"];
  const winAfter = [...winHead, ...Array(19).fill(" "), ...winFoot];
  assert.deepEqual(codexScreenFacts(winAfter.length, (i) => winAfter[i]), { turn: false, start: true }, "Windows, after /new");
  // A taller tile: Codex draws its logo between the banner and the box.
  const logo = ["                 ⣀⣤⣤⣤⣀⣀", "              ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣦⣤⣤⣤⣤⣤⣤⡀", "            ⢀⣾⣿⣿⠿⠋⠉⠉⢉⣭⣿⣿⣿⣿⣿⠿⣿⣿⣿⣿⣷⣄", "                    ⠈⠙⠛⠿⠿⠿⠿⠛⠉"];
  assert.equal(isCodexStartScreen([...winHead, ...Array(10).fill(" "), ...logo, ...Array(9).fill(" "), ...winFoot]), true, "the start screen with the logo");
  assert.equal(isCodexStartScreen([...winHead, " ", "  Tip: try /review", " ", ...winFoot]), false, "words between the banner and the box");
  // The transcript pager (alternate screen too): the last `›` row is a message, its answer under it.
  assert.equal(isCodexStartScreen([...banner, "› Count to three", B, "• 1", "  2", "  3", B, "  ↑/↓ scroll · q quit"]), false, "the pager at the top of a transcript");
  // Real, Mac walk 2026-11-25, Codex 0.172 after `/new`: a leftover above the
  // banner, the logo, and a footer wrapped over four rows.
  const macAfter = [
    " ".repeat(58) + "lse.", "  >_ OpenAI Codex (v0.172.0)", "     ~/Library/Application Support/…/compare-1177/app",
    ...Array(8).fill(B), ...logo, ...Array(5).fill(B), "› Ask Codex to do anything", B,
    "  GPT-6.2-Sol default · ~/Library/Application Support/", "  com.mbadv.ply.test/app-tester/sandboxes/compare-1177/", "  app", "  ← for agents · ? for shortcuts",
  ];
  assert.deepEqual(codexScreenFacts(macAfter.length, (i) => macAfter[i]), { turn: false, start: true }, "Mac, after /new, wrapped footer");
  // Review round 3: a first message taller than the screen, no answer in view.
  assert.equal(
    isCodexStartScreen([...banner, "› Review this plan. Say what is missing.", ...Array(20).fill("  a pasted line of the plan"), B, "  ↑/↓ scroll · q quit"]),
    false,
    "the pager on a long first message",
  );
  assert.equal(isCodexStartScreen([...banner, ...Array(5).fill(B), "› Ask Codex to do anything", B, "q quit · ? for shortcuts"]), false, "a column-0 row under the box");
}

// F1, real (Windows walk 2026-11-25, step 11, Claude Code 2.1.332): Send,
// then Esc before any output. The rows are the tile as its screenshot shows
// them (`app-walks/2026-11-25-091333-…/shots/11-send-then-esc.png`; the walk
// recorded no grid read): the logo rows left out, the box rules at the tile's
// width. Claude put the text back in its box; its transcript's turn stays
// open (src-tauri/src/compare_fixtures/win-send-esc-tail.jsonl).
{
  const W = "─".repeat(64);
  const above = [
    "❯ Say OK in one word.",
    "",
    "● OK",
    "",
    "✻ Worked for 7s · done 9:14 AM",
    "",
    "❯  From Codex:",
    "  BLUE",
    "",
    '● Noted: Codex says "BLUE". What would you like me to do with',
    "  it?",
    "",
    "✻ Brewed for 2s · done 9:20 AM",
    "",
  ];
  const backInBox = [...above, W, "❯ From Codex:", "  BLUE", W, "  ⏵⏵ auto mode on (shift+tab to cycle)"];
  const cleared = [...above, W, "❯ ", W, "  ⏵⏵ auto mode on (shift+tab to cycle)"];
  // A real turn started from that screen: its prompt row and spinner above the box, the footer says so.
  const running = [...above, "❯ From Codex:", "  BLUE", "", "✻ Thinking… (3s · ↓ 12 tokens)", "", W, "❯ ", W, "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"];
  // Thinking with the footer's words gone (unmeasured) still has no `done` line last.
  const silent = [...above, "❯ From Codex:", "  BLUE", "", W, "❯ ", W, "  ⏵⏵ auto mode on (shift+tab to cycle)"];
  const open: CompareAnswer = { vendor: "claude", conversation: "known", turn: "open", answer: "Noted.", answerKind: "text", cut: false };
  const factsOf = (rows: string[], plain: boolean, quietMs: number): TileFacts => {
    const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, plain));
    return {
      id: "t", vendor: "claude", label: "t", live: true, ended: false,
      question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working,
      quietMs, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn,
    };
  };
  assert.equal(claudeTurnOver(backInBox), true);
  assert.equal(deliveryGate("claude", factsOf(backInBox, true, 6_000), open, "send"), "Claude's box has text you typed. Send it or clear it first.");
  assert.equal(deliveryGate("claude", factsOf(cleared, false, 6_000), open, "send"), null, "proven over, idle and still: Send goes");
  assert.equal(deliveryGate("claude", factsOf(cleared, false, 1_000), open, "send"), "Claude is working. You can pass this when it's done.", "printed a moment ago");
  assert.equal(claudeTurnOver(running), false);
  assert.equal(deliveryGate("claude", factsOf(running, false, 60_000), open, "send"), "Claude is working. You can pass this when it's done.");
  assert.equal(claudeTurnOver(silent), false, "a new prompt row above the box, no done line after it");
  assert.notEqual(deliveryGate("claude", factsOf(silent, false, 60_000), open, "send"), null);
}

// Review B1: every frame of the Builder's screen fixtures (real Mac and
// Windows captures and the synthetic ones) whose truth is a running turn,
// with an open known turn and a minute of quiet, never takes a Send — Codex
// at all (its open turn always stands), Claude because its screen never
// proves the turn over. Claude's idle frames do prove it.
{
  const dir = new URL("../../src-tauri/src/builder_screens_fixtures/", import.meta.url);
  let working = 0;
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const [head, body] = text.split(/^# ----\n/m);
    const vendor = /# vendor: (\w+)/.exec(head)![1] as "claude" | "codex";
    const truth = /# truth: (\w+)/.exec(head)![1];
    const expect = /# expect: (\w+)/.exec(head)![1];
    const rows = body.replace(/\n$/, "").split("\n");
    const live = liveScreenFacts(vendor, rows, null);
    const f: TileFacts = {
      id: "t", vendor, label: "t", live: true, ended: false,
      question: live.decision, draft: false, promptIdle: live.promptIdle, working: live.working,
      quietMs: 60_000, turnOverOnScreen: vendor === "codex" ? true : live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn,
    };
    const open: CompareAnswer = { vendor, conversation: "known", turn: "open", answer: "x", answerKind: "text", cut: false };
    if (truth === "working" || (vendor === "codex" && expect === "working")) {
      working++;
      assert.equal(openTurnStale(f), false, name);
      assert.notEqual(deliveryGate(vendor, f, open, "send"), null, `${name}: never Send into a running turn`);
      if (vendor === "claude") assert.equal(live.turnOver, false, `${name}: no proof of a finished turn`);
    }
    if (vendor === "claude" && expect === "nothing") assert.equal(live.turnOver, true, `${name}: an idle Claude proves it`);
  }
  assert.ok(working >= 24, `frames read: ${working}`);
}

// 1.177.1 (items 18, 4/16): Compare writes only on POSITIVE proof of the
// CLI's idle box. Every frame of the Builder's screen fixtures, through the
// box proof and through the whole guard (cells unknown: the box's text decides
// the draft), with the expected verdict per frame. Only these frames show an
// idle box ready for text; every other one — running, streaming, a menu, a
// trust question, the start-up splash, nothing drawn — refuses.
{
  const READY = new Set([
    "claude-2.1-mac-2-turn-just-over.txt",
    "claude-2.1-mac-3-idle-20s.txt",
    "claude-2.1-mac-4-idle-fresh-output.txt",
    "claude-2.1-mac-turn-over.synthetic.txt",
    "claude-2.1-win-2-turn-just-over.txt",
    "claude-2.1-win-3-idle-10s.txt",
    "claude-2.1-win-4-idle-fresh-output.txt",
    "codex-0.171-mac-5-turn-just-over.txt",
    "codex-0.171-mac-6-idle-15s.txt",
    "codex-0.171-mac-7-idle-fresh-output.txt",
    "codex-0.171-win-5-turn-just-over.txt",
    "codex-0.171-win-6-idle-15s.txt",
    "codex-0.171-win-7-idle-fresh-output.txt",
  ]);
  // Frames whose box SHAPE reads ready, where another guard decides: a
  // synthetic Claude screen whose spinner AND footer words are both gone
  // (unmeasured; every real working Claude frame has "esc to interrupt" in
  // its footer) — the turn's start isn't in view, so "working" is unknown and
  // only a transcript with no open turn lets it through; and a synthetic
  // Codex box holding a prompt Plyloft typed (text in the box: never).
  // Round 9: the synthetic spinner-outside-scan frame no longer reads ready at
  // all — a spinner row anywhere after the last finished turn is a turn running.
  const SHAPE_ONLY = new Set(["codex-0.171-idle-typed-prompt.synthetic.txt"]);
  const dir = new URL("../../src-tauri/src/builder_screens_fixtures/", import.meta.url);
  const names = readdirSync(dir).sort();
  const wrong: string[] = [];
  for (const name of names) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const [head, body] = text.split(/^# ----\n/m);
    const vendor = /# vendor: (\w+)/.exec(head)![1] as "claude" | "codex";
    const rows = body.replace(/\n$/, "").split("\n");
    const live = liveScreenFacts(vendor, rows, null);
    const shapeReady = READY.has(name) || SHAPE_ONLY.has(name);
    if (boxProof(vendor, rows).ready !== shapeReady) wrong.push(`${name}: box proof ${!shapeReady ? "ready" : "not ready"}`);
    for (const turn of ["done", "open"] as const) {
      const f: TileFacts = {
        id: "t", vendor, label: "t", live: true, ended: false,
        question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working,
        quietMs: 60_000, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn,
      };
      const a: CompareAnswer = { vendor, conversation: "known", turn, answer: "x", answerKind: "text", cut: false };
      for (const action of ["put", "send"] as const) {
        const v = deliveryGate(vendor, f, a, action);
        // An open rollout turn takes nothing into Codex, Put or Send (review
        // B1; round 1 H1).
        const expectReady =
          READY.has(name) && !(turn === "open" && vendor === "codex");
        if ((v === null) !== expectReady) wrong.push(`${name} ${action} turn ${turn}: ${v ?? "ready"}`);
      }
    }
  }
  assert.equal(wrong.length, 0, "\n" + wrong.join("\n"));
  assert.ok(names.length >= 37, `frames read: ${names.length}`);
}

// Round 3: every real screen of the Mac capture walk (2026-11-26, Claude Code
// 2.1.332, Codex 0.172.0) through the live read and the whole guard, with
// the verdict its header names: the conversation known and its turn done
// unless the header says otherwise (a fresh tile's `turn: none`, a working
// one's `turn: open`). `send-open: ready`: a Send also goes into the turn
// Esc left open (4/16), once the screen has been still.
{
  const names = readdirSync(SCREENS).filter((n) => n.endsWith(".txt")).sort();
  const wrong: string[] = [];
  // Round 9: each frame as the report gives it, and as the app reads it
  // (xterm's `translateToString(true)` drops trailing spaces).
  for (const [name0, trim] of names.flatMap((n) => [[n, false], [n, true]] as const)) {
    const name = trim ? `${name0} (trimmed)` : name0;
    const { head, rows: raw } = screenOf(name0);
    const rows = trim ? raw.map((r) => r.replace(/\s+$/, "")) : raw;
    const vendor = head.vendor as "claude" | "codex";
    assert.match(head.source, /^real capture/, `${name}: real`);
    const live = liveScreenFacts(vendor, rows, cellsOf(vendor, rows, head.cells === "plain"));
    const f: TileFacts = {
      id: "t", vendor, label: "t", live: true, ended: false,
      question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working,
      quietMs: 60_000, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxIdle: live.boxIdle,
      boxAsked: live.boxAsked, boxMode: live.boxMode, inputQuietMs: Number.POSITIVE_INFINITY, echoPending: false,
    };
    const a: CompareAnswer = {
      vendor,
      conversation: (head.conversation as CompareAnswer["conversation"]) ?? "known",
      turn: (head.turn as CompareAnswer["turn"]) ?? "done",
      answer: "x",
      answerKind: "text",
      cut: false,
    };
    const to = vendor === "claude" ? "Claude" : "Codex";
    const expected = head.verdict === "ready" ? null : words[head.verdict as keyof typeof words](to);
    const put = deliveryGate(vendor, f, a, "put");
    if (put !== expected) wrong.push(`${name} put: expected ${expected ?? "ready"}, got ${put ?? "ready"}`);
    if (head.verdict === "ready" && a.turn !== "open") {
      const send = deliveryGate(vendor, f, a, "send");
      if (send !== null) wrong.push(`${name} send: ${send}`);
    }
    if (head["send-open"] === "ready") {
      const send = deliveryGate(vendor, f, { ...a, turn: "open" }, "send");
      if (send !== null) wrong.push(`${name} send into the open turn: ${send}`);
    }
    // Codex: an open rollout turn refuses whatever the screen (H1).
    if (vendor === "codex" && a.conversation === "known") {
      if (deliveryGate(vendor, f, { ...a, turn: "open" }, "put") === null) wrong.push(`${name}: put into an open Codex turn`);
    }
  }
  assert.equal(wrong.length, 0, "\n" + wrong.join("\n"));
  assert.ok(names.length >= 39, `screens read: ${names.length}`);
  // M2 (cap 12-b): Codex idle under its /status card — no turn's end above
  // the box. Ready on the rollout's word that its turn is closed; with no
  // such word (fresh, `/new`, ambiguous) the stricter rule refuses.
  const status = screenRowsOf("codex-after-status.txt");
  assert.deepEqual(codexBoxProof(status), { drawn: true, ready: false, turnOver: false, idleShape: true, askedShape: false, boxMode: false });
  const sx = liveScreenFacts("codex", status, cellsOf("codex", status, true));
  const xf: TileFacts = { id: "t", vendor: "codex", label: "t", live: true, ended: false, question: sx.decision, draft: sx.draft, promptIdle: sx.promptIdle, working: sx.working, readyBox: sx.readyBox, boxDrawn: sx.boxDrawn, boxIdle: sx.boxIdle };
  const known = (turn: CompareAnswer["turn"], conversation: CompareAnswer["conversation"] = "known"): CompareAnswer => ({ vendor: "codex", conversation, turn, cut: false });
  assert.equal(deliveryGate("codex", xf, known("done"), "send"), null);
  assert.equal(deliveryGate("codex", xf, known("none"), "put"), "Can't tell if Codex is ready. Click its tile and try again.", "no turn on record: the strict rule");
  assert.equal(deliveryGate("codex", xf, known("none", "ambiguous"), "put"), "Can't tell if Codex is ready. Click its tile and try again.");
  assert.equal(deliveryGate("codex", xf, known("open"), "put"), "Codex is working. You can pass this when it's done.");
  // A turn that has just started: the member's prompt right above the box,
  // nothing after it yet (reconstructed from cap 12-e) — never the idle shape.
  const asked = [...status.slice(0, -6), "› Say ORANGE in one word.", " ", " ", ...status.slice(-6)];
  assert.equal(asked[asked.length - 6], "› Ask Codex to do anything");
  assert.equal(codexBoxProof(asked).idleShape, false);
  // Walk step 8 (caps 8-b, 8-c): the passed text back in Claude's box after
  // Send + Esc. The screen proves the turn over and the box holds the text:
  // the bar's facts read "not working, text in the box" (`factsOfTile`), so
  // the line says the text is in its box at once.
  for (const n of ["claude-send-esc-scrolled-2-text-back.txt", "claude-send-esc-scrolled-3-text-back.txt"]) {
    const rows = screenRowsOf(n);
    const l = liveScreenFacts("claude", rows, cellsOf("claude", rows, true));
    assert.equal(l.turnOver, true, n);
    assert.equal(l.draft, true, n);
    assert.equal(l.decision, false, n);
  }
  // Review round 2 (M1), derived from the real frame `codex-idle-after-pass`
  // (step 4) with its answer rows cut — the instant after a pass of several
  // lines was submitted, before Codex drew anything: never the idle shape.
  const afterPass = screenRowsOf("codex-idle-after-pass.txt");
  const answerAt = afterPass.findIndex((r) => r.startsWith("• RECEIVED"));
  const workedAt = afterPass.findIndex((r) => r.includes("Worked for"));
  assert.ok(answerAt > 0 && workedAt > answerAt);
  const justSubmitted = [...afterPass.slice(0, answerAt), ...afterPass.slice(workedAt + 1)];
  assert.equal(codexBoxProof(afterPass).idleShape, true, "the real frame: answered");
  assert.equal(codexBoxProof(justSubmitted).idleShape, false, "a prompt of several lines just submitted");
  const jf = liveScreenFacts("codex", justSubmitted, cellsOf("codex", justSubmitted, true));
  assert.equal(
    deliveryGate("codex", { id: "t", vendor: "codex", label: "t", live: true, ended: false, question: jf.decision, draft: jf.draft, promptIdle: jf.promptIdle, working: jf.working, readyBox: jf.readyBox, boxDrawn: jf.boxDrawn, boxIdle: jf.boxIdle }, known("done"), "put"),
    "Can't tell if Codex is ready. Click its tile and try again.",
    "even with a rollout that still says its last turn is closed",
  );
  // Reconstructed from cap 12-b: a taller tile showing `/status`'s own echo
  // above its card — a slash command, no turn: still the idle shape.
  const statusEcho = ["› /status", " ", ...status];
  assert.equal(codexBoxProof(statusEcho).idleShape, true);
  // …while a prompt (not a command) with only blank rows under it is.
  assert.equal(codexBoxProof(["› Say ORANGE in one word.", " ", " ", ...status.slice(-6)]).idleShape, false);
  assert.equal(codexBoxProof([" ", " ", ...status.slice(-6)]).idleShape, true, "the same box, nothing above");
  // Round 5 (final Mac walk 2026-11-26, steps 6-7: the cause). Opening the
  // composer shrank the Codex tile (42 → 34 rows); the `/status` echo scrolled
  // off and Codex pinned its LAST PROMPT at the top over the card. Screen
  // reconstructed from the real cap 12-b plus the pinned row and the card's
  // first row as screenshot step6-composer-cant-tell.png shows them. The
  // round-4 walk-up read that pinned row as a prompt just asked: "Can't tell…"
  // for good, since nothing changes on an idle screen.
  const pinned = ["› Say PURPLE in one word.", " ", "  Model:               GPT-6.2-Sol (reasoning low,", "                       summaries auto)", ...status];
  assert.deepEqual(codexBoxProof(pinned), { drawn: true, ready: false, turnOver: false, idleShape: false, askedShape: true, boxMode: false });
  const pf = liveScreenFacts("codex", pinned, cellsOf("codex", pinned, true));
  const pinnedFacts = (inputQuietMs: number | null): TileFacts => ({
    id: "t", vendor: "codex", label: "t", live: true, ended: false, question: pf.decision, draft: pf.draft, promptIdle: pf.promptIdle,
    working: pf.working, readyBox: pf.readyBox, boxDrawn: pf.boxDrawn, boxIdle: pf.boxIdle, boxAsked: pf.boxAsked, inputQuietMs,
  });
  // The member typed `/status` a moment ago: not yet (it could be a prompt
  // just asked); 3 s on, and with no typing at all, the pass goes.
  assert.equal(deliveryGate("codex", pinnedFacts(1_000), known("done"), "put"), "Can't tell if Codex is ready. Click its tile and try again.");
  for (const q of [3_000, 45_000, Number.POSITIVE_INFINITY]) {
    assert.equal(deliveryGate("codex", pinnedFacts(q), known("done"), "put"), null, `quiet ${q}`);
    assert.equal(deliveryGate("codex", pinnedFacts(q), known("done"), "send"), null, `quiet ${q}`);
    assert.equal(deliveryGate("codex", pinnedFacts(q), known("open"), "put"), "Codex is working. You can pass this when it's done.");
    assert.equal(deliveryGate("codex", pinnedFacts(q), known("none"), "put"), "Can't tell if Codex is ready. Click its tile and try again.");
  }
  assert.equal(deliveryGate("codex", pinnedFacts(null), known("done"), "put"), "Can't tell if Codex is ready. Click its tile and try again.", "input not read");
  // The same 34-row screen after `/model` + Esc is identical: the same verdicts.
  // The just-submitted multi-line prompt (round 4) stays refused while the
  // member's typing is recent.
  const jq = { ...pinnedFacts(500), boxIdle: jf.boxIdle, boxAsked: jf.boxAsked };
  assert.equal(jf.boxAsked, true);
  assert.equal(deliveryGate("codex", jq, known("done"), "put"), "Can't tell if Codex is ready. Click its tile and try again.");
  // The /model picker (cap 12-c): its marked row 22 rows up, its footer last.
  assert.equal(codexPickerOpen(screenRowsOf("codex-model-picker.txt")), true);
  assert.equal(codexPickerOpen(status), false);
}

// 1.177.1: screens transcribed from walk screenshots (no grid was read; a
// walk must capture each as a real frame) or reconstructed (named so), and
// the real Mac captures of 2026-11-26 where they replace one.
{
  const W = "─".repeat(74);
  const factsOf = (vendor: "claude" | "codex", rows: string[], plain: boolean, quietMs = 60_000): TileFacts => {
    const live = liveScreenFacts(vendor, rows, cellsOf(vendor, rows, plain));
    return {
      id: "t", vendor, label: "t", live: true, ended: false,
      question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working,
      quietMs, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxIdle: live.boxIdle,
    };
  };
  const open: CompareAnswer = { vendor: "claude", conversation: "known", turn: "open", answer: "x", answerKind: "text", cut: false };
  // Real (Mac capture walk 2026-11-26, cap 3, Claude Code 2.1.332): a NAMED
  // session idle — the name inside the rule above the box, right-aligned.
  const namedIdle = screenRowsOf("claude-named-idle-after-turn.txt");
  assert.deepEqual(claudeBoxProof(namedIdle), { drawn: true, ready: true, turnOver: true, idleShape: true, askedShape: false, boxMode: true, running: false }, "named session at idle");
  assert.equal(deliveryGate("claude", factsOf("claude", namedIdle, false), open, "send"), null, "named, idle, turn over: Send goes");
  // Real (step 7): Claude's grey suggestion in the named box is no draft; the
  // same words drawn plain are.
  const suggestion = screenRowsOf("claude-named-suggestion.txt");
  assert.equal(deliveryGate("claude", factsOf("claude", suggestion, false), open, "send"), null);
  assert.equal(deliveryGate("claude", factsOf("claude", suggestion, true), open, "put"), "Claude's box has text you typed. Send it or clear it first.");
  // Reconstructed from it: the box half drawn, its footer not yet there (the
  // Windows walk's 09-answer-composer.png showed one) — no proof.
  const halfDrawn = namedIdle.slice(0, -2);
  assert.equal(claudeBoxProof(halfDrawn).ready, false);
  assert.notEqual(deliveryGate("claude", factsOf("claude", halfDrawn, false), open, "put"), null);

  // Transcribed: Windows walk 2026-11-24 (235814), shot step3-look.png, Claude
  // Code 2.1.330, a plan-mode turn that ended in a sign-in error (no `done`
  // line): the error row, the notices row right above the box, the box
  // holding Claude's dim hint. Item 4: the turn reads over, at once.
  const loginEnded = [
    "❯ Plan, in at most five short steps, how to show a word count",
    "  under the notes list. Read at most two files.",
    "",
    "● Login reached its time limit · Please run /login",
    ...Array(12).fill(""),
    "  Not logged in · run /l… · ✓ Update installed · Restart to…",
    W,
    "❯ Once fixed, resend your message",
    W,
    "  ⏸ plan mode on (shift+tab to cycle)",
  ];
  assert.deepEqual(claudeBoxProof(loginEnded), { drawn: true, ready: true, turnOver: true, idleShape: true, askedShape: false, boxMode: true, running: false }, "a turn a sign-in error ended");
  const lf = factsOf("claude", loginEnded, false, 0);
  assert.equal(claudeTurnEnded(lf), true, "the line leaves 'working' at once");
  assert.equal(deliveryGate("claude", lf, open, "put"), null, "Put at once");
  assert.equal(deliveryGate("claude", lf, open, "send"), "Claude is working. You can pass this when it's done.", "Send once the screen is still");
  assert.equal(deliveryGate("claude", factsOf("claude", loginEnded, false), open, "send"), null, "…then Send goes");

  // Review round 1 (M1), reconstructed (no capture): rows that are no turn's
  // end — Claude's retry row, a tool's output mentioning an API error, an
  // error row under a spinner that goes on.
  const endedBy = (rows: string[]) => claudeBoxProof([...rows, "", W, "❯ ", W, "  ⏸ manual mode on · ? for shortcuts"]).turnOver;
  const asked = ["❯ Fix the build.", ""];
  assert.equal(endedBy([...asked, "  ⎿  API Error (Connection error.) · Retrying in 4 seconds… (attempt 2/10)"]), false, "a retry");
  assert.equal(endedBy([...asked, "● Bash(curl x)", '  ⎿  {"error":"API Error: rate limited"}']), false, "a tool's output");
  assert.equal(endedBy([...asked, "✶ Thinking…", "", "  ⎿  API Error: 500 Internal server error"]), false, "a spinner over it");
  assert.equal(endedBy([...asked, "● I'll check where /login is wired."]), false, "an answer that mentions /login");
  assert.equal(endedBy([...asked, "  ⎿  API Error: 500 Internal server error"]), true, "an API error that ended the turn");
  assert.equal(endedBy([...asked, "  ⎿  Interrupted · What should Claude do instead?"]), true, "Esc");
  assert.equal(endedBy(["✻ Worked for 2s · done 9:00 AM", "", "✶ Thinking…", "", "  ⎿  Interrupted · What should Claude do instead?"]), false, "a spinner in that turn");

  // Real (cap 8-d): 4/16's other case — Send, then Esc, with the turn's start
  // scrolled off the page, the box cleared. The readiness probe can't say
  // "working" (no prompt row in view); the `done` line over the box proves
  // the turn over.
  const scrolled = screenRowsOf("claude-send-esc-scrolled-4-cleared.txt");
  const sf = factsOf("claude", scrolled, false);
  assert.equal(sf.turnOverOnScreen, true);
  assert.equal(deliveryGate("claude", { ...sf, working: null }, open, "send"), null, "working unknown, the turn proven over");
  assert.equal(deliveryGate("claude", { ...sf, working: null, quietMs: 1_000 }, open, "send"), "Claude is working. You can pass this when it's done.");

  // Real (cap 10-a): Claude's /model picker in a named session — the name row
  // above an empty row and a full rule, no box. It asks; it is never a box.
  const picker = screenRowsOf("claude-model-picker-named.txt");
  assert.equal(claudeBoxProof(picker).drawn, false);
  const um = factsOf("claude", picker, true);
  assert.equal(deliveryGate("claude", um, answer("claude"), "put"), "Claude is asking you something. Answer it in its tile first.");
  // …and should the menu matchers ever miss it, still no write.
  assert.equal(deliveryGate("claude", { ...um, question: false }, answer("claude"), "put"), "Can't tell if Claude is ready. Click its tile and try again.");
  // Reconstructed (seen only in a screenshot, 09-esc-once.png; its leading
  // spaces unknown): `abc` and one Esc, Claude's "esc again to clear" row
  // under the footer. Text in the box; the footer says `esc`: no proof.
  const escOnce = [...screenRowsOf("claude-abc-after-one-esc.txt"), " ".repeat(34) + "esc again to clear"];
  assert.equal(claudeBoxProof(escOnce).ready, false);
  assert.equal(deliveryGate("claude", factsOf("claude", escOnce, true), answer("claude"), "put"), "Claude's box has text you typed. Send it or clear it first.");

  // Reconstructed: a narrow tile whose footer Claude cut short (`…`): its
  // running words may be what was cut. No proof.
  const cut = [...scrolled.slice(0, -1), "  ⏵⏵ auto mode on (shift+tab to cycle) · es…"];
  assert.equal(claudeBoxProof(cut).ready, false, "a cut footer");
  // …and one that wrapped at a word: read as one footer.
  const wrapped = [...scrolled.slice(0, -1), "  ⏵⏵ auto mode on (shift+tab to", "  cycle)"];
  assert.equal(claudeBoxProof(wrapped).ready, true, "a wrapped footer");
  const wrappedRunning = [...scrolled.slice(0, -1), "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to", "  interrupt"];
  assert.equal(claudeBoxProof(wrappedRunning).ready, false, "a wrapped running footer");

  // Codex: the start screen with the footer wrapped on a long folder (real
  // rows, Mac walk 2026-11-25) is its ready box; words or an answer above it,
  // or the splash's footer alone, are not.
  const logo = ["                 ⣀⣤⣤⣤⣀⣀", "                    ⠈⠙⠛⠿⠿⠿⠿⠛⠉"];
  const macAfter = [
    " ".repeat(58) + "lse.", "  >_ OpenAI Codex (v0.172.0)", "     ~/Library/Application Support/…/compare-1177/app",
    ...Array(8).fill(B), ...logo, ...Array(5).fill(B), "› Ask Codex to do anything", B,
    "  GPT-6.2-Sol default · ~/Library/Application Support/", "  com.mbadv.ply.test/app-tester/sandboxes/compare-1177/", "  app", "  ← for agents · ? for shortcuts",
  ];
  assert.equal(codexBoxProof(macAfter).ready, true, "the start screen, wrapped footer");
  assert.equal(codexBoxProof([...macAfter.slice(0, 3), B, "  Tip: try /review", ...macAfter.slice(-6)]).ready, false, "words above the box: no proof");
  assert.equal(codexBoxProof([B, "• Explored", "  └ Read f2.txt", B, B, ...macAfter.slice(-6)]).ready, false, "an answer streaming above the box");
  assert.equal(codexBoxProof([B, "■ Conversation interrupted - tell the model what to do differently.", B, ...macAfter.slice(-6)]).ready, true, "an interrupted turn");
  assert.equal(codexBoxProof([...macAfter.slice(0, -4), "  ? for shortcuts"]).ready, false, "the splash's footer alone");
}

// Round 7 (second final Mac walk, step 18): a 35-column Claude tile. Real:
// idle, empty box, its footer without the hint (`  ⏵⏵ auto mode on`), the
// turn's done line above the box — ready (also in the 39-screen sweep).
{
  const narrow = screenRowsOf("claude-35-cols-idle.txt");
  assert.equal(claudeBoxProof(narrow).ready, true, "real 35-column idle");
  const N = "─".repeat(35);
  const factsOf = (rows: string[], plain: boolean): TileFacts => {
    const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, plain));
    return { id: "t", vendor: "claude", label: "t", live: true, ended: false, question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxMode: live.boxMode, quietMs: 60_000 };
  };
  // Real frames of the narrow walk (round 9) where they exist: text in the
  // narrow box → the draft sentence; after `/model` then Esc → ready; the
  // `/model` picker → asking.
  assert.equal(deliveryGate("claude", factsOf(screenRowsOf("claude-35-abc.txt"), true), answer("claude"), "put"), "Claude's box has text you typed. Send it or clear it first.");
  assert.equal(claudeBoxProof(screenRowsOf("claude-35-after-model-esc.txt")).ready, true, "a local command's result over the box");
  const picker = screenRowsOf("claude-35-model-picker.txt");
  assert.equal(claudeBoxProof(picker).drawn, false);
  assert.equal(deliveryGate("claude", factsOf(picker, true), answer("claude"), "put"), "Claude is asking you something. Answer it in its tile first.");
  // Still RECONSTRUCTED (no such frame captured): an answer streaming with
  // no spinner in view, a custom command that started a turn — never ready.
  assert.equal(claudeBoxProof([...narrow.slice(0, -4), "✶ Thinking…", "", N, "❯ ", N, "  ⏵⏵ auto mode on"]).ready, false, "a spinner");
  assert.equal(claudeBoxProof([...narrow.slice(0, -4), "⏺ Here is the first part of", "  the answer", "", N, "❯ ", N, "  ⏵⏵ auto mode on"]).ready, false, "an answer streaming");
  assert.equal(claudeBoxProof([...narrow.slice(0, -4), "❯ /ply:review", "⏺ Looking at the diff", "", N, "❯ ", N, "  ⏵⏵ auto mode on"]).ready, false, "a command that started a turn");
  // A running turn whose footer and spinner both left the screen would look
  // like the idle box at this width (unmeasured: every real narrow working
  // frame shows its cut `· esc to inter…`/`· es…` footer). The transcript's
  // open turn refuses it; the screen's box alone never writes then.
  const looksIdle = [...narrow.slice(0, -4), "⏺ Here is the first part of", "  the answer", "", N, "❯ ", N, "  ⏵⏵ auto mode on"];
  assert.equal(claudeBoxProof(looksIdle).boxMode, true);
  assert.notEqual(deliveryGate("claude", factsOf(looksIdle, false), { vendor: "claude", conversation: "known", turn: "open", cut: false }, "put"), null);
  // (with the transcript's turn closed the same screen IS the idle box: allowed)
  assert.equal(deliveryGate("claude", { ...factsOf(looksIdle, false), working: false }, { vendor: "claude", conversation: "known", turn: "done", cut: false }, "put"), null);
}

// Round 9: the two pairs of opposite outcomes, at 35 columns and at normal
// width, each through the whole guard (conversation known, turn as named).
{
  const gate = (rows: string[], plain: boolean, turn: CompareAnswer["turn"], action: "put" | "send" = "put") => {
    const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, plain));
    const f: TileFacts = {
      id: "t", vendor: "claude", label: "t", live: true, ended: false,
      question: live.decision, draft: live.draft, promptIdle: live.promptIdle,
      working: live.working !== true && live.turnOver === true ? false : live.working,
      quietMs: 60_000, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxMode: live.boxMode,
      inputQuietMs: Number.POSITIVE_INFINITY, echoPending: false,
    };
    return deliveryGate("claude", f, { vendor: "claude", conversation: "known", turn, cut: false }, action);
  };
  const ASKS = "Claude is asking you something. Answer it in its tile first.";
  const WORKS = "Claude is working. You can pass this when it's done.";
  const c = (name: string) => cases.find((x) => x.name.startsWith(name))!.rows;
  // 1. The plan on screen. Menu open → refused (35 cols: real cap 6; normal: real C3).
  assert.equal(gate(screenRowsOf("claude-35-plan-menu.txt"), true, "open"), ASKS);
  assert.equal(gate(c("C3 Claude plan menu"), true, "open"), ASKS);
  //    After Esc, the empty box under the plan → allowed (35 cols: real caps 6 and 7; normal: real C5).
  for (const n of ["claude-35-after-plan-esc.txt", "claude-35-after-plan-esc-auto.txt"]) {
    assert.equal(gate(screenRowsOf(n), false, "done"), null, n);
    assert.equal(gate(screenRowsOf(n), false, "done", "send"), null, n);
  }
  assert.equal(gate(c("C5 Claude empty box after Esc"), false, "done"), null);
  // 2. A command running. In the foreground, turn open → refused (35 cols: real cap 4, 1 s and 3 s;
  //    normal: real cap 11-b of the first capture walk).
  assert.equal(gate(screenRowsOf("claude-35-working-1s.txt"), false, "open"), WORKS);
  assert.equal(gate(screenRowsOf("claude-35-working-3s.txt"), false, "open"), WORKS);
  assert.equal(gate(screenRowsOf("claude-working-named.txt"), false, "open"), WORKS);
  //    Turn closed, the command still in the BACKGROUND (`1 shell`) → allowed (35 cols: real cap 4;
  //    normal: RECONSTRUCTED from the real cap 3 with the footer's and the done line's `1 shell`
  //    parts as the 35-column frame shows them — no wide capture yet).
  assert.equal(gate(screenRowsOf("claude-35-turn-closed-bg-shell.txt"), false, "done"), null);
  assert.equal(gate(screenRowsOf("claude-35-turn-closed-bg-shell.txt"), false, "done", "send"), null);
  const wide = screenRowsOf("claude-named-idle-after-turn.txt");
  const wideBg = [
    ...wide.slice(0, -5),
    "✻ Worked for 4s · done 12:23 PM · 1 shell still running",
    "",
    ...wide.slice(-4, -1),
    "  ⏵⏵ auto mode on (shift+tab to cycle) · 1 shell · ↓ to manage",
  ];
  assert.equal(gate(wideBg, false, "done"), null, "normal width, a background shell");
  // …and a turn that's still open while it says `1 shell` and is cut (`es…`) is running.
  assert.equal(gate([...wide.slice(0, -1), "  ⏵⏵ auto mode on · 1 shell · es…"], false, "open"), WORKS);
}

// Review round 6 (M1), RECONSTRUCTED (the reviewer's probe): the turn's prompt
// in view, an answer row, no spinner and no running words — the readiness
// probe says "not working" and the hint footer makes the box ready. With the
// transcript's turn open and no turn end over the box, Put is refused as Send is.
{
  const W = "─".repeat(60);
  const rows = ["❯ Do the thing", "", "⏺ Reading files", "", W, "❯ ", W, "  ⏵⏵ auto mode on (shift+tab to cycle)"];
  const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, false));
  assert.equal(live.working, false);
  assert.equal(live.readyBox, true);
  const f: TileFacts = {
    id: "t", vendor: "claude", label: "t", live: true, ended: false, question: live.decision, draft: live.draft, promptIdle: live.promptIdle,
    working: live.working, quietMs: 60_000, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxMode: live.boxMode,
    inputQuietMs: Number.POSITIVE_INFINITY, echoPending: false,
  };
  const open: CompareAnswer = { vendor: "claude", conversation: "known", turn: "open", cut: false };
  for (const action of ["put", "send"] as const) {
    assert.equal(deliveryGate("claude", f, open, action), "Claude is working. You can pass this when it's done.", action);
  }
  // The same screen with the transcript's turn closed: ready.
  assert.equal(deliveryGate("claude", f, { ...open, turn: "done" }, "put"), null);
}

// Round 11 (review round 7, L1): at 35 columns Claude wraps its turn-end row.
{
  const factsOf = (rows: string[]): TileFacts => {
    const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, false));
    return {
      id: "t", vendor: "claude", label: "t", live: true, ended: false, question: live.decision, draft: live.draft, promptIdle: live.promptIdle,
      working: live.working !== true && live.turnOver === true ? false : live.working,
      quietMs: 60_000, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxMode: live.boxMode,
      inputQuietMs: Number.POSITIVE_INFINITY, echoPending: false,
    };
  };
  const open: CompareAnswer = { vendor: "claude", conversation: "known", turn: "open", cut: false };
  // Real: the closed turn's done line wrapped (`… · 1` / `shell still running`), a background shell
  // alive. The screen proves the turn over, so even a transcript turn read open lets the pass go.
  const bg = screenRowsOf("claude-35-turn-closed-bg-shell.txt");
  assert.equal(claudeTurnOver(bg), true, "the wrapped done line");
  for (const action of ["put", "send"] as const) assert.equal(deliveryGate("claude", factsOf(bg), open, action), null, action);
  // Real: a narrow working frame with the turn open stays refused.
  for (const n of ["claude-35-working-1s.txt", "claude-35-working-3s.txt"]) {
    assert.equal(claudeTurnOver(screenRowsOf(n)), false, n);
    for (const action of ["put", "send"] as const) assert.equal(deliveryGate("claude", factsOf(screenRowsOf(n)), open, action), "Claude is working. You can pass this when it's done.", `${n} ${action}`);
  }
  // RECONSTRUCTED from the real frame: an answer whose wrapped prose reads "…for 4s · done" is no done line;
  const N = "─".repeat(35);
  const box = ["", N, "❯ ", N, "  ⏵⏵ auto mode on"];
  const asked = ["❯ Run it", ""];
  assert.equal(claudeTurnOver([...asked, "⏺ The build ran for 4s · done", "  and the tests passed.", ...box]), false, "an answer row");
  assert.equal(claudeTurnOver([...asked, "  It ran for 4s · done", "  quickly.", ...box]), false, "indented prose");
  // …a wrapped Esc row and a wrapped error row still end the turn; a wrapped retry row never does.
  assert.equal(claudeTurnOver([...asked, "  ⎿  Interrupted · What should", "     Claude do instead?", ...box]), true, "Interrupted, wrapped");
  assert.equal(claudeTurnOver([...asked, "● Login reached its time limit ·", "  Please run /login", ...box]), true, "a sign-in error, wrapped");
  assert.equal(claudeTurnOver([...asked, "  ⎿  API Error (Connection error.)", "     · Retrying in 4 seconds…", "     (attempt 2/10)", ...box]), false, "a retry, wrapped");
}

// Review H1: a tile's own resize redraw doesn't restart Compare's quiet clock.
{
  assert.equal(outputIsRedraw(1_000, 1_500, 0), true, "inside the refit window");
  assert.equal(outputIsRedraw(2_000, 1_500, 0), false, "after it, no size change");
  assert.equal(outputIsRedraw(4_000, 1_500, 1_000), true, "the reflow after a real size change");
  assert.equal(outputIsRedraw(1_000 + REDRAW_AFTER_RESIZE_MS, 1_500, 1_000), false, "past the settle window it is work");
}

// Walk round 4 (Windows, Claude Code 2.1.332): the permission menu with the
// session's name drawn as the screen's last row under it reads as a question
// (it read as text typed in the box), and the tile is no draft.
{
  const file = new URL("../../src-tauri/src/builder_screens_fixtures/claude-2.1.332-win-edit-permission-session-name.txt", import.meta.url);
  const rows = readFileSync(file, "utf8").split(/^# ----\n/m)[1].replace(/\n$/, "").split("\n");
  const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, true));
  assert.equal(live.decision, true, "the menu over the session-name row asks");
  const f: TileFacts = { id: "t", vendor: "claude", label: "t", live: true, ended: false, question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working, readyBox: live.readyBox, boxDrawn: live.boxDrawn };
  assert.equal(deliveryGate("claude", f, answer("claude"), "put"), "Claude is asking you something. Answer it in its tile first.");
  // Without the name row, as before.
  assert.equal(liveScreenFacts("claude", rows.slice(0, -1), null).decision, true);
  // A draft `❯ 1. …` typed in a named session's box is still no menu: the box
  // closes with its own rule before any menu footer.
  const named = "─".repeat(35) + " add-notes-list-title ─";
  const draft = ["✻ Brewed for 2s · done 9:20 AM", "", named, "❯ 1. first", "  2. second", "─".repeat(58), "  ⏵⏵ auto mode on (shift+tab to cycle)"];
  assert.equal(liveScreenFacts("claude", draft, null).decision, false, "a numbered draft in the box");
}

// Walk round 4: Compare's quiet clock moves only on output that changed the
// screen and was not the tile's own resize redraw (a focus change's re-sent
// modes when the composer opens never restart it).
{
  assert.equal(workStamp(100, 10_000, false, 0, 0), 100, "the same screen painted again");
  assert.equal(workStamp(100, 10_000, true, 0, 0), 10_000, "a real change");
  assert.equal(workStamp(100, 10_000, true, 10_500, 0), 100, "inside the refit window");
  assert.equal(workStamp(100, 10_000, true, 0, 9_000), 100, "the reflow after a size change");
}

// 1.179.0 Windows walk (step 7), RECONSTRUCTED from its screenshots (no grid
// was read): after the composer's preview shrank the tiles, ConPTY left
// Claude's box with blank rows where its footer was. A fresh tile whose
// conversation has no turn yet, and one after a turn, take a Put and a Send on
// the transcript's word; an open turn, no transcript, a spinner, typed text,
// or a rule on the screen's last row (the footer may be below the view) never
// do. Windows only: on the Mac the same shape is a frame read halfway through
// a redraw, never proof.
{
  const fresh = screenRowsOf("claude-fresh-idle.txt");
  const lost = (rows: string[]) => [...rows, "", "", ""];
  const freshLost = lost(fresh.slice(0, -2));
  const facts = (rows: string[], plain: boolean): TileFacts => {
    const live = liveScreenFacts("claude", rows, cellsOf("claude", rows, plain));
    return {
      id: "t", vendor: "claude", label: "t", live: true, ended: false,
      question: live.decision, draft: live.draft, promptIdle: live.promptIdle, working: live.working,
      quietMs: 60_000, turnOverOnScreen: live.turnOver, readyBox: live.readyBox, boxDrawn: live.boxDrawn, boxMode: live.boxMode,
      inputQuietMs: Number.POSITIVE_INFINITY, echoPending: false,
    };
  };
  const none: CompareAnswer = { vendor: "claude", conversation: "known", turn: "none", cut: false };
  const open: CompareAnswer = { vendor: "claude", conversation: "known", turn: "open", cut: false };
  const ASKS = "Claude is asking you something. Answer it in its tile first.";
  const DRAFT = "Claude's box has text you typed. Send it or clear it first.";

  // macOS (the default here): no box, as before.
  setPlatformForTests("mac");
  assert.equal(claudeBoxProof(freshLost).drawn, false, "mac: a half-drawn frame is no box");
  assert.notEqual(deliveryGate("claude", facts(freshLost, false), none, "put"), null, "mac: no Put");

  setPlatformForTests("windows");
  try {
    assert.deepEqual(
      claudeBoxProof(freshLost),
      { drawn: true, ready: false, turnOver: false, idleShape: false, askedShape: false, boxMode: true, running: false, asks: false },
      "the box with its footer gone",
    );
    assert.equal(deliveryGate("claude", facts(freshLost, false), none, "put"), null, "fresh, no turn yet: Put");
    assert.equal(deliveryGate("claude", facts(freshLost, false), none, "send"), null, "fresh, no turn yet: Send");
    const afterTurn = lost(screenRowsOf("claude-named-idle-after-turn.txt").slice(0, -1));
    assert.equal(deliveryGate("claude", facts(afterTurn, false), answer("claude"), "put"), null, "after a turn: Put");
    // No proof without the transcript's word: an open turn, or none read.
    assert.notEqual(deliveryGate("claude", facts(freshLost, false), open, "put"), null, "an open turn");
    assert.notEqual(deliveryGate("claude", facts(freshLost, false), null, "put"), null, "no transcript read");
    // The placeholder drawn plain is typed text; so is a paste waiting in the box.
    assert.equal(deliveryGate("claude", facts(freshLost, true), none, "put"), DRAFT);
    const pasted = lost([...fresh.slice(0, 6), "❯ [Pasted text #1 +20 lines]", fresh[7]]);
    assert.equal(deliveryGate("claude", facts(pasted, true), none, "put"), DRAFT, "a paste in the box");
    // A spinner above the box: a turn running.
    const spinning = lost([...fresh.slice(0, 3), "❯ Fix the build.", "", "✶ Thinking…", ...fresh.slice(5, -2)]);
    assert.equal(claudeBoxProof(spinning).boxMode, false, "a spinner");
    assert.notEqual(deliveryGate("claude", facts(spinning, false), none, "put"), null);
    // A permission or a plan question above the box: asking.
    const permission = lost([
      ...fresh.slice(0, 3), "", "● Bash(npm run build)", "", " Do you want to proceed?", "❯ 1. Yes", "  2. No", "",
      ...fresh.slice(5, -2),
    ]);
    assert.equal(deliveryGate("claude", facts(permission, false), none, "put"), ASKS, "a permission above the box");
    const plan = lost([
      ...fresh.slice(0, 3), "", " Would you like to proceed?", "", "❯ 1. Yes, and auto-accept edits",
      "  2. Yes, and manually approve edits", "  3. No, keep planning", "", ...fresh.slice(5, -2),
    ]);
    assert.equal(deliveryGate("claude", facts(plan, false), none, "put"), ASKS, "a plan question above the box");
    // The bottom rule on the screen's last row: no box, as before.
    assert.equal(claudeBoxProof(fresh.slice(0, -2)).drawn, false, "the footer may be below the view");
    // A numbered row between the rules is a menu, never the box.
    const R56 = "─".repeat(56);
    assert.equal(claudeBoxProof(lost([...fresh.slice(0, 5), R56, "❯ 1. Yes, proceed", R56])).drawn, false);
  } finally {
    setPlatformForTests(null);
  }
}

console.log("tileScreens: all verdicts as expected\n" + got.join("\n"));
