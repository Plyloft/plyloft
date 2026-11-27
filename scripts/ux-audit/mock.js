// Browser-side mock of the Tauri backend for the Ply UX audit harness.
// Injected with page.evaluateOnNewDocument BEFORE the app loads. It installs
// `window.__TAURI_INTERNALS__` (invoke / transformCallback / runCallback /
// metadata) exactly like @tauri-apps/api/mocks does, answers every command the
// screens call from `window.__HARNESS_SEED__` (a snapshot of real Ply state +
// fixtures), keeps writes in memory (never disk), and records every call and
// every command it had no fixture for.
//
// `window.__harness` is the scenario-side handle: emit events, tweak flags,
// read the call log.
/* eslint-disable */
(function installPlyMock() {
  const SEED = window.__HARNESS_SEED__;
  const FLAGS = Object.assign({}, SEED.flags || {});
  const NOW = Date.now();
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  const HOME = SEED.home;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  // ---------------------------------------------------------------- state
  const state = {
    settings: clone(SEED.settings),
    workspaces: clone(SEED.workspaces),
    activeWorkspaceId: SEED.activeWorkspaceId,
    cards: clone(SEED.cards), // { [wsId]: KanbanCard[] }
    files: SEED.files, // { [absPath]: { dir: true, children: [...] } | { text } | { binary: true } | { tooLarge: true } }
    ptyCounter: 0,
    ptys: {}, // id -> {cmd, args, cwd}
    seen: {},
    calls: [],
    unhandled: {}, // cmd -> {count, args}
    defaulted: {},
    errors: [],
  };
  const wsById = (id) => state.workspaces.find((w) => w.id === id);
  const cwdOf = (id) => (wsById(id) || {}).cwd || SEED.plyCwd;
  const activeWs = () => wsById(state.activeWorkspaceId) || state.workspaces[0];
  const cardsOf = (ws) => (state.cards[ws] = state.cards[ws] || []);
  const findCard = (ws, id) => cardsOf(ws).find((c) => c.id === id) || Object.values(state.cards).flat().find((c) => c.id === id);

  // ---------------------------------------------------------------- tauri callbacks + events
  const callbacks = new Map();
  let cbSeq = 1;
  function registerCallback(callback, once = false) {
    const id = cbSeq++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return callback && callback(data);
    });
    return id;
  }
  function runCallback(id, data) {
    const cb = callbacks.get(id);
    if (cb) cb(data);
  }
  const listeners = new Map(); // event -> [handlerId]
  let eventSeq = 1;
  function emit(event, payload) {
    const ids = (listeners.get(event) || []).slice();
    for (const h of ids) runCallback(h, { event, id: eventSeq++, payload });
    return ids.length;
  }

  // ---------------------------------------------------------------- fixtures helpers
  const toolsReport = () => {
    const missingCodex = !!FLAGS.missingTool;
    const tool = (o) => Object.assign({
      id: "git", name: "Git", required: true, found: true, path: "/usr/bin/git", version: "2.50.1",
      versionOk: true, detail: "Version control", installCmd: "xcode-select --install",
      docsUrl: "https://git-scm.com/downloads", reviewer: null, auth: null,
    }, o);
    const reviewer = (provider, ok) => ({
      provider, installed: ok, executablePath: ok ? `/opt/homebrew/bin/${provider}` : null,
      version: ok ? (provider === "claude" ? "2.1.232" : "0.154.0") : null,
      level: ok ? (provider === "claude" ? "harness-enforced" : "os-sandboxed") : null,
      outcome: ok ? "passed" : null, eligible: ok, stale: false,
      proof: ok ? "Wrote nothing during a read-only review of a scratch repo." : "Not installed.",
      probedAt: NOW - 3 * DAY, probing: false,
    });
    return {
      tools: [
        tool({}),
        tool({ id: "claude", name: "Claude Code", path: HOME + "/.local/bin/claude", version: "2.1.232",
          detail: "Runs your Claude agents and swarms.", installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
          docsUrl: "https://docs.claude.com/en/docs/claude-code/setup", reviewer: reviewer("claude", true),
          auth: { signedIn: true, detail: "Signed in with a Claude Max subscription.", command: "claude auth status", action: "Check" } }),
        tool({ id: "codex", name: "Codex", required: !!FLAGS.missingTool, found: !missingCodex, path: missingCodex ? null : "/opt/homebrew/bin/codex",
          version: missingCodex ? null : "0.154.0", versionOk: !missingCodex, detail: "The Challenger and Codex tiles.",
          installCmd: "npm i -g @openai/codex", docsUrl: "https://github.com/openai/codex", reviewer: reviewer("codex", !missingCodex) }),
        tool({ id: "gh", name: "GitHub CLI", required: false, path: "/opt/homebrew/bin/gh", version: "2.74.0",
          detail: "GitHub-backed boards, PRs and claims.", installCmd: "brew install gh", docsUrl: "https://cli.github.com",
          auth: { signedIn: true, detail: "Signed in to github.com as test-owner (keychain).", command: "gh auth status", action: "Check" } }),
      ],
      teamSkills: null,
      projectSkills: {
        loaded: 4, claudeOnly: 1, codexOnly: 0, unloadable: 1, diverged: 1, gitignored: [], ignoredLinks: [],
        unanswered: [], gitDetails: [], workspace: activeWs().name,
        detail: "4 skills load in both CLIs. 1 is in .claude/skills only. 1 has no description. 1 differs between its two copies.",
      },
      microphone: { access: "granted", detail: "Plyloft may use the microphone.", settingsUrl: null },
      whisperModel: { model: "small", present: true, path: HOME + "/Library/Application Support/com.mbadv.ply/whisper/ggml-small.bin", detail: "Downloaded (466 MB)." },
      dictationShell: { shell: "/bin/zsh", label: "zsh", found: true, ok: true, detail: "zsh takes dictated text at its prompt." },
      sharedDefinition: { workspace: activeWs().name, state: "ok", summary: "from main", detail: ".atelier/workspace.json read from origin/main at 3567c20." },
      probeError: null,
      allRequiredOk: !missingCodex,
    };
  };
  const shellEnv = () => ({
    path: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + HOME + "/.local/bin",
    shell: "/bin/zsh", claudePath: HOME + "/.local/bin/claude", claudeVersion: "2.1.232",
    codexPath: FLAGS.missingTool ? null : "/opt/homebrew/bin/codex", codexVersion: FLAGS.missingTool ? null : "0.154.0",
    codexHealthy: !FLAGS.missingTool, gitPath: "/usr/bin/git", gitVersion: "2.50.1", ghPath: "/opt/homebrew/bin/gh",
    ghVersion: "2.74.0", supportsStreamJson: true, probeError: null,
  });

  function proof(events) {
    const kinds = ["review_needed","card_failed","verify_failed","skill_change_waiting","run_done","run_failed","pr_review","shipped","card_running","card_queued","run_running","schedule_upcoming"];
    const groups = ["needs_you","running","shipped","failed","scheduled"];
    const byKind = {}, byGroup = {};
    for (const k of kinds) byKind[k] = { total: 0, eligibleUnseen: 0 };
    for (const g of groups) byGroup[g] = { total: 0, eligibleUnseen: 0 };
    let unseen = 0;
    for (const e of events) {
      byKind[e.kind].total++; byGroup[e.group].total++;
      if (e.seenEligible && !e.seenAt) { byKind[e.kind].eligibleUnseen++; byGroup[e.group].eligibleUnseen++; unseen++; }
    }
    return { generatedAt: NOW, licensed: false, resolvedUserSha256: "a".repeat(64), totalRows: events.length,
      eligibleUnseenRows: unseen, byKind, byGroup, eligibleUnseenSetSha256: "b".repeat(64), targetPresent: true,
      admittedPrTargets: 1, successfulPrSources: 1, failedPrSources: 0, prSourcesComplete: true };
  }
  function inboxFeed() {
    const events = FLAGS.inboxEmpty ? [] : SEED.inbox.map((e) => Object.assign({}, e, { seenAt: state.seen[e.id] || e.seenAt }));
    return { generatedAt: NOW, windowDays: 28, events, costRollup: FLAGS.inboxEmpty ? [] : SEED.costRollup, eligibilityProof: proof(events) };
  }

  const PLY_CWD = SEED.plyCwd;
  const served = (p) => p === PLY_CWD || p.startsWith(PLY_CWD + "/");
  async function dirEntries(path) {
    if (served(path)) {
      const r = await fetch("/__ls?path=" + encodeURIComponent(path));
      if (!r.ok) {
        if (/\/skills\/[^/]+$/.test(path)) return [{ name: "SKILL.md", path: path + "/SKILL.md", isDir: false, size: 812 }];
        throw `No such file or directory (os error 2): ${path}`;
      }
      const list = await r.json();
      // overlay files that live in this dir
      for (const p of Object.keys(state.files)) {
        const i = p.lastIndexOf("/");
        if (p.slice(0, i) === path && !list.some((e) => e.path === p)) list.push({ name: p.slice(i + 1), path: p, isDir: false, size: state.files[p].size || 0 });
      }
      return list;
    }
    if (/\/skills\/[^/]+$/.test(path)) return [{ name: "SKILL.md", path: path + "/SKILL.md", isDir: false, size: 812 }];
    return [];
  }
  async function readText(path) {
    const n = state.files[path];
    if (n && n.binary) throw "binary file: " + path;
    if (n && n.tooLarge) throw "file too large: " + path + " is 7.4 MB (limit 5 MB)";
    if (n && typeof n.text === "string") return n.text;
    if (served(path)) {
      const r = await fetch("/__fs?path=" + encodeURIComponent(path));
      if (r.status === 415) throw "binary file: " + path;
      if (r.status === 413) throw "file too large: " + path;
      if (!r.ok) {
        if (/SKILL\.md$/.test(path)) return SEED.skillText(path.split("/").slice(-2, -1)[0]);
        throw `No such file or directory (os error 2): ${path}`;
      }
      return await r.text();
    }
    if (/SKILL\.md$/.test(path)) return SEED.skillText(path.split("/").slice(-2, -1)[0]);
    if (/(AGENTS|CLAUDE)\.md$/.test(path)) return SEED.instructionsText;
    throw `No such file or directory (os error 2): ${path}`;
  }

  function patchCard(ws, id, patch) {
    const c = findCard(ws, id);
    if (!c) throw `Card ${id} not found`;
    Object.assign(c, patch, { updatedAt: Date.now() });
    setTimeout(() => emit("kanban://changed", ws), 0);
    return clone(c);
  }

  // ---------------------------------------------------------------- the command table
  const H = {
    // --- env / doctor
    shell_env_info: shellEnv,
    shell_env_retry: shellEnv,
    dependency_doctor: toolsReport,
    program_folders_check: ({ value }) => ({
      windows: false, entries: [], problems: [], basicsMissing: [], systemFoldersMissing: [], missing: [],
      found: ["claude", "codex", "git", "gh"].map((name) => ({ name, path: HOME + "/.local/bin/" + name })),
      saveAs: value, useFolders: null, expanded: null, pathVariableFirst: false, withShell: null, needsConfirmation: false,
    }),
    reviewer_capability_probe: ({ provider }) => toolsReport().tools.find((t) => t.id === provider).reviewer,
    build_cache_status: () => ({ workspaceId: activeWs().id, workspaceName: activeWs().name, enabled: true,
      status: { path: activeWs().cwd + "/.atelier-worktrees/.cargo-target", bytes: 3_812_000_000, exists: true } }),
    build_cache_clear: () => 3_812_000_000,
    skill_root_ignore_plan: () => ({ roots: [], edits: [], refused: [] }),
    dictation_status: () => ({ whisperCli: "/opt/homebrew/bin/whisper-cli", models: [
      { id: "small", fileName: "ggml-small.bin", path: "/…/ggml-small.bin", present: true, sizeBytes: 487_601_967, approxBytes: 487_601_967, downloading: false },
      { id: "base", fileName: "ggml-base.bin", path: "/…/ggml-base.bin", present: false, sizeBytes: null, approxBytes: 147_951_465, downloading: false }] }),
    microphone_request_access: () => ({ access: "granted", detail: "Plyloft may use the microphone.", settingsUrl: null }),
    identity_get: () => "dev@example.com",
    // Launch A2: signed in, so the Sign-in screen is not over every page.
    account_get: () => ({ signedIn: true, login: "test-owner", sub: "1", plan: "team", teamRepo: null, teamRole: null, status: null, periodEnd: null, exp: 4102444800000, comp: true, entitlementValid: true, lastCheckedAt: Date.now(), offline: false, replacedBy: null, deviceName: "Audit Mac" }),
    account_dev_skip_sign_in: () => false,
    github_current_login: () => "test-owner",
    // Onboarding §11.1: the backend decides `teamAllowed`; teams are free in the beta.
    license_get: () => (FLAGS.noLicence ? { status: "none", team: null, seats: null, issuedAt: null, expiresAt: null, teamRepo: null, teamAllowed: true, freeDuringBeta: true }
      : { status: "valid", team: "MB ADV", seats: 3, issuedAt: NOW - 120 * DAY, expiresAt: NOW + 245 * DAY, teamRepo: null, teamAllowed: true, freeDuringBeta: true }),
    // QoL 1.168 H1: the plan gates the window reads (`plan_gates_get`). Without
    // them `teamAllowed` was false, so every GitHub Issues board (the Ply
    // workspace's) drew the read-only path and 036/039/040/061 caught nothing.
    plan_gates_get: () => (FLAGS.noLicence
      ? { plan: "free", entitlementValid: true, exp: null, proAllowed: false, cardSlotLimited: true, team: { state: "no_team_plan" }, teamAllowed: false, teamRefusal: "Sharing a Board through GitHub is part of the Team plan." }
      : { plan: "team", entitlementValid: true, exp: 4102444800000, proAllowed: true, cardSlotLimited: false, team: { state: "allowed" }, teamAllowed: true, teamRefusal: null }),
    // QoL 1.168 C7: the one list behind every "Ship N" (`ship.rs`'s metadata
    // rule, with no git: every such card has something to ship here).
    ship_pending_cards: () =>
      Object.entries(state.cards)
        .map(([workspaceId, cards]) => ({
          workspaceId,
          cardIds: cards
            .filter((c) => c.columnId === "complete" && !c.archived && (c.shipStatus ?? "unshipped") === "unshipped"
              && c.reviewStatus !== "merged" && c.reviewStatus !== "conflict_blocked" && !c.prReview
              && (c.verifyStatus === "passed" || c.verifyStatus === "skipped") && (c.worktreePath || !c.builder))
            .map((c) => c.id),
        }))
        .filter((w) => w.cardIds.length > 0),
    // QoL 1.168 H1: an index read, so All skills isn't "could not be read"
    // (empty: the seed has no skill folders to index).
    skills_hub_index: () => ({ index: { schemaVersion: 1, builtAt: NOW, workspaces: [], team: null, myLibrary: null, thisMac: null, plyloft: null }, refreshing: false, reading: [] }),
    skills_hub_index_refresh: () => null,
    quit_listening: () => null,
    quit_not_listening: () => null,
    onboarding_take_welcome: () => false,
    ripgrep_available: () => true,
    probe_localhost_ports: () => [5173, 4174],
    probe_ports: () => [],
    drain_status: () => ({ draining: !!FLAGS.draining, startedAt: FLAGS.draining ? NOW - 40_000 : null }),
    drain_start: () => null, drain_cancel: () => { FLAGS.draining = false; return null; },
    ship_pending_count: () => 3,
    ship_unverified_count: () => (FLAGS.unverified ? 2 : 0),
    notification_send_test: () => null,
    notification_access: () => "allowed",
    notification_request_access: () => "allowed",
    notification_open_settings: () => null,
    reveal_log_dir: () => null,

    // --- settings
    settings_get: () => clone(state.settings),
    settings_set: ({ settings }) => { state.settings = clone(settings); setTimeout(() => emit("settings://changed", clone(settings)), 0); return clone(settings); },
    settings_reset: ({ settings }) => { const before = clone(state.settings); state.settings = clone(settings); setTimeout(() => emit("settings://changed", clone(settings)), 0); return { before, saved: clone(settings) }; },

    // --- workspaces
    workspace_list: () => ({ workspaces: clone(state.workspaces), activeWorkspaceId: state.activeWorkspaceId }),
    workspace_cwd_exists: () => true,
    workspace_set_active: ({ id }) => { state.activeWorkspaceId = id; return null; },
    workspace_rename: ({ id, name }) => { wsById(id).name = name; return null; },
    workspace_set_files: ({ id, openFiles, activeFile }) => { const w = wsById(id); if (w) { w.openFiles = openFiles; w.activeFile = activeFile; } return null; },
    workspace_set_layout_preset: ({ id, preset }) => { const w = wsById(id); if (w) w.layoutPreset = preset; return null; },
    workspace_set_icon: ({ id, icon }) => { wsById(id).icon = icon; return null; },
    workspace_set_accent_color: ({ id, color }) => { wsById(id).accentColor = color; return null; },
    workspace_delete: ({ id }) => { state.workspaces = state.workspaces.filter((w) => w.id !== id); return null; },
    workspace_create: ({ name, cwd }) => { const w = { id: "ws-new-" + Date.now(), name: name || "new", cwd, createdAt: NOW, lastOpenedAt: NOW, openFiles: [], activeFile: null }; state.workspaces.push(w); return w; },
    workspace_set_kanban_sync_mode: () => 0,
    workspace_adoption_status: ({ workspaceId }) => ({ githubRepo: (wsById(workspaceId) || {}).githubOwnerRepo || null, hasDefinition: true, boardRepo: (wsById(workspaceId) || {}).githubOwnerRepo || null, action: { kind: "none" } }),
    workspace_definition_refresh: ({ workspaceId, moment }) => ({ workspaceId, moment, hasDefinition: true, source: "repo", branch: "main", author: "dev@example.com", commit: "3567c205", changes: [], unreadable: null, fetchError: null, pendingFields: [], pendingState: null, publish: null, readOnly: false, library: null }),
    workspace_definition_get: ({ workspaceId }) => definitionView(workspaceId),
    workspace_definition_save: ({ workspaceId, draft }) => { const v = definitionView(workspaceId); Object.assign(v.effective, draft); v.cache.pendingState = "pendingSync"; v.cache.pending = draft; return v; },
    workspace_definition_branches: () => ({ branches: ["main", "staging", "ux/next"], defaultBranch: "main", error: null, hasOrigin: true }),
    workspace_definition_publish: ({ workspaceId }) => definitionView(workspaceId),
    workspace_definition_open_pull_request: () => null,
    fs_watch_workspace: () => null, fs_unwatch_workspace: () => null,

    // --- files
    fs_list_dir: ({ path }) => dirEntries(path),
    fs_list_files_recursive: async ({ cwd }) => (served(cwd) ? await (await fetch("/__walk?path=" + encodeURIComponent(cwd))).json() : { paths: [], truncated: false }),
    fs_read_text_file: ({ path }) => readText(path),
    fs_write_text_file: ({ path, content }) => { state.files[path] = { text: content }; return null; },
    files_order_get: () => null, files_order_set: () => null, files_order_clear: () => null,
    fs_reveal_in_workspace: () => null,
    codeowners_check: () => ({ flagged: false, owners: [] }),
    search_start: ({ workspaceId, query }) => {
      setTimeout(() => {
        const hits = SEED.searchHits(query, cwdOf(workspaceId));
        for (const h of hits) emit("search://result", Object.assign({ workspaceId }, h));
        emit("search://done", { workspaceId, status: "completed", message: null, total: hits.length });
      }, 60);
      return null;
    },
    search_cancel: () => null,
    history_search_start: ({ query }) => {
      setTimeout(() => {
        const hits = SEED.historyHits(query);
        for (const h of hits) emit("history://result", h);
        emit("history://done", { status: "completed", message: null, total: hits.length });
      }, 60);
      return null;
    },
    history_search_cancel: () => null,

    // --- pty
    pty_spawn: ({ cmd, args, cwd }) => {
      const id = "pty-" + (++state.ptyCounter);
      state.ptys[id] = { cmd, args, cwd };
      const canned = SEED.cannedOutput(cmd, args || [], cwd);
      if (canned) setTimeout(() => emit("pty://data", { id, data: Array.from(new TextEncoder().encode(canned)) }), 700);
      if (window.__harness && window.__harness.onSpawn) window.__harness.onSpawn(id, cmd, args);
      return id;
    },
    pty_write: () => null,
    pty_resize: () => null,
    pty_kill: ({ id }) => { setTimeout(() => emit("pty://exit", { id, code: null }), 0); return null; },
    pty_prompt_idle: ({ id }) => !(window.__harness && window.__harness.busyPtys && window.__harness.busyPtys.has(id)),
    pty_prompt_state: ({ id }) => (window.__harness && window.__harness.busyPtys && window.__harness.busyPtys.has(id) ? "running" : "editing"),
    shell_integration_script: () => "",
    codex_app_start: () => 4242,
    codex_app_write: ({ sessionId, message }) => { SEED.codexAppReply && setTimeout(() => SEED.codexAppReply(sessionId, message, emit), 30); return null; },
    codex_app_stop: () => null,
    codex_approval_list: () => [],
    codex_approval_matches: () => false,

    // --- kanban
    // QoL 1.168 H1: an empty Inbox (`inbox/empty`) needs Boards with nothing
    // waiting either — the Inbox also lists what the loaded cards say (a ready
    // card, a draft), so only shipped cards are loaded then.
    kanban_load: ({ workspaceId }) =>
      clone(FLAGS.inboxEmpty ? cardsOf(workspaceId).filter((c) => c.shipStatus === "shipped") : cardsOf(workspaceId)),
    kanban_get_card: ({ workspaceId, cardId }) => clone(findCard(workspaceId, cardId)),
    kanban_card_patch: ({ workspaceId, cardId, patch }) => patchCard(workspaceId, cardId, patch),
    kanban_card_set_run_state: ({ workspaceId, cardId, patch }) => patchCard(workspaceId, cardId, patch),
    kanban_card_set_board_order: ({ workspaceId, cardId, boardOrder }) => patchCard(workspaceId, cardId, { boardOrder }),
    kanban_card_set_blocked_by: ({ workspaceId, cardId, blockedBy }) => patchCard(workspaceId, cardId, { blockedBy }),
    kanban_card_set_builder_vendor_pref: ({ workspaceId, cardId, vendor }) => patchCard(workspaceId, cardId, { builderVendorPref: vendor }),
    // SL-5: line comments on the review diff.
    card_line_comment_add: ({ workspaceId, cardId, draft }) => {
      const c = findCard(workspaceId, cardId);
      const now = Date.now();
      const lc = { ...draft, body: draft.body.trim(), id: `lc-${now}`, createdAt: now, updatedAt: now };
      return patchCard(workspaceId, cardId, { lineComments: [...(c?.lineComments ?? []), lc] });
    },
    card_line_comment_update: ({ workspaceId, cardId, commentId, body }) => {
      const c = findCard(workspaceId, cardId);
      const list = (c?.lineComments ?? []).map((x) => (x.id === commentId ? { ...x, body: body.trim(), updatedAt: Date.now() } : x));
      return patchCard(workspaceId, cardId, { lineComments: list });
    },
    card_line_comment_remove: ({ workspaceId, cardId, commentId }) => {
      const c = findCard(workspaceId, cardId);
      return patchCard(workspaceId, cardId, { lineComments: (c?.lineComments ?? []).filter((x) => x.id !== commentId) });
    },
    card_line_comments_mark_sent: ({ workspaceId, cardId, commentIds }) => {
      const c = findCard(workspaceId, cardId);
      const now = Date.now();
      const list = (c?.lineComments ?? []).map((x) => (!x.sentAt && commentIds.includes(x.id) ? { ...x, sentAt: now } : x));
      return patchCard(workspaceId, cardId, { lineComments: list });
    },
    kanban_card_add_later_request: ({ workspaceId, cardId, text, source }) => {
      const c = findCard(workspaceId, cardId);
      const now = Date.now();
      const r = { id: `lr-${now}`, text: text.trim(), at: now, source };
      return patchCard(workspaceId, cardId, { laterRequests: [...(c?.laterRequests ?? []), r].slice(-10) });
    },
    kanban_card_remove_later_request: ({ workspaceId, cardId, requestId }) => {
      const c = findCard(workspaceId, cardId);
      return patchCard(workspaceId, cardId, { laterRequests: (c?.laterRequests ?? []).filter((x) => x.id !== requestId) });
    },
    kanban_card_archive: ({ workspaceId, cardId }) => patchCard(workspaceId, cardId, { archived: true, archivedAt: Date.now() }),
    kanban_card_restore: ({ workspaceId, cardId }) => patchCard(workspaceId, cardId, { archived: false }),
    kanban_card_create: ({ workspaceId, cardId, title, notes, columnId }) => {
      const c = Object.assign(SEED.blankCard(workspaceId, cardId), { title, notes, columnId, createdAt: Date.now(), updatedAt: Date.now() });
      cardsOf(workspaceId).push(c); setTimeout(() => emit("kanban://changed", workspaceId), 0); return clone(c);
    },
    kanban_card_delete: ({ workspaceId, cardId }) => { state.cards[workspaceId] = cardsOf(workspaceId).filter((c) => c.id !== cardId); setTimeout(() => emit("kanban://changed", workspaceId), 0); return { worktreeRemoved: false, branchRemoved: false, keptPath: null, problem: null, keptInTrash: null, keptReason: null }; },
    kanban_card_delete_github: (a) => H.kanban_card_delete(a),
    kanban_card_worktree_state: ({ workspaceId, cardId }) => {
      const c = findCard(workspaceId, cardId) || {};
      return c.worktreePath
        ? { disposition: "ask", path: c.worktreePath, branch: c.branchName, dirtyFiles: 3, unpushedCommits: 2, liveSession: false, unreadable: false, busy: null, cardBranch: c.branchName, cardBranchCommits: 2 }
        : { disposition: "keep", path: null, branch: null, dirtyFiles: 0, unpushedCommits: 0, liveSession: false, unreadable: false, busy: null, cardBranch: null, cardBranchCommits: null };
    },
    kanban_card_claim_state: ({ workspaceId, cardId }) => ({ claimed: true, holder: { kind: "mine" }, card: clone(findCard(workspaceId, cardId)) }),
    kanban_card_claim: ({ workspaceId, cardId }) => ({ claimed: true, holder: { kind: "mine" }, card: patchCard(workspaceId, cardId, { ghAssignees: ["test-owner"] }) }),
    kanban_github_reconcile: () => ({ created: 0, patched: 2, missing: [], prunedWorktrees: 0, localBranch: { branch: "main", outcome: { kind: "upToDate" } } }),
    kanban_github_refresh: () => ({ created: 0, patched: 0, missing: [], prunedWorktrees: 0, trashFreedBytes: 0 }),
    kanban_github_push_local: () => ({ pushed: 0, failed: 0 }),
    kanban_card_use_issue_remainder: ({ workspaceId, cardId }) => clone(findCard(workspaceId, cardId)),
    kanban_clear_run_history: () => null,
    kanban_attachment_gc_card: () => null,
    kanban_swarm_gc_card: () => ({ deleted: [], refusedRunning: [], refusedOther: [] }),
    kanban_card_advance_to_in_progress: ({ workspaceId, cardId }) => patchCard(workspaceId, cardId, { columnId: "in_progress" }),
    card_overlap_check: () => [],
    card_outcome: ({ workspaceId, cardId }) => SEED.outcomeFor(findCard(workspaceId, cardId)),
    card_local_base_commits: () => null,
    card_review_tip: ({ workspaceId, cardId }) => { const c = findCard(workspaceId, cardId) || {}; const s = (c.builder && c.builder.snapshots) || []; return { branchTip: s.length ? s[s.length - 1].sha : null, commitsSinceReview: 0 }; },
    card_ship_preflight: () => ({ totalCount: 0, paths: [], truncated: false }),
    card_review_diff: ({ cardId }) => SEED.reviewDiff(cardId),
    card_compose_dispatch_prompt: ({ workspaceId, cardId }) => { const c = findCard(workspaceId, cardId) || {}; return (c.title || "") + "\n\n" + (c.notes || ""); },
    ship_audit: ({ workspaceId }) => ({ activeSwarms: [], activeIntakes: [], activeRunCount: 0, branch: "main", branchOk: true, currentVersion: "1.150.0", suggestedNextVersion: "1.151.0", shipInFlight: false, pendingRelease: null, pendingRecordUnreadable: null, pendingElsewhere: null }),
    ship_pending_release: () => ({ release: null, unreadable: null }),
    ship_pending_release_dismiss: () => null,
    ship_pending_release_undo: () => "",
    verify_status: ({ workspaceId, cardId }) => SEED.verifyStatusFor(findCard(workspaceId, cardId)),
    verify_list_inflight: () => [],
    verify_start: () => "verify-run-new",
    verify_reveal_log: () => null,
    builder_last_output_at: () => NOW - 2 * MIN,
    builder_read_capture: () => SEED.builderCapture,
    builder_trust_questions: () => [],
    intake_ended_cards: () => ({ ended: [], live: [] }),
    builder_self_check_message: () => null,
    intake_read_transcript: () => SEED.intakeTranscript,
    intake_start: ({ workspaceId, cardId, workspaceCwd }) => { const id = H.pty_spawn({ cmd: "claude", args: [], cwd: workspaceCwd }); patchCard(workspaceId, cardId, { intakeStatus: "active" }); return id; },
    intake_cancel: ({ workspaceId, cardId }) => { patchCard(workspaceId, cardId, { intakeStatus: "none" }); return null; },
    intake_conclude: () => null,
    builder_resume: ({ workspaceId, cardId }) => { const id = "pty-" + (++state.ptyCounter); state.ptys[id] = { cmd: "claude" }; const c = findCard(workspaceId, cardId); if (c && c.builder) c.builder.ptyId = id; return { ptyId: id, card: clone(c) }; },
    builder_start: ({ workspaceId, cardId, vendor, bypass }) => { const id = H.pty_spawn({ cmd: vendor || "claude", args: [], cwd: cwdOf(workspaceId) }); const c = findCard(workspaceId, cardId); c.builder = c.builder || { vendor, bypass, sessionLost: false, startedAt: Date.now(), snapshots: [], review: null }; c.builder.ptyId = id; c.lastRunStatus = "running"; c.columnId = "in_progress"; setTimeout(() => emit("kanban://changed", workspaceId), 0); return { ptyId: id, card: clone(c) }; },
    builder_close: () => null,
    builder_session_ended: () => null,
    intake_read_draft: () => null,
    reviewer_list: () => [],
    discussion_list: () => clone(SEED.discussions || []),
    worktree_list: ({ workspaceId }) => cardsOf(workspaceId).filter((c) => c.worktreePath).map((c) => ({ dirName: c.id, branchName: c.branchName, worktreePath: c.worktreePath, exists: true })),
    worktree_kept_list: () => [],
    snapshot_get_changes: () => null,

    // --- inbox / activity / coordination
    inbox_feed: inboxFeed,
    inbox_mark_seen: ({ eventIds }) => { for (const id of eventIds) state.seen[id] = Date.now(); return eventIds.length; },
    inbox_mark_all_seen: () => ({ proof: proof([]), markedCount: 0 }),
    activity_feed: () => clone(SEED.activity),
    coordination_status: ({ workspaceId }) => ({ trackingActive: true, state: "ok", workspaceId, activeSessions: [], liveWarnings: [], recentInterruptedCount: 0 }),
    coordination_handoff_recent: () => [],
    improvement_proposal_state: ({ workspaceId }) => (workspaceId === SEED.plyId && SEED.proposal ? clone(SEED.proposal) : null),

    // --- agents / swarms / templates
    agent_list: () => [],
    agent_run_list: () => clone(SEED.agentRuns || []),
    agent_run_get: ({ runId }) => (SEED.agentRuns || []).find((r) => r.id === runId) || null,
    // GH #260: fx-swarm's swarm and mailbox (seed-browser.js).
    swarm_list: ({ workspaceId } = {}) => clone((SEED.swarms || []).filter((x) => !workspaceId || x.workspaceId === workspaceId)),
    swarm_get: ({ swarmId }) => clone((SEED.swarms || []).find((x) => x.id === swarmId) || null),
    swarm_mailbox_read: ({ swarmId }) => clone((SEED.swarmMailbox || {})[swarmId] || []),
    swarm_card_slot_status: () => ({ runningCardSwarms: 0, suspendedCardSwarms: 0, cap: 3 }),
    swarm_templates_list: () => clone(SEED.swarmTemplates),
    swarm_templates_get: ({ id }) => clone(SEED.swarmTemplates.find((t) => t.id === id) || null),
    templates_list: () => clone(SEED.userTemplates),
    prompts_list: () => [],
    memory_list: () => [],
    memory_search: () => [],
    knowledge_list_project: () => [],
    knowledge_list_team: () => ({ configured: false, hasClone: false, reason: "No team key on this Mac.", canShare: false, entries: [] }),

    // --- library
    library_instructions_view: ({ workspaceId }) => SEED.instructionsView(workspaceId, cwdOf(workspaceId)),
    personal_instruction_read: () => SEED.instructionsText,
    personal_skills_view: () => clone(SEED.personalSkills),
    project_skills_view: ({ workspaceId }) => SEED.projectSkillsView(workspaceId, wsById(workspaceId) || activeWs()),
    ply_skills_view: () => clone(SEED.plySkills),
    knowledge_project_state: ({ workspaceId }) => SEED.libraryState(workspaceId, wsById(workspaceId) || activeWs()),
    skill_history: () => ({ gitRef: "main", author: "Matteo Braghetta", at: Math.floor((NOW - 12 * DAY) / 1000), commit: "a3f9c21" }),
    team_status: () => clone(SEED.teamStatus),
    // OB-4: Setup asks solo or team. The seed has GitHub Issues boards: team.
    team_work_mode: () => ({ mode: "team", chosen: false }),
    // OB-5: the AI step's sign-in reads and its offline check.
    setup_check: ({ actionId }) =>
      actionId === "status.codex"
        ? { signedIn: true, method: "chatgpt", plan: null, words: "Logged in using ChatGPT" }
        : { signedIn: true, method: "claude.ai", plan: "max", words: null },
    setup_reach: () => ({ reachable: true, proxy: false, details: null }),
    // 1.176.0: the Repair's reads — nothing to repair.
    cli_repair_plan: ({ tool, request }) => ({
      tool: tool || "claude",
      situations: [{ kind: "healthy" }],
      notes: [],
      steps: [],
      block: { kind: "nothingToRepair", healthyEnough: false },
      nextStep: null,
      manual: [],
      quick: !!(request && request.quick),
    }),
    cli_health: ({ tool }) => ({ tool: tool || "claude", healthy: true, runsToday: null, shouldRun: null, installDir: null, cached: null, copies: [], folders: [], findings: [], passedOver: null }),
    cli_repair_in_use: () => [],
    cli_repair_report: () => "",
    setup_last_run: () => null,
    setup_active: () => null,
    team_refresh: () => clone(SEED.teamStatus),
    // Launch T1–T3: the team's plan and seats (a paid team, two of five seats).
    team_billing_get: () => ({
      stage: { stage: "bound", teamRepo: (SEED.teamStatus && SEED.teamStatus.teamRepo) || "mb-adv/ply-team" },
      team: { teamRepo: (SEED.teamStatus && SEED.teamStatus.teamRepo) || "mb-adv/ply-team", owner: { sub: "1", login: "test-owner" }, seats: 5,
        assigned: [{ sub: "1", login: "test-owner" }, { sub: "2", login: "mb-member" }], status: "active", periodEnd: NOW + 20 * DAY },
      error: null,
    }),
    team_create_defaults: () => ({ login: "test-owner", workspaces: state.workspaces.filter((w) => w.githubOwnerRepo).map((w) => ({ repo: w.githubOwnerRepo, name: w.name })) }),

    // --- project config
    project_config_get: ({ workspaceId }) => clone(SEED.projectConfig(workspaceId)),
    project_config_list: () => state.workspaces.map((w) => [w.id, SEED.projectConfig(w.id)]),
    project_review_get: () => ({ selfCheck: true, reviewChecklist: [{ name: "IPC", sentence: "Every new invoke has a Rust command and a capability entry." }] }),
    project_config_detect: ({ workspaceId }) => ({ config: SEED.projectConfig(workspaceId), hasClaudeMd: true, notes: ["Found package.json version 1.150.0"] }),
    project_config_list_templates: () => [],

    // --- app plugins
    "plugin:app|version": () => "1.150.0",
    "plugin:app|name": () => "Ply",
    "plugin:app|tauri_version": () => "2.8.0",
    "plugin:log|log": () => null,
    "plugin:window|is_fullscreen": () => false,
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_focused": () => true,
    "plugin:window|scale_factor": () => 2,
    "plugin:window|inner_size": () => ({ width: innerWidth * 2, height: innerHeight * 2 }),
    "plugin:window|set_title": () => null,
    "plugin:window|set_badge_count": () => null,
    "plugin:window|set_badge_label": () => null,
    "plugin:window|theme": () => "light",
    "plugin:window|set_theme": () => null,
    "plugin:notification|is_permission_granted": () => true,
    "plugin:updater|check": () => (FLAGS.updateAvailable ? { rid: 77, available: true, currentVersion: "1.150.0", version: "1.151.0", date: "2026-09-24T09:00:00Z", body: "The Inbox groups sessions that wait for you; the Board remembers your filters.", rawJson: {} } : null),
    "plugin:updater|download_and_install": () => null,
    "plugin:resources|close": () => null,
    "plugin:dialog|open": () => null,
    "plugin:dialog|confirm": () => true,
    "plugin:dialog|ask": () => true,
    "plugin:dialog|message": () => null,
  };

  function definitionView(workspaceId) {
    const w = wsById(workspaceId) || activeWs();
    const def = { schemaVersion: 1, name: w.name, accentColor: w.accentColor || null, board: w.kanbanSyncMode || "local", githubOwnerRepo: w.githubOwnerRepo || null, integrationBranch: "main",
      versionFiles: [{ path: "package.json", kind: "package_json" }, { path: "src-tauri/Cargo.toml", kind: "cargo_toml" }, { path: "src-tauri/tauri.conf.json", kind: "tauri_conf_json" }],
      installScript: "scripts/install-local.sh", verifyPipeline: [{ kind: "script", path: "scripts/ppvp.sh" }], cachePaths: [], sharedBuildCache: true, selfCheck: true, reviewChecklist: [] };
    const draft = FLAGS.repoDraft;
    return {
      cache: { schemaVersion: 1, definition: clone(def), source: "repo", branch: "main", commit: "3567c205", author: "dev@example.com", changedAt: Math.floor((NOW - 2 * DAY) / 1000), refreshedAt: NOW - 5 * MIN, unreadable: null,
        pending: draft ? { installScript: "scripts/install.sh" } : {}, pendingState: draft ? "pendingSync" : null, writeAccess: { canPush: true, checkedAt: NOW - HOUR, pushRefused: null } },
      effective: Object.assign(clone(def), draft ? { installScript: "scripts/install.sh" } : {}),
      defaultBranch: "main",
      queue: { schemaVersion: 1, createDefinition: false, fields: draft ? { installScript: { value: "scripts/install.sh", base: "scripts/install-local.sh", baseCommit: "3567c205", queuedAt: NOW - 3 * MIN, attempts: 1, lastError: null, pullRequest: null } } : {}, lastError: null, createPullRequest: null, pullRequestBranch: null, supersededPullRequests: [] },
      readOnly: false,
      provenance: {},
    };
  }

  // Defaults for commands with no fixture: logged, typed by name.
  function defaultFor(cmd) {
    if (/_list$|_recent$|_inflight$|_overlaps$/.test(cmd)) return [];
    return null;
  }

  async function invoke(cmd, args) {
    args = args || {};
    if (cmd === "plugin:event|listen") {
      const arr = listeners.get(args.event) || [];
      arr.push(args.handler); listeners.set(args.event, arr);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") {
      const arr = listeners.get(args.event) || [];
      listeners.set(args.event, arr.filter((h) => h !== args.eventId));
      return null;
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") { emit(args.event, args.payload); return null; }
    const brief = {};
    for (const k of Object.keys(args)) { const v = args[k]; brief[k] = Array.isArray(v) && v.length > 20 ? `[${v.length} items]` : v; }
    state.calls.push({ cmd, t: Date.now() - NOW });
    if (state.calls.length > 5000) state.calls.splice(0, 1000);
    const override = window.__harness && window.__harness.overrides[cmd];
    const fn = override || H[cmd];
    if (!fn) {
      const u = state.unhandled[cmd] || (state.unhandled[cmd] = { count: 0, args: brief });
      u.count++;
      return defaultFor(cmd);
    }
    try {
      const r = await fn(args);
      return r === undefined ? null : r;
    } catch (e) {
      state.errors.push({ cmd, error: String(e) });
      throw e;
    }
  }

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      invoke,
      transformCallback: registerCallback,
      unregisterCallback: (id) => callbacks.delete(id),
      runCallback,
      callbacks,
      convertFileSrc: (p, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(p)}`,
    },
    configurable: true,
  });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener: (event, id) => callbacks.delete(id) },
    configurable: true,
  });
  window.__harness = {
    state, FLAGS, emit, H, overrides: {}, busyPtys: new Set(), silentNextSpawn: false,
    listenerCount: (ev) => (listeners.get(ev) || []).length,
    ptyData(id, text) { return emit("pty://data", { id, data: Array.from(new TextEncoder().encode(text)) }); },
    ptyExit(id, code) { return emit("pty://exit", { id, code }); },
    takeLog() { const out = { unhandled: state.unhandled, errors: state.errors }; state.unhandled = {}; state.errors = []; return out; },
  };
})();
