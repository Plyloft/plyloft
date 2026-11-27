// GH #327: closing a live tile asks in words — no "kill", no ampersand, and
// every kind says what is lost and what is kept.
import assert from "node:assert/strict";

import { closeAllAsks, closeAllQuestion, closeAsks, closeQuestion, type CloseFacts, type CloseKind } from "./tileClose.ts";

const kinds: CloseKind[] = ["shell", "claude", "codex", "codex-chat", "agent-run"];
for (const kind of kinds) {
  const q = closeQuestion(kind, "session 1");
  assert.equal(q.title, "Stop session 1?");
  assert.equal(q.confirmLabel, "Stop and close");
  for (const text of [q.title, q.body, q.confirmLabel]) {
    assert.doesNotMatch(text, /kill|&/i, `${kind}: ${text}`);
  }
  assert.ok(q.body.length > 0);
}
assert.match(closeQuestion("claude", "claude 1").body, /Claude keeps the conversation history/);
assert.match(closeQuestion("shell", "shell 1").body, /output here is gone/);

// QoL 1.168 (D4): closing an idle tile does not ask; a working one does.
const NOW = 100_000;
const base = (over: Partial<CloseFacts>): CloseFacts => ({ kind: "claude", status: "running", startedAt: 0, ...over });
const idle = { lastOutputAt: NOW - 5_000, matcherIdle: true, leftReadyAt: 0 };
assert.equal(closeAsks(base({ readiness: idle }), NOW), false, "Claude Ready asks nothing");
assert.equal(closeAsks(base({ kind: "codex", readiness: idle }), NOW), false, "Codex Ready asks nothing");
assert.equal(closeAsks(base({ readiness: { ...idle, matcherIdle: false } }), NOW), true, "working asks");
// Walk lane 1: Claude's box at rest with its turn scrolled off (a fresh
// tile, a long answer) is Ready by quiet, as its header says.
assert.equal(closeAsks(base({ readiness: { ...idle, matcherIdle: null } }), NOW), false, "Ready by quiet closes");
assert.equal(closeAsks(base({ readiness: { ...idle, matcherIdle: null, lastOutputAt: NOW - 500 } }), NOW), true, "moving output asks");
// A dim placeholder or suggestion is not a draft; the member's typing is.
assert.equal(closeAsks(base({ readiness: idle, inputEmpty: false, inputDraft: false }), NOW), false, "a placeholder is no draft");
assert.equal(closeAsks(base({ readiness: idle, inputEmpty: false, inputDraft: true }), NOW), true, "a typed draft asks");
assert.equal(closeAsks(base({ readiness: { ...idle, lastOutputAt: NOW - 500 } }), NOW), true, "just moved asks");
assert.equal(closeAsks(base({}), NOW), true, "never scanned asks");
assert.equal(closeAsks(base({ readiness: idle, question: "trust" }), NOW), true, "waiting on the member asks");
assert.equal(closeAsks(base({ status: "pending" }), NOW), true, "starting asks");
assert.equal(closeAsks(base({ status: "done" }), NOW), false, "ended asks nothing");
assert.equal(closeAsks(base({ kind: "shell", shellAlone: true }), NOW), false, "a shell alone at its prompt");
assert.equal(closeAsks(base({ kind: "shell", shellAlone: false }), NOW), true, "a shell with a job, foreground or background");
assert.equal(closeAsks(base({ kind: "shell", shellAlone: null }), NOW), true, "a shell that cannot say");
assert.equal(closeAsks(base({ kind: "shell" }), NOW), true, "a shell not asked");
assert.equal(closeAsks(base({ readiness: idle, inputEmpty: false }), NOW), true, "an unsent draft asks (M1)");
assert.equal(closeAsks(base({ readiness: idle, inputEmpty: true }), NOW), false);
assert.equal(closeAsks(base({ readiness: { ...idle, waiting: true } }), NOW), true, "a permission prompt asks (M2)");
assert.equal(closeAsks(base({ kind: "codex", readiness: { ...idle, background: true } }), NOW), true, "background work asks (M3)");
assert.equal(closeAsks(base({ kind: "codex-chat", sessionBusy: false }), NOW), false);
assert.equal(closeAsks(base({ kind: "codex-chat", sessionBusy: true }), NOW), true);
assert.equal(closeAsks(base({ kind: "agent-run" }), NOW), true, "a running agent run asks");
// M4: Close all asks for more than one session, always; for one, only
// when it is working.
assert.equal(closeAllAsks(0, 2), true);
assert.equal(closeAllAsks(0, 1), false);
assert.equal(closeAllAsks(1, 1), true);
const all = closeAllQuestion(2, 5);
assert.equal(all.title, "Close all 5 sessions?");
assert.match(all.body, /2 of them are working/);
assert.match(closeAllQuestion(0, 3).body, /None of them is working/);
assert.match(closeAllQuestion(1, 3, true).body, /run is marked stopped/);
assert.equal(closeAllQuestion(1, 1).title, "Stop the session that is working?");

console.log("tileClose: all assertions passed");
