// A synthetic stand-in for a Ply state snapshot, so the harness runs without
// anyone's private app-support data. Same shape as loadState() in fixtures.mjs:
// settings.json, workspaces.json and kanban/workspaces/<id>.json as Ply writes
// them. The Ply workspace's cwd is the repository itself (Code shows its files).
import os from "node:os";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export function syntheticState(repo, now = Date.now()) {
  const home = /^\/Users\/[^/]+/.test(repo) ? repo.match(/^\/Users\/[^/]+/)[0] : os.homedir();
  const settings = {
    schemaVersion: 1,
    appearance: { theme: "system", accent: "violet" },
    terminals: { defaultNewPaneKind: "shell", scrollbackLines: 5000 },
    shell: { pathOverride: null, tileShell: null },
    editor: { tabSize: 2, lineNumbers: true, wordWrap: false },
    behavior: {
      fileWatcherEnabled: true, externalWriteReloadStrategy: "promptIfDirty", notifyOnAgentDone: true, notifyOnSessionWaiting: true,
      runHistoryRetention: { days: null, maxRuns: null }, commandBlocksEnabled: false,
      autoResumeSuspended: false, autoCloseFinishedRunTiles: true,
      injectGlobalMemories: false, openOn: "board", discussionSynthesizer: "claude", builderVendor: "claude",
      models: { claude: { builder: null, challenger: null }, codex: { builder: null, challenger: null, builderReasoning: null, challengerReasoning: null } },
      dictation: { enabled: true, model: "small", language: "auto" },
    },
    // OB-4: a Mac that has seen Setup — the audit drives the shell, and a
    // Setup scenario opens it on purpose.
    onboarding: { firstRunCompletedAt: new Date(now - 14 * DAY).toISOString(), setupVersion: 2 },
    identity: { userEmail: "you@example.com" },
    team: { cloneRoot: null, ignoredRepos: [] },
    sharing: { notOnThisMac: [] },
    windows: { settings: null, sidebar: { width: 240, collapsed: false } },
    library: { silencedDuplicates: [], plySkillsOff: [] },
  };
  const ws = (id, name, cwd, accentColor, githubOwnerRepo, kanbanSyncMode, i) => ({
    id, name, cwd, createdAt: now - 40 * DAY, lastOpenedAt: now - i * HOUR, openFiles: i === 0 ? [cwd + "/vite.config.ts"] : [],
    activeFile: i === 0 ? cwd + "/vite.config.ts" : null, accentColor, layoutPreset: null, verifySuite: null, pinnedRightTabs: null,
    icon: null, githubOwnerRepo, kanbanSyncMode,
  });
  const PLY = "syn-ws-ply", APP = "syn-ws-sample-app", SITE = "syn-ws-notes-site";
  const workspaces = [
    ws(PLY, "Ply", repo, "#7c3aed", "MatteoB-adv/atelier", "githubIssues", 0),
    ws(APP, "Sample app — spring release", home + "/code/sample-app", "#2563eb", "example/sample-app", "githubIssues", 1),
    ws(SITE, "Notes site", home + "/code/notes-site", "#ca8a04", null, "local", 2),
  ];

  const sha = (n) => (n.toString(16).repeat(40)).slice(0, 40);
  const builderTemplate = {
    vendor: "claude", bypass: false, model: null, ptyId: null, sessionLost: false, startedAt: now - 10 * DAY,
    snapshots: [{ n: 1, sha: sha(0xb6a24e2f), at: now - 10 * DAY }, { n: 2, sha: sha(0x609d0b13), at: now - 9 * DAY }],
    review: {
      snapshotN: 2, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", reviewId: "syn-review-1",
      excerpt: "## Verdict\n\nCHANGES_REQUESTED\n\n## Findings\n\n- **P2 — The retry count is not reset.** A second run starts at the old count.",
      error: null, at: now - 9 * DAY, note: null, overriddenBy: null, passCount: null, fileCount: null, incompleteReason: null, model: null,
      reviewedRevision: null, failureReason: null, retryAt: null, retried: false, commitsSinceReview: null, failedPasses: null, kind: "review",
      synthesisPass: false, findings: [], nonBlocking: [], checklist: [], failedPassNames: [], findingsUnread: false, builderHandoff: null,
      followUpFallback: null, ledgerNote: null, ledger: [],
    },
    lastReviewedRevision: null, shippedUnreviewed: null,
  };
  const card = (wsId, id, title, columnId, o = {}) => ({
    id, workspaceId: wsId, title, notes: o.notes ?? `${title}.\n\nAcceptance: tests cover it; PPVP passes.`, knowledge: null, columnId,
    agentConfigId: null, linkedRunId: null, lastRunStatus: o.merged ? "success" : null, swarmTemplateId: null, linkedSwarmId: null,
    linkedBrainstormId: null, dismissedBanners: [], runHistory: [], suppressRunHistory: false, builder: o.builder ?? null, planChallenge: null,
    dispatchPrompt: null, dispatchPromptEditedAt: null, intakeStatus: "none", intakeHistory: [], archived: false, verifyIntent: null,
    verifyStatus: o.merged ? "passed" : "none", verifyHistory: [], shipStatus: o.merged ? "shipped" : "unshipped", shipHistory: [],
    commitSha: o.merged ? sha(o.n || 7) : null, shippedVersion: o.merged ? o.version : null, attachments: [], worktreePath: null, branchName: null,
    worktreeBase: null, reviewStatus: o.merged ? "merged" : null, reviewDecisions: [], prUrl: o.merged ? `https://github.com/MatteoB-adv/atelier/pull/${o.n}` : null,
    parentCardId: null, ghIssueNumber: o.issue ?? null, syncPending: false, ghRawRemainder: null, ghAssignees: [], ghLabelsPending: false,
    author: "you@example.com", lastEditedBy: null, createdAt: now - (o.age ?? 5) * DAY, updatedAt: now - (o.age ?? 5) * DAY + HOUR,
  });
  const plyTitles = [
    "Team sharing: create a team and invite members from Settings",
    "Inbox: mark a row seen when its card opens",
    "Board: remember the collapsed Done column per workspace",
    "Code: reopen the last file when a workspace is switched back",
    "Terminals: a Claude tile says Ready only after two quiet seconds",
    "History: filter runs by workspace",
    "Library: show a skill's history from git",
    "Settings: one search across every page",
    "Card: Blocked by picker lists only open cards",
    "Ship batch: a release note per card",
    "Sidebar: the workspace switcher searches by folder too",
    "Diagnostics: say which CLI is missing, in words",
  ];
  const plyCards = [
    ...plyTitles.map((t, i) => card(PLY, `gh-issue-${21 + i}`, t, "complete", { merged: true, n: 180 + i, version: `v1.${140 + (i % 9)}.0`, issue: 21 + i, age: 1 + i * 0.4, builder: i === 0 ? builderTemplate : null })),
    ...["Release: note the version in the About box", "Editor: remember the scroll position per file", "Tiles: rename a tile inline", "Board: drag a card between workspaces is refused",
      "Doctor: probe gh auth once per launch", "Inbox: a shipped row links its release", "History: export as CSV", "Library: hide a duplicate skill"]
      .map((t, i) => card(PLY, `syn-ply-closed-${i}`, t, "complete", { age: 2 + i * 0.3, issue: 60 + i })),
    card(PLY, "syn-ply-done-1", "Docs: explain the Verify pipeline in the README", "complete", { age: 3 }),
    card(PLY, "syn-ply-done-2", "Remove the unused Knowledge panel styles", "complete", { age: 2 }),
    card(PLY, "syn-ply-todo-1", "Dictation: pick the model per workspace", "todo", { age: 1 }),
    card(PLY, "syn-ply-todo-2", "Board: keyboard shortcut to move a card right", "todo", { age: 1 }),
  ];
  const appCards = [
    card(APP, "syn-app-1", "Onboarding: rewrite the three welcome screens so a first-time visitor understands pricing, the free tier and how to invite a teammate before signing up", "in_progress", { age: 2 }),
    ...["Checkout: show VAT on the summary", "Settings: export account data", "Pricing page: annual toggle", "Email: weekly digest template", "Mobile nav: close on route change", "Blog: RSS feed"]
      .map((t, i) => card(APP, `syn-app-todo-${i}`, t, "todo", { age: 3 + i })),
    ...["Landing: hero copy", "Auth: magic links", "Footer: legal links", "Analytics: page views", "Dashboard: empty state"]
      .map((t, i) => card(APP, `syn-app-done-${i}`, t, "complete", { age: 10 + i })),
  ];
  const cardsByWs = { [PLY]: plyCards, [APP]: appCards, [SITE]: [] };
  const intakeTranscript = [
    "Claude: I read the List view. What should the Sort menu offer?",
    "You: Attention first, then last activity, then title.",
    "Claude: Should the choice persist across launches?",
    "You: No — session only, per workspace.",
    "Claude: Then the dispatch prompt is ready. I'll write it to the card.",
  ].join("\n");
  return { settings, workspaces, cardsByWs, intakeTranscript, builderTemplate, source: "synthetic" };
}
