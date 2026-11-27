// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/worktreeSetup.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { WorktreeSetupRecord } from "../ipc.ts";
import {
  copyProblems,
  copySummary,
  envProposalQuestion,
  isWorktreeSetupFailure,
  PORT_COUNT,
  portHint,
  portRangeWords,
  SETUP_APPROVAL_LEAD,
  SETUP_FAILED_LEAD,
  SETUP_RUNNING_LEAD,
  setupRefusalNotice,
  setupFailureWords,
  setupStartedToast,
  worktreeCopyProblem,
} from "./worktreeSetup.ts";

function record(overrides: Partial<WorktreeSetupRecord> = {}): WorktreeSetupRecord {
  return { state: "failed", at: 1, ...overrides };
}

// The backend's refusal is recognised, whatever wraps it.
{
  const refusal =
    "The card's setup failed, so the Builder was not started. Retry the setup, or start anyway, from the card. The setup command failed (exit code 1).";
  assert.ok(isWorktreeSetupFailure("The card is still being set up; the Builder starts when the setup is done."));
  assert.ok(isWorktreeSetupFailure(refusal));
  assert.ok(isWorktreeSetupFailure(new Error(refusal)));
  assert.ok(!isWorktreeSetupFailure("Can't verify the claim while offline."));
  assert.ok(!isWorktreeSetupFailure(null));
}

// The leads are the backend's own words (worktree_setup.rs), read from the
// source so they can't drift; a command quoted in the reason never decides.
{
  const rust = readFileSync(new URL("../../src-tauri/src/worktree_setup.rs", import.meta.url), "utf8");
  for (const lead of [SETUP_FAILED_LEAD, SETUP_APPROVAL_LEAD, SETUP_RUNNING_LEAD]) {
    assert.ok(rust.includes(`"${lead}`), `worktree_setup.rs starts a refusal with ${lead}`);
  }
  const approval = `${SETUP_APPROVAL_LEAD}, so the Builder was not started. The repository's setup command hasn't run on this Mac before: echo "${SETUP_FAILED_LEAD}". Allow it here?`;
  assert.equal(setupRefusalNotice(approval)?.title, "The setup command needs your OK");
  const failed = `${SETUP_FAILED_LEAD}, so the Builder was not started. The setup command failed (exit code 1). echo "${SETUP_APPROVAL_LEAD}"`;
  assert.equal(setupRefusalNotice(failed)?.title, "Setup failed");
  assert.equal(setupRefusalNotice("Allow it here?"), null);
}

// The question lists the files and never promises more than names.
{
  const q = envProposalQuestion([".env", "apps/web/.env"], true);
  assert.equal(q.title, "Copy these files into cards' copies?");
  assert.ok(q.body.startsWith(".env and apps/web/.env are ignored by git"));
  assert.ok(q.body.includes("published"));
  assert.equal(q.confirmLabel, "Copy them");
  assert.equal(q.cancelLabel, "Don't copy");
  const one = envProposalQuestion([".env"], false);
  assert.ok(one.body.startsWith(".env is ignored by git"));
  // F10: one file is "it", not "them".
  assert.equal(one.title, "Copy this file into cards' copies?");
  assert.ok(one.body.includes("starts without it.") && one.body.includes("copy it in"), one.body);
  assert.ok(!/\bthem\b/.test(one.body), one.body);
  assert.equal(one.confirmLabel, "Copy it");
  assert.ok(q.body.includes("starts without them."), q.body);
  assert.ok(one.body.includes("saved") && !one.body.includes("published"));
  // v1.154.1 (F10 rest): "its name … what it holds", not "their names … they hold".
  assert.ok(one.body.endsWith("Only its name is saved in this repository's settings, never what it holds."), one.body);
  assert.ok(!/\b(their|they)\b/.test(one.body), one.body);
  assert.ok(q.body.endsWith("Only their names are published with this repository's settings, never what they hold."), q.body);
}

// A failure says what happened and what the two ways out do.
{
  const failed = setupFailureWords(record({ reason: "The setup command failed (exit code 3)." }));
  assert.equal(failed.title, "Setup failed");
  assert.ok(!/worktree/i.test(failed.title + failed.text), "no worktree on the card's surface");
  assert.ok(failed.text.startsWith("The setup command failed (exit code 3)."));
  assert.ok(failed.text.includes("Retry") && failed.text.includes("Start anyway"));
  const skipped = setupFailureWords(record({ state: "skipped", reason: "The setup command was stopped after 15 minutes." }));
  assert.ok(skipped.title.includes("started anyway"));
  assert.ok(setupFailureWords(record()).text.startsWith("The setup command failed."));
  const approval = setupFailureWords(record({ approvalNeeded: true, reason: "The repository's setup command changed: npm ci. Allow it on this Mac?" }));
  assert.equal(approval.title, "The setup command needs your OK");
  assert.ok(approval.text.includes("Allow and run"));
  const running = setupFailureWords(record({ state: "running", command: "npm ci" }));
  assert.equal(running.title, "Setting up the card");
  assert.ok(running.text.startsWith("npm ci is running."));
}

// The copy's summary and leftovers.
{
  assert.equal(copySummary(record({ state: "done" })), null);
  assert.equal(copySummary(record({ copied: [".env"] })), "1 file copied in.");
  assert.equal(
    copySummary(record({ copied: [".env", "b"], unmatched: ["x"], skipped: [{ path: "y", reason: "z" }] })),
    "2 files copied in, 2 left out.",
  );
  assert.deepEqual(copyProblems(record({ skipped: [{ path: "README.md", reason: "not git-ignored" }], unmatched: ["a/.env"] })), [
    "README.md — not git-ignored",
    "a/.env — nothing in the main checkout matches it",
  ]);
}

// Only a command is worth a toast.
{
  assert.equal(setupStartedToast({ workspaceId: "w", cardId: "c", command: null }), null);
  assert.deepEqual(setupStartedToast({ workspaceId: "w", cardId: "c", command: "npm ci" }), {
    title: "Setting up the card",
    body: "npm ci runs before the Builder starts.",
  });
  // 1.168.1 (Mac walk): a built card's setup (Try it) runs before the app.
  const built = { builder: { vendor: "claude", bypass: false, startedAt: 1 } } as never;
  assert.deepEqual(setupStartedToast({ workspaceId: "w", cardId: "c", command: "npm ci" }, built), {
    title: "Setting up the card's copy",
    body: "npm ci runs in the card's copy before your app starts.",
  });
  const bothBuilt = { builder: null, buildBoth: { lanes: [{ lane: "a", startedAt: 3 }] } } as never;
  assert.match(setupStartedToast({ workspaceId: "w", cardId: "c", command: "npm ci" }, bothBuilt)!.body, /before your app starts/);
  const notYet = { builder: null, buildBoth: { lanes: [{ lane: "a", startedAt: null }] } } as never;
  assert.match(setupStartedToast({ workspaceId: "w", cardId: "c", command: "npm ci" }, notYet)!.body, /before the Builder starts/);
}

// The entry rules match the backend's.
{
  for (const ok of [".env", "apps/*/.env.local", "**/.env", "secrets/"]) {
    assert.equal(worktreeCopyProblem(ok), null, ok);
  }
  for (const bad of ["", "/etc/passwd", "C:/x", "a\\b", "../x", "a/../b", "./a", "a//b", ".git", ".git/config"]) {
    assert.ok(worktreeCopyProblem(bad), `${bad} accepted`);
  }
}

// Worktree ports: the range and the hint, the same on both shells but
// PowerShell's spelling.
{
  assert.equal(PORT_COUNT, 10);
  assert.equal(portRangeWords(41020), "41020–41029 (PLYLOFT_PORT_BASE)");
  assert.equal(portHint(false), "Everything run in this card's copy gets them, e.g. PORT=$PLYLOFT_PORT_BASE npm run dev.");
  assert.ok(portHint(true).endsWith(" In PowerShell: $env:PLYLOFT_PORT_BASE."));
  // The backend's count and range.
  const rust = readFileSync("src-tauri/src/worktree_ports.rs", "utf8");
  assert.match(rust, /pub const PORT_COUNT: u16 = 10;/);
  assert.match(rust, /pub const RANGE_START: u16 = 41000;/);
}

console.log("worktreeSetup: ok");
