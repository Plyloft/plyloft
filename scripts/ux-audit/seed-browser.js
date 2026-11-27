// Function half of the mock seed. Runs in the page before mock.js, reading
// `window.__HARNESS_DATA__` (built by fixtures.mjs from a state snapshot or
// the synthetic seed) and adding the derived answers the mock needs.
/* eslint-disable */
(function buildSeed() {
  const D = window.__HARNESS_DATA__;
  const NOW = Date.now();
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  const PLY_CWD = D.plyCwd;
  const HOME = D.home;
  const ESC = "\x1b[";

  // Files: the Ply workspace is served read-only from the worktree by the
  // harness server (/__fs, /__ls). These overlays add the Code edge cases.
  const files = {};
  files[PLY_CWD + "/fixtures/ship-audit-export.json"] = { tooLarge: true, size: 7_761_512 };

  const personalSkills = {
    skills: [
      { name: "ply-installed-validation", codexName: null, description: "Prepare, diagnose, resume or audit installed Ply validation on macOS. My local copy, older than the repository's.", claude: true, codex: false, roots: [".claude/skills"], dir: HOME + "/.claude/skills/ply-installed-validation" },
      { name: "obsidian-think", codexName: null, description: "Strategic thinking session grounded in Obsidian vault notes.", claude: true, codex: false, roots: [".claude/skills"], dir: HOME + "/.claude/skills/obsidian-think" },
      { name: "seo-content-writer", codexName: null, description: "GEO-optimized SEO content writer for blog posts and articles.", claude: true, codex: true, roots: [".claude/skills", ".codex/skills"], dir: HOME + "/.claude/skills/seo-content-writer" },
      { name: "prd", codexName: null, description: "Generate a structured Product Requirements Document through spec-driven discovery.", claude: true, codex: false, roots: [".claude/skills"], dir: HOME + "/.claude/skills/prd" },
      { name: "spec-verify", codexName: null, description: "Validate a PRD against coding standards and planning decisions.", claude: true, codex: false, roots: [".claude/skills"], dir: HOME + "/.claude/skills/spec-verify" },
    ],
    rootsPresent: [".claude/skills", ".codex/skills"],
    errors: [],
  };
  const PLY_SKILLS_DIR = PLY_CWD + "/src-tauri/resources/ply-skills";
  const plySkills = {
    skills: [
      ["answer-the-challenger", "Answer the Reviewer", "How the Builder replies when the Reviewer pushes back."],
      ["answer-the-reviewer", "Answer the Reviewer", "How the Builder replies when the Reviewer pushes back."],
      ["card-brief", "Card brief", "Turns a rough idea into a brief an agent can work from."],
      ["release-notes", "Release notes", "Writes the release note and the status line the same way every time."],
      ["verify-before-done", "Verify before done", "Makes an agent check its own work before it reports back."],
    ].map(([name, title, description]) => ({ name: "ply:" + name, title, description, dir: PLY_SKILLS_DIR + "/" + name, claude: true, codex: true, on: true })),
    problem: null,
  };

  function projectSkillsView(workspaceId, ws) {
    const isPly = ws.cwd === PLY_CWD;
    return {
      workspaceId, workspaceName: ws.name, cwd: ws.cwd,
      skills: isPly ? [
        { name: "ply-installed-validation", codexName: null, description: "Prepare, diagnose, resume or audit installed Ply validation on macOS, including cross-user Terminal handoffs, GUI/process lifecycle and shared receipts.", claude: true, codex: true, roots: [".claude/skills", ".agents/skills"], diverged: false, ignoredRoots: [], team: "absent", promoteBlocked: "No team key on this Mac." },
        { name: "ds-refresh", codexName: null, description: "Refresh the design-system tokens from the brief and re-run the ratchet.", claude: true, codex: false, roots: [".claude/skills"], diverged: false, ignoredRoots: [], team: "absent", promoteBlocked: "No team key on this Mac." },
      ] : [],
      team: [], unloadable: isPly ? [{ name: "scratch-notes", root: ".claude/skills", reason: "SKILL.md has no description, so neither CLI loads it." }] : [],
      rootsPresent: isPly ? [".claude/skills", ".agents/skills"] : [], ignoredRoots: [],
      configured: false, hasClone: false, canPromote: false, promoteReason: "No team key on this Mac.", promotePlugin: "team", errors: [],
    };
  }
  function libraryState(workspaceId, ws) {
    const isPly = ws.cwd === PLY_CWD;
    return {
      shared: !!ws.githubOwnerRepo, branch: "main", readOnly: false, repository: ws.githubOwnerRepo || null,
      pending: [], branchSkills: isPly ? ["ply-installed-validation"] : [],
      branchSkillRows: isPly ? [{ name: "ply-installed-validation", codexName: null, description: "Prepare, diagnose, resume or audit installed Ply validation on macOS.", dir: HOME + "/Library/Application Support/com.mbadv.ply/mirror/atelier/.claude/skills/ply-installed-validation", claude: true, codex: true, differs: false, codexDir: null }] : [],
      skipped: [], suppliedToCheckout: [],
    };
  }
  function skillText(name) {
    const bits = {
      "ply-installed-validation": "---\nname: ply-installed-validation\ndescription: Prepare, diagnose, resume or audit installed Ply validation on macOS (local copy).\n---\n\n# Installed validation (my notes)\n\n1. Quit Ply.\n2. Run the installer from an external terminal.\n3. Walk the Tier 4 list.\n",
      "obsidian-think": "---\nname: obsidian-think\ndescription: Strategic thinking session grounded in Obsidian vault notes.\n---\n\n# Think with the vault\n\nRead the notes tagged #strategy first.\n",
    };
    return bits[name] || `---\nname: ${name}\ndescription: ${name.replace(/-/g, " ")}.\n---\n\n# ${name}\n\nSteps go here.\n`;
  }
  const instructionsText = "# Atelier\n\nPersonal Mac workspace shell (Ply): Tauri 2, React 19, Vite and TypeScript.\n";

  function instructionsView(workspaceId, cwd) {
    const isPly = cwd === PLY_CWD;
    return {
      shared: true, branch: "main", readOnly: false, repository: isPly ? "MatteoB-adv/atelier" : null, workspaceRoot: cwd,
      files: isPly ? [
        { name: "AGENTS.md", lines: 96, hint: "Read by Codex and, through CLAUDE.md, by Claude", openInCode: cwd + "/AGENTS.md", readOnlyPath: null, located: "both" },
        { name: "CLAUDE.md", lines: 1, hint: "Imports AGENTS.md", openInCode: cwd + "/CLAUDE.md", readOnlyPath: null, located: "both" },
      ] : [
        { name: "CLAUDE.md", lines: 42, hint: "Read by Claude only", openInCode: cwd + "/CLAUDE.md", readOnlyPath: null, located: "both" },
      ],
      procedure: isPly
        ? { status: "compliant", sentence: "Both CLIs read the same instructions.", step: null }
        : { status: "agents-missing", sentence: "Codex reads no instructions here: there is no AGENTS.md.", step: "move-claude-to-agents" },
      plan: isPly ? null : { proposalId: "move-claude-to-agents", eyebrow: "Agent instructions", title: "Give Codex the same instructions", lede: "Move CLAUDE.md's text into AGENTS.md and leave CLAUDE.md importing it.", compared: "CLAUDE.md", before: "# Project\n\nRules…\n", after: "@AGENTS.md\n", note: null, disk: ["AGENTS.md — created, 42 lines", "CLAUDE.md — replaced by one import line"], reach: "Published to main for everyone who opens the repo.", bases: {}, expected: { agentsFingerprint: "x", claudeFingerprint: "y" } },
      personal: [
        { rel: ".claude/CLAUDE.md", path: HOME + "/.claude/CLAUDE.md", cli: "Claude", lines: 58 },
        { rel: ".codex/AGENTS.md", path: HOME + "/.codex/AGENTS.md", cli: "Codex", lines: 12 },
      ],
      errors: [],
    };
  }

  const teamStatus = {
    teamRepo: null, teamName: null, ownerLogin: null, members: [], isOwner: false, ignoredRepos: [], login: "test-owner",
    membership: "unknown", membershipReason: null, membershipStale: false, cloneRoot: HOME + "/code", cloneRootIsDefault: true,
    hasClone: false, workspaces: [], skills: [], refusedSkills: [], canWriteLibrary: false, writeLibraryReason: "No team key on this Mac.",
    libraryDivergence: null, libraryInterruption: null, error: null,
  };

  function projectConfig(workspaceId) {
    return {
      schemaVersion: 1, targetBranch: "main",
      versionFiles: [{ path: "package.json", kind: "package_json" }, { path: "src-tauri/Cargo.toml", kind: "cargo_toml" }, { path: "src-tauri/tauri.conf.json", kind: "tauri_conf_json" }],
      installScript: "scripts/install-local.sh", verifyPipeline: [{ kind: "script", path: "scripts/ppvp.sh" }], cachePaths: [], sharedBuildCache: true, selfCheck: true,
      reviewChecklist: [{ name: "IPC", sentence: "Every new invoke has a Rust command and a capability entry." }], createdAt: NOW - 90 * DAY, updatedAt: NOW - 3 * DAY,
    };
  }

  const swarmTemplates = [
    ["feature", "Feature", "Scout, build, review."], ["refactor", "Refactor", "Plan a refactor and carry it out."], ["ux-audit", "UX audit", "Walk the UI and report."], ["bugfix", "Bugfix", "Reproduce, fix, verify."],
  ].map(([id, label, description]) => ({ schemaVersion: 1, id, label, description, steps: [{ role: "scout", expectsArtifact: true, onRejectJumpTo: null }, { role: "builder", expectsArtifact: true, onRejectJumpTo: null }, { role: "reviewer", expectsArtifact: true, onRejectJumpTo: 1 }], maxIterations: 3, maxWallSeconds: 3600, builtin: true, coordinator: false, outputKind: id === "ux-audit" ? "recon" : "code", createdAt: 0, updatedAt: 0, author: "atelier", scope: "personal" }));
  const userTemplates = [
    { id: "tpl-dev", label: "Dev pair", description: "One shell and one Claude", tiles: [{ kind: "shell" }, { kind: "claude" }], createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY, scope: "personal" },
    { id: "tpl-quad", label: "Review quad", description: "Two shells, two Claudes", tiles: [{ kind: "shell" }, { kind: "shell" }, { kind: "claude" }, { kind: "claude" }], createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY, scope: "shared" },
  ];

  function outcomeFor(card) {
    if (!card) return { filesChanged: 0, verifyConfigured: true, isRecon: false, reconVerdictNegative: false };
    const r = card.builder && card.builder.review;
    return {
      reviewerVerdict: r && r.verdict ? r.verdict : null,
      reviewerCritique: r && r.excerpt ? r.excerpt : null,
      reviewerSource: r ? "challenger" : null, reviewerProvider: r ? r.provider : null, reviewerDegraded: false,
      filesChanged: card.id === "fx-failed" ? 0 : 7, verifyConfigured: true, isRecon: false, reconSummaryMd: null, reconVerdictNegative: false,
      shipBlockedReason: null, recoverySha: null, alreadyIn: null,
    };
  }
  function verifyStatusFor(card) {
    if (!card) return null;
    if (card.verifyStatus === "failed") return { verifyRunId: `verify-${NOW - HOUR}`, workspaceId: card.workspaceId, cardId: card.id, state: { kind: "failed", reason: "Tier 2 (cargo test) failed: 2 tests failed in kanban::tests" }, steps: card.verifyHistory[0].steps };
    if (card.verifyStatus === "passed") return { verifyRunId: `verify-${NOW - HOUR}`, workspaceId: card.workspaceId, cardId: card.id, state: { kind: "passed" }, steps: (card.verifyHistory[0] || { steps: [] }).steps };
    return null;
  }
  function reviewDiff(cardId) {
    return { cardId, baseBranch: "main", cardBranch: `atelier/card-${cardId}`, generatedAt: NOW, files: [
      { path: "src/lib/settingsSearch.ts", kind: "modified", hunks: [{ header: "@@ -40,7 +40,9 @@ export function searchSettings(", oldStart: 40, oldLines: 7, newStart: 40, newLines: 9, body: " const rows = index.rows;\n-  return rows.filter((r) => r.label.includes(q));\n+  return rows.filter(\n+    (r) => r.label.toLowerCase().includes(q) || (r.description ?? \"\").toLowerCase().includes(q),\n+  );\n }\n" }] },
      { path: "src/lib/settingsIndex.ts", kind: "modified", hunks: [{ header: "@@ -12,3 +12,4 @@", oldStart: 12, oldLines: 3, newStart: 12, newLines: 4, body: "   label: string;\n+  description?: string;\n   page: string;\n" }] },
    ] };
  }
  function searchHits(query, cwd) {
    const q = String(query || "");
    return [
      ["src/components/KanbanBoard.tsx", 212, `  const visible = cards.filter((c) => matches(c, "${q}"));`],
      ["src/lib/boardFilter.ts", 18, `export function matches(card: KanbanCard, q: string) { // ${q}`],
      ["docs/STATUS.md", 431, `- Board: ${q} filters by title and notes`],
      ["src/components/BoardList.tsx", 77, `      aria-label={\`${q} results\`}`],
    ].map(([p, n, line]) => ({ path: cwd + "/" + p, lineNumber: n, lineText: line, matchText: q, columnStart: Math.max(0, line.indexOf(q)), columnEnd: Math.max(0, line.indexOf(q)) + q.length }));
  }
  function historyHits(query) {
    const q = String(query || "");
    return [
      { kind: "card", workspaceId: D.plyId, artifactId: "fx-ready-to-ship", path: "kanban/workspaces/x.json", lineNumber: 1, lineText: `Settings: search matches row descriptions (${q})`, matchText: q },
      { kind: "runTranscript", workspaceId: D.plyId, artifactId: "run-3", path: "runs/run-3.log", lineNumber: 88, lineText: `> I'll update the ${q} index so descriptions are searched too.`, matchText: q },
      { kind: "intakeTranscript", workspaceId: D.plyId, artifactId: "faa81115", path: "intake/x.log", lineNumber: 12, lineText: `Should ${q} also match the page names?`, matchText: q },
      { kind: "snapshot", workspaceId: D.plyId, artifactId: "snap-2", path: "snapshots/2", lineNumber: 4, lineText: `M src/lib/${q}.ts`, matchText: q },
    ];
  }

  // Canned PTY output. Claude Code 2.1 idle REPL (prompt box + mode line) so
  // the tile's readiness matcher reads Ready; a zsh prompt for shells.
  const claudeScreen = () => [
    `${ESC}38;5;174m ▐▛███▜▌${ESC}0m   ${ESC}1mClaude Code${ESC}0m v2.1.232`,
    `${ESC}38;5;174m▝▜█████▛▘${ESC}0m  Opus 5 (1M context) · Claude Max`,
    `${ESC}38;5;174m  ▘▘ ▝▝${ESC}0m    ~/code/atelier`,
    "",
    `${ESC}2m> Read docs/STATUS.md and tell me what is pending for C11${ESC}0m`,
    "",
    "⏺ Pending for C11 (from docs/STATUS.md):",
    "  1. Tier 4 walk of the Settings search on the installed build",
    "  2. Contrast pass on void theme status dots",
    "  3. Board List view keyboard selection (Shift-click range)",
    "",
    "─".repeat(72),
    `❯ ${ESC}2mTry "how does the Inbox decide what needs me?"${ESC}0m`,
    "─".repeat(72),
    `  ${ESC}38;5;141m⏵⏵ auto mode on${ESC}0m ${ESC}2m(shift+tab to cycle)${ESC}0m`,
  ].join("\r\n");
  const shellScreen = (cwd) => [
    `${ESC}2mLast login: Thu Sep 24 09:12:44 on ttys004${ESC}0m`,
    `${ESC}32mmatteo@mbp${ESC}0m ${ESC}34m${(cwd || "~").replace(HOME, "~")}${ESC}0m ${ESC}33m(main)${ESC}0m % git status -sb`,
    "## main...origin/main [behind 2]",
    " M src/components/KanbanBoard.tsx",
    "?? notes/ux-audit.md",
    `${ESC}32mmatteo@mbp${ESC}0m ${ESC}34m${(cwd || "~").replace(HOME, "~")}${ESC}0m ${ESC}33m(main)${ESC}0m % npm run build`,
    "",
    "> ply@1.150.0 build",
    "> tsc && vite build",
    "",
    `${ESC}36mvite v6.3.5 ${ESC}32mbuilding for production...${ESC}0m`,
    `${ESC}32m✓${ESC}0m 2143 modules transformed.`,
    `dist/index.html                   0.62 kB │ gzip:   0.35 kB`,
    `dist/assets/index-CaTAzw0z.css  171.22 kB │ gzip:  27.90 kB`,
    `dist/assets/index-IqEL0Yz2.js  2,307.66 kB │ gzip: 640.12 kB`,
    `${ESC}32m✓ built in 4.13s${ESC}0m`,
    `${ESC}32mmatteo@mbp${ESC}0m ${ESC}34m${(cwd || "~").replace(HOME, "~")}${ESC}0m ${ESC}33m(main)${ESC}0m % `,
  ].join("\r\n");
  const codexScreen = () => [
    `${ESC}1m>_ OpenAI Codex${ESC}0m (v0.154.0)`,
    "",
    `${ESC}2mmodel:${ESC}0m gpt-5-codex high   ${ESC}2mdirectory:${ESC}0m ~/code/atelier`,
    "",
    "• Explored src/lib/attention.ts, src/lib/tileHeaderStatus.ts",
    "• The Ready chip needs two quiet seconds after the prompt matcher holds.",
    "",
    `› ${ESC}2mAsk Codex to do anything${ESC}0m`,
    "",
    `  ${ESC}2m? for shortcuts${ESC}0m                                  ${ESC}2m82% context left${ESC}0m`,
  ].join("\r\n");
  function cannedOutput(cmd, args, cwd) {
    const c = String(cmd || "");
    if (/claude/.test(c)) return claudeScreen();
    if (/codex/.test(c)) return codexScreen();
    if (/src-tauri$/.test(cwd || "")) return [
      `${ESC}32mmatteo@mbp${ESC}0m ${ESC}34m~/code/atelier/src-tauri${ESC}0m ${ESC}33m(main)${ESC}0m % cargo test --workspace --lib`,
      `${ESC}1;32m   Compiling${ESC}0m atelier v1.150.0 (${PLY_CWD}/src-tauri)`,
      `${ESC}1;36m    Building${ESC}0m [=======================> ] 611/618: atelier(test)`,
    ].join("\r\n");
    return shellScreen(cwd);
  }

  const builderCapture = claudeScreen();

  function discussionFixture() {
    const leg = (kind, provider, start) => ({ kind, provider, status: "completed", executable: provider === "claude" ? HOME + "/.local/bin/claude" : "/opt/homebrew/bin/codex", version: provider === "claude" ? "2.1.232" : "0.154.0", capability: provider === "claude" ? "harness-enforced" : "os-sandboxed", attemptCount: 1, promptDigest: "sha256:9f2c", artifact: null, exitCode: 0, timedOut: false, writeEscaped: false, endRevision: "3567c205", unavailable: null, attemptHistory: [], diagnostics: [], startedAt: start, endedAt: start + 6 * MIN });
    const t0 = NOW - 30 * HOUR;
    const part = (provider) => ({ provider, executable: provider, version: provider === "claude" ? "2.1.232" : "0.154.0", capability: provider === "claude" ? "harness-enforced" : "os-sandboxed" });
    return { currentRevision: "3567c205", stale: false, record: {
      schemaVersion: 1, id: "disc-inbox-landing", workspaceId: D.plyId, cardId: null,
      problem: "Should the Inbox be the landing page, or the Board? Weigh first-run clarity against daily use.",
      source: { project: { displayPath: PLY_CWD, comparisonKey: PLY_CWD }, displayPath: PLY_CWD, sourceRef: "main", baseRevision: "3567c205", pinnedRevision: "3567c205", dirtyPaths: ["src/components/KanbanBoard.tsx"], dirtyPathsTruncated: false },
      participants: { analysisA: part("claude"), analysisB: part("codex"), synthesizer: part("claude") },
      status: "completed", currentPhase: "completed", promptEnvelopeDigest: "sha256:77ab",
      legs: { analysisA: leg("analysis_a", "claude", t0), analysisB: leg("analysis_b", "codex", t0), crossReviewA: leg("cross_review_a", "claude", t0 + 7 * MIN), crossReviewB: leg("cross_review_b", "codex", t0 + 7 * MIN), synthesis: leg("synthesis", "claude", t0 + 14 * MIN) },
      ledgerReady: true,
      disagreementLedger: [
        { id: "D1", raisedBy: "analysis_b", statement: "The Board should stay the default for people with one workspace.", rationale: "The Inbox is mostly empty on a single-workspace Mac.", severity: "medium", evidenceRefs: ["src/store/uiStore.ts:effectiveCenterMode"], relatedIds: [] },
        { id: "D2", raisedBy: "analysis_a", statement: "An empty Inbox needs a next step, not only a sentence.", rationale: "First run lands on nothing to do.", severity: "low", evidenceRefs: ["src/components/InboxPanel.tsx"], relatedIds: ["D1"] },
      ],
      finalResult: { answer: "Keep the Inbox as the landing page, and let an empty Inbox offer the Board as its one action. People with one workspace can choose Board in Settings › Appearance › Open on.", agreements: ["The Inbox is the right place for cross-workspace attention.", "Open on must stay a per-Mac setting."], unresolvedQuestions: ["Should Open on follow the last mode used instead?"], disagreementResolutions: [{ disagreementId: "D1", disposition: "partially accepted", rationale: "Handled by the existing Open on setting rather than a new default." }, { disagreementId: "D2", disposition: "accepted", rationale: "The empty state gets one action." }] },
      startedAt: t0, updatedAt: t0 + 20 * MIN, endedAt: t0 + 20 * MIN,
    } };
  }

  // Minimal `codex app-server` JSON-RPC answers so a codex-chat tile reaches
  // "Codex ready" and can run one canned turn.
  function codexAppReply(sessionId, message, emit) {
    const send = (m) => emit("codex-app://message", { sessionId, processId: 4242, message: m });
    const later = (ms, m) => setTimeout(() => send(m), ms);
    if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex_app_server/0.154.0" } });
    if (message.method === "thread/start" || message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: "thr_" + sessionId.slice(-6) } } });
    if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn_1" } } });
      later(40, { method: "turn/started", params: { turn: { id: "turn_1" } } });
      later(80, { method: "item/started", params: { item: { id: "cmd_1", type: "commandExecution", command: "rg -n \"Pending\" docs/STATUS.md", commandActions: [{ type: "search" }] } } });
      later(120, { method: "item/commandExecution/outputDelta", params: { itemId: "cmd_1", delta: "431:## Pending for C11\n432:- Tier 4 walk of the Settings search\n433:- Contrast pass on void status dots\n" } });
      later(160, { method: "item/completed", params: { item: { id: "cmd_1", type: "commandExecution", status: "completed", exitCode: 0 } } });
      const text = "Three things are pending for C11: the Tier 4 walk of the Settings search on the installed build, a contrast pass on the void theme's status dots, and Shift-click range selection in the Board's List view.";
      later(220, { method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: text.slice(0, 60) } });
      later(260, { method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: text.slice(60) } });
      later(300, { method: "item/completed", params: { item: { id: "msg_1", type: "agentMessage", text } } });
      later(340, { method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } });
    }
  }

  // GH #260: the swarm behind fx-swarm — scout done, the builder running —
  // and its mailbox, so the card's swarm-run section has something to draw.
  const swarmCwd = PLY_CWD + "/.atelier-worktrees/fx-swarm";
  const swarms = [{
    schemaVersion: 1, id: "sw-fx-swarm", workspaceId: D.plyId, templateId: "feature",
    goal: "The Worktrees page names the card that holds each worktree, not only its branch.",
    status: "running", state: { kind: "pending_step", idx: 1, role: "builder", priorRunIds: ["run-fx-scout"] }, kind: "card",
    iteration: 0, roleBindings: { scout: "agent-scout", builder: "agent-builder", reviewer: "agent-reviewer" },
    runIds: ["run-fx-scout", "run-fx-builder"], startedAt: NOW - 42 * MIN, endedAt: null, endReason: null, cwd: swarmCwd, throttled: false,
  }];
  const summary = (runId, role, status, startedAt, endedAt, bytes, cost, files) =>
    ({ runId, role, status, startedAt, endedAt, exitCode: endedAt ? 0 : null, bytesWritten: bytes, model: "opus", totalCostUsd: cost, filesChangedCount: files });
  const swarmMailbox = {
    "sw-fx-swarm": [
      { id: "m1", ts: NOW - 42 * MIN, swarmId: "sw-fx-swarm", kind: "created", role: null, runId: null, body: null },
      { id: "m2", ts: NOW - 42 * MIN, swarmId: "sw-fx-swarm", kind: "dispatch", role: "scout", runId: "run-fx-scout", body: null },
      { id: "m3", ts: NOW - 31 * MIN, swarmId: "sw-fx-swarm", kind: "artifact", role: "scout", runId: "run-fx-scout",
        body: { text: "Worktrees are listed by branch in WorktreesPage.tsx; the card id is in the path. Add the card's title from the board store." } },
      { id: "m4", ts: NOW - 31 * MIN, swarmId: "sw-fx-swarm", kind: "report", role: "scout", runId: "run-fx-scout",
        runSummary: summary("run-fx-scout", "scout", "success", NOW - 42 * MIN, NOW - 31 * MIN, 48_213, 0.84, 0) },
      { id: "m5", ts: NOW - 30 * MIN, swarmId: "sw-fx-swarm", kind: "dispatch", role: "builder", runId: "run-fx-builder", body: null },
    ],
  };

  window.__HARNESS_SEED__ = Object.assign({}, D, {
    files, personalSkills, plySkills, projectSkillsView, libraryState, skillText, instructionsText, instructionsView, teamStatus,
    projectConfig, swarmTemplates, userTemplates, codexAppReply, outcomeFor, verifyStatusFor, reviewDiff, searchHits, historyHits, cannedOutput, builderCapture,
    blankCard: (ws, id) => Object.assign(JSON.parse(JSON.stringify(D.blankCardTemplate)), { id, workspaceId: ws }),
    discussions: [discussionFixture()], agentRuns: [], swarms, swarmMailbox,
    proposal: {
      target: { kind: "skill", name: "ply:verify-before-done", path: "src-tauri/resources/ply-skills/verify-before-done/SKILL.md" }, label: "verify-before-done", scope: "ply",
      path: "src-tauri/resources/ply-skills/verify-before-done/SKILL.md", cardId: "fx-changes", cardRef: "#212",
      reason: "The Builder reported done twice before running PPVP.", words: "Add one line: run ./scripts/ppvp.sh and quote its last line before saying done.", diff: null, createdAt: NOW - 3 * HOUR, canApprove: false,
    },
  });
})();
