// UX P1 point 2 (P-A): one fixture per rule of `presentCard`'s order and one
// per canonical state through rule 20. Shared by cardPresentation.test.ts,
// surfaceAgreement.test.ts and the no-drift snapshot. Not a test itself.
import type { KanbanCard, PrStatus, PrReview } from "../ipc.ts";
import { cardLive, type CardLive, type PresentationRule } from "./cardPresentation.ts";

export type PresentationFixture = {
  name: string;
  card: KanbanCard;
  live: CardLive;
  /** The rule the fixture is about. */
  rule: PresentationRule;
};

export const NOW = 1_700_000_000_000;

export function fixtureCard(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    workspaceId: "ws",
    title: id,
    columnId: "todo",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function builder(patch: Partial<NonNullable<KanbanCard["builder"]>> = {}): NonNullable<KanbanCard["builder"]> {
  return {
    vendor: "claude",
    bypass: false,
    sessionLost: false,
    startedAt: NOW - 60_000,
    snapshots: [],
    ...patch,
  };
}

const SNAP = [{ n: 1, sha: "aaaaaaaa1", at: NOW - 30_000 }];

/** 1.171.0 C1: the findings of `fixRoundCard`'s review, delivered into its
 *  session `pty-1`. */
const FIX_VERDICT_SENT = { at: NOW - 1000, ptyId: "pty-1", state: "sent" as const, acked: true };

/** 1.171.0 C1: a card whose Challenger asked for changes (three findings,
 *  delivered) and whose Builder session is attached. */
function fixRoundCard(id: string): KanbanCard {
  const finding = (n: number) => ({ severity: "P1", title: `F${n}`, body: `Fix ${n}.`, preExisting: false, pass: null });
  return fixtureCard(id, {
    columnId: "in_progress",
    lastRunStatus: "success",
    worktreePath: `/w/${id}`,
    builder: builder({
      ptyId: "pty-1",
      snapshots: SNAP,
      review: {
        snapshotN: 1,
        provider: "codex",
        degraded: false,
        status: "done",
        verdict: "changes_requested",
        at: NOW - 1000,
        findings: [finding(1), finding(2), finding(3)],
      },
    }),
  });
}

function pr(patch: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 5,
    state: "open",
    checks: "passing",
    checksTotal: 1,
    checksPassed: 1,
    checksPending: 0,
    failingChecks: [],
    mergeable: "mergeable",
    reviewDecision: "none",
    ...patch,
  };
}

function prReview(patch: Partial<PrReview> = {}): PrReview {
  return {
    url: "https://github.com/o/r/pull/7",
    number: 7,
    repo: "o/r",
    title: "Their change",
    baseRef: "main",
    headRef: "feature",
    headSha: "bbbbbbbb1",
    crossRepository: false,
    pushable: true,
    state: "open",
    checkedAt: NOW,
    ...patch,
  };
}

const shippable: Partial<KanbanCard> = {
  columnId: "complete",
  lastRunStatus: "success",
  verifyStatus: "passed",
  worktreePath: "/w/c",
  branchName: "card/c",
};

const blocker = fixtureCard("blocker", { notes: "first", columnId: "in_progress", lastRunStatus: "running" });

function fx(name: string, rule: PresentationRule, card: KanbanCard, live: Partial<CardLive> = {}): PresentationFixture {
  return { name, rule, card, live: cardLive({ now: NOW, ...live }) };
}

export const PRESENTATION_FIXTURES: readonly PresentationFixture[] = [
  // ── one per rule ──
  fx("archived card", "archived", fixtureCard("archived", { archived: true, lastRunStatus: "success" })),
  fx("reviews a member's pull request", "pr-review", fixtureCard("pr-review", { prReview: prReview() })),
  fx(
    "held by a blocker",
    "blocked",
    fixtureCard("blocked", { notes: "second", blockedBy: ["blocker"] }),
    { workspaceCards: [blocker, fixtureCard("blocked", { notes: "second", blockedBy: ["blocker"] })] },
  ),
  fx("someone else holds its issue", "claimed", fixtureCard("claimed", { notes: "brief", ghIssueNumber: 12 }), {
    claimedByOthers: "Claimed by ana",
  }),
  // 1.174.0 (C3, P9): made on All areas — Now asks which area, before Start.
  fx("its area is not chosen yet", "choose-area", fixtureCard("no-area", { notes: "brief" }), {
    areaAsk: { kind: "choose", area: "Site", why: null },
  }),
  fx("a two-AI plan waits for the person", "plan", fixtureCard("plan-waits"), {
    plan: { status: "awaitingMember", proposer: "claude", critic: "codex", roundsDone: 2, pause: null },
  }),
  fx("a two-AI plan runs", "plan", fixtureCard("plan-runs", { notes: "brief" }), {
    plan: { status: "running", proposer: "claude", critic: "codex", roundsDone: 1, pause: null },
  }),
  fx(
    "its setup failed",
    "setup",
    fixtureCard("setup-failed", { notes: "brief", worktreeSetup: { state: "failed", reason: "npm ci failed.", at: NOW } }),
  ),
  fx(
    "its setup runs",
    "setup",
    fixtureCard("setup-runs", { notes: "brief", worktreeSetup: { state: "running", command: "npm ci", at: NOW } }),
  ),
  fx("its intake conversation ended", "intake-stopped", fixtureCard("intake-stopped", { intakeStatus: "active" }), {
    intakeStop: "The intake conversation ended.",
  }),
  fx("its intake asks to trust the folder", "intake-trust", fixtureCard("intake-trust", { intakeStatus: "active" }), {
    intakeTrust: "claude",
  }),
  fx(
    "its Builder asks to trust the folder",
    "session-block",
    fixtureCard("trust", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/t",
      builder: builder({ ptyId: "pty-1" }),
    }),
    { session: { vendor: "claude", state: null, block: { kind: "trust" } } },
  ),
  // 1.171.0 D2: Codex's own words (unmeasured: no "once", no button name).
  fx(
    "its Codex Builder asks to trust the folder",
    "session-block",
    fixtureCard("trust-codex", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/tc",
      builder: builder({ ptyId: "pty-1", vendor: "codex" }),
    }),
    { session: { vendor: "codex", state: null, block: { kind: "trust" } } },
  ),
  // P-B (points 3 and 4): rule 9, a Builder waiting on the person.
  fx(
    "its Builder stopped",
    "builder-waiting",
    fixtureCard("stopped", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/s",
      builder: builder({ ptyId: "pty-1" }),
    }),
    { session: { vendor: "claude", state: "stopped", block: null } },
  ),
  fx(
    "its Builder asks a question",
    "builder-waiting",
    fixtureCard("question", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/q",
      builder: builder({ ptyId: "pty-1" }),
    }),
    { session: { vendor: "claude", state: "question", block: null } },
  ),
  fx(
    "its Builder went quiet",
    "builder-waiting",
    fixtureCard("quiet", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/z",
      builder: builder({ vendor: "codex", ptyId: "pty-1" }),
    }),
    { session: { vendor: "codex", state: "quiet", block: null } },
  ),
  // UX P-B Mac walk 2: a question outranks "Challenger requests changes".
  fx(
    "changes requested, its Builder asks a question",
    "builder-waiting",
    fixtureCard("changes-requested-question", {
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/w/q",
      builder: builder({
        ptyId: "pty-1",
        snapshots: SNAP,
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: NOW - 1000 },
      }),
    }),
    { session: { vendor: "claude", state: "question", block: null } },
  ),
  // 1.171.0 C1 (CF1): the fix round — the Builder at work on the findings,
  // then its turn over, then the person's own changes.
  // The findings went into this session (`verdictDelivery`).
  fx("changes requested, its Builder fixes them", "builder-fixing", fixRoundCard("changes-requested-fixing"), {
    session: { vendor: "claude", state: "working", block: null, since: NOW - 125_000 },
    delivery: { handedOver: null, verdict: FIX_VERDICT_SENT, changesSentAt: null, fixSentKey: null },
    now: NOW,
  }),
  fx("changes requested, its Builder finished the fixes", "builder-waiting", fixRoundCard("changes-requested-fixed"), {
    session: { vendor: "claude", state: "stopped", block: null },
    delivery: { handedOver: null, verdict: FIX_VERDICT_SENT, changesSentAt: null, fixSentKey: null },
    now: NOW,
  }),
  // 1.171.0 C2 (CF3): Finish and check pressed — the Builder re-reads its
  // own work before the checks and the review.
  fx(
    "Finish and check pressed, its Builder re-reads its work",
    "finishing",
    fixtureCard("finishing", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/f",
      builder: builder({ ptyId: "pty-1" }),
    }),
    {
      session: { vendor: "claude", state: "working", block: null, since: NOW - 300_000, finishing: true, selfCheck: { since: NOW - 80_000, delivered: true } },
      now: NOW,
    },
  ),
  // 1.171.0 C2: Plyloft quit while the Builder re-read its own work.
  fx(
    "Plyloft quit during the self-check",
    "check-stopped",
    fixtureCard("check-stopped", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/q",
      builder: builder({ sessionLost: true, lostOnRestart: true, selfCheckStartedAt: NOW - 60_000 }),
    }),
    { now: NOW },
  ),
  // 1.175.0 B2: Finish and check saved the work; the checks wait for the OK.
  fx(
    "the checks wait for this Mac's OK",
    "checks-ok",
    fixtureCard("checks-ok", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/ok",
      builder: builder({ snapshots: SNAP }),
      checksHold: { at: NOW - 120_000 },
    }),
    { now: NOW },
  ),
  fx(
    "changes sent, its Builder works on them",
    "builder-fixing",
    fixtureCard("changes-sent-working", { ...shippable, columnId: "in_progress", builder: builder({ vendor: "codex", ptyId: "pty-5", snapshots: SNAP }) }),
    {
      delivery: { handedOver: null, verdict: null, changesSentAt: 1, fixSentKey: null },
      session: { vendor: "codex", state: "working", block: null, since: NOW - 10_000 },
      now: NOW,
    },
  ),
  fx(
    "built by both, a build waits",
    "both",
    fixtureCard("both-waits", {
      columnId: "in_progress",
      lastRunStatus: "running",
      buildBoth: {
        startedAt: NOW - 60_000,
        lanes: [
          { lane: "a", vendor: "claude", worktreePath: "/w/a", branchName: "a", ptyId: "pa", startedAt: NOW - 60_000 },
          { lane: "b", vendor: "codex", worktreePath: "/w/b", branchName: "b", ptyId: "pb", startedAt: NOW - 60_000 },
        ],
      },
    }),
    { session: { vendor: "codex", state: "stopped", block: null } },
  ),
  fx(
    "built by both, both working",
    "both",
    fixtureCard("both", {
      columnId: "in_progress",
      lastRunStatus: "running",
      buildBoth: {
        startedAt: NOW - 60_000,
        lanes: [
          { lane: "a", vendor: "claude", worktreePath: "/w/a", branchName: "a", ptyId: "pa", startedAt: NOW - 60_000 },
          { lane: "b", vendor: "codex", worktreePath: "/w/b", branchName: "b", ptyId: "pb", startedAt: NOW - 60_000 },
        ],
      },
    }),
  ),
  fx(
    "changes sent to the Builder",
    "changes-sent",
    fixtureCard("changes-sent", { ...shippable, columnId: "in_progress", builder: builder({ ptyId: "pty-2", snapshots: SNAP }) }),
    { delivery: { handedOver: null, verdict: null, changesSentAt: 1, fixSentKey: null } },
  ),
  fx(
    "a request for changes the Builder never received",
    "handed-over",
    fixtureCard("handed-over", {
      ...shippable,
      columnId: "in_progress",
      builder: builder({
        ptyId: "pty-4",
        snapshots: [...SNAP, { n: 2, sha: "aaaaaaaa2", at: NOW - 20_000 }],
        review: { snapshotN: 2, provider: "codex", degraded: false, status: "failed", error: "timed out", at: NOW - 1000 },
        handedOver: { snapshotN: 1, findingIds: ["F1"], handoff: "Fix F1.", at: NOW - 10_000 },
      }),
    }),
    { outcome: { loading: false, filesChanged: 2, shipBusy: false, noRemote: false, reviewFreshness: "none" } },
  ),
  fx(
    "changes requested, verdict not delivered",
    "verdict-owed",
    fixtureCard("verdict-owed", {
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/w/v",
      builder: builder({
        ptyId: "pty-3",
        snapshots: SNAP,
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: NOW - 1000 },
        undeliveredVerdict: { snapshotN: 1, at: NOW - 1000 },
      }),
    }),
  ),
  fx(
    "review failed on a ready card",
    "review-truth",
    fixtureCard("review-truth", {
      ...shippable,
      builder: builder({
        snapshots: SNAP,
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "failed", error: "timed out", at: NOW - 1000 },
      }),
    }),
    { outcome: { loading: false, filesChanged: 2, shipBusy: false, noRemote: false, reviewFreshness: "none" } },
  ),
  fx("a runner is chosen", "swarm-ready", fixtureCard("swarm-ready", { notes: "brief", agentConfigId: "agent-1" })),
  fx(
    "its pull request is open",
    "pr-open",
    fixtureCard("pr-open", {
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/5",
      // 1.169.1 (R1): checks still running — On hold. Green, it asks for
      // its Merge (the next fixtures).
      pr: pr({ checks: "pending", checksPassed: 0, checksPending: 1 }),
      worktreePath: "/w/p",
    }),
  ),
  // 1.169.1 (R1, walk R3 step A4): a green pull request.
  fx(
    "its pull request is ready to merge",
    "pr-open",
    fixtureCard("pr-ready", {
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/5",
      pr: pr({ checkedAt: NOW - 60_000, mergeState: "clean" }),
      worktreePath: "/w/p",
    }),
  ),
  fx(
    "its pull request has no checks",
    "pr-open",
    fixtureCard("pr-no-checks", {
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/5",
      pr: pr({ checks: "none", checksTotal: 0, checksPassed: 0, checkedAt: NOW - 60_000, mergeState: "clean" }),
      worktreePath: "/w/p",
    }),
  ),
  fx(
    "its pull request waits for a review",
    "pr-open",
    fixtureCard("pr-review", {
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/5",
      pr: pr({ reviewDecision: "review_required", mergeState: "blocked", checkedAt: NOW - 60_000 }),
      worktreePath: "/w/p",
    }),
  ),
  fx(
    "its pull request was closed",
    "pr-closed",
    fixtureCard("pr-closed", {
      ...shippable,
      prUrl: "https://github.com/o/r/pull/5",
      pr: pr({ state: "closed", closedAt: NOW - 5000 }),
    }),
  ),
  fx(
    "merged as a pull request",
    "merged",
    fixtureCard("merged", {
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/5",
      // D8 (1.171.0): the merge stamps the project's version and a local
      // entry — not a release — and GitHub's title is what shipped.
      pr: pr({ state: "merged", mergedAt: NOW - 5000, mergeCommit: "m5", title: "Add the merged page" }),
      shippedVersion: "1.0.0",
      shipHistory: [{ commitSha: "m5", shippedVersion: "1.0.0", releaseKind: "local", shippedAt: NOW - 5000 }],
      columnId: "complete",
    }),
  ),
  fx(
    "its Builder session closed",
    "session-closed",
    fixtureCard("session-closed", {
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/w/s",
      builder: builder({ ptyId: null }),
    }),
  ),
  fx(
    "a local ship stopped on a conflict",
    "ship-conflict",
    fixtureCard("conflict", { ...shippable, reviewStatus: "conflict_blocked" }),
  ),
  fx(
    "a skill card behind its team library",
    "skill-behind",
    fixtureCard("skill-behind", { columnId: "complete", lastRunStatus: "success", verifyStatus: "passed", worktreePath: "/w/k" }),
    { skillBehind: true },
  ),
  // Windows walk (H6b step 9): its newer version brings a changed script,
  // which Refresh card won't take in unseen.
  fx(
    "a skill card behind its team library, a changed script shown first",
    "skill-behind",
    fixtureCard("skill-behind-script", { columnId: "complete", lastRunStatus: "success", verifyStatus: "passed", worktreePath: "/w/k" }),
    { skillBehind: "script" },
  ),
  fx("a ship press failed", "ship-failed", fixtureCard("ship-failed", { ...shippable }), {
    outcome: { loading: false, filesChanged: 3, shipBusy: false, noRemote: false, reviewFreshness: "none" },
    shipFailure: "ship-it",
  }),
  // 1.170 walk (Mac and Windows): a release through a pull request on its
  // way — the card's own state, never "Ship didn't go through".
  fx("a release through a pull request on its way", "releasing", fixtureCard("releasing", { ...shippable }), {
    outcome: { loading: false, filesChanged: 3, shipBusy: false, noRemote: false, reviewFreshness: "none" },
    shipFailure: null,
    releasing: { tag: "v1.0.1", step: "merging", number: 119, url: "https://github.com/owner/app/pull/119", waiting: null },
  }),

  // ── one per canonical state, through rule 20 ──
  fx("draft", "base", fixtureCard("draft")),
  fx("planning with Claude", "base", fixtureCard("intake-live", { intakeStatus: "active" })),
  fx("closed with no run", "base", fixtureCard("closed", { columnId: "complete" })),
  fx("ready to start", "base", fixtureCard("ready", { notes: "brief" })),
  // 1.175.0 (D3): its issue asks which version to keep — Needs you, with
  // its Inbox row, whatever rule the card reads by.
  fx(
    "ready, its brief changed on GitHub and here",
    "base",
    fixtureCard("edit-asks", { notes: "mine", ghIssueNumber: 70, editConflicts: [{ part: "brief", theirs: "theirs" }] }),
  ),
  fx(
    "a teammate's, its title changed on GitHub and here",
    "claimed",
    fixtureCard("edit-asks-claimed", { notes: "brief", ghIssueNumber: 71, editConflicts: [{ part: "title", theirs: "theirs" }] }),
    { claimedByOthers: "Claimed by ana" },
  ),
  fx("in line for a swarm slot", "base", fixtureCard("queued", { columnId: "in_progress", swarmTemplateId: "t1" })),
  fx("an agent run is working", "base", fixtureCard("running", { columnId: "in_progress", lastRunStatus: "running" })),
  fx("paused swarm", "base", fixtureCard("paused", { columnId: "in_progress", linkedSwarmId: "sw1", lastRunStatus: "success" }), {
    linkedSwarmStatus: "suspended",
  }),
  fx(
    "Reviewing",
    "base",
    fixtureCard("challenger-reviewing", {
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/w/r",
      builder: builder({
        snapshots: SNAP,
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "running", at: NOW - 1000 },
      }),
    }),
  ),
  fx(
    "Reviewer requests changes (delivered)",
    "base",
    fixtureCard("changes-requested", {
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/w/q",
      builder: builder({
        snapshots: SNAP,
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: NOW - 1000 },
      }),
    }),
  ),
  fx("running checks", "base", fixtureCard("checking", { ...shippable, verifyStatus: "running" })),
  fx("checks failed", "base", fixtureCard("verify-failed", { ...shippable, verifyStatus: "failed" })),
  fx("the run failed", "base", fixtureCard("failed", { columnId: "in_progress", lastRunStatus: "failed" })),
  fx("the review is out of date", "base", fixtureCard("review-stale", { ...shippable }), {
    outcome: { loading: false, filesChanged: 2, shipBusy: false, noRemote: false, reviewFreshness: "stale" },
  }),
  fx("nothing changed", "base", fixtureCard("no-changes", { ...shippable }), {
    outcome: { loading: false, filesChanged: 0, shipBusy: false, noRemote: false, reviewFreshness: "none" },
  }),
  fx("ready to ship (result read)", "base", fixtureCard("ready-to-ship", { ...shippable }), {
    outcome: { loading: false, filesChanged: 2, shipBusy: false, noRemote: false, reviewFreshness: "none" },
  }),
  fx("ready to ship (result not read yet)", "base", fixtureCard("result-unread-shippable", { ...shippable })),
  fx("the result is loading", "base", fixtureCard("result-loading", { ...shippable }), {
    outcome: { loading: true, filesChanged: null, shipBusy: false, noRemote: false, reviewFreshness: "none" },
  }),
  fx("result ready, not verified", "base", fixtureCard("result-ready", { columnId: "in_progress", lastRunStatus: "success" })),
  fx("shipping", "base", fixtureCard("shipping", { ...shippable }), {
    outcome: { loading: false, filesChanged: 2, shipBusy: true, noRemote: false, reviewFreshness: "none" },
  }),
  fx("shipped in a release", "base", fixtureCard("shipped", { ...shippable, shipStatus: "shipped", shippedVersion: "1.2.0" })),
];
