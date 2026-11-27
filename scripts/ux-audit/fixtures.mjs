// Builds the data half of the mock seed from a Ply state snapshot (read-only;
// `--state <dir>` or PLY_STATE_DIR) or, without one, from the synthetic seed in
// synthetic.mjs — plus clearly-marked fixtures for states neither contains.
// Output is plain JSON; the function half lives in seed-browser.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR, REPO } from "./config.mjs";
import { syntheticState } from "./synthetic.mjs";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** { settings, workspaces, cardsByWs, intakeTranscript, source } */
export function loadState(dir = STATE_DIR, now = Date.now()) {
  if (!dir) return syntheticState(REPO, now);
  const readJson = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), "utf8"));
  const settings = readJson("settings.json");
  const workspaces = readJson("workspaces.json").workspaces;
  const cardsByWs = {};
  for (const w of workspaces) {
    const p = path.join(dir, "kanban/workspaces", `${w.id}.json`);
    cardsByWs[w.id] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).cards : [];
  }
  let intakeTranscript = "";
  try {
    const root = path.join(dir, "intake/transcripts");
    const logs = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".log")) logs.push(f); } };
    walk(root);
    if (logs[0]) intakeTranscript = fs.readFileSync(logs[0], "utf8");
  } catch { /* no transcripts in this snapshot */ }
  return { settings, workspaces, cardsByWs, intakeTranscript, source: dir };
}

let cached = null;
export function buildSeedData(now = Date.now()) {
  if (!cached || cached.dir !== STATE_DIR) cached = { dir: STATE_DIR, st: loadState(STATE_DIR, now) };
  const st = cached.st;
  const settings = JSON.parse(JSON.stringify(st.settings));
  // OB-4: a snapshot from before Setup has no `setupVersion`, and Setup would
  // open over every screen. Stamp it; the Setup scenarios open Setup
  // themselves through its store.
  settings.onboarding = { ...(settings.onboarding || {}), setupVersion: Math.max(settings.onboarding?.setupVersion ?? 2, 2) };
  const workspaces = st.workspaces.map((w) => ({ ...w }));
  const ply = workspaces.find((w) => w.name === "Ply") || workspaces[0];
  const plyId = ply.id;
  const plyCwd = ply.cwd;
  const home = /^\/Users\/[^/]+/.test(plyCwd) ? plyCwd.match(/^\/Users\/[^/]+/)[0] : os.homedir();
  // The "other" workspace: one with a card in progress (for a long-title card page), else the next one.
  const others = workspaces.filter((w) => w.id !== plyId);
  const other = others.find((w) => (st.cardsByWs[w.id] || []).some((c) => c.columnId === "in_progress")) || others[0];
  const otherId = other.id;
  // Fixture workspaces so the switcher crosses its search threshold (6).
  const extra = [
    ["fx-ws-docs", "Ply docs site", home + "/code/ply-docs", "#0891b2"],
    ["fx-ws-infra", "Infra & deploy", home + "/code/infra", null],
    ["fx-ws-mbadv", "Agency website", home + "/code/agency-site", "#db2777"],
  ];
  extra.forEach(([id, name, cwd, accent], i) =>
    workspaces.push({ id, name, cwd, createdAt: now - 60 * DAY, lastOpenedAt: now - (10 + i) * DAY, openFiles: [], activeFile: null,
      accentColor: accent, layoutPreset: null, verifySuite: null, pinnedRightTabs: null, icon: i === 1 ? { kind: "emoji", value: "🛠️" } : null,
      githubOwnerRepo: null, kanbanSyncMode: "local" }));
  // Freshen lastOpenedAt order (Ply most recent) relative to now.
  workspaces.forEach((w, i) => { if (!w.id.startsWith("fx-")) w.lastOpenedAt = now - i * 3 * HOUR; });

  const cards = {};
  for (const w of workspaces) cards[w.id] = JSON.parse(JSON.stringify(st.cardsByWs[w.id] || []));
  const plyCards = cards[plyId];
  const template = plyCards.find((c) => c.builder && c.builder.review && c.builder.review.verdict === "changes_requested")
    || plyCards.find((c) => c.builder && c.builder.review) || { builder: syntheticState(REPO, now).builderTemplate };
  const blank = blankCard(plyId, "x", now);
  const cwd = plyCwd;
  const sha = (n) => (n.toString(16).repeat(40)).slice(0, 40);
  const snaps = (k, t0) => Array.from({ length: k }, (_, i) => ({ n: i + 1, sha: sha(0xa3f9c21 + i * 977), at: t0 + i * 20 * MIN }));
  const wt = (id, slug) => ({ worktreePath: `${cwd}/.atelier-worktrees/${id}`, branchName: `atelier/card-${id.slice(3, 9)}-${slug}`,
    worktreeBase: { commit: sha(0x3567c205), refName: "origin/main", source: "origin", note: null } });
  const review = (o) => ({ ...template.builder.review, excerpt: null, findings: [], nonBlocking: [], ledger: [], ...o });
  const builder = (o) => ({ ...template.builder, snapshots: snaps(2, now - 3 * HOUR), review: null, ptyId: null, startedAt: now - 4 * HOUR, ...o });
  const verifyEntry = (status, o = {}) => ({ verifyRunId: `verify-${now - HOUR}`, status, endedAt: now - 50 * MIN,
    summary: status === "passed" ? "all 1 step(s) passed" : "1 of 1 step(s) failed",
    steps: [{ kind: "script:scripts/ppvp.sh", passed: status === "passed", elapsedMs: 26_410, reason: status === "passed" ? null : "Tier 2 (cargo test) failed: 2 tests failed in kanban::tests" }],
    treeSha: null, ...o });

  const fx = [
    { id: "fx-draft", title: "Remember the last Settings search between openings", notes: null, columnId: "todo", createdAt: now - 2 * HOUR },
    { id: "fx-ready", title: "Inbox: group rows that wait on the same card", columnId: "todo", createdAt: now - 5 * HOUR,
      notes: "When two rows point at one card (review needed + checks failed), show one row with both facts.\n\nKeep the seen-store keys as they are." },
    { id: "fx-planned", title: "Board List view: sort by last activity", columnId: "todo", intakeStatus: "ready", createdAt: now - 26 * HOUR,
      notes: "Add a sort control to the List view.",
      dispatchPrompt: "Add a Sort menu to the Board's List view (Attention · Last activity · Title). Persist the choice per workspace in session state only. Tests in boardList.test.tsx.",
      intakeHistory: [{ intakeId: "faa81115-1e2d-44d9-9b5b-46534c882dfd", startedAt: now - 25 * HOUR, concludedAt: now - 24 * HOUR,
        dispatchPrompt: "Add a Sort menu to the Board's List view…", transcriptPath: `intake/transcripts/${plyId}/fx-planned/faa81115.log`, applied: true }] },
    { id: "fx-blocked", title: "Ship batch: remember the last release kind", columnId: "todo", createdAt: now - 4 * HOUR, blockedBy: ["fx-ready", "fx-running"],
      notes: "Default the Ship batch sheet's release kind to the one used last time." },
    { id: "fx-running", title: "Terminals: restore the expanded tile after a workspace switch", columnId: "in_progress", lastRunStatus: "running", createdAt: now - 7 * HOUR,
      notes: "Expanded state is lost when switching workspaces and back.", ...wt("fx-running", "terminals-restore-expanded"),
      builder: builder({ snapshots: snaps(1, now - 90 * MIN), startedAt: now - 2 * HOUR, model: "opus" }), ghAssignees: ["test-owner"] },
    { id: "fx-reviewing", title: "Code: breadcrumb overflow menu for deep paths", columnId: "in_progress", lastRunStatus: "success", createdAt: now - 9 * HOUR,
      notes: "Collapse middle segments into … with a menu.", ...wt("fx-reviewing", "code-breadcrumb-overflow"),
      builder: builder({ snapshots: snaps(3, now - 3 * HOUR), review: review({ snapshotN: 3, status: "running", verdict: null, at: now - 4 * MIN, provider: "codex", kind: "sweep" }) }) },
    { id: "fx-changes", title: "Library: show which CLI loads each skill copy", columnId: "in_progress", lastRunStatus: "success", createdAt: now - 30 * HOUR,
      notes: "Each copy row says Claude / Codex / both.", ...wt("fx-changes", "library-cli-badges"), verifyStatus: "passed", verifyHistory: [verifyEntry("passed")],
      builder: builder({ snapshots: snaps(2, now - 5 * HOUR), firstReviewDone: true, changesRequestedCount: 1,
        review: review({ snapshotN: 2, status: "done", verdict: "changes_requested", at: now - 35 * MIN, provider: "codex", kind: "sweep", passCount: 1, fileCount: 6,
          findings: [
            { id: "F1", severity: "P1", title: "Codex copy counted twice when .agents and .codex both hold it", body: "`skillSections` adds the codex root once per directory, so a skill present in both roots reads “Codex ×2”.", preExisting: false, pass: null, location: "src/lib/librarySkills.ts:212" },
            { id: "F2", severity: "P2", title: "Badge text is not read by VoiceOver", body: "The badges are aria-hidden spans; the row's accessible name never says which CLI loads it.", preExisting: false, pass: null, location: "src/components/library/SkillRow.tsx:88" },
          ],
          nonBlocking: [{ id: "F3", severity: "P3", title: "Tooltip copy says ‘CLI’ twice", body: "“Loaded by the Claude CLI CLI”.", preExisting: false, pass: null, location: "src/components/library/SkillRow.tsx:97" }],
          ledger: [
            { id: "F1", severity: "P1", preExisting: false, location: "src/lib/librarySkills.ts:212", title: "Codex copy counted twice when .agents and .codex both hold it", body: "…", reviewId: "r1", round: 1, state: "open", reason: null, updatedRound: 1 },
            { id: "F2", severity: "P2", preExisting: false, location: "src/components/library/SkillRow.tsx:88", title: "Badge text is not read by VoiceOver", body: "…", reviewId: "r1", round: 1, state: "open", reason: null, updatedRound: 1 },
          ],
          builderHandoff: "Fix F1 and F2, then Finish and check." }) }) },
    { id: "fx-checks-failed", title: "Kanban: keep boardOrder when a card changes column", columnId: "in_progress", lastRunStatus: "success", createdAt: now - 20 * HOUR,
      notes: "Dragging across columns resets the order.", ...wt("fx-checks-failed", "kanban-keep-board-order"), verifyStatus: "failed", verifyHistory: [verifyEntry("failed")],
      builder: builder({ snapshots: snaps(2, now - 3 * HOUR), firstReviewDone: true, review: review({ snapshotN: 2, status: "done", verdict: "approve", at: now - 70 * MIN, provider: "codex", kind: "sweep" }) }) },
    { id: "fx-ready-to-ship", title: "Settings: search matches row descriptions, not only labels", columnId: "complete", lastRunStatus: "success", createdAt: now - 28 * HOUR,
      notes: "Searching “scrollback” should find Terminals › Lines kept.", ...wt("fx-ready-to-ship", "settings-search-descriptions"), verifyStatus: "passed", verifyHistory: [verifyEntry("passed")],
      builder: builder({ snapshots: snaps(3, now - 8 * HOUR), firstReviewDone: true, review: review({ snapshotN: 3, status: "done", verdict: "approve", at: now - 6 * HOUR, provider: "codex", kind: "follow-up",
        excerpt: "## Verdict\n\nAPPROVE\n\nNothing blocking. The index now carries each row's description; the search test covers “scrollback”." }) }), ghAssignees: ["test-owner"] },
    { id: "fx-ready-to-ship-2", title: "Toasts: stack at most three, newest on top", columnId: "complete", lastRunStatus: "success", createdAt: now - 29 * HOUR,
      notes: "Older toasts collapse into “+2 more”.", ...wt("fx-ready-to-ship-2", "toasts-stack-three"), verifyStatus: "passed", verifyHistory: [verifyEntry("passed")],
      builder: builder({ snapshots: snaps(2, now - 9 * HOUR), firstReviewDone: true, review: review({ snapshotN: 2, status: "done", verdict: "approve", at: now - 7 * HOUR, provider: "codex", kind: "sweep" }) }) },
    { id: "fx-failed", title: "Discussion: retry a leg after a quota stop", columnId: "in_progress", lastRunStatus: "failed", createdAt: now - 12 * HOUR,
      notes: "The retry button stays disabled after the quota resets.", ...wt("fx-failed", "discussion-retry-leg") },
    { id: "fx-shipped", title: "Sidebar: status rows for update, missing tool and drain", columnId: "complete", lastRunStatus: "success", createdAt: now - 3 * DAY,
      notes: "One quiet row per status at the sidebar's foot.", verifyStatus: "passed", verifyHistory: [verifyEntry("passed", { endedAt: now - 2 * DAY })], shipStatus: "shipped",
      shipHistory: [{ commitSha: sha(0x88af12), shippedVersion: "v1.149.0", releaseKind: "github", shippedAt: now - 2 * DAY }], commitSha: sha(0x88af12), shippedVersion: "v1.149.0",
      prUrl: "https://github.com/MatteoB-adv/atelier/pull/238", reviewStatus: "merged",
      builder: builder({ snapshots: snaps(2, now - 3 * DAY), firstReviewDone: true, review: review({ snapshotN: 2, status: "done", verdict: "approve", at: now - 2.5 * DAY, provider: "codex", kind: "sweep" }) }) },
    { id: "fx-archived", title: "Retire the Knowledge sidebar entry", columnId: "complete", lastRunStatus: "success", archived: true, archivedAt: now - 5 * DAY, createdAt: now - 20 * DAY,
      notes: "Superseded by the Library.", shipStatus: "shipped", shippedVersion: "v1.140.0", reviewStatus: "merged",
      shipHistory: [{ commitSha: sha(0x51ab), shippedVersion: "v1.140.0", releaseKind: "github", shippedAt: now - 19 * DAY }] },
    // States the UX fix cycle introduced (GH #243, #244, #299).
    { id: "fx-closed", title: "Import a closed GitHub issue that never started", columnId: "complete", lastRunStatus: null, createdAt: now - 6 * DAY,
      notes: "Synced from GitHub after the issue was closed.", ghIssueNumber: 199 },
    { id: "fx-merged", title: "Library: a skill's page links its history", columnId: "complete", lastRunStatus: "success", createdAt: now - 4 * DAY,
      notes: "The page names the last commit that touched the skill.", verifyStatus: "passed", verifyHistory: [verifyEntry("passed", { endedAt: now - 3 * DAY })],
      reviewStatus: "merged", shipStatus: "unshipped", prUrl: "https://github.com/MatteoB-adv/atelier/pull/229", ...wt("fx-merged", "library-skill-history"),
      builder: builder({ snapshots: snaps(2, now - 4 * DAY), firstReviewDone: true, review: review({ snapshotN: 2, status: "done", verdict: "approve", at: now - 3.5 * DAY, provider: "codex", kind: "sweep" }) }) },
    // GH #260: a card whose run is a swarm (the Advanced role chain), for the
    // swarm-run section; its record and mailbox are seed-browser.js's.
    { id: "fx-swarm", title: "Worktrees: say which card holds a stale worktree", columnId: "in_progress", lastRunStatus: "running", createdAt: now - 3 * HOUR,
      notes: "The Worktrees page names the card, not only the branch.", ...wt("fx-swarm", "worktrees-name-card"), swarmTemplateId: "feature", linkedSwarmId: "sw-fx-swarm" },
  ].map((o, i) => ({ ...blank, ...o, workspaceId: plyId, updatedAt: now - (i + 1) * 7 * MIN }));
  cards[plyId] = [...fx, ...plyCards];

  const mergedCard = plyCards.find((c) => c.reviewStatus === "merged" && !c.archived) || null;
  return {
    plyId, otherId, otherName: other.name, plyCwd, home, now, stateSource: st.source,
    mergedCardId: mergedCard ? mergedCard.id : null,
    settings, workspaces, activeWorkspaceId: plyId, cards,
    fixtureCardIds: fx.map((c) => c.id),
    blankCardTemplate: blankCard(plyId, "x", now),
    intakeTranscript: st.intakeTranscript || "Claude: What should the Sort menu offer?\nYou: Attention, last activity, title.\n",
    inbox: inboxEvents(now, plyId, otherId, other.name, plyCards),
    costRollup: [
      { workspaceId: plyId, workspaceName: "Ply", totalUsd: 184.32, weeklyUsd: [38.1, 52.7, 41.9, 51.62] },
      { workspaceId: otherId, workspaceName: other.name, totalUsd: 22.4, weeklyUsd: [0, 4.2, 9.6, 8.6] },
    ],
    activity: activityFeed(now, plyId, otherId, other.name, plyCards),
  };
}

export function blankCard(ws, id, now = Date.now()) {
  return {
    id, workspaceId: ws, title: "", notes: null, knowledge: null, columnId: "todo", agentConfigId: null, linkedRunId: null, lastRunStatus: null,
    swarmTemplateId: null, linkedSwarmId: null, linkedBrainstormId: null, dismissedBanners: [], runHistory: [], suppressRunHistory: false,
    builder: null, planChallenge: null, dispatchPrompt: null, dispatchPromptEditedAt: null, intakeStatus: "none", intakeHistory: [], archived: false,
    verifyIntent: null, verifyStatus: "none", verifyHistory: [], shipStatus: "unshipped", shipHistory: [], commitSha: null, shippedVersion: null,
    attachments: [], worktreePath: null, branchName: null, worktreeBase: null, reviewStatus: null, reviewDecisions: [], prUrl: null, parentCardId: null,
    ghIssueNumber: null, syncPending: false, ghRawRemainder: null, ghAssignees: [], ghLabelsPending: false, author: "dev@example.com", lastEditedBy: null,
    createdAt: now, updatedAt: now,
  };
}

function inboxEvents(now, plyId, otherId, otherName, plyCards) {
  const ev = (o) => ({ workspaceId: plyId, workspaceName: "Ply", cardId: null, runId: null, detail: null, url: null, seenAt: null, seenEligible: true, ...o });
  const merged = plyCards.filter((c) => c.reviewStatus === "merged").slice(0, 4);
  return [
    ev({ id: "review:fx-ready-to-ship", kind: "review_needed", group: "needs_you", cardId: "fx-ready-to-ship", title: "Settings: search matches row descriptions, not only labels", detail: "Ready to ship · 7 files changed", at: now - 6 * HOUR }),
    ev({ id: "skill:deploy", kind: "skill_change_waiting", group: "needs_you", cardId: "fx-changes", title: "Improvement proposal for verify-before-done", detail: "The Challenger proposed one change after #212", at: now - 3 * HOUR }),
    ev({ id: "pr:other-41", kind: "pr_review", group: "needs_you", workspaceId: otherId, workspaceName: otherName, title: "Review requested: Onboarding copy pass (#41)", url: "https://github.com/example/sample-app/pull/41", at: null }),
    ev({ id: "fail:fx-failed", kind: "card_failed", group: "failed", cardId: "fx-failed", title: "Discussion: retry a leg after a quota stop", detail: "The Builder session exited with code 1", at: now - 2 * HOUR }),
    ev({ id: "verify:fx-checks-failed", kind: "verify_failed", group: "failed", cardId: "fx-checks-failed", title: "Kanban: keep boardOrder when a card changes column", detail: "Checks failed: Tier 2 (cargo test) failed: 2 tests failed in kanban::tests", at: now - 50 * MIN }),
    ev({ id: "run:fx-running", kind: "card_running", group: "running", cardId: "fx-running", title: "Terminals: restore the expanded tile after a workspace switch", detail: "Claude is building · 2h", at: now - 2 * HOUR, seenEligible: false }),
    ev({ id: "run:fx-reviewing", kind: "card_running", group: "running", cardId: "fx-reviewing", title: "Code: breadcrumb overflow menu for deep paths", detail: "The Challenger is reviewing snapshot 3", at: now - 4 * MIN, seenEligible: false }),
    ...merged.map((c, i) => ev({ id: `ship:${c.id}`, kind: "shipped", group: "shipped", cardId: c.id, title: c.title, detail: `Shipped in v1.${149 - i}.0`, at: now - (i + 1) * 9 * HOUR, seenAt: i > 1 ? now - HOUR : null, url: c.prUrl })),
  ];
}

function activityFeed(now, plyId, otherId, otherName, plyCards) {
  const rows = [];
  const merged = plyCards.filter((c) => c.reviewStatus === "merged").slice(0, 14);
  merged.forEach((c, i) => {
    const t = now - (i + 1) * 5 * HOUR;
    rows.push({ id: `run-${c.id}`, kind: "run", state: i === 3 ? "failed" : "done", title: c.title, detail: i === 3 ? "Builder · exited 1 after 12m" : `Builder · Claude Opus · ${18 + i * 3}m`, workspaceId: plyId, workspaceName: "Ply", cardId: c.id, runId: `run-${i}`, at: t, costUsd: +(1.2 + i * 0.73).toFixed(2) });
    rows.push({ id: `verify-${c.id}`, kind: "verify", state: "passed", title: c.title, detail: "scripts/ppvp.sh · 9/9 · 26s", workspaceId: plyId, workspaceName: "Ply", cardId: c.id, runId: null, at: t + 40 * MIN, costUsd: null });
    if (i % 3 === 0) rows.push({ id: `ship-${c.id}`, kind: "ship", state: "shipped", title: `v1.${149 - i}.0`, detail: "GitHub release · 3 cards", workspaceId: plyId, workspaceName: "Ply", cardId: c.id, runId: null, at: t + 70 * MIN, costUsd: null });
  });
  rows.push({ id: "disc-1", kind: "discussion", state: "completed", title: "Should the Inbox be the landing page?", detail: "Claude + Codex · synthesis by Claude", workspaceId: plyId, workspaceName: "Ply", cardId: null, runId: null, at: now - 30 * HOUR, costUsd: 3.84 });
  rows.push({ id: "run-other", kind: "run", state: "done", title: "Onboarding copy pass", detail: "Builder · Codex · 22m", workspaceId: otherId, workspaceName: otherName, cardId: null, runId: "run-other", at: now - 20 * HOUR, costUsd: 0.92 });
  rows.push({ id: "cleanup-1", kind: "cleanup", state: "done", title: "Trashed 4 merged worktrees", detail: "Freed 3.1 GB", workspaceId: plyId, workspaceName: "Ply", cardId: null, runId: null, at: now - 26 * HOUR, costUsd: null });
  rows.sort((a, b) => b.at - a.at);
  return { generatedAt: now, windowDays: 28, stats: { runs: 38, failedRuns: 3, ships: 9, verifyPassed: 41, verifyTotal: 44, costUsd: 206.72, medianRunSecs: 1_380 }, rows, truncated: false };
}
