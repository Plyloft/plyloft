// 1.176.3 phase 2: how a Builder no terminal shows is counted, judged from
// its screen (src/lib/builderScreenState.ts). Run with Node 22+:
//   node --experimental-strip-types src/lib/builderScreenState.test.ts
//
// The shared frames: every file in src-tauri/src/builder_screens_fixtures/
// — real captures of the 2026-11-23 walks (Claude Code 2.1.330, Codex
// 0.171, on the Mac and on ConPTY) and synthetic ones ported from the older
// tests — is read here and by the Rust commentary's own test
// (`builder_screen_judge::every_captured_frame_reads_as_its_header_says`).
// Each says what `attention.ts` reads (`screen`), what the rule must count
// it as (`expect`), and the truth from the walk's timeline (`truth`, its
// first word: working, waiting or nothing).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  OFF_SCREEN_HUNG_MS,
  OFF_SCREEN_SETTLE_MS,
  OFF_SCREEN_WORKING_MS,
  offScreenJudgement,
  offScreenQuitState,
  readBuilderScreen,
} from "./builderScreenState.ts";

const NOW = 10_000_000_000;
let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

// ── The shared frames ─────────────────────────────────────────────────────
const dir = new URL("../../src-tauri/src/builder_screens_fixtures/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
assert.ok(files.length >= 20, `the shared frames are there (${files.length})`);
const platforms = new Set<string>();
const wrong: string[] = [];
for (const file of files) {
  const text = readFileSync(new URL(file, dir), "utf8").replace(/\r\n/g, "\n");
  const [head, body] = text.split("\n# ----\n");
  assert.equal(head.split("\n")[0], "# plyloft builder screen frame v1", file);
  const h: Record<string, string> = {};
  for (const line of head.split("\n").slice(1)) {
    const m = /^# ([^:]+): (.*)$/.exec(line);
    if (m) h[m[1].trim()] = m[2].trim();
  }
  const rows = body.replace(/\n$/, "").split("\n").map((r) => r.trimEnd());
  const ago = (key: string) => (h[key] === "never" ? null : NOW - Number(h[key]));
  const vendor = h.vendor;
  const read = readBuilderScreen(vendor, rows);
  const screenSaid = h.screen === "nothing drawn" ? null : h.screen;
  if (read !== screenSaid) wrong.push(`${file}: attention.ts reads ${read ?? "nothing drawn"}, the file says ${h.screen}`);
  const judged = offScreenJudgement(
    { vendor, exited: h.exited === "true", lastOutputAt: ago("last-output-ago-ms"), rows, contentChangedAt: ago("content-changed-ago-ms") },
    NOW,
  );
  const got = judged.state ?? "nothing";
  if (got !== h.expect) wrong.push(`${file}: counted ${got} (${judged.why}), the file expects ${h.expect}`);
  // Never less careful than the truth: what was at work or asked is never
  // counted as nothing, and a safe-side count says so.
  const truth = /^(working|waiting|nothing):/.exec(h.truth ?? "")?.[1];
  assert.ok(truth, `${file}: truth starts with working, waiting or nothing`);
  assert.ok(!(truth !== "nothing" && h.expect === "nothing"), `${file}: the truth is ${truth}, never counted as nothing`);
  if (truth !== h.expect) assert.match(h.truth, /safe side/, `${file}: expect differs from the truth only on the safe side`);
  if (h.platform) platforms.add(`${vendor}-${h.platform}`);
}
assert.deepEqual(wrong, [], `${wrong.length} of ${files.length} frames misread:\n${wrong.join("\n")}`);
passed += files.length;
// Each vendor on each platform has real frames.
for (const want of ["claude-macos", "codex-macos", "claude-windows", "codex-windows"]) {
  assert.ok(platforms.has(want), `real frames of ${want}`);
}

// ── The rules, one by one ─────────────────────────────────────────────────
const RULE = "─".repeat(60);
const claudeRunning = ["⏺ Reading f2.txt", "", "✳ Smooshing… (2s · ↓ 79 tokens)", "", RULE, "❯", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"];
const claudeIdle = ["⏺ f5.txt has 15 lines.", "", "✻ Churned for 9s · done 11:19 AM", "", RULE, "❯", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"];
const codexFooter = ["", "  GPT-6.2-Sol default · ~/work/s1", "  ← for agents · ? for shortcuts"];
const codexWorking = ["• Explored", "  └ Read f2.txt", "", "• Working (11s • esc to interrupt)", "", "", "› Ask Codex to do anything", ...codexFooter];
const codexIdle = ["• f5.txt has 15 lines.", "", "  Worked for 21s • 11:22", "", "", "› Ask Codex to do anything", ...codexFooter];
const codexTrust = [
  "  Trust this folder? Codex can read, edit, and run files here, subject to your",
  "  permission settings.",
  "",
  "› 1. Trust and continue",
  "  2. Back to Agent Command Center",
  "",
  "  enter continue · esc back",
];
const at = (rows: string[], vendor: string, changedAgo: number, printedAgo: number | null = 100) => ({
  vendor,
  exited: false,
  lastOutputAt: printedAgo == null ? null : NOW - printedAgo,
  rows,
  contentChangedAt: NOW - changedAgo,
});

check("a finished turn lets go once its screen and its output have both been still for 10 s (review MF1)", () => {
  // Its done line last above the composer, nothing printed for 10 s: nothing.
  assert.equal(offScreenQuitState(at(codexIdle, "codex", 30_000, 30_000), NOW), null);
  assert.equal(offScreenQuitState(at(codexIdle, "codex", OFF_SCREEN_SETTLE_MS, OFF_SCREEN_SETTLE_MS), NOW), null);
  assert.equal(offScreenQuitState(at(claudeIdle, "claude", 20_000, 20_000), NOW), null);
  // Fresh output (a prompt typed into it, a redraw): working, the safe side.
  assert.equal(offScreenQuitState(at(codexIdle, "codex", 30_000, 200), NOW), "working");
  assert.equal(offScreenQuitState(at(codexIdle, "codex", OFF_SCREEN_SETTLE_MS, OFF_SCREEN_SETTLE_MS - 1), NOW), "working");
  // No done line (a silent phase mid-turn, a first prompt, a tip under the
  // done line): 1.176.2's 2-minute rule.
  const noMarker = ["• I'll now rewrite the matcher in one patch.", "", "› Ask Codex to do anything", ...codexFooter];
  assert.equal(readBuilderScreen("codex", noMarker), "idle");
  assert.equal(offScreenQuitState(at(noMarker, "codex", 60_000, 60_000), NOW), "working");
  assert.equal(offScreenQuitState(at(noMarker, "codex", 3 * 60_000, OFF_SCREEN_WORKING_MS), NOW), null);
});
check("a turn in progress is working, on both vendors", () => {
  assert.equal(offScreenQuitState(at(claudeRunning, "claude", 0), NOW), "working");
  assert.equal(offScreenQuitState(at(codexWorking, "codex", 0), NOW), "working");
  // However long ago it printed, while the screen still moves.
  assert.equal(offScreenQuitState(at(codexWorking, "codex", 1_000, 10 * 60_000), NOW), "working");
});
check("the trust screen waits for the person", () => {
  assert.equal(readBuilderScreen("codex", codexTrust), "asking");
  assert.equal(offScreenQuitState(at(codexTrust, "codex", 10 * 60_000, 10 * 60_000), NOW), "waiting");
  const claudeTrust = ["  Is this a project you created or one you trust?", "", " ❯ 1. Yes, I trust this folder", "   2. No, exit", "", " Enter to confirm · Esc to exit"];
  assert.equal(readBuilderScreen("claude", claudeTrust), "asking");
  // A draft "1. …" in Claude's box is no question.
  assert.notEqual(readBuilderScreen("claude", ["⏺ ok", "", RULE, "❯ 1. fix it", "  2. then test", RULE]), "asking");
});
check("no rows (an older backend): 1.176.2's rule", () => {
  assert.equal(offScreenQuitState({ exited: false, lastOutputAt: NOW - 1_000 }, NOW), "working");
  assert.equal(offScreenQuitState({ exited: false, lastOutputAt: NOW - OFF_SCREEN_WORKING_MS + 1 }, NOW), "working");
  assert.equal(offScreenQuitState({ exited: false, lastOutputAt: NOW - OFF_SCREEN_WORKING_MS }, NOW), null);
  assert.equal(offScreenQuitState({ exited: false, lastOutputAt: null }, NOW), null);
  // Nothing drawn yet: the same.
  assert.equal(offScreenQuitState(at(["", ""], "codex", 60_000, 1_000), NOW), "working");
  assert.equal(offScreenQuitState(at([], "codex", 60_000, 3 * 60_000), NOW), null);
});
check("an unknown screen is working while its content changes, then 1.176.2's rule", () => {
  const unknown = ["Some menu of its own", "  with no prompt"];
  assert.equal(readBuilderScreen("codex", unknown), "unknown");
  assert.equal(offScreenQuitState(at(unknown, "codex", 2_000), NOW), "working");
  assert.equal(offScreenQuitState(at(unknown, "codex", OFF_SCREEN_SETTLE_MS - 1), NOW), "working");
  assert.equal(offScreenQuitState(at(unknown, "codex", OFF_SCREEN_SETTLE_MS), NOW), "working");
  assert.equal(offScreenQuitState(at(unknown, "codex", 3 * 60_000, OFF_SCREEN_WORKING_MS), NOW), null);
  // A first reading (no clock yet) counts as a change now.
  assert.equal(offScreenQuitState({ ...at(unknown, "codex", 0), contentChangedAt: null }, NOW), "working");
});
check("an idle-looking screen whose content moves is a turn streaming: working", () => {
  assert.equal(offScreenQuitState(at(codexIdle, "codex", 0), NOW), "working");
  assert.equal(offScreenQuitState(at(claudeIdle, "claude", 3_000), NOW), "working");
  assert.equal(offScreenQuitState(at(claudeIdle, "claude", 20_000, 20_000), NOW), null);
});
check("a hung running screen: 1.176.2's byte rule decides it", () => {
  const frozen = OFF_SCREEN_HUNG_MS;
  assert.equal(offScreenQuitState(at(codexWorking, "codex", frozen - 1, 10 * 60_000), NOW), "working");
  assert.equal(offScreenQuitState(at(codexWorking, "codex", frozen, 1_000), NOW), "working");
  assert.equal(offScreenQuitState(at(codexWorking, "codex", frozen, OFF_SCREEN_WORKING_MS), NOW), null);
  assert.equal(offScreenQuitState(at(claudeRunning, "claude", frozen, null), NOW), null);
});
check("an ended process is nothing, whatever its last screen", () => {
  assert.equal(offScreenQuitState({ ...at(codexTrust, "codex", 0, 0), exited: true }, NOW), null);
});
check("why names states and times, never the screen's text", () => {
  const all = [
    offScreenJudgement(at(codexWorking, "codex", 0), NOW),
    offScreenJudgement(at(codexIdle, "codex", 30_000, 30_000), NOW),
    offScreenJudgement(at(codexTrust, "codex", 0), NOW),
    offScreenJudgement({ exited: false, lastOutputAt: NOW - 5_000 }, NOW),
  ].map((j) => j.why);
  assert.deepEqual(all, [
    "turn running, screen changed 0s ago",
    "turn over, screen unchanged for 30s",
    "a question in view",
    "screen not read, printed 5s ago",
  ]);
});

console.log(`builderScreenState.test.ts — ${passed} passed`);
