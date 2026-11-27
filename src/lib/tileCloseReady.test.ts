// QoL 1.168 (walk lane 1, step 4): Claude at Ready with an empty prompt —
// a fresh tile under its placeholder, and after a long turn — closes
// without asking; mid-turn it asks. The screens are the walk's (Claude Code
// 2.1.307), through the same probe the tile's header reads.
//     node --experimental-strip-types src/lib/tileCloseReady.test.ts
import assert from "node:assert/strict";
import { BACKGROUND_WORK, readinessProbe } from "./tileHeaderStatus.ts";
import { closeAsks } from "./tileClose.ts";

const RULE = "─".repeat(60);
const FOOTER = [
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  "                                                    ◐ medium · /effort",
];
const NOW = 1_000_000;

function closeAsksOn(screen: string[], draft = false): boolean {
  const p = readinessProbe("claude", screen.map((r) => r.trimEnd()));
  return closeAsks(
    {
      kind: "claude",
      status: "running",
      startedAt: 0,
      inputEmpty: !draft,
      inputDraft: draft,
      readiness: { lastOutputAt: NOW - 3_000, matcherIdle: p.idle, leftReadyAt: 0, waiting: p.waiting, background: p.background, running: p.running },
    },
    NOW,
  );
}

const fresh = [
  "╭─── Claude Code v2.1.307 ───────────────────────────╮",
  "│                Welcome back!                       │",
  "╰────────────────────────────────────────────────────╯",
  "",
  RULE,
  '❯ Try "refactor <filepath>"',
  RULE,
  ...FOOTER,
];
assert.equal(closeAsksOn(fresh), false, "a fresh tile under its placeholder");

// After "count slowly from 1 to 40": the prompt that started it is off the page.
const afterTurn = [
  ...Array.from({ length: 30 }, (_, i) => `  ${i + 11}`),
  "",
  "✻ Cogitated for 4s · done 3:19 AM",
  "",
  RULE,
  "❯ ",
  RULE,
  ...FOOTER,
];
assert.equal(closeAsksOn(afterTurn), false, "a bare prompt after a long turn");
assert.equal(closeAsksOn(afterTurn, true), true, "a draft asks");

const midTurn = [
  "❯ count slowly from 1 to 40",
  "",
  "  1",
  "",
  "✳ Photosynthesizing… (3s · ↓ 20 tokens)",
  "",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
];
assert.equal(closeAsksOn(midTurn), true, "mid-turn asks");

// The footers the walk saw are no background work.
for (const f of [...FOOTER, "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt", "  ? for shortcuts"]) {
  assert.equal(BACKGROUND_WORK.test(f), false, f);
}
assert.equal(BACKGROUND_WORK.test("  ⏵⏵ auto mode on · 1 background task · ↓ to manage"), true);
console.log("tileCloseReady: all assertions passed");
