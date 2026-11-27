// Every screen/state the audit visits. Each scenario starts from a fresh page
// load (mocked backend, one theme, one viewport) and drives the real UI —
// clicks and keys where practical, the app's own store actions where a click
// path would only add noise (opening a given card, a given Settings page).
import { sleep } from "./lib.mjs";

export function makeCtx(page, env) {
  const ctx = {
    page, env,
    wait: sleep,
    /** Run fn(P, arg) in the page with the store handle. */
    app: (fn, arg) => page.evaluate(`(${fn.toString()})(window.__P(), ${JSON.stringify(arg ?? null)})`),
    async find(q, opts = {}) {
      const h = await page.evaluateHandle((q, o) => window.__find(q, o), q, opts);
      const el = h.asElement();
      return el;
    },
    async click(q, opts = {}) {
      const el = await ctx.find(q, opts);
      if (!el) throw new Error(`control not found: ${q}`);
      await el.click({ delay: 20 }).catch(async () => { await el.evaluate((e) => e.click()); });
      await sleep(opts.after ?? 350);
      return el;
    },
    async tryClick(q, opts = {}) {
      try { await ctx.click(q, opts); return true; } catch { return false; }
    },
    async hover(q, opts = {}) {
      const el = await ctx.find(q, opts);
      if (!el) throw new Error(`hover target not found: ${q}`);
      await el.hover();
      await sleep(300);
    },
    async openSwitcher() {
      if (env.width < 1000) await ctx.key("Meta+\\", 600); // below 1000px the sidebar is an overlay: open it first
      await ctx.clickSel(".shell-switcher-trigger", 500);
    },
    async sel(selector) { return page.$(selector); },
    async clickSel(selector, after = 350) {
      const el = await page.$(selector);
      if (!el) throw new Error(`selector not found: ${selector}`);
      await el.click();
      await sleep(after);
    },
    async key(combo, after = 350) {
      const parts = combo.split("+");
      const k = parts.pop();
      for (const m of parts) await page.keyboard.down(m);
      await page.keyboard.press(k);
      for (const m of parts.reverse()) await page.keyboard.up(m);
      await sleep(after);
    },
    async type(text, after = 400) { await page.keyboard.type(text, { delay: 15 }); await sleep(after); },
    async waitText(t, timeout = 4000) {
      await page.waitForFunction((t) => window.__hasText(t), { timeout }, t);
    },
    hasText: (t) => page.evaluate((t) => window.__hasText(t), t),
    async mode(m) {
      await ctx.app((P, m) => P.uiMod.openCenterMode(P.ws, m), m);
      await sleep(700);
    },
    async openCard(id, step) {
      await ctx.app((P, a) => { P.ui().selectCard(P.ws, a.id, true); if (a.step) P.ui().setCardStep(a.id, a.step); }, { id, step: step || null });
      await sleep(900);
    },
    async settings(section) {
      await ctx.app((P, s) => P.ui().openSettingsSection(s), section);
      await sleep(900);
    },
    async library(page, scope) {
      await ctx.app((P, a) => P.uiMod.openLibraryPage(P.ws, a.page, a.scope || undefined), { page, scope: scope || null });
      await sleep(900);
    },
    /** Scroll a card section (`data-ply-card-section`) to its start or end. */
    async section(name, block = "start") {
      const ok = await page.evaluate((a) => {
        const el = [...document.querySelectorAll(`[data-ply-card-section="${a.name}"]`)].find((e) => e.checkVisibility());
        if (!el) return false;
        el.scrollIntoView({ block: a.block });
        return true;
      }, { name, block });
      await sleep(400);
      return ok;
    },
    async scrollText(t) {
      await page.evaluate((t) => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (n.nodeValue.includes(t) && n.parentElement.checkVisibility()) { n.parentElement.scrollIntoView({ block: "center" }); return; }
      }, t);
      await sleep(300);
    },
    /** Tiles: a realistic grid — shell (output), Claude (idle at its prompt),
     *  a quiet shell (no output for 11m), an exited shell, Codex TUI, Codex chat. */
    async seedTiles({ quiet = true, exited = true, codex = true, claudeWaiting = false } = {}) {
      await ctx.mode("terminals");
      await ctx.app((P, o) => {
        const cwd = P.seed.plyCwd;
        const t = P.tiles();
        t.addShellTile(P.ws, cwd);
        t.addClaudeTile(P.ws, cwd);
        if (o.quiet) P.H.quietTile = t.addShellTile(P.ws, cwd + "/src-tauri").id;
        if (o.exited) P.H.exitTile = t.addShellTile(P.ws, cwd).id;
        if (o.codex) { t.addCodexTile(P.ws, cwd); t.addCodexChatTile(P.ws, cwd); }
      }, { quiet, exited, codex });
      await sleep(1500);
      await ctx.app((P, o) => {
        const st = P.tilesStore;
        const now = Date.now();
        const s = st.getState();
        const wsTiles = s.byWorkspace[P.ws].tiles;
        const patch = (id, fn) => st.setState((cur) => ({ byWorkspace: { ...cur.byWorkspace, [P.ws]: { ...cur.byWorkspace[P.ws], tiles: cur.byWorkspace[P.ws].tiles.map((x) => (x.id === id ? fn(x) : x)) } } }));
        const quiet = wsTiles.find((x) => x.id === P.H.quietTile);
        if (quiet) { if (quiet.ptyId) P.H.busyPtys.add(quiet.ptyId); patch(quiet.id, (x) => ({ ...x, startedAt: now - 11 * 60_000 - 5_000, lastOutputAt: now - 11 * 60_000, readiness: { lastOutputAt: now - 11 * 60_000, matcherIdle: false, leftReadyAt: now - 11 * 60_000 - 5_000 } })); }
        const ex = wsTiles.find((x) => x.id === P.H.exitTile);
        if (ex && ex.ptyId) P.H.ptyExit(ex.ptyId, 1);
        if (o.claudeWaiting) {
          const c = wsTiles.find((x) => x.kind === "claude");
          if (c) patch(c.id, (x) => ({ ...x, lastOutputAt: now - 45_000, promptBoxIdle: true }));
        }
      }, { claudeWaiting });
      await sleep(1200);
      if (codex) {
        const ok = await page.evaluate(() => {
          const ta = [...document.querySelectorAll("textarea[placeholder^='Ask Codex']")].find((t) => t.checkVisibility() && !t.disabled);
          if (!ta) return false;
          ta.focus();
          return true;
        });
        if (ok) { await page.keyboard.type("What is pending for C11?", { delay: 5 }); await page.keyboard.press("Enter"); await sleep(900); }
      }
    },
    /** A value from the seed (window.__HARNESS_SEED__): plyId, otherId, otherName, plyCwd, mergedCardId… */
    seed: (k) => page.evaluate((k) => window.__HARNESS_SEED__[k], k),
    async otherWorkspace() {
      const id = await ctx.seed("otherId");
      await ctx.app((P, id) => P.wsStore.getState().setActive(id), id);
      await sleep(900);
    },
    /** Give a Builder card a live session (a PTY id), as a running build has. */
    async liveBuilder(id) {
      await ctx.app((P, id) => {
        const card = P.H.state.cards[P.ws].find((x) => x.id === id);
        card.builder.ptyId = "pty-live-" + id;
        P.H.emit("kanban://changed", P.ws);
      }, id);
      await sleep(900);
    },
    /** Tick the List view's row checkbox for each card title. */
    async pickRows(titles) {
      return page.evaluate((titles) => {
        let n = 0;
        for (const t of titles) {
          const row = [...document.querySelectorAll("[role=row], tr")].find((r) => r.checkVisibility() && r.innerText.includes(t));
          const box = row && row.querySelector("input[type=checkbox], [role=checkbox]");
          if (box) { box.click(); n++; }
        }
        return n;
      }, titles);
    },
    info: (s) => ({ info: s }),
    unreachable: (why) => ({ unreachable: why }),
  };
  return ctx;
}

/** Other workspaces with something going on, for the sidebar's stack. */
async function seedOtherWorkspaces(c, { all = false } = {}) {
  await c.app((P, o) => {
    const now = Date.now();
    const byName = (n) => P.wsStore.getState().workspaces.find((w) => w.name === n || w.id === n);
    const tile = (id, ws, kind, label, quiet) => ({
      id, workspaceId: ws.id, kind, ptyId: null, label, cwd: ws.cwd, startedAt: now - 30 * 60_000, status: "running",
      pendingClose: false, expanded: false, lastOutputAt: now - quiet,
      readiness: { lastOutputAt: now - quiet, matcherIdle: quiet > 5_000, leftReadyAt: now - 20 * 60_000 },
    });
    const put = {};
    const add = (name, tiles) => { const ws = byName(name); if (ws) put[ws.id] = { tiles: tiles(ws), expandedTileId: null, detailTileId: null }; return ws; };
    add(P.seed.otherId, (ws) => [tile("fx-t-app-1", ws, "claude", "Onboarding copy", 400), tile("fx-t-app-2", ws, "shell", "npm run dev", 800)]);
    const docs = add("Ply docs site", (ws) => [tile("fx-t-docs-1", ws, "claude", "Search index rebuild", 90_000)]);
    const infra = add("Infra & deploy", (ws) => [tile("fx-t-infra-1", ws, "shell", "terraform plan", 600)]);
    add("Agency website", (ws) => [tile("fx-t-agency-1", ws, "codex", "Hero redesign", 300)]);
    if (o.all) {
      // Past the cap of five: Notes site and two more workspaces go active.
      const base = byName("Notes site") || byName(P.seed.otherId);
      const more = [["fx-ws-mobile", "Mobile app"], ["fx-ws-design", "Design system"]].map(([id, name], i) => ({ ...base, id, name, cwd: base.cwd + "-" + id, lastOpenedAt: now - (30 + i) * 86_400_000, accentColor: null, icon: null }));
      P.wsStore.setState((cur) => ({ workspaces: [...cur.workspaces, ...more] }));
      add("Notes site", (ws) => [tile("fx-t-notes-1", ws, "claude", "Tag pages", 120_000)]);
      add("Mobile app", (ws) => [tile("fx-t-mobile-1", ws, "shell", "xcodebuild", 700)]);
      add("Design system", (ws) => [tile("fx-t-design-1", ws, "claude", "Tokens audit", 500)]);
    }
    const tiles = P.tilesStore;
    tiles.setState((cur) => ({ byWorkspace: { ...cur.byWorkspace, ...put } }));
    const inbox = P.get("inboxStore").useInbox;
    const feed = inbox.getState().feed;
    if (feed && infra) {
      inbox.setState({ feed: { ...feed, events: [...feed.events, { id: "fx-run-failed-infra", kind: "run_failed", group: "failed", workspaceId: infra.id, workspaceName: infra.name, cardId: null, runId: "fx-run-infra", title: "Nightly backup check", detail: "The run failed", url: null, at: now - 20 * 60_000, seenAt: null, seenEligible: true }] } });
    }
    if (docs) P.ui().toggleStackExpanded(docs.id, true);
  }, { all });
  // The other workspaces' grids are warm, so their tiles spawn (mocked) PTYs
  // and print; then settle each tile into its state: the "quiet" ones have
  // waited a while at their prompt, the rest are busy.
  await c.wait(1500);
  await c.app((P) => {
    const now = Date.now();
    const st = P.tilesStore;
    st.setState((cur) => {
      const byWorkspace = { ...cur.byWorkspace };
      for (const [id, w] of Object.entries(byWorkspace)) {
        if (!w.tiles.some((t) => t.id.startsWith("fx-t-"))) continue;
        byWorkspace[id] = { ...w, tiles: w.tiles.map((t) => {
          if (!t.id.startsWith("fx-t-")) return t;
          const quiet = t.id === "fx-t-docs-1" || t.id === "fx-t-notes-1";
          if (quiet) return { ...t, lastOutputAt: now - 90_000, promptBoxIdle: true, readiness: { lastOutputAt: now - 90_000, matcherIdle: true, leftReadyAt: now - 20 * 60_000 } };
          if (t.ptyId) P.H.busyPtys.add(t.ptyId);
          return { ...t, lastOutputAt: now, readiness: { lastOutputAt: now, matcherIdle: false, leftReadyAt: now - 20 * 60_000 } };
        }) };
      }
      return { byWorkspace };
    });
  });
  await c.wait(600);
}

let nn = 0;
const S = (area, state, run, extra = {}) => ({ nn: String(++nn).padStart(3, "0"), id: `${area}-${state}`, area, state, run, ...extra });

/** OB-4: open Setup over the app as `setupCase`, on the path `level`. */
async function openSetup(c, setupCase, level) {
  await c.app((P, a) => {
    const s = P.settings.getState();
    P.settings.setState({ settings: { ...s.settings, onboarding: { ...s.settings.onboarding, level: a.level, currentStep: null } } });
    P.get("setupStore").useSetup.getState().openSetup(a.setupCase);
  }, { setupCase, level });
  await c.wait(1200);
}

export const SCENARIOS = [
  // ───────────── Setup (OB-4): drawn over the shell
  S("setup", "existing-user-guided", async (c) => { await openSetup(c, "existing", "guided"); }, { tabWalk: 20 }),
  S("setup", "checklist-fast", async (c) => { await openSetup(c, "rerun", "fast"); }, { sizes: [900, 1280] }),
  // ───────────── Shell
  S("shell", "sidebar-default", async (c) => { await c.mode("board"); }, { tabWalk: 25 }),
  S("shell", "sidebar-collapsed", async (c) => { await c.mode("board"); await c.key("Meta+\\"); }, { sizes: [1280, 1600] }),
  S("shell", "sidebar-overlay-open", async (c) => { await c.mode("board"); await c.key("Meta+\\"); }, { sizes: [900] }),
  S("shell", "sidebar-toggle-overlay-closed", async (c) => { await c.mode("board"); await c.page.focus(".shell-sidebar-toggle").catch(() => {}); await c.key("Shift+Tab", 100); await c.key("Tab", 400); }, { sizes: [900], tabWalk: 8 }),
  S("shell", "sidebar-toggle-hidden-signal", async (c) => { await c.mode("board"); await c.key("Meta+\\"); await c.page.hover(".shell-sidebar-toggle").catch(() => {}); await c.wait(400); }, { sizes: [1280] }),
  // The stack of other workspaces: sessions working, waiting and failed in
  // four other workspaces (synthetic tiles and one feed row put straight into
  // the stores — nothing is spawned), one row expanded; Notes site stays idle
  // behind "1 more workspace".
  S("shell", "sidebar-other-workspaces", async (c) => { await c.mode("board"); await seedOtherWorkspaces(c); if (c.env.width < 1000) await c.key("Meta+\\", 600); }, { sizes: [900, 1280], tabWalk: 30, fixture: "tiles in Sample app, Ply docs site, Infra & deploy and Agency website; a failed run in Infra & deploy" }),
  S("shell", "sidebar-other-workspaces-capped", async (c) => { await c.mode("board"); await seedOtherWorkspaces(c, { all: true }); if (c.env.width < 1000) await c.key("Meta+\\", 600); }, { sizes: [1280], fixture: "six active other workspaces: five shown, then '1 more active'" }),
  S("shell", "switcher-open", async (c) => { await c.openSwitcher(); }),
  S("shell", "switcher-search", async (c) => { await c.openSwitcher(); await c.type("cl"); }),
  S("shell", "switcher-more-menu", async (c) => { await c.openSwitcher(); await c.click("More for " + await c.seed("otherName")); }),
  S("shell", "switcher-icon-colour", async (c) => { await c.openSwitcher(); await c.click("More for " + await c.seed("otherName")); await c.click("Icon and colour", { after: 600 }); }),
  S("shell", "status-update-available", async (c) => { await c.mode("board"); await c.wait(600); await c.click("Later", { exact: true, after: 600 }); }, { flags: { updateAvailable: true } }),
  S("shell", "status-missing-tool", async (c) => { await c.mode("board"); await c.wait(800); }, { flags: { missingTool: true } }),
  S("shell", "status-draining", async (c) => { await c.mode("board"); await c.wait(800); }, { flags: { draining: true, unverified: true } }),
  S("shell", "palette-commands", async (c) => { await c.mode("board"); await c.key("Meta+k"); await c.type("ship"); }, { tabWalk: 12 }),
  S("shell", "palette-commands-empty-query", async (c) => { await c.mode("board"); await c.key("Meta+k"); }),
  S("shell", "palette-files", async (c) => { await c.mode("board"); await c.key("Meta+p", 900); await c.type("kanban", 900); }),
  S("shell", "palette-in-files", async (c) => { await c.mode("board"); await c.key("Meta+Shift+f"); await c.type("boardOrder", 1200); }),
  S("shell", "palette-history", async (c) => { await c.mode("board"); await c.key("Meta+Shift+h"); await c.type("search", 1200); }),
  S("shell", "palette-no-results", async (c) => { await c.mode("board"); await c.key("Meta+k"); await c.type("zzqxv"); }),
  S("shell", "shortcuts-sheet", async (c) => { await c.mode("board"); await c.key("Meta+/"); }, { tabWalk: 10 }),

  // ───────────── Inbox / History
  S("inbox", "items", async (c) => { await c.mode("inbox"); }, { tabWalk: true }),
  S("inbox", "empty", async (c) => { await c.mode("inbox"); }, { flags: { inboxEmpty: true } }),
  S("inbox", "waiting-claude-session", async (c) => { await c.seedTiles({ quiet: false, exited: false, codex: false, claudeWaiting: true }); await c.mode("inbox"); await c.wait(1500); }),
  S("inbox", "row-hover", async (c) => { await c.mode("inbox"); await c.hover("Settings: search matches row descriptions, not only labels", { sel: "*" }); }),
  S("history", "page", async (c) => { await c.mode("activity"); }, { tabWalk: 20 }),
  S("history", "scrolled", async (c) => { await c.mode("activity"); await c.scrollText("Trashed 4 merged worktrees"); }),

  // ───────────── Board
  S("board", "columns", async (c) => { await c.mode("board"); }, { tabWalk: true }),
  S("board", "filters-open", async (c) => { await c.mode("board"); await c.click("Filter the cards"); }),
  S("board", "search-active", async (c) => { await c.mode("board"); await c.clickSel(".board-search input"); await c.type("settings", 700); }),
  S("board", "search-no-match", async (c) => { await c.mode("board"); await c.clickSel(".board-search input"); await c.type("qqqzz", 700); }),
  S("board", "list-view", async (c) => { await c.mode("board"); await c.click("List"); }, { tabWalk: 20 }),
  S("board", "list-selection", async (c) => {
    await c.mode("board"); await c.click("List");
    const boxes = await c.page.$$(".board-list input[type=checkbox], [role=row] input[type=checkbox], .board-list [role=checkbox]");
    if (boxes.length < 3) return c.unreachable("no row checkboxes found in the List view");
    await boxes[1].click(); await c.wait(150); await boxes[2].click(); await c.wait(150); if (boxes[5]) await boxes[5].click();
  }),
  S("board", "new-card-field", async (c) => { await c.mode("board"); await c.click("New card"); await c.type("Add a Sort menu to the List view", 300); }),
  S("board", "more-menu", async (c) => { await c.mode("board"); await c.click("More for the Board"); }),
  S("board", "done-show-all", async (c) => { await c.mode("board"); await c.scrollText("Show all"); await c.click("Show all", { after: 600 }); }),
  S("board", "blocked-card-hover", async (c) => { await c.mode("board"); await c.hover("Ship batch: remember the last release kind", { sel: "*", exact: false }); }),
  S("board", "drag-refused-toast", async (c) => {
    await c.mode("board");
    const res = await c.page.evaluate(() => {
      const card = [...document.querySelectorAll("[draggable=true]")].find((e) => e.innerText.includes("Ship batch: remember the last release kind"));
      const col = [...document.querySelectorAll("[data-board-column]")].find((e) => e.checkVisibility() && /^Working/.test(e.innerText.trim()));
      const target = col && (col.querySelector(".board-column-body") || col);
      if (!card || !target) return "no draggable card / Working column";
      const dt = new DataTransfer();
      const r = target.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
      card.dispatchEvent(new DragEvent("dragstart", opts(10, 10)));
      target.dispatchEvent(new DragEvent("dragenter", opts(r.left + 20, r.top + 60)));
      target.dispatchEvent(new DragEvent("dragover", opts(r.left + 20, r.top + 60)));
      target.dispatchEvent(new DragEvent("drop", opts(r.left + 20, r.top + 60)));
      card.dispatchEvent(new DragEvent("dragend", opts(r.left + 20, r.top + 60)));
      return null;
    });
    await c.wait(700);
    if (res) return c.unreachable(res);
    const toast = await c.page.$(".toast, [role=status] .toast, .ux-toast");
    if (!toast) return c.info("synthetic HTML5 drop dispatched; no toast element matched — see screenshot");
  }),
  S("board", "read-only-no-licence", async (c) => { await c.mode("board"); }, { flags: { noLicence: true } }),
  S("board", "empty-workspace", async (c) => { await c.app((P) => P.wsStore.getState().setActive("fx-ws-infra")); await c.wait(900); await c.mode("board"); }),
  S("board", "other-workspace-lyra", async (c) => { await c.otherWorkspace(); await c.mode("board"); }),

  // ───────────── Card page
  S("card", "draft", async (c) => { await c.openCard("fx-draft"); }, { tabWalk: true, fixture: "fx-draft" }),
  S("card", "planning-intake-live", async (c) => { await c.openCard("fx-draft"); await c.click("Plan it with Claude", { after: 1800 }); }, { fixture: "fx-draft" }),
  S("card", "planning-conversation-open", async (c) => { await c.openCard("fx-draft"); await c.click("Plan it with Claude", { after: 1500 }); await c.click("Open the conversation", { after: 1800 }); await c.scrollText("Conversation with Claude"); }, { fixture: "fx-draft" }),
  S("card", "ready", async (c) => { await c.openCard("fx-ready"); }, { fixture: "fx-ready" }),
  S("card", "ready-with-plan", async (c) => { await c.openCard("fx-planned"); }, { fixture: "fx-planned" }),
  S("card", "running-session-closed", async (c) => { await c.openCard("fx-running"); }, { fixture: "fx-running" }),
  S("card", "running-session-open", async (c) => { await c.openCard("fx-running"); await c.click("Resume", { exact: true, after: 2000 }); await c.scrollText("Claude session"); }, { fixture: "fx-running" }),
  S("card", "running-session-closed-panel", async (c) => { await c.openCard("fx-running"); if (!(await c.tryClick("Open session", { after: 900 }))) return c.info("session-closed: the Now callout offers Resume only (no Open session) — page as is"); }, { fixture: "fx-running" }),
  S("card", "running-live", async (c) => { await c.liveBuilder("fx-running"); await c.openCard("fx-running"); }, { fixture: "fx-running with a live Builder PTY attached in-scenario" }),
  S("card", "running-live-session-open", async (c) => { await c.liveBuilder("fx-running"); await c.openCard("fx-running"); await c.click("Open session", { after: 1200 }); }, { fixture: "fx-running with a live Builder PTY attached in-scenario" }),
  S("card", "closed", async (c) => { await c.openCard("fx-closed"); }, { tabWalk: 12, fixture: "fx-closed" }),
  S("card", "merged-pr", async (c) => { await c.openCard("fx-merged"); }, { fixture: "fx-merged" }),
  S("card", "challenger-reviewing", async (c) => { await c.openCard("fx-reviewing"); }, { fixture: "fx-reviewing" }),
  S("card", "changes-requested", async (c) => { await c.openCard("fx-changes"); }, { fixture: "fx-changes" }),
  S("card", "checks-failed", async (c) => { await c.openCard("fx-checks-failed"); }, { fixture: "fx-checks-failed" }),
  S("card", "run-failed", async (c) => { await c.openCard("fx-failed"); }, { fixture: "fx-failed" }),
  S("card", "ready-to-ship", async (c) => { await c.openCard("fx-ready-to-ship"); }, { tabWalk: true, fixture: "fx-ready-to-ship" }),
  // SP-1 phase 2: the result and its diff open together (beside each other on a wide page).
  S("card", "result-diff-open", async (c) => { await c.openCard("fx-ready-to-ship"); await c.app((P) => P.ui().openCardDiff("fx-ready-to-ship")); await c.wait(900); }, { fixture: "fx-ready-to-ship" }),
  S("card", "shipped", async (c) => { await c.openCard("fx-shipped"); }, { fixture: "fx-shipped" }),
  S("card", "shipped-real-merged", async (c) => { const id = await c.seed("mergedCardId"); if (!id) return c.unreachable("no merged card in the seed"); await c.openCard(id); }),
  S("card", "archived", async (c) => { await c.openCard("fx-archived"); }, { fixture: "fx-archived" }),
  S("card", "blocked", async (c) => { await c.openCard("fx-blocked"); }, { fixture: "fx-blocked" }),
  S("card", "more-menu", async (c) => { await c.openCard("fx-ready-to-ship"); await c.click("More for this card"); }),
  S("card", "ship-it-menu", async (c) => {
    await c.openCard("fx-ready-to-ship");
    const ok = await c.tryClick("More ways to ship") || await c.tryClick("Other ways to ship") || await c.page.evaluate(() => { const b = [...document.querySelectorAll(".ux-split button[aria-haspopup=menu], [aria-haspopup=menu]")].find((e) => e.closest(".card-state-header, .ux-card-state, [aria-label=Now]")); if (b) { b.click(); return true; } return false; });
    if (!ok) return c.unreachable("Ship it ▾ trigger not found");
    await c.wait(400);
  }),
  S("card", "release-flow", async (c) => { await c.openCard("fx-ready-to-ship"); await c.click("More for this card"); await c.click("Release…", { after: 1200 }); }, { tabWalk: 15 }),
  S("card", "blocked-by-picker", async (c) => {
    await c.openCard("fx-ready");
    const ok = await c.page.evaluate(() => { const b = [...document.querySelectorAll("button[aria-haspopup=dialog]")].find((e) => e.innerText.trim() === "Add" && e.checkVisibility()); if (b) { b.click(); return true; } return false; });
    if (!ok) return c.unreachable("Blocked by › Add control not found");
    await c.wait(500);
  }),
  S("card", "technical-details-open", async (c) => { await c.openCard("fx-running"); await c.click("Technical details", { after: 500 }); await c.scrollText("Branch"); }),
  S("card", "error-block", async (c) => {
    await c.openCard("fx-ready-to-ship");
    await c.app((P) => { P.H.overrides.card_ship = () => { throw "git merge failed: CONFLICT (content): Merge conflict in src/lib/settingsSearch.ts\nAutomatic merge failed; fix conflicts and then commit the result."; }; P.H.overrides.card_review_merge = P.H.overrides.card_ship; });
    await c.click("Ship it", { exact: true, after: 1500 });
  }),
  S("card", "long-title-lyra", async (c) => { await c.otherWorkspace(); const id = await c.app((P) => P.kanban().byWorkspace[P.ws].cards.find((x) => x.columnId === "in_progress").id); await c.openCard(id); }),

  // ───────────── Terminals
  S("terminals", "empty", async (c) => { await c.mode("terminals"); }),
  S("terminals", "grid", async (c) => { await c.seedTiles(); }, { tabWalk: true, settle: 1200 }),
  S("terminals", "new-menu", async (c) => { await c.seedTiles(); await c.click("New"); }),
  S("terminals", "more-menu", async (c) => { await c.seedTiles(); await c.click("More for Terminals"); }),
  S("terminals", "tile-expanded", async (c) => { await c.seedTiles(); await c.app((P) => { const t = P.tiles().byWorkspace[P.ws].tiles.find((x) => x.kind === "claude"); P.tiles().setExpanded(P.ws, t.id); }); await c.wait(900); }),
  S("terminals", "tile-header-hover", async (c) => { await c.seedTiles(); const h = await c.page.$$(".tile-header, .tile .tile-head, [data-tile-id] header"); if (!h.length) return c.unreachable("no tile header element found"); await h[0].hover(); await c.wait(400); }),
  S("terminals", "layout-template-modal", async (c) => { await c.mode("terminals"); if (!(await c.tryClick("Several sessions at once…", { after: 700 }))) { await c.click("New"); await c.click("Several sessions at once…", { after: 700 }); } }),
  S("terminals", "empty-tabwalk", async (c) => { await c.mode("terminals"); }, { tabWalk: 10, sizes: [1280] }),
  S("terminals", "close-live-tile-confirm", async (c) => { await c.seedTiles({ quiet: false, exited: false, codex: false }); const b = await c.page.$$("button[aria-label='Close tile']"); if (!b.length) return c.unreachable("no Close tile button");
    // QoL 1.168 H1: the button shows only on hover (`tile-on-hover`), so a
    // pointer click at its place missed; the DOM click is the button's own.
    await b[b.length - 1].evaluate((e) => e.click()); await c.wait(700);
    if (!(await c.hasText("Stop and close"))) return c.unreachable("the live tile closed without asking"); }, { tabWalk: 6 }),

  // ───────────── Code
  S("code", "empty", async (c) => {
    await c.app((P) => { const w = P.wsStore.getState(); const ws = w.workspaces.find((x) => x.id === P.ws); P.wsStore.setState({ workspaces: w.workspaces.map((x) => (x.id === P.ws ? { ...x, openFiles: [], activeFile: null } : x)) }); const e = P.get("editorStore").useEditor.getState(); if (e.closeAll) e.closeAll(P.ws); });
    await c.mode("code");
    let n = 0; while (n++ < 6 && (await c.tryClick("Close vite.config.ts") || await c.tryClick("Close", { exact: true }))) {}
    await c.key("Meta+w", 500);
  }),
  S("code", "text-file", async (c) => { await c.mode("code"); await c.click("src"); await c.click("components", { after: 600 }); await c.click("KanbanBoard.tsx", { after: 1200 }); }, { tabWalk: 20 }),
  S("code", "binary-file", async (c) => { await c.mode("code"); await c.click("public", { after: 600 }); await c.click("ply-favicon-32.png", { after: 1200 }); }),
  S("code", "too-large-file", async (c) => { await c.mode("code"); await c.click("fixtures", { after: 600 }); await c.click("ship-audit-export.json", { after: 1200 }); }),
  // GH #268: the header's Preview is the Markdown preview; your running app is in the ⋯ (1.174.0 E10).
  S("code", "header-preview-pane", async (c) => { await c.mode("code"); await c.click("README.md", { after: 1200 }); await c.click("More for Code"); await c.click("Show your running app", { after: 900 }); }),
  S("code", "markdown-preview", async (c) => { await c.mode("code"); await c.click("README.md", { after: 1200 }); await c.click("Preview", { exact: true, after: 1200 }); }, { tabWalk: 12 }),
  S("code", "markdown-file", async (c) => { await c.mode("code"); await c.click("README.md", { after: 1200 }); }),
  S("code", "deep-breadcrumb", async (c) => { await c.mode("code"); await c.click("src-tauri", { after: 500 }); await c.click("resources", { after: 500 }); await c.click("ply-skills", { after: 500 }); await c.click("verify-before-done", { after: 500 }); await c.click("SKILL.md", { after: 1200 }); }),

  // ───────────── Library
  S("library", "instructions", async (c) => { await c.library("instructions"); }, { tabWalk: 20 }),
  S("library", "instructions-setup-needed", async (c) => { await c.otherWorkspace(); await c.library("instructions"); }),
  S("library", "skills-all", async (c) => { await c.library("skills", "all"); }, { tabWalk: 20 }),
  S("library", "skills-repository", async (c) => { await c.library("skills", "repository"); }),
  S("library", "skills-this-mac", async (c) => { await c.library("skills", "this-mac"); }),
  S("library", "skills-ply", async (c) => { await c.library("skills", "ply"); }),
  S("library", "skills-filtered", async (c) => { await c.library("skills", "all"); await c.clickSel("input[placeholder^='Filter']"); await c.type("valid"); }),
  S("library", "skill-detail", async (c) => { await c.library("skills", "all"); await c.click("ds-refresh", { after: 1000 }); }),
  S("library", "skill-detail-ply", async (c) => { await c.library("skills", "ply"); await c.click("Card brief", { after: 1000 }); }),
  S("library", "skill-compare-duplicate", async (c) => { await c.library("skills", "all"); await c.click("Compare", { after: 1200 }); }),

  // ───────────── Settings
  ...["appearance", "editor-terminals", "claude-codex", "dictation", "general", "build-release", "board-worktrees", "team-workspaces", "plan", "profile-licence", "diagnostics"].map((id) =>
    S("settings", id, async (c) => { await c.settings(id); }, { tabWalk: id === "appearance" || id === "diagnostics" ? 25 : false })),
  S("settings", "search-results", async (c) => { await c.settings("appearance"); await c.clickSel("input[placeholder='Search settings']"); await c.type("scroll", 700); }),
  S("settings", "search-no-results", async (c) => { await c.settings("appearance"); await c.clickSel("input[placeholder='Search settings']"); await c.type("qwxzv", 700); }),
  S("settings", "general-pending-publish", async (c) => { await c.settings("general"); }, { flags: { repoDraft: true } }),
  S("settings", "diagnostics-danger-zone", async (c) => { await c.settings("diagnostics"); await c.scrollText("Reset"); }),
  S("settings", "reset-confirm-sheet", async (c) => { await c.settings("diagnostics"); await c.scrollText("Reset"); const ok = await c.tryClick("Reset all settings…") || await c.tryClick("Reset…") || await c.tryClick("Reset"); if (!ok) return c.unreachable("Reset button not found"); await c.wait(600); }),
  S("settings", "appearance-theme-switched", async (c) => {
    await c.settings("appearance");
    const next = c.env.theme === "light" ? "dark" : c.env.theme === "dark" ? "void" : "light";
    // GH #275: the theme is a Segmented control (Light · Dark · Void · System).
    const label = next[0].toUpperCase() + next.slice(1);
    const ok = await c.tryClick(label, { exact: true, sel: "[role=radio], [role=tab], button" });
    if (!ok) return c.unreachable("theme Segmented option not found");
    await c.wait(800);
    return c.info(`switched from ${c.env.theme} to ${next} through the Theme segmented control`);
  }),
  S("settings", "appearance-sidebar-hidden", async (c) => {
    await c.settings("appearance");
    const ok = await c.page.evaluate(() => {
      const row = [...document.querySelectorAll("*")].filter((e) => e.children.length < 12 && e.innerText && e.innerText.includes("Show the sidebar") && e.querySelector("[role=switch], input[type=checkbox]")).pop();
      const sw = row && row.querySelector("[role=switch], input[type=checkbox]");
      if (!sw) return false; sw.click(); return true;
    });
    if (!ok) return c.unreachable("Show the sidebar switch not found");
    await c.wait(800);
  }, { sizes: [1280, 1600] }),
  S("settings", "general-editing-draft", async (c) => { await c.settings("general"); const el = await c.page.$("input[value='Ply']"); if (!el) return c.unreachable("Name field not found"); await el.click({ clickCount: 3 }); await c.type("Ply (atelier)", 700); }),

  // ───────────── Sheets & dialogs
  S("sheet", "delete-card-confirm", async (c) => { await c.openCard("fx-checks-failed"); await c.click("More for this card"); await c.click("Delete card…", { after: 900 }); }, { tabWalk: 10 }),
  S("sheet", "ship-batch", async (c) => { await c.mode("board"); await c.app((P) => P.ui().setShipBatchOpen(true)); await c.wait(1200); }, { tabWalk: 12 }),
  S("sheet", "ship-batch-from-header", async (c) => { await c.mode("board"); const ok = await c.page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((e) => /^Ship \d+$/.test(e.innerText.trim()) && e.checkVisibility()); if (b) { b.click(); return true; } return false; }); if (!ok) return c.unreachable("Board header Ship N not found"); await c.wait(1200); }),
  S("sheet", "ship-batch-from-list-selection", async (c) => {
    await c.mode("board"); await c.click("List");
    const n = await c.pickRows(["Settings: search matches row descriptions", "Remember the last Settings search", "Toasts: stack at most three"]);
    if (n < 2) return c.unreachable(`only ${n} List rows ticked`);
    await c.wait(300);
    const ok = await c.page.evaluate(() => { const b = [...document.querySelectorAll(".board-list button")].find((e) => /^Ship \d+$/.test(e.innerText.trim()) && e.checkVisibility()); if (b) { b.click(); return true; } return false; });
    if (!ok) return c.unreachable("List selection bar Ship N not found");
    await c.wait(1200);
    return c.info("3 rows ticked (2 eligible + 1 draft); the sheet should tick only the eligible ones");
  }),
  S("sheet", "template-delete-confirm", async (c) => { await c.seedTiles({ quiet: false, exited: false, codex: false }); await c.click("New"); await c.click("Several sessions at once…", { after: 800 }); await c.click("Delete Dev pair", { after: 800 }); }, { tabWalk: 6 }),
  // QoL 1.168 H1: "Brainstorm…" left the Board's ⋯ with the swarm UI (G4); its
  // one sheet there now is Discuss…, captured by `sheet/discussion` below.
  S("sheet", "discussion", async (c) => { await c.mode("board"); await c.click("More for the Board"); await c.click("Discuss…", { after: 900 }); }),
  S("sheet", "discussion-completed", async (c) => { await c.mode("board"); await c.click("More for the Board"); await c.click("Discuss…", { after: 900 }); if (!(await c.tryClick("Should the Inbox be the landing page, or the Board? Weigh first-run clarity against daily use.", { sel: "*" }))) return c.unreachable("recent discussion row not found"); await c.wait(700); }),
  S("sheet", "workspace-remove-confirm", async (c) => { await c.openSwitcher(); await c.click("More for " + await c.seed("otherName")); await c.click("Remove…", { after: 600 }); }),
  S("sheet", "tile-layout-template", async (c) => { await c.seedTiles({ quiet: false, exited: false, codex: false }); await c.click("New"); await c.click("Several sessions at once…", { after: 800 }); }),
  S("sheet", "update-install-dialog", async (c) => { await c.mode("board"); await c.wait(900); }, { flags: { updateAvailable: true }, tabWalk: 6, fixture: "the app opens this dialog by itself when the launch check finds an update" }),

  // ───────────── Card sections (GH #260): the result, Shipping, a swarm's run
  S("card", "result-open", async (c) => { await c.openCard("fx-ready-to-ship", "outcome"); if (!(await c.section("outcome"))) return c.unreachable("The result section not open"); }, { tabWalk: 15, fixture: "fx-ready-to-ship, the result opened" }),
  S("card", "result-open-end", async (c) => { await c.openCard("fx-ready-to-ship", "outcome"); if (!(await c.section("outcome", "end"))) return c.unreachable("The result section not open"); }, { fixture: "fx-ready-to-ship, the result's foot" }),
  S("card", "result-checks-failed", async (c) => { await c.openCard("fx-checks-failed", "outcome"); if (!(await c.section("outcome"))) return c.unreachable("The result section not open"); }, { fixture: "fx-checks-failed, the result opened" }),
  S("card", "result-changes-requested", async (c) => { await c.openCard("fx-changes", "outcome"); if (!(await c.section("outcome"))) return c.unreachable("The result section not open"); }, { fixture: "fx-changes, the result opened" }),
  S("card", "result-details-open", async (c) => {
    await c.openCard("fx-ready-to-ship", "outcome");
    if (!(await c.section("outcome"))) return c.unreachable("The result section not open");
    const n = await c.page.evaluate(() => { let k = 0; for (const d of document.querySelectorAll('[data-ply-card-section="outcome"] details')) { if (d.checkVisibility() && !d.open) { d.open = true; k++; } } return k; });
    await c.wait(700);
    await c.section("outcome", "end");
    return c.info(`${n} disclosure(s) in the result opened`);
  }, { fixture: "fx-ready-to-ship, every disclosure in the result opened" }),
  S("card", "shipping-shipped", async (c) => { await c.openCard("fx-shipped", "ship"); if (!(await c.section("ship"))) return c.unreachable("Shipping section not open"); }, { tabWalk: 10, fixture: "fx-shipped, Shipping opened" }),
  S("card", "shipping-merged-pr", async (c) => { await c.openCard("fx-merged", "ship"); if (!(await c.section("ship"))) return c.unreachable("Shipping section not open"); }, { fixture: "fx-merged, Shipping opened" }),
  S("card", "shipping-ready", async (c) => { await c.openCard("fx-ready-to-ship", "ship"); if (!(await c.section("ship"))) return c.unreachable("Shipping section not open"); }, { fixture: "fx-ready-to-ship, Shipping opened before a ship" }),
  S("card", "swarm-run", async (c) => { await c.openCard("fx-swarm", "run"); if (!(await c.section("run"))) return c.unreachable("the swarm run section not open"); await c.wait(600); }, { tabWalk: 10, fixture: "fx-swarm (a running feature swarm: scout done, builder running)" }),
  S("card", "swarm-run-end", async (c) => { await c.openCard("fx-swarm", "run"); if (!(await c.section("run", "end"))) return c.unreachable("the swarm run section not open"); await c.wait(600); }, { fixture: "fx-swarm, the mailbox's foot" }),

  // ───────────── Toasts
  S("toast", "undo-archive", async (c) => { await c.openCard("fx-shipped"); await c.click("More for this card"); await c.click("Archive", { after: 700 }); }),
  S("toast", "error-with-copy", async (c) => {
    await c.mode("board");
    await c.app((P) => P.toast.pushToast({ kind: "error", title: "The card couldn't be archived", body: "It is back on the Board as it was.", copyText: "kanban_card_archive: worktree prune failed: fatal: '~/code/atelier/.atelier-worktrees/fx-shipped' contains modified or untracked files, use --force to delete it" }));
    await c.wait(400);
  }, { fixture: "toast pushed through the app's own toastStore.pushToast (same call CardDetailPanel makes on archive failure)" }),
  S("toast", "error-details-open", async (c) => {
    await c.mode("board");
    await c.app((P) => P.toast.pushToast({ kind: "error", title: "The card couldn't be archived", body: "It is back on the Board as it was.", details: "kanban_card_archive: worktree prune failed: fatal: '~/code/atelier/.atelier-worktrees/fx-shipped' contains modified or untracked files, use --force to delete it" }));
    await c.wait(300);
    if (!(await c.tryClick("Details", { exact: true, after: 500 }))) return c.unreachable("toast Details not found");
  }, { fixture: "toast pushed through toastStore.pushToast with details (GH #297)" }),
  S("toast", "one-at-a-time", async (c) => {
    await c.mode("board");
    await c.app((P) => { P.toast.pushToast({ kind: "info", title: "Card archived" }); P.toast.pushToast({ kind: "warn", title: "Checks are still running on this card" }); P.toast.pushToast({ kind: "info", title: "Copied the branch name" }); });
    await c.wait(500);
    const n = await c.page.evaluate(() => document.querySelectorAll(".ux-toast, .toast, [data-toast-id]").length);
    return c.info(`three toasts pushed in a row; ${n} toast element(s) on screen (GH #296: one at a time)`);
  }, { fixture: "three toasts pushed through toastStore.pushToast back to back" }),
];

// Accent presets: Board, a card page and Settings › Appearance, at 1280.
let an = 900;
const A = (state, run) => ({ nn: String(++an), id: `accent-${state}`, area: "accent", state, run });
export const ACCENT_SCENARIOS = [
  A("board", async (c) => { await c.mode("board"); }),
  A("card-ready-to-ship", async (c) => { await c.openCard("fx-ready-to-ship"); }),
  A("settings-appearance", async (c) => { await c.settings("appearance"); }),
];

// States the mock does not reach, or reaches by a shortcut — written to results.json and INDEX.md.
export const NOT_REACHED = [
 {
  "id": "card-queued / card-paused / card-shipping / card-no-changes / card-review-stale",
  "why": "Not captured: these need a live swarm registry, an in-flight ship or a stale-review revision check that the mock does not model (they are derived from runtime stores, not card fields). The other lifecycle states (incl. running, session-closed, closed and merged) are captured."
 },
 {
  "id": "board-drag-refused-toast",
  "why": "Reached, but through synthetic HTML5 DragEvents (headless Chrome cannot do an OS drag); the toast is the app's real refusal path."
 },
 {
  "id": "toast-error-with-copy",
  "why": "Reached by calling the app's own toastStore.pushToast with the payload CardDetailPanel uses on an archive failure (no natural failure path in the mock that ends in a Copy toast)."
 },
 {
  "id": "card-error-block",
  "why": "Reached by making the mocked card_ship reject with a git merge-conflict string; the ErrorBlock and its toast are the real rendering."
 },
 {
  "id": "team (Members and library) with a real team",
  "why": "The snapshot has no team key; the page renders the no-team state only."
 }
];
