// SL-2: Fix with the Builder and Push update — when they're offered, and one
// press's delivery (live session, closed session resumed first, and every
// way it stops). Run with
//   node --experimental-strip-types src/lib/prFix.test.ts
import assert from "node:assert/strict";
import type { KanbanCard, PrFixMessage, PrStatus } from "../ipc.ts";
import {
  fixWhat,
  fixWithBuilder,
  prAutoMergeOffered,
  prAutoMergeOffOffered,
  briefFixOffered,
  DONT_MERGE_BY_ITSELF_LABEL,
  prFixKey,
  prFixKinds,
  prFixRoundLine,
  prMergeBlocked,
  prMergeReady,
  prShippingMergeOffered,
  prFixOffered,
  prFixSentLine,
  prNowAction,
  pushUpdateLine,
  pushUpdateSnapshot,
  prHeadMovedMergeOffered,
  type FixDeps,
} from "./prFix.ts";
import { FIX_ACTION, inboxRowWords } from "./inboxView.ts";
import { deriveCardState, EMPTY_CARD_STATE_CONTEXT } from "./cardLifecycle.ts";
import { githubChecksFact, openPrBoard, prFactsKey, prMergeOffered, prNowFact, shippedSessionKind } from "./prStatus.ts";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 8,
  state: "open",
  checks: "failing",
  checksTotal: 1,
  checksPassed: 0,
  checksPending: 0,
  failingChecks: [{ name: "test", workflow: "test", url: "https://github.com/o/r/actions/runs/1/job/2" }],
  mergeable: "mergeable",
  reviewDecision: "none",
  headSha: "aaa",
  checkedAt: 1,
  ...patch,
});

const builder = (shas: string[]) =>
  ({
    vendor: "claude",
    bypass: false,
    startedAt: 0,
    snapshots: shas.map((sha, i) => ({ n: i + 1, sha, at: 0 })),
    ptyId: "pty1",
  }) as unknown as KanbanCard["builder"];

const card = (patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "c1",
    workspaceId: "ws",
    title: "Add sum",
    columnId: "in_progress",
    reviewStatus: "merged",
    prUrl: "https://github.com/o/r/pull/8",
    pr: pr(),
    worktreePath: "/tmp/wt",
    branchName: "card/c1",
    builder: builder(["aaa"]),
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as KanbanCard;

// ── What is offered ─────────────────────────────────────────────────────

assert.deepEqual(prFixKinds(pr()), ["checks"]);
assert.deepEqual(
  prFixKinds(pr({ mergeable: "conflicting", reviewDecision: "changes_requested" })),
  ["conflict", "checks", "review"],
);
assert.deepEqual(prFixKinds(pr({ state: "merged" })), []);

assert.equal(prFixOffered(card()), true);
assert.equal(prFixOffered(card({ pr: pr({ checks: "passing" }) })), false, "nothing to fix");
assert.equal(prFixOffered(card({ pr: pr({ checks: "pending", reviewDecision: "changes_requested" }) })), true);
assert.equal(prFixOffered(card({ builder: null })), false, "no Builder");
assert.equal(prFixOffered(card({ worktreePath: null })), false, "no worktree");
assert.equal(prFixOffered(card({ archived: true })), false);
assert.equal(prFixOffered(card({ pr: pr({ state: "closed" }) })), false);
assert.equal(prFixOffered(card({ pr: null })), false, "a card shipped before SL-1");

// Push update: the last snapshot isn't the PR's head yet.
assert.equal(pushUpdateSnapshot(card()), null, "GitHub has it");
assert.deepEqual(pushUpdateSnapshot(card({ builder: builder(["aaa", "bbb"]) })), { n: 2, sha: "bbb" });
assert.equal(pushUpdateLine(card({ builder: builder(["aaa", "bbb"]) })), "Your latest fixes are only on this Mac. Send them to pull request #8 so GitHub checks them again.");
assert.equal(pushUpdateSnapshot(card({ builder: builder(["aaa", "bbb"]), pr: pr({ state: "merged" }) })), null);
assert.equal(pushUpdateSnapshot(card({ builder: builder([]) })), null);

assert.equal(fixWhat(["checks"]), "the failed checks");
assert.equal(fixWhat(["conflict", "checks", "review"]), "the conflict, the failed checks and the requested changes");

// ── The Inbox row ───────────────────────────────────────────────────────

const ev = (kind: string) =>
  ({ id: "e", kind, group: "needs_you", workspaceId: "ws", workspaceName: "W", title: "Add sum", detail: "test", at: 1 }) as never;
for (const kind of ["pr_checks_failed", "pr_changes_requested", "pr_conflict"]) {
  const words = inboxRowWords(ev(kind), { fix: true });
  assert.equal(words.action, FIX_ACTION, kind);
  assert.equal(words.fix, true);
  assert.notEqual(inboxRowWords(ev(kind), {}).action, FIX_ACTION, `${kind}: not without a Builder`);
}
assert.equal(inboxRowWords(ev("pr_closed"), { fix: true }).action, "Open the card");

// ── One press ───────────────────────────────────────────────────────────

const message: PrFixMessage = { prNumber: 8, kinds: ["checks"], message: "[Plyloft] fix it", notes: [] };

function deps(patch: Partial<FixDeps> = {}) {
  const log: string[] = [];
  const notes: { kind: string; title: string; body: string; details?: string }[] = [];
  const d: FixDeps = {
    gather: async () => message,
    sessionOpen: () => true,
    sessionRecorded: () => true,
    resume: async () => {
      log.push("resume");
    },
    reveal: () => log.push("reveal"),
    waitForSession: async () => {
      log.push("wait");
      return true;
    },
    deliver: (text) => {
      log.push(`deliver ${text}`);
      return Promise.resolve();
    },
    queued: () => log.push("queued"),
    notify: (kind, title, body, details) => notes.push({ kind, title, body, details }),
    ...patch,
  };
  return { d, log, notes };
}

{
  // A live session at its prompt: pasted now.
  const { d, log, notes } = deps();
  assert.equal(await fixWithBuilder(d), "sent");
  assert.deepEqual(log, ["reveal", "deliver [Plyloft] fix it"]);
  assert.equal(notes[0].title, "Sent to the Builder");
  assert.equal(
    notes[0].body,
    "What pull request #8 needs (the failed checks) is in its session. When it's done, Plyloft checks the fix by itself; then Send the fixes to GitHub.",
  );
}
{
  // Busy: held until its prompt, said; then written; what was cut under Details.
  const { d, log, notes } = deps({
    gather: async () => ({ ...message, notes: ["test: the last 60 lines of its log were sent, 440 left out."] }),
    deliver: (_text, onQueued) => {
      onQueued();
      return Promise.resolve();
    },
  });
  assert.equal(await fixWithBuilder(d), "sent");
  assert.ok(log.includes("queued"));
  assert.equal(notes[0].title, "Queued for the Builder");
  assert.match(notes[0].body, /goes in when the Builder is back at its prompt/);
  assert.equal(notes[0].details, "test: the last 60 lines of its log were sent, 440 left out.");
  assert.equal(notes[1].title, "Sent to the Builder");
}
{
  // Closed: resumed in the same worktree, the card opened on it, then pasted
  // once its terminal attached.
  const { d, log } = deps({ sessionOpen: () => false, sessionRecorded: () => false });
  assert.equal(await fixWithBuilder(d), "sent");
  assert.deepEqual(log, ["resume", "reveal", "wait", "deliver [Plyloft] fix it"]);
}
{
  // The resumed session's terminal never attached: not sent, never "queued".
  const { d, log, notes } = deps({
    sessionOpen: () => false,
    sessionRecorded: () => false,
    waitForSession: async () => false,
  });
  assert.equal(await fixWithBuilder(d), "failed");
  assert.ok(!log.some((l) => l.startsWith("deliver")));
  assert.equal(notes[0].title, "The Builder session didn't open");
}
{
  // No runtime to deliver to: said, not queued.
  const { d, notes } = deps({ deliver: () => null });
  assert.equal(await fixWithBuilder(d), "failed");
  assert.equal(notes[0].title, "The Builder session is not open");
}
{
  // Resume refused: nothing sent, said.
  const { d, log, notes } = deps({
    sessionOpen: () => false,
    sessionRecorded: () => false,
    resume: async () => {
      throw new Error("claude CLI not found on PATH");
    },
  });
  assert.equal(await fixWithBuilder(d), "failed");
  assert.deepEqual(log, []);
  assert.equal(notes[0].title, "Nothing was sent to the Builder");
  assert.equal(notes[0].details, "claude CLI not found on PATH");
}
{
  // Gathering failed (gh missing, a conflict's fetch): no resume, no paste.
  const { d, log, notes } = deps({
    sessionOpen: () => false,
    gather: async () => {
      throw "Couldn't fetch main from origin, so nothing was sent to the Builder: timed out";
    },
  });
  assert.equal(await fixWithBuilder(d), "failed");
  assert.deepEqual(log, []);
  assert.equal(notes[0].kind, "error");
  assert.match(notes[0].details ?? "", /Couldn't fetch main/);
}
{
  // The session ended before its prompt, or the write failed: said.
  const { d, notes } = deps({ deliver: () => Promise.reject(new Error("The Builder session ended")) });
  assert.equal(await fixWithBuilder(d), "failed");
  assert.equal(notes[0].title, "The fix didn't reach the Builder");
}
{
  // B1: control characters from GitHub never reach the paste, even if the
  // backend let one through.
  const { d, log } = deps({
    gather: async () => ({ ...message, message: "review \u001b[201~x\r\nnext\u0007 \u009b" }),
  });
  await fixWithBuilder(d);
  assert.equal(log[1], "deliver review [201~x\nnext ");
}

console.log("prFix.test.ts ok");

// ── v1.154.1 (F11, F14, F18): the walk — open PR, a review round, Push update ──
{
  const reviewed = (n: number, status: string, verdict: string | null) =>
    ({ ...builder(["aaa", "bbb"])!, review: { snapshotN: n, provider: "codex", status, verdict, at: 0 } }) as unknown as KanbanCard["builder"];
  const state = (c: KanbanCard) => deriveCardState(c, EMPTY_CARD_STATE_CONTEXT);

  // Fix → Build done: the Challenger reads snapshot 2, which GitHub doesn't
  // have — the card says so, not "Pull request open".
  const reviewing = card({ lastRunStatus: "success", builder: reviewed(2, "running", null) });
  assert.equal(state(reviewing), "challenger-reviewing");
  // The Builder is working on the fix.
  assert.equal(state(card({ lastRunStatus: "running", builder: builder(["aaa"]) })), "running");

  // It approved (or the pushback was accepted): review status back to
  // merged (backend), and even v1.154.0's none keeps the PR open.
  for (const reviewStatus of ["merged", null] as const) {
    const approved = card({ lastRunStatus: "success", reviewStatus, builder: reviewed(2, "done", "approve") });
    assert.equal(pushUpdateLine(approved), "Your latest fixes are only on this Mac. Send them to pull request #8 so GitHub checks them again.");
    if (reviewStatus === "merged") {
      assert.equal(state(approved), "shipped");
      assert.equal(prNowAction(approved)?.actionId, "pr-push-update");
    }
  }
  // M1: changes requested on the fix — the card is on the Challenger's
  // request, and neither Push update nor Merge is offered (as v1.154.0).
  const asked = card({ reviewStatus: "changes_requested", builder: reviewed(2, "done", "changes_requested") });
  assert.equal(state(asked), "changes-requested");
  assert.equal(pushUpdateLine(asked), null);
  assert.equal(prMergeOffered(asked), false);
  assert.equal(prMergeOffered({ ...asked, reviewStatus: "merged", pr: pr({ checks: "passing" }) }), false);

  // The Now action for each PR state.
  assert.equal(prNowAction(card())?.actionId, "pr-fix", "checks failed");
  assert.equal(prNowAction(card({ pr: pr({ checks: "passing", mergeable: "conflicting" }) }))?.actionId, "pr-fix", "conflict");
  assert.equal(prNowAction(card({ pr: pr({ checks: "passing", reviewDecision: "changes_requested" }) }))?.actionId, "pr-fix");
  assert.equal(prNowAction(card({ pr: pr({ checks: "passing" }) }))?.actionId, "pr-merge");
  // 1.171.0 A3 (DL-16): the title names no merge method — the repository's
  // own is said beside Merge (`mergeMethodLabel`).
  assert.doesNotMatch(prNowAction(card({ pr: pr({ checks: "passing" }) }))!.actionTitle ?? "", /squash/i);
  assert.equal(prNowAction(card({ pr: pr({ checks: "none" }) }))?.actionId, "pr-merge", "no checks on GitHub");
  assert.equal(prNowAction(card({ pr: pr({ checks: "pending" }) }))?.actionId, "inspect-ship");
  // 1.174.0 A2 (P7): it merges by itself — Now offers to turn that off.
  assert.equal(prNowAction(card({ pr: pr({ checks: "passing", autoMerge: true }) }))?.actionId, "pr-auto-merge-off", "GitHub merges it");
  {
    const waiting = prNowAction(card({ pr: pr({ checks: "pending", autoMerge: true }) }));
    assert.equal(waiting?.actionId, "pr-auto-merge-off", "checks running, it merges by itself");
    assert.equal(waiting?.actionLabel, DONT_MERGE_BY_ITSELF_LABEL);
    assert.equal(DONT_MERGE_BY_ITSELF_LABEL, "Don't merge by itself");
    assert.equal(prNowAction(card({ pr: pr({ checks: "pending", plyloftAutoMerge: true }) }))?.actionId, "pr-auto-merge-off", "Plyloft merges it");
    assert.notEqual(prNowAction(card({ pr: pr({ checks: "failing", autoMerge: true }) }))?.actionId, "pr-auto-merge-off", "the fix comes first");
    assert.equal(prAutoMergeOffOffered(card({ pr: pr({ checks: "pending" }) })), false, "nothing merges it by itself");
    // Round 1: Plyloft holds a merge by itself it means to turn on.
    assert.equal(prAutoMergeOffOffered(card({ pr: pr({ checks: "pending", autoMergeWanted: "held" }) })), true, "held");
    // Round 2: ⋯ › Fix with the Builder only with a brief to send.
    assert.equal(briefFixOffered({ ...card(), notes: "Do it" }, "pr-merge"), true);
    assert.equal(briefFixOffered({ ...card(), notes: "  " }, "pr-merge"), false, "an empty brief");
    assert.equal(briefFixOffered({ ...card(), notes: "Do it" }, "pr-fix"), false, "Now presses it");
    assert.equal(prAutoMergeOffOffered(card({ pr: pr({ checks: "pending", autoMergeWanted: "turnedOff" }) })), true, "turned off");
    assert.equal(prAutoMergeOffOffered(card({ archived: true, pr: pr({ autoMerge: true }) })), false);
  }
  assert.equal(prNowAction(card({ pr: pr({ checks: "passing", checkedAt: null }) }))?.actionId, "inspect-ship", "not read yet");
  assert.equal(prNowAction(card({ builder: null }))?.actionId, "inspect-ship", "no Builder to fix it");
  assert.equal(prNowAction(card({ pr: pr({ state: "merged" }) })), null);
  assert.equal(prNowAction(card({ pr: null })), null, "shipped before SL-1");
  assert.equal(prNowAction(card({ archived: true })), null);
  console.log("prFix v1.154.1 ok");
}

// ── Round 2 of the v1.154.1 walk fixes (re-walk R2) ─────────────────────
{
  // I1: right after Push update GitHub reports no checks on the new head
  // (or still the old head's failure): not "none", not a failure, no Merge.
  const awaitingNone = card({ pr: pr({ checks: "none", checksTotal: 0, failingChecks: [], awaitingChecks: true }) });
  assert.equal(prNowAction(awaitingNone)?.actionId, "inspect-ship", "no Merge before GitHub has the checks");
  assert.deepEqual(githubChecksFact(awaitingNone.pr!), { word: "Starting on GitHub", state: "running" });
  assert.equal(
    prNowFact(awaitingNone, () => "today"),
    "Its pull request #8 is open; GitHub is starting its checks on the latest push.",
  );
  // 1.171.0 B1 (owner D6): GitHub starting its checks is Working.
  assert.equal(openPrBoard(awaitingNone)?.attention, "working");
  const awaitingOldFailure = card({ pr: pr({ awaitingChecks: true }) });
  assert.equal(prFixOffered(awaitingOldFailure), false, "the failure is the old head's");
  assert.equal(openPrBoard(awaitingOldFailure)?.label, "On GitHub · waiting for checks");
  assert.notEqual(prFactsKey(awaitingNone.pr!), prFactsKey({ ...awaitingNone.pr!, awaitingChecks: false }));
  // Just pushed, GitHub still on the old head: no second Push update.
  const behind = card({ builder: builder(["aaa", "bbb"]), pr: pr({ awaitingChecks: true, pushedHead: "bbb" }) });
  assert.equal(pushUpdateSnapshot(behind), null);
  assert.equal(prNowAction(behind)?.actionId, "inspect-ship");
  // The wait over: "none" is none again, and Merge comes back.
  assert.equal(prNowAction(card({ pr: pr({ checks: "none", awaitingChecks: false }) }))?.actionId, "pr-merge");

  // I4: a fix delivered for what GitHub says now is not offered again.
  const failing = card();
  const sent = prFixKey(failing.pr!);
  assert.equal(prFixOffered(failing, sent), false);
  const round = prNowAction(failing, sent)!;
  assert.equal(round.actionId, "inspect-run", "the fix round, not a second Fix");
  assert.equal(round.actionLabel, "Open the Builder");
  assert.equal(round.label, "Fix sent to the Builder");
  assert.equal(round.helper, prFixSentLine(8));
  // A new head (Push update), a new failure or a new review: Fix again.
  assert.equal(prFixOffered(card({ pr: pr({ headSha: "bbb" }) }), sent), true, "new head");
  assert.equal(
    prFixOffered(card({ pr: pr({ failingChecks: [{ name: "lint", workflow: "lint" }] }) }), sent),
    true,
    "another check failed",
  );
  assert.equal(
    prFixOffered(card({ pr: pr({ mergeable: "conflicting" }) }), sent),
    true,
    "a conflict came",
  );
  // A snapshot to push still comes first.
  assert.equal(prNowAction(card({ builder: builder(["aaa", "bbb"]) }), sent)?.actionId, "pr-push-update");

  // UX P-A Mac walk 1: a land stopped on a conflict shipped nothing, so it
  // closes nothing (G11: no question after any ship); a merge and a pull
  // request count.
  assert.equal(shippedSessionKind({ kind: "local_merge", merged: false }), null);
  assert.equal(shippedSessionKind({ kind: "merged_live", merged: false }), null);
  assert.equal(shippedSessionKind({ kind: "local_merge", merged: true }), "merged");
  assert.equal(shippedSessionKind({ kind: "merged_live", merged: true }), "merged");
  assert.equal(shippedSessionKind({ kind: "pr", merged: false }), "pr");
  console.log("prFix v1.154.1 round 2 ok");
}

// ── Round 3 (re-walk RW-A): Shipping and Now share the merge gates ──────
{
  // Checks failed (a fix under way or not): no Merge, no Merge when checks pass.
  const failing = card();
  assert.equal(prMergeBlocked(failing), true);
  assert.equal(prMergeReady(failing), false);
  assert.equal(prAutoMergeOffered(failing), false);
  // A snapshot GitHub doesn't have (the fix, before or while it is pushed).
  const unpushed = card({ pr: pr({ checks: "passing" }), builder: builder(["aaa", "bbb"]) });
  assert.equal(prMergeReady(unpushed), false);
  assert.equal(prAutoMergeOffered(unpushed), false);
  // Just pushed: GitHub on the old head, the pushed one recorded — not
  // blocked by the snapshot, but the wait for its checks holds Merge.
  const justPushed = card({ builder: builder(["aaa", "bbb"]), pr: pr({ checks: "failing", awaitingChecks: true, pushedHead: "bbb" }) });
  assert.equal(prMergeBlocked(justPushed), false, "the old head's failure isn't the pushed commit's");
  assert.equal(prMergeReady(justPushed), false);
  assert.equal(prAutoMergeOffered(justPushed), true, "GitHub can wait for them itself");
  // Conflict, changes requested on GitHub.
  assert.equal(prMergeReady(card({ pr: pr({ checks: "passing", mergeable: "conflicting" }) })), false);
  assert.equal(prMergeReady(card({ pr: pr({ checks: "passing", reviewDecision: "changes_requested" }) })), false);
  // Passing, nothing in the way: Merge; pending: Merge when checks pass only.
  assert.equal(prMergeReady(card({ pr: pr({ checks: "passing" }) })), true);
  assert.equal(prAutoMergeOffered(card({ pr: pr({ checks: "passing" }) })), false);
  assert.equal(prMergeReady(card({ pr: pr({ checks: "pending", failingChecks: [] }) })), false);
  assert.equal(prAutoMergeOffered(card({ pr: pr({ checks: "pending", failingChecks: [] }) })), true);
  assert.equal(prAutoMergeOffered(card({ pr: pr({ checks: "pending", autoMerge: true }) })), false, "already on");

  // The fix round's Now line, from the session.
  assert.equal(
    prFixRoundLine(17, "Claude", "working", false),
    "Claude is working on what pull request #17 needs. When it's done, Plyloft checks the fix by itself; then Send the fixes to GitHub.",
  );
  assert.equal(
    prFixRoundLine(17, "Claude", "asking-you", true),
    "Claude says it's done. If the fix is done: Finish and check, then Send the fixes to GitHub.",
  );
  assert.equal(prFixRoundLine(17, "Claude", "asking-you", false), "Claude asks you something in its session.");
  assert.equal(prFixRoundLine(17, "Claude", null, false), prFixSentLine(17));
  // Shipping's Merge keeps SL-3's rule: pending checks included (GitHub
  // judges); not blocked, not waiting for a push's checks, read, no auto-merge.
  const pending = card({ pr: pr({ checks: "pending", failingChecks: [] }) });
  assert.equal(prShippingMergeOffered(pending), true);
  assert.equal(prMergeReady(pending), false, "Now's primary waits for them");
  assert.equal(prShippingMergeOffered(card()), false, "checks failed");
  // 1.169.1 (R1, Challenger m4): not while GitHub waits for a required review.
  const review = card({ pr: pr({ checks: "passing", failingChecks: [], reviewDecision: "review_required", mergeState: "blocked" }) });
  assert.equal(prShippingMergeOffered(review), false, "GitHub would refuse it");
  assert.equal(prNowAction(review)?.actionId, "pr-open-github");
  // Round 2: GitHub's merge state in the way — no Merge in Now or Shipping.
  const draft = card({ pr: pr({ checks: "passing", failingChecks: [], mergeState: "draft" }) });
  assert.equal(prMergeReady(draft), false);
  assert.equal(prShippingMergeOffered(draft), false);
  assert.equal(prNowAction(draft)?.actionId, "inspect-ship", "View the pull request");
  const clean = card({ pr: pr({ checks: "passing", failingChecks: [], mergeState: "clean" }) });
  assert.equal(prMergeReady(clean), true);
  assert.equal(prShippingMergeOffered(clean), true);
  assert.equal(prShippingMergeOffered(justPushed), false, "waiting for the push's checks");
  assert.equal(prShippingMergeOffered(unpushed), false, "a snapshot GitHub doesn't have");
  assert.equal(prShippingMergeOffered(card({ pr: pr({ checks: "pending", failingChecks: [], autoMerge: true }) })), false);
  assert.equal(prShippingMergeOffered(card({ pr: pr({ checks: "pending", failingChecks: [], checkedAt: null }) })), false);
  console.log("prFix v1.154.1 round 3 ok");
}

// G1–G3 Challenger (2): GitHub's head isn't the one Plyloft pushed — no
// Merge, no Merge when checks pass; Now offers the person's own press,
// Merge what's on GitHub now, with the line that says why.
{
  const moved = card({ builder: builder(["aaa"]), pr: pr({ checks: "passing", failingChecks: [], headSha: "bbb", pushedHead: "aaa" }) });
  assert.equal(prMergeReady(moved), false);
  assert.equal(prShippingMergeOffered(moved), false);
  assert.equal(prAutoMergeOffered(moved), false);
  assert.equal(prHeadMovedMergeOffered(moved), true);
  const now = prNowAction(moved);
  assert.equal(now?.actionId, "pr-merge-github-head");
  assert.equal(now?.actionLabel, "Merge what's on GitHub now");
  assert.equal(now?.helper, "Someone else changed it on GitHub: the pull request has commits Plyloft didn't push.");
  // Something else in the way first: not offered.
  assert.equal(prHeadMovedMergeOffered({ ...moved, pr: { ...moved.pr!, checks: "failing" } }), false);
  assert.equal(prHeadMovedMergeOffered({ ...moved, pr: { ...moved.pr!, mergeable: "conflicting" } }), false);
  assert.equal(prHeadMovedMergeOffered({ ...moved, pr: { ...moved.pr!, autoMerge: true } }), false);
  // Plyloft's own push: Merge as before.
  const own = card({ builder: builder(["aaa"]), pr: pr({ checks: "passing", failingChecks: [], headSha: "aaa", pushedHead: "aaa" }) });
  assert.equal(prHeadMovedMergeOffered(own), false);
  assert.equal(prNowAction(own)?.actionId, "pr-merge");
}

// 1.175.0 F5 round 2: the pull request's fix lines say the press on a card set to "Waits for me".
{
  const { prFixSentLine: sent, prFixRoundLine: round } = await import("./prFix.ts");
  assert.match(sent(8), /When it's done, Plyloft checks the fix by itself; then Send the fixes to GitHub\.$/);
  assert.match(sent(8, false), /When it's done: Finish and check, then Send the fixes to GitHub\.$/);
  assert.match(round(17, "Claude", "working", false, false), /When it's done: Finish and check, then Send the fixes to GitHub\.$/);
  assert.equal(round(17, "Claude", null, false, false), sent(17, false));
  console.log("prFix F5 round 2: ok");
}
