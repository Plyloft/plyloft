// UX-8.2 / UX-8.4: what a tile header says on its right, and when a working
// PTY tile says "No output for 10m" instead of its playful verb.
import assert from "node:assert/strict";

import {
  IDLE_WARNING_MS,
  idleWarning,
  tileQuestionShort,
  tileStatusLine,
  type TileStatusInput,
} from "./tileStatusLine.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

// ── The threshold ────────────────────────────────────────────────────
assert.equal(IDLE_WARNING_MS, 10 * MIN);
assert.equal(idleWarning(T0, T0 + IDLE_WARNING_MS - 1), null);
assert.equal(idleWarning(T0, T0 + IDLE_WARNING_MS), "No output for 10m");
// Minutes roll up, then hours.
assert.equal(idleWarning(T0, T0 + 11 * MIN + 59_000), "No output for 11m");
assert.equal(idleWarning(T0, T0 + 59 * MIN), "No output for 59m");
assert.equal(idleWarning(T0, T0 + 60 * MIN), "No output for 1h");
assert.equal(idleWarning(T0, T0 + 65 * MIN), "No output for 1h 5m");

// A working shell: its matcher says busy since the start.
function working(over: Partial<TileStatusInput>): TileStatusInput {
  return {
    kind: "shell",
    status: "running",
    startedAt: T0,
    readiness: { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 },
    now: T0,
    ...over,
  };
}

// ── The rule ─────────────────────────────────────────────────────────
// Under the threshold: the session word Working and this turn's time, a
// live running dot (1.171.0 C2, CF8: the playful verbs are the agent runs').
assert.deepEqual(tileStatusLine(working({ kind: "claude", lastOutputAt: T0, now: T0 + 9 * MIN })), {
  text: "Working · 9m 0s",
  tone: "running",
  live: true,
});
assert.deepEqual(tileStatusLine(working({ kind: "codex", lastOutputAt: T0, now: T0 + 45_000 })), {
  text: "Working · 45s",
  tone: "running",
  live: true,
});
// Owner, 2026-10-19: a shell says shell words — "Running", with the same
// live dot, no verb and no timer, at any age.
for (const age of [0, 5_000, 45_000, 3 * MIN, 9 * MIN]) {
  assert.deepEqual(tileStatusLine(working({ lastOutputAt: T0 + age, now: T0 + age + 500 })), {
    text: "Running",
    tone: "running",
    live: true,
  });
}
// No shell state, however long, reads an agent's word or a timer.
const playful = /Working|Cooking|Sautéed|Churning|Crunching|Vibing/;
const shellWords = /^(Ready|Running|No output for \d+[mh].*)$/;
for (const now of [T0, T0 + 30_000, T0 + 3 * MIN, T0 + 9 * MIN, T0 + 30 * MIN]) {
  for (const matcherIdle of [true, false, null]) {
    const line = tileStatusLine(
      working({ readiness: { lastOutputAt: T0, matcherIdle, leftReadyAt: T0 }, lastOutputAt: T0, now }),
    );
    assert.doesNotMatch(line.text, playful, `${matcherIdle} at ${now - T0}`);
    assert.match(line.text, shellWords, `${matcherIdle} at ${now - T0}`);
  }
}
// The prompt back (the PTY says idle, or output quiet where it cannot say):
// Ready after the 2 s window, never a counter.
assert.equal(
  tileStatusLine(working({ readiness: { lastOutputAt: T0 + 5000, matcherIdle: true, leftReadyAt: T0 }, now: T0 + 7000 })).text,
  "Ready",
);
assert.equal(
  tileStatusLine(working({ readiness: { lastOutputAt: T0 + 5000, matcherIdle: null, leftReadyAt: T0 }, now: T0 + 7000 })).text,
  "Ready",
);
// Inside the window the shell still reads Running, not "Working for 5s".
assert.equal(
  tileStatusLine(working({ readiness: { lastOutputAt: T0 + 5000, matcherIdle: null, leftReadyAt: T0 }, now: T0 + 6000 })).text,
  "Running",
);
// At it: amber words, no pulse.
assert.deepEqual(tileStatusLine(working({ lastOutputAt: T0, now: T0 + 10 * MIN })), {
  text: "No output for 10m",
  tone: "quiet",
  live: false,
});
// Output resumes: back to running.
assert.equal(
  tileStatusLine(working({ lastOutputAt: T0 + 12 * MIN, now: T0 + 12 * MIN + 1000 })).tone,
  "running",
);
// No output ever: counted from the start.
assert.equal(tileStatusLine(working({ now: T0 + 10 * MIN })).text, "No output for 10m");
// Silence while it sat at Ready is not the work's: counted from leaving Ready.
assert.equal(
  tileStatusLine(
    working({
      lastOutputAt: T0,
      readiness: { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 + 30 * MIN },
      now: T0 + 35 * MIN,
    }),
  ).tone,
  "running",
);
// At its prompt: Ready, however long it has been quiet.
assert.deepEqual(
  tileStatusLine(
    working({
      readiness: { lastOutputAt: T0, matcherIdle: true, leftReadyAt: T0 },
      lastOutputAt: T0,
      now: T0 + 60 * MIN,
    }),
  ),
  { text: "Ready", tone: "ready", live: false },
);
// Claude and the Codex TUI follow the same rule; a chat session and an agent
// run do not (their bodies say what they are doing).
assert.equal(tileStatusLine(working({ kind: "claude", now: T0 + 10 * MIN })).tone, "quiet");
assert.equal(tileStatusLine(working({ kind: "codex", now: T0 + 10 * MIN })).tone, "quiet");
assert.equal(
  tileStatusLine({ kind: "codex-chat", status: "running", startedAt: T0, sessionBusy: true, sessionTurnStartedAt: T0, now: T0 + 10 * MIN }).tone,
  "running",
);
assert.equal(
  tileStatusLine({ kind: "agent-run", status: "running", startedAt: T0, now: T0 + 30 * MIN }).tone,
  "running",
);

// ── The other states' words and tones ───────────────────────────────
assert.deepEqual(tileStatusLine({ kind: "shell", status: "done", exitCode: 0, startedAt: T0, now: T0 }), {
  text: "Ended",
  tone: "exited",
  title: "The session ended normally.",
  live: false,
});
assert.deepEqual(tileStatusLine({ kind: "claude", status: "crashed", exitCode: 137, startedAt: T0, now: T0 }), {
  // QoL 1.168 (block 10, A6 and the Mac walk): a session ending abnormally
  // (a kill -9 reads as a code) is a crash, in red and in these words.
  text: "Stopped unexpectedly",
  tone: "crashed",
  title: "The session ended with an error (code 137).",
  live: false,
});
// QoL 1.168 (block 4): Ctrl-C is a calm end; no code at all is the crash.
assert.equal(tileStatusLine({ kind: "shell", status: "crashed", exitCode: 130, startedAt: T0, now: T0 }).tone, "exited");
assert.equal(tileStatusLine({ kind: "codex", status: "crashed", exitCode: null, startedAt: T0, now: T0 }).text, "Stopped unexpectedly");
// Challenger round 1: Windows' Ctrl-C (STATUS_CONTROL_C_EXIT) is Ctrl-C there, only there.
for (const code of [-1073741510, 3221225786]) {
  const win = tileStatusLine({ kind: "shell", status: "crashed", exitCode: code, startedAt: T0, now: T0, windows: true });
  assert.equal(win.text, "Ended with Ctrl-C");
  assert.equal(win.tone, "exited");
  assert.equal(tileStatusLine({ kind: "shell", status: "crashed", exitCode: code, startedAt: T0, now: T0 }).text, `Ended · error code ${code}`);
}
// QoL 1.168 (block 10, A6): red only for a real crash — no code, or Claude
// or Codex ending abnormally; a shell's ordinary error stays amber.
assert.equal(tileStatusLine({ kind: "shell", status: "crashed", exitCode: 2, startedAt: T0, now: T0 }).tone, "failed");
assert.equal(tileStatusLine({ kind: "shell", status: "crashed", exitCode: null, startedAt: T0, now: T0 }).tone, "crashed");
assert.equal(tileStatusLine({ kind: "codex", status: "crashed", exitCode: null, startedAt: T0, now: T0 }).tone, "crashed");
assert.equal(
  tileStatusLine({ kind: "shell", status: "crashed", exitCode: 2, startedAt: T0, now: T0 }).title,
  "The process ended with an error (code 2): the last command reported one.",
);
// Claude/Codex never Ready since it started: Starting…, for a while only.
assert.equal(tileStatusLine({ kind: "claude", status: "running", startedAt: T0, now: T0 + 3000 }).text, "Starting…");
assert.equal(tileStatusLine({ kind: "codex", status: "running", startedAt: T0, now: T0 + 25_000 }).text, "Working · 25s");
assert.equal(tileStatusLine({ kind: "shell", status: "running", startedAt: T0, now: T0 + 3000 }).text, "Running");
assert.equal(tileStatusLine({ kind: "codex-chat", status: "running", startedAt: T0, now: T0 }).text, "Your turn");
assert.equal(tileStatusLine({ kind: "agent-run", status: "done", startedAt: T0, now: T0 + 5000 }).tone, "done");
assert.equal(tileStatusLine({ kind: "agent-run", status: "error", startedAt: T0, now: T0 + 5000 }).tone, "failed");
assert.equal(tileStatusLine({ kind: "agent-run", status: "killed", startedAt: T0, now: T0 + 5000 }).tone, "ended");
// A finished run says how long it took, however long ago it ended (the
// live walk of PR #382 saw "Done · 7s" grow to "Done · 4m 3s").
for (const later of [0, 2 * MIN, 4 * MIN]) {
  assert.equal(
    tileStatusLine({ kind: "agent-run", status: "done", startedAt: T0, endedAt: T0 + 7000, now: T0 + 7000 + later }).text,
    "Done · 7s",
  );
}
assert.equal(
  tileStatusLine({ kind: "agent-run", status: "killed", startedAt: T0, endedAt: T0 + 65_000, now: T0 + 10 * MIN }).text,
  "Killed after 1m 5s",
);
// Still running: the clock runs on, whatever endedAt says.
assert.match(
  tileStatusLine({ kind: "agent-run", status: "running", startedAt: T0, endedAt: T0 + 1000, now: T0 + 30_000 }).text,
  /30s/,
);

// ── 1.174.0 E4 (P21): a narrow tile's short forms ────────────────────
// The header shows them at ≤ 480 px; `text` keeps the full words for the
// tooltip and the screen-reader label.
assert.equal(tileQuestionShort("trust"), "Asks: trust");
assert.equal(tileQuestionShort("decision"), "Asks you");
assert.equal(tileQuestionShort("bypass"), "Asks you");
assert.equal(tileQuestionShort("usageLimit", "3 pm"), "Paused till 3 pm");
assert.equal(tileQuestionShort("usageLimit", null), "Paused");
// Challenger 1: the time zone in brackets stays in the full words only.
assert.equal(tileQuestionShort("usageLimit", "3:30pm (Europe/Rome)"), "Paused till 3:30pm");
assert.equal(tileQuestionShort("usageLimit", "Oct 21, 1pm (Europe/Rome)"), "Paused till Oct 21, 1pm");
assert.equal(
  tileStatusLine({ kind: "claude", status: "running", startedAt: T0, question: "usageLimit", questionResetsAt: "3:30pm (Europe/Rome)", now: T0 + MIN }).text,
  "Paused · your plan's limit resets at 3:30pm (Europe/Rome)",
);
{
  const asking = (kind: string, question: TileStatusInput["question"], questionResetsAt?: string) =>
    tileStatusLine({ kind, status: "running", startedAt: T0, question, questionResetsAt, now: T0 + MIN });
  const trust = asking("codex", "trust");
  assert.equal(trust.text, "Codex asks to trust the folder");
  assert.equal(trust.short, "Asks: trust");
  assert.equal(trust.tone, "asks");
  assert.equal(asking("claude", "decision").text, "Asks you something");
  assert.equal(asking("claude", "decision").short, "Asks you");
  assert.equal(asking("claude", "bypass").text, "Claude asks before working without asking");
  assert.equal(asking("claude", "bypass").short, "Asks you");
  const paused = asking("claude", "usageLimit", "3 pm");
  assert.equal(paused.text, "Paused · your plan's limit resets at 3 pm");
  assert.equal(paused.short, "Paused till 3 pm");
  // Nothing else has a short form: a narrow tile keeps its words.
  assert.equal(tileStatusLine({ kind: "codex", status: "running", startedAt: T0, now: T0 + 25_000 }).short, undefined);
}

console.log("tileStatusLine: all assertions passed");
