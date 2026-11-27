// Terminals block P4/P5: Resume…'s and History › Sessions' words and rows.
// Run with `node --experimental-strip-types src/lib/terminalConversations.test.ts`.
import assert from "node:assert/strict";
import type { TerminalHistorySession } from "../ipc.ts";
import {
  FILE_GONE,
  NO_CONVERSATION_YET,
  ROW_FOLDER_GONE,
  ago,
  conversationTitle,
  durationWords,
  goneMessage,
  resumableKinds,
  sessionHistoryRows,
} from "./terminalConversations.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 100 * DAY;

assert.equal(conversationTitle({ kind: "claude", title: "Dark mode" }), "Dark mode");
assert.equal(conversationTitle({ kind: "codex", title: "  " }), "Codex conversation");
assert.equal(ago(NOW - 10_000, NOW), "just now");
assert.equal(ago(NOW - 5 * MIN, NOW), "5m ago");
assert.equal(ago(NOW - 3 * DAY, NOW), "3d ago");
assert.match(goneMessage("claude"), /no longer on this computer/);
assert.deepEqual(resumableKinds({ claudePath: "/c", codexPath: null }), ["claude"]);
assert.deepEqual(resumableKinds(null), []);

assert.equal(durationWords(20_000), "under a minute");
assert.equal(durationWords(12 * MIN), "12 min");
assert.equal(durationWords(65 * MIN), "1 h 5 min");
assert.equal(durationWords(120 * MIN), "2 h");
assert.equal(durationWords(3 * DAY), "3 days");

function s(over: Partial<TerminalHistorySession> & { id: string }): TerminalHistorySession {
  return { workspaceId: "a", kind: "claude", cwd: "/p", startedAt: NOW - DAY, live: false, resumable: true, cliSessionId: "c", title: "Work", ...over };
}

const rows = sessionHistoryRows(
  [
    s({ id: "ended", endedAt: NOW - DAY + 12 * MIN, title: "Footer" }),
    s({ id: "live", startedAt: NOW - MIN, live: true, ptyId: "pty-1", title: undefined }),
    s({ id: "gone", kind: "codex", startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + MIN, resumable: false, gone: "conversation", title: "  " }),
    s({ id: "gone-titled", kind: "codex", startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + MIN, resumable: false, gone: "conversation" }),
    s({ id: "moved", startedAt: NOW - 2.5 * DAY, endedAt: NOW - 2.5 * DAY + MIN, resumable: false, gone: "folder" }),
    s({ id: "no-id", kind: "codex", startedAt: NOW - 3 * DAY, cliSessionId: undefined, resumable: false }),
    s({ id: "old", startedAt: NOW - 29 * DAY }),
    // Still running after four weeks: kept.
    s({ id: "long", startedAt: NOW - 30 * DAY, live: true, ptyId: "pty-2" }),
    // Nothing typed in it: left out (a tile opened and closed, the one before a /clear).
    s({ id: "empty", startedAt: NOW - 4 * MIN, endedAt: NOW - 3 * MIN, title: undefined }),
    // A kind History doesn't list (a newer Plyloft's).
    { ...s({ id: "other" }), kind: "shell" as unknown as "claude" },
    s({ id: "b1", workspaceId: "b", cwd: "/b", startedAt: NOW - 2 * MIN, endedAt: NOW - MIN }),
  ],
  { a: "Notes", b: "Site" },
  NOW,
);
assert.deepEqual(
  rows.map((r) => r.id),
  ["a:live", "a:long", "b:b1", "a:ended", "a:gone-titled", "a:moved", "a:no-id"],
  "most recently used first (running ones now), 28 days (a running one kept), Claude and Codex only, nothing untyped",
);
const by = (id: string) => rows.find((r) => r.id === id)!;
assert.equal(by("a:live").duration, "Running");
assert.deepEqual(by("a:live").action, { kind: "show" });
assert.equal(by("a:live").title, "Claude conversation", "a running one with no name yet says which AI");
assert.equal(by("a:ended").duration, "12 min");
assert.equal(by("a:ended").title, "Footer");
assert.deepEqual(by("a:ended").action, { kind: "resume" });
assert.deepEqual(by("a:gone-titled").action, { kind: "none", reason: FILE_GONE });
assert.deepEqual(by("a:moved").action, { kind: "none", reason: ROW_FOLDER_GONE });
assert.deepEqual(by("a:no-id").action, { kind: "none", reason: NO_CONVERSATION_YET });
assert.equal(by("a:no-id").duration, "Ended when Plyloft quit");
assert.equal(by("b:b1").workspaceName, "Site");
// 1.174.0 E9 (T9): one clock with Resume… — last used, not started.
assert.equal(by("a:live").lastUsedAt, NOW);
assert.equal(by("a:ended").lastUsedAt, NOW - DAY + 12 * MIN);
assert.equal(by("a:no-id").lastUsedAt, NOW - 3 * DAY, "no end, no conversation: when it started");
{
  // A session with no end takes its conversation's last write (round 1:
  // `lastWriteAt` from the same History call); one that ended keeps its end.
  // The 28-day window counts from the last use.
  const later = sessionHistoryRows(
    [
      s({ id: "quit", cliSessionId: "c-q", startedAt: NOW - 2 * DAY, openAtQuit: NOW - DAY, lastWriteAt: NOW - 5 * MIN }),
      s({ id: "end", startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, lastWriteAt: NOW - MIN }),
      s({ id: "quit2", cliSessionId: "c-x", startedAt: NOW - 3 * DAY, openAtQuit: NOW - 2 * DAY }),
      s({ id: "long-ago-used-now", startedAt: NOW - 40 * DAY, lastWriteAt: NOW - 3 * DAY }),
      s({ id: "long-ago-ended", startedAt: NOW - 40 * DAY, endedAt: NOW - 30 * DAY }),
    ],
    { a: "Notes" },
    NOW,
  );
  assert.deepEqual(later.map((r) => [r.id, r.lastUsedAt]), [
    ["a:end", NOW - 2 * MIN],
    ["a:quit", NOW - 5 * MIN],
    ["a:quit2", NOW - 2 * DAY],
    ["a:long-ago-used-now", NOW - 3 * DAY],
  ]);
}

// ── QoL 1.168 (block 4) ──────────────────────────────────────────────
{
  const m = await import("./terminalConversations.ts");
  // F3 (1.172.1): one calm line naming the session(s), and a short button.
  assert.equal(m.reopenLineText(["Redesign UX/UI Lyra PPC"]), "Redesign UX/UI Lyra PPC was open when Plyloft quit.");
  assert.equal(m.reopenLineText(["A", "B"]), "2 sessions were open when Plyloft quit: A and B.");
  assert.equal(m.reopenLineText(["A", "B", "C"]), "3 sessions were open when Plyloft quit: A, B and 1 more.");
  assert.equal(m.reopenLineText(["A", "B", "C", "D", "E"]), "5 sessions were open when Plyloft quit: A, B and 3 more.");
  assert.deepEqual(
    m.reopenLine(["A", "B", "C"]).filter((p) => p.name).map((p) => p.text),
    ["A", "B"],
    "the names shown are drawn as names",
  );
  assert.deepEqual(m.reopenLine([]), []);
  assert.equal(m.reopenButtonWords(1), "Reopen it");
  assert.equal(m.reopenButtonWords(3), "Reopen them");
  assert.equal(
    m.reopenList([{ kind: "claude", title: "Footer" }, { kind: "codex", title: null }]),
    "Claude: Footer\nCodex: Codex conversation",
  );
  assert.equal(m.reopenOutcome(2, []), null, "all reopened: nothing to say");
  assert.deepEqual(m.reopenOutcome(1, [{ title: "Footer", message: "Its folder is gone." }]), {
    title: "Reopened 1 of 2 sessions",
    body: "Footer: Its folder is gone.",
  });
  assert.deepEqual(m.reopenOutcome(0, [{ title: "A", message: "x" }, { title: "B", message: "y" }]), {
    title: "Those sessions couldn't be reopened",
    body: "A: x (and 1 more)",
  });
  // Resume…: two of one name say how each began, or when it was used.
  const rows = [
    { kind: "claude" as const, title: "Walk rename", opening: "Rename the tiles", updatedAt: 1 },
    { kind: "claude" as const, title: "Walk rename", opening: "Walk rename", updatedAt: 2 },
    { kind: "codex" as const, title: "Other", updatedAt: 3 },
  ];
  const twice = m.duplicateTitles(rows);
  assert.deepEqual([...twice], ["Walk rename"]);
  const when = (at: number) => `T${at}`;
  assert.equal(m.resumeDetail(rows[0], twice.has("Walk rename"), when), "Began “Rename the tiles” · last used T1");
  assert.equal(m.resumeDetail(rows[1], true, when), "Last used T2", "an opening that is the name adds nothing");
  assert.equal(m.resumeDetail(rows[2], false, when), null, "a name of its own needs no second line");
  assert.equal(m.noSessionsOpenWords(true), "No sessions open. Resume… picks up an earlier one.");
  assert.equal(m.noSessionsOpenWords(false), "No sessions open.");
  assert.doesNotMatch(m.goneMessage("claude"), /cleanupPeriodDays/, "no setting names");
}

console.log("terminalConversations: ok");
