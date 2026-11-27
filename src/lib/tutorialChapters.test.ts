// Getting started TU-7 (docs/tutorial/TUTORIAL_SPEC.md §3.1, §6.1, §6.6, §7,
// §12.1): the optional chapters, Tier 3. Each chapter is walked to its end
// through the engine — every action step done by the app's state, every
// explain step by Next — and the panel then says the chapter is done. The
// team chapter is there in team mode and absent in solo; G3 only while one
// AI is ready; the panel lists the chapters under "More, when you're ready",
// with their length and progress. Run by scripts/ppvp-pure-contracts.sh
// under node --experimental-strip-types.
import assert from "node:assert/strict";
import type { TutorialProgress } from "./settingsShape.ts";
import type { CenterMode, PaletteScope } from "../store/uiStore.ts";
import { tryRunKey, type TryPhase } from "./tryPanel.ts";
import { PROJECT_TRY_ID } from "./tryTile.ts";
import {
  ALL_STEPS,
  BASE_STEPS,
  CHAPTER_DONE_COPY,
  CHAPTERS,
  CHAPTERS_SINCE,
  LOOP_DONE_COPY,
  MORE_CHAPTERS_HEADING,
  OPT,
  SECOND_AI_OFFER,
  STEP,
  TOUR_ANCHORS,
  followsActive,
  stepById,
  stepCopy,
  TRY_FALLBACK,
  TRY_PROJECT_STATIC_BODY,
  type ChapterId,
  type TourNav,
} from "./tutorial/manifest.ts";
import {
  buildTutorialSnapshot,
  cardKey,
  chapterProgress,
  chapterSteps,
  completeStep,
  currentChapter,
  observeTour,
  optionalChapters,
  projectTryRunning,
  skipChapter,
  skipStep,
  startFullTour,
  tourView,
  withTourCard,
  type HereFacts,
  type SnapshotInput,
  type TourCardPresentation,
  type TutorialSnapshot,
} from "./tutorial/tutorialEngine.ts";
import { panelView } from "./tutorial/tourPanel.ts";
import { PLANNED_IN_CHAPTER } from "./tutorial/coverage.ts";
import { compareVersions } from "./tutorial/whatsNew.ts";

const WS = "ws-tour";
const OTHER_WS = "ws-other";
const T0 = "2026-10-21T09:00:00.000Z";
const NOW = "2026-10-21T09:30:00.000Z";

type Opts = {
  mode?: CenterMode;
  active?: string | null;
  workMode?: "solo" | "team" | null;
  ai?: { claude: boolean; codex: boolean };
  platform?: "mac" | "windows";
  overlays?: Partial<{ allSkills: boolean; shipBatch: boolean; settings: boolean }>;
  here?: SnapshotInput["here"];
  palette?: PaletteScope | null;
  tryRuns?: Record<string, { phase: TryPhase }>;
  workspaces?: { id: string; name: string }[];
  tryOpened?: ReadonlySet<string>;
  staticSites?: ReadonlySet<string>;
};

function snapshot(record: TutorialProgress | null, o: Opts = {}): TutorialSnapshot {
  return buildTutorialSnapshot({
    record,
    platform: o.platform ?? "mac",
    level: "guided",
    workMode: o.workMode === undefined ? "solo" : o.workMode,
    plan: { teamAllowed: false },
    workspaces: {
      loaded: true,
      list: o.workspaces ?? [
        { id: WS, name: "lyra" },
        { id: OTHER_WS, name: "vega" },
      ],
    },
    activeWorkspaceId: o.active === undefined ? WS : o.active,
    mode: o.mode ?? "board",
    overlays: { allSkills: false, shipBatch: false, settings: false, ...o.overlays },
    ai: o.ai ?? { claude: true, codex: true },
    boards: { [WS]: { loaded: true, cards: [] }, [OTHER_WS]: { loaded: true, cards: [] } },
    present: (): TourCardPresentation => ({ state: "draft", rule: "base", session: null, vendor: "claude" }),
    tryRuns: o.tryRuns ?? {},
    here: o.here,
    palette: o.palette ?? null,
    tryOpened: o.tryOpened,
    staticSites: o.staticSites,
  });
}

const started: TutorialProgress = startFullTour(null, { now: T0, version: "1.167.0" });
/** The base chapter done: Ship it recorded, B11 skipped. */
const baseDone: TutorialProgress = {
  ...started,
  done: Object.fromEntries(BASE_STEPS.filter((s) => s.kind !== "interrupt" && s.kind !== "checklist").map((s) => [s.id, NOW])),
  skipped: { [STEP.secondCard]: NOW },
};

/** What the app looks like when each action step is done (and, `before`,
 *  just before: where the person was a moment earlier). */
const DONE_STATE: Record<string, { before: Opts; after: Opts }> = {
  [OPT.inbox]: { before: { mode: "board" }, after: { mode: "inbox" } },
  [OPT.history]: { before: { mode: "inbox" }, after: { mode: "activity" } },
  [OPT.chat]: {
    before: { here: { openCard: { id: "c7", section: null } } },
    after: { here: { openCard: { id: "c7", section: "chat" } } },
  },
  [OPT.terminalsNew]: { before: { mode: "terminals" }, after: { mode: "terminals", here: { tiles: { shell: 1 } } } },
  [OPT.codeFiles]: { before: { mode: "code" }, after: { mode: "code", palette: "files" } },
  [OPT.codePreview]: { before: { mode: "code" }, after: { mode: "code", here: { previewOpen: true } } },
  [OPT.codeTryProject]: {
    before: { mode: "code", here: { previewOpen: true } },
    after: {
      mode: "code",
      here: { previewOpen: true },
      tryRuns: { [tryRunKey(WS, PROJECT_TRY_ID, null)]: { phase: "running" } },
    },
  },
  [OPT.librarySkills]: { before: { mode: "board" }, after: { mode: "library", here: { libraryPage: "skills" } } },
  [OPT.libraryInstructions]: {
    before: { mode: "library", here: { libraryPage: "skills" } },
    after: { mode: "library", here: { libraryPage: "instructions" } },
  },
  [OPT.allSkills]: { before: {}, after: { overlays: { allSkills: true } } },
  [OPT.search]: { before: {}, after: { palette: "commands" } },
  [OPT.settings]: { before: {}, after: { overlays: { settings: true } } },
};

/** Walk a chapter to its end: every step done by its own way, in order. */
function walk(chapter: ChapterId, o: Opts = {}): TutorialProgress {
  let r: TutorialProgress = baseDone;
  const steps = chapterSteps(chapter, snapshot(r, o));
  assert.ok(steps.length > 0, `${chapter} has steps here`);
  for (const step of steps) {
    const view = tourView(r, snapshot(r, o), { chapter });
    assert.equal(view.step?.id, step.id, `${chapter}: ${step.id} is the current step`);
    assert.equal(view.wait, null, `${step.id} waits on nothing`);
    if (step.kind === "explain") {
      // Explain-only: the app's state never marks it; Next does.
      assert.equal(step.done(snapshot(r, o)), false, `${step.id} is done by Next only`);
      assert.equal(observeTour(r, snapshot(r, o), NOW, { chapter }), null, `observing never marks ${step.id}`);
      r = completeStep(r, step.id, NOW);
      continue;
    }
    const state = DONE_STATE[step.id];
    assert.ok(state, `${step.id} has a done state in this test`);
    const before = snapshot(r, { ...o, ...state.before });
    const after = snapshot(r, { ...o, ...state.after });
    assert.equal(step.done(before), false, `${step.id}: not done before`);
    assert.equal(step.done(after), true, `${step.id}: done after`);
    const next = observeTour(r, after, NOW, { chapter, before });
    assert.equal(next?.done?.[step.id], NOW, `${step.id} is recorded when the app says so`);
    r = next!;
  }
  const last = snapshot(r, o);
  assert.equal(tourView(r, last, { chapter }).step, null, `${chapter} completes`);
  const p = chapterProgress(r, last, chapter);
  assert.equal(p.complete, true);
  assert.equal(p.done, p.total, `${chapter}: ${p.total} of ${p.total}`);
  const pv = panelView(r, last, { chapter });
  assert.equal(pv.chapter.id, chapter, "the panel shows the chapter picked");
  assert.deepEqual(pv.finished, CHAPTER_DONE_COPY, "and says it is done");
  assert.equal(pv.progress, `${p.total} of ${p.total}`);
  return r;
}

const OPTIONAL: ChapterId[] = [
  "inbox-history",
  "talk",
  "terminals",
  "code",
  "library",
  "all-skills",
  "ship-batch",
  "team",
  "settings-search",
];

// ── The manifest (§6.1, §6.6) ────────────────────────────────────────────

{
  assert.deepEqual(
    CHAPTERS.filter((c) => c.id !== "base").map((c) => c.id),
    OPTIONAL,
    "every optional chapter of §6.1, in order",
  );
  const lengths = Object.fromEntries(CHAPTERS.map((c) => [c.id, c.steps.length]));
  assert.deepEqual(lengths, {
    // 1.175.0 F4: the permissions question (not counted, never a row).
    base: 13,
    "inbox-history": 3,
    talk: 4,
    // 1.173.0 A3: "In a new copy…" (terminals.new-copy).
    terminals: 4,
    code: 3,
    // L4 Knowledge is gone: the Library has Instructions and Skills only.
    library: 3,
    // A1–A4: the Skills hub's Copy to… (H8), Plyloft's skills (H9), My library (H10).
    "all-skills": 4,
    "ship-batch": 2,
    team: 3,
    // 1.173.0 B2: the area picker (shown only with two areas or more).
    "settings-search": 4,
  });
  const anchors = new Set<string>(TOUR_ANCHORS);
  // 1.173.0 A3 added terminals-new-copy (the New › In a new copy… item).
  // 1.173.0 B2 added sidebar-area (the area picker).
  // 1.173.0 E3 added board-next-improvement (Next improvement above the Board).
  assert.equal(TOUR_ANCHORS.length, 26, "only the anchors §4.3 and 1.173.0's copies, areas and Next improvement name");
  for (const c of CHAPTERS.filter((ch) => ch.id !== "base")) {
    for (const s of c.steps) {
      assert.equal(s.chapter, c.id, `${s.id} is in its chapter`);
      const prefix = c.id === "inbox-history" ? "inbox" : c.id === "settings-search" ? "settings" : c.id;
      assert.ok(s.id.startsWith(`${prefix}.`), `${s.id}: its chapter's prefix`);
      // TU-7's release, or the later one that changed its meaning
      // (terminals.new: New › Resume…, 1.168.0).
      assert.ok(compareVersions(s.since, CHAPTERS_SINCE) >= 0, `${s.id} since 1.167.0 or later`);
      assert.equal(s.counted, true, `${s.id} counts in its chapter`);
      assert.ok(!s.cardBound, `${s.id} watches no tour card`);
      assert.ok(followsActive(s), `${s.id} follows the active workspace`);
      if (s.anchor) assert.ok(anchors.has(s.anchor), `${s.id}'s anchor is listed`);
      // G3's done state is its own block below (it applies only while one AI is ready).
      if (s.kind === "action" && s.id !== OPT.secondAi) assert.ok(DONE_STATE[s.id], `${s.id}: an action step with its done state tested`);
      assert.ok(s.kind === "action" || s.kind === "explain", `${s.id} is an action or an explanation`);
    }
  }
  assert.equal(CHAPTERS_SINCE, "1.167.0", "the release the Skills hub ships in");
  // §12.1 (1): nothing is left planned — every destination is in a step.
  assert.deepEqual(Object.keys(PLANNED_IN_CHAPTER), []);
  // §5: the Library has no Knowledge any more.
  for (const s of ALL_STEPS) {
    assert.doesNotMatch(`${s.copy.title} ${s.copy.body} ${s.copy.why ?? ""}`, /\bKnowledge\b|\bNotes\b/, s.id);
  }
  // The Skills hub's final names (ADR 0009, the release note).
  assert.match(stepById(OPT.copyTo)!.copy.title, /^Add to other projects…$/);
  assert.match(stepById(OPT.plyloftSkills)!.copy.body, /Where it's on/);
  assert.match(stepById(OPT.plyloftSkills)!.copy.body, /Personalize…/);
  assert.equal(stepById(OPT.myLibrary)!.copy.title, "My library");
  assert.equal(stepById(OPT.myLibrary)!.kind, "explain");
  assert.equal(stepById(OPT.shipBatch)!.kind, "explain");
  // D8: the steps that can start an AI say whose subscription it is.
  for (const id of [OPT.terminalsNew, OPT.planTwoAis]) {
    const s = stepById(id)!;
    assert.equal(s.startsAi, true, `${id} starts an AI`);
    assert.match(stepCopy(s, "claude").body, /your own (Claude )?subscription/, `${id} says so first`);
  }
}

// ── Each chapter completes (§6.6, TU-7 acceptance) ───────────────────────

for (const chapter of OPTIONAL) {
  if (chapter === "team") continue; // below, in team mode
  walk(chapter);
}

// ── The team chapter: team mode only, absent in solo (D7, §11) ───────────

{
  const solo = snapshot(baseDone, { workMode: "solo" });
  assert.deepEqual(chapterSteps("team", solo), [], "solo: no team steps");
  assert.ok(!optionalChapters(solo).includes("team"), "solo: the team chapter is not offered");
  assert.ok(!panelView(baseDone, solo).chapters.some((c) => c.id === "team"), "solo: not listed in the panel");
  assert.equal(currentChapter(baseDone, solo, "team"), "base", "solo: picking it (a stale pick) shows the base chapter");

  const team = snapshot(baseDone, { workMode: "team" });
  assert.deepEqual(chapterSteps("team", team).map((s) => s.id), [OPT.teamLibrary, OPT.teamWorkspaces, OPT.teamInvite]);
  assert.ok(panelView(baseDone, team).chapters.some((c) => c.id === "team" && c.title === "Your team"), "team: listed");
  walk("team", { workMode: "team" });
  // Unknown mode shows everything (OB-9's rule).
  assert.ok(optionalChapters(snapshot(baseDone, { workMode: null })).includes("team"), "unknown: shown");
  // Its steps open Settings › Members and library.
  for (const s of chapterSteps("team", team)) assert.deepEqual(s.navigate, { settings: "team-workspaces" } satisfies TourNav);
}

// ── G3, Add a second AI: only while one AI is ready (D17) ────────────────

{
  const both = snapshot(baseDone, { ai: { claude: true, codex: true } });
  const claudeOnly = snapshot(baseDone, { ai: { claude: true, codex: false } });
  const none = snapshot(baseDone, { ai: { claude: false, codex: false } });
  const ids = (s: TutorialSnapshot) => chapterSteps("settings-search", s).map((st) => st.id);
  assert.deepEqual(ids(both), [OPT.search, OPT.settings], "both ready: no G3");
  assert.deepEqual(ids(none), [OPT.search, OPT.settings], "none ready: Setup's business, not G3");
  assert.deepEqual(ids(claudeOnly), [OPT.search, OPT.settings, OPT.secondAi], "one ready: G3");
  assert.deepEqual(stepById(OPT.secondAi)!.navigate, { setup: "ai" }, "Take me there opens Setup's AI step");
  // G3's own walk: done once both read Ready.
  let r = completeStep(completeStep(baseDone, OPT.search, NOW), OPT.settings, NOW);
  const g3 = stepById(OPT.secondAi)!;
  assert.equal(tourView(r, claudeOnly, { chapter: "settings-search" }).step?.id, OPT.secondAi);
  assert.equal(g3.done(claudeOnly), false);
  assert.equal(g3.done(both), true);
  // Both ready: G3 no longer applies — the chapter is complete without it.
  assert.equal(tourView(r, both, { chapter: "settings-search" }).step, null, "a second AI added: the chapter completes");
  // Skip it: done too.
  r = skipStep(r, OPT.secondAi, NOW);
  assert.equal(chapterProgress(r, claudeOnly, "settings-search").complete, true);

  // §6.6: after B10, while one AI is ready, the panel offers it once.
  const pv = panelView(baseDone, claudeOnly);
  assert.equal(pv.secondAi?.title, SECOND_AI_OFFER);
  assert.match(pv.secondAi?.body ?? "", /^Plyloft works with one AI/);
  assert.equal(panelView(baseDone, both).secondAi, null, "both ready: no offer");
  assert.equal(panelView(skipStep(baseDone, OPT.secondAi, NOW), claudeOnly).secondAi, null, "G3 skipped: no offer");
  assert.equal(panelView(started, claudeOnly).secondAi, null, "not before the loop is done");
}

// ── The chapter list (§3.1) and the chapter shown ────────────────────────

{
  const s = snapshot(baseDone);
  const pv = panelView(baseDone, s);
  assert.equal(pv.chapter.id, "base", "after the loop: still the base chapter, with the list below");
  assert.equal(pv.finished?.body, LOOP_DONE_COPY.body, "Pick a chapter below");
  assert.equal(MORE_CHAPTERS_HEADING, "More, when you're ready");
  assert.deepEqual(
    pv.chapters.map((c) => [c.id, c.length]),
    [
      ["inbox-history", "3 steps"],
      ["talk", "4 steps"],
      ["terminals", "4 steps"],
      ["code", "3 steps"],
      ["library", "3 steps"],
      ["all-skills", "4 steps"],
      ["ship-batch", "2 steps"],
      ["settings-search", "2 steps"],
    ],
    "solo, both AIs: each with its length",
  );
  // Picked: its steps, its progress, and the base chapter listed to go back.
  const inbox = panelView(baseDone, s, { chapter: "inbox-history" });
  assert.equal(inbox.chapter.title, "Inbox and History");
  assert.deepEqual(inbox.rows.map((r) => r.step.id), [OPT.inbox, OPT.inboxEveryProject, OPT.history]);
  assert.equal(inbox.progress, "0 of 3");
  // 1.173.0 (F1, Challenger 8): one count — the Board's Needs you is the
  // Inbox's number for its cards only (rows with no card are the Inbox's).
  const every = inbox.rows[1].step;
  assert.match(every.copy.body, /the same number as Needs you here and, for its cards, on the Board/);
  assert.equal(every.since, "1.173.0");
  assert.equal(inbox.rows[0].status, "current");
  assert.equal(inbox.chapters[0].id, "base", "the base chapter is listed to go back to");
  assert.equal(inbox.chapters[0].length, "Done");
  assert.ok(!inbox.chapters.some((c) => c.id === "inbox-history"), "not the one shown");
  assert.equal(inbox.b3, null);
  assert.equal(inbox.checklist, null, "B11's list is the base chapter's");
  assert.equal(inbox.announcement, "Step 1 of 3: Open the Inbox");
  // Under way: a launch (nothing picked) shows the base chapter, and the
  // list says how far the chapter got. The panel never moves on its own.
  const one = completeStep(baseDone, OPT.inbox, NOW);
  assert.equal(currentChapter(one, s, null), "base");
  assert.equal(panelView(one, s).chapters.find((c) => c.id === "inbox-history")?.length, "1 of 3");
  assert.equal(currentChapter(started, s, null), "base", "before the loop is done: the base chapter");
  assert.equal(currentChapter(started, s, "code"), "code", "a chapter picked before the loop is done is shown");
  // Skip chapter: every step of it skipped, the chapter done.
  const skipped = skipChapter(baseDone, "code", NOW);
  assert.deepEqual(Object.keys(skipped.skipped ?? {}).filter((id) => id.startsWith("code.")).sort(), [OPT.codeFiles, OPT.codePreview, OPT.codeTryProject].sort());
  assert.equal(panelView(skipped, s, { chapter: "code" }).finished, CHAPTER_DONE_COPY);
  assert.equal(panelView(skipped, s).chapters.find((c) => c.id === "code")?.length, "Done");
  // §6.3: K3 skipped — how to see it running by hand.
  assert.match(panelView(skipped, s, { chapter: "code" }).tryFallback?.text ?? "", /Show your running app/);
}

// ── An optional step follows the active workspace (§9) ───────────────────

{
  // The tour card in lyra, the person in vega: a base step says where; an
  // optional chapter's step is where they are.
  const r: TutorialProgress = { ...withTourCard(started, WS, "c1"), done: baseDone.done, skipped: baseDone.skipped };
  const inVega = snapshot(r, { active: OTHER_WS, mode: "board" });
  const view = tourView(r, inVega, { chapter: "inbox-history" });
  assert.equal(view.step?.id, OPT.inbox);
  assert.equal(view.wait, null, "never This step is in lyra");
  const inVegaInbox = snapshot(r, { active: OTHER_WS, mode: "inbox" });
  assert.equal(observeTour(r, inVegaInbox, NOW, { chapter: "inbox-history", before: inVega })?.done?.[OPT.inbox], NOW, "the Inbox where you are");
  // No workspace at all: a place in a workspace waits on one; All skills doesn't.
  const none = snapshot(started, { active: null, workspaces: [] });
  assert.equal(tourView(started, none, { chapter: "library" }).wait, "no-workspace");
  assert.equal(tourView(started, none, { chapter: "all-skills" }).wait, null);
  // K3's project name is the active workspace's.
  const k3 = panelView(started, inVega, { chapter: "code" }).rows.find((row) => row.step.id === OPT.codeTryProject)!;
  assert.match(k3.copy.body, /Try it in vega,/);
  assert.equal(projectTryRunning({ [tryRunKey(OTHER_WS, PROJECT_TRY_ID, null)]: { phase: "running" } }, OTHER_WS), true);
  assert.equal(projectTryRunning({ [tryRunKey(OTHER_WS, "card-1", null)]: { phase: "running" } }, OTHER_WS), false, "a card's copy is not the project");
  assert.equal(projectTryRunning({ [tryRunKey(WS, PROJECT_TRY_ID, null)]: { phase: "running" } }, OTHER_WS), false, "another project's");
}

// ── K3 on a plain website (TU-5 Challenger's note) ───────────────────────

{
  // Try it in <project> goes through the same How to start your app sheet:
  // its Open index.html (tryRunStore's indexOpened, under the project's key)
  // completes K3 as it completes B9.
  const k3 = stepById(OPT.codeTryProject)!;
  const projectKey = cardKey(WS, PROJECT_TRY_ID);
  const opened = snapshot(baseDone, { mode: "code", tryOpened: new Set([projectKey]), staticSites: new Set([projectKey]) });
  assert.equal(opened.here.projectTryOpened, true);
  assert.equal(k3.done(opened), true, "Open index.html on the project's sheet is K3 done");
  assert.equal(
    k3.done(snapshot(baseDone, { mode: "code", tryOpened: new Set([cardKey(WS, "card-1")]) })),
    false,
    "a card's Open index.html is B9's, not K3's",
  );
  assert.equal(
    k3.done(snapshot(baseDone, { mode: "code", active: OTHER_WS, tryOpened: new Set([projectKey]) })),
    false,
    "another project's",
  );
  assert.equal(
    observeTour(baseDone, opened, NOW, { chapter: "code" })?.done?.[OPT.codeTryProject],
    NOW,
    "observed in the chapter",
  );
  // Skipped on a plain website: the plain-website words, never a terminal or
  // the localhost preview.
  const skipped = skipStep(baseDone, OPT.codeTryProject, NOW);
  const plain = snapshot(skipped, { mode: "code", staticSites: new Set([projectKey]) });
  assert.equal(plain.here.projectStaticSite, true);
  assert.equal(panelView(skipped, plain, { chapter: "code" }).tryFallback?.text, TRY_FALLBACK.staticAfterShip);
  const app = snapshot(skipped, { mode: "code" });
  assert.equal(panelView(skipped, app, { chapter: "code" }).tryFallback?.text, TRY_FALLBACK.afterShip);
  // Skipped, then opened after all: nothing to fall back on.
  const later = snapshot(skipped, { mode: "code", tryOpened: new Set([projectKey]), staticSites: new Set([projectKey]) });
  assert.equal(panelView(skipped, later, { chapter: "code" }).tryFallback, null);
}

// ── Where you are counts as it is for the chapter shown (§7) ─────────────

{
  // Already in the Inbox when the chapter is picked: I1 is done.
  const inInbox = snapshot(baseDone, { mode: "inbox" });
  assert.equal(observeTour(baseDone, inInbox, NOW, { chapter: "inbox-history" })?.done?.[OPT.inbox], NOW);
  // Another chapter shown: an optional step never counts, not even as a
  // fresh change — opening the Inbox during the first card is not the Inbox
  // chapter begun.
  const onBoard = snapshot(baseDone, { mode: "board" });
  assert.equal(observeTour(baseDone, inInbox, NOW, { chapter: "base" })?.done?.[OPT.inbox], undefined);
  assert.equal(observeTour(baseDone, inInbox, NOW, { chapter: "base", before: onBoard })?.done?.[OPT.inbox], undefined);
  assert.equal(observeTour(started, inInbox, NOW, { before: onBoard })?.done?.[OPT.inbox], undefined, "during the first card");
  // In the chapter shown, a step ahead counts as a fresh change (§7)…
  const inHistory = snapshot(baseDone, { mode: "activity" });
  assert.equal(observeTour(baseDone, inHistory, NOW, { chapter: "inbox-history", before: onBoard })?.done?.[OPT.history], NOW);
  // …but not as the place it was already in.
  assert.equal(observeTour(baseDone, inHistory, NOW, { chapter: "inbox-history" })?.done?.[OPT.history], undefined);
}

// ── Words: one AI, Windows keys, no plan words (§4.1, §11) ─────────────────

{
  const p2 = stepById(OPT.planTwoAis)!;
  const oneAi = panelView(baseDone, snapshot(baseDone, { ai: { claude: false, codex: true } }), { chapter: "talk" });
  const row = oneAi.rows.find((r) => r.step.id === OPT.planTwoAis)!;
  assert.match(row.copy.body, /Both views come from Codex, in two separate sessions with different roles\./, "ONBOARDING_SPEC §13.4");
  assert.doesNotMatch(row.copy.body, /\{ai\}/);
  // 1.172.0 (C1): it is in Plan it first, beside Start build.
  assert.match(stepCopy(p2, "claude").body, /Plan it first beside Start build has Plan with two AIs: one AI writes a plan and the other questions it/);
  // ⌘ written once, drawn for this machine (formatKeys).
  const mac = panelView(baseDone, snapshot(baseDone), { chapter: "code" }).rows[0].copy.body;
  const win = panelView(baseDone, snapshot(baseDone, { platform: "windows" }), { chapter: "code" }).rows[0].copy.body;
  assert.match(mac, /Press ⌘P/);
  assert.match(win, /Press Ctrl\+P/);
  const g1 = panelView(baseDone, snapshot(baseDone, { platform: "windows" }), { chapter: "settings-search" }).rows[0];
  assert.match(g1.copy.body, /^Search \(Ctrl\+K\)/);
  // Every plan sees the same words: no Pro or Free in a step.
  for (const st of ALL_STEPS) {
    assert.doesNotMatch(`${st.copy.body} ${st.copy.why ?? ""}`, /\bPro\b|\bFree\b|on Free/, `${st.id}: no plan words`);
  }
  assert.equal(panelView(baseDone, snapshot(baseDone), { chapter: "ship-batch" }).rows[0].step.kind, "explain");
}

// ── B5b is shown in an optional chapter too ──────────────────────────────

{
  // The tour card's session asks while the person reads another chapter.
  const r: TutorialProgress = { ...withTourCard(started, WS, "c1"), done: { [STEP.howItWorks]: NOW } };
  const asking = buildTutorialSnapshot({
    ...{
      record: r,
      platform: "mac",
      level: "guided",
      workMode: "solo",
      plan: null,
      workspaces: { loaded: true, list: [{ id: WS, name: "lyra" }] },
      activeWorkspaceId: WS,
      mode: "board",
      overlays: { allSkills: false, shipBatch: false, settings: false },
      ai: { claude: true, codex: true },
      boards: { [WS]: { loaded: true, cards: [{ id: "c1", workspaceId: WS, title: "x", columnId: "todo", createdAt: 1, updatedAt: 1 }] } },
      present: (): TourCardPresentation => ({ state: "running", rule: "builder-waiting", session: null, vendor: "claude", waiting: null }),
      tryRuns: {},
    },
  } satisfies SnapshotInput);
  assert.equal(tourView(r, asking, { chapter: "terminals" }).interrupt?.kind, "waiting");
}

// HereFacts is the snapshot's own type: an absent `here` reads as nothing.
{
  const blank: HereFacts = snapshot(started).here;
  assert.deepEqual(blank, {
    workspaceName: "lyra",
    tiles: {},
    libraryPage: null,
    previewOpen: false,
    projectTryRunning: false,
    projectTryOpened: false,
    projectStaticSite: false,
    openCard: null,
    // 1.173.0 B2: the repository has two areas or more.
    areas: false,
  });
}

// ── TU-7 Mac walk 1: P1/P2 point on the card open here (§6.6) ───────────

{
  // The base chapter's tour card c1 is known; the person opens a draft c7
  // for the Talk chapter. P1 and P2 point on c7's page; B4–B10 and B5b stay
  // bound to the tour card's page (tutorialBase.test.ts, "3: B5b never …").
  const r: TutorialProgress = { ...withTourCard(started, WS, "c1"), done: baseDone.done, skipped: baseDone.skipped };
  const kc = (id: string, createdAt: number) => ({ id, workspaceId: WS, title: id, columnId: "todo" as const, createdAt, updatedAt: createdAt });
  const at = (open: string | null, section: "chat" | null = null, mode: CenterMode = "board") =>
    buildTutorialSnapshot({
      record: r,
      platform: "mac",
      level: "guided",
      workMode: "solo",
      plan: null,
      workspaces: { loaded: true, list: [{ id: WS, name: "lyra" }] },
      activeWorkspaceId: WS,
      mode,
      overlays: { allSkills: false, shipBatch: false, settings: false },
      ai: { claude: true, codex: true },
      boards: { [WS]: { loaded: true, cards: [kc("c1", Date.parse(T0) + 1), kc("c7", Date.parse(NOW))] } },
      present: (): TourCardPresentation => ({ state: "draft", rule: "base", session: null, vendor: "claude" }),
      tryRuns: {},
      openCardId: open,
      here: open && mode === "board" ? { openCard: { id: open, section } } : undefined,
    } satisfies SnapshotInput);
  const draft = at("c7");
  assert.ok(draft.tourCard, "the base chapter's tour card is known");
  assert.equal(draft.tourCardOpen, false, "another card's page is open");
  assert.equal(panelView(r, draft, { chapter: "talk" }).coachAnchor, "card-tab-chat", "P1 points at Chat on the draft card");
  const p2 = completeStep(r, OPT.chat, NOW);
  assert.equal(panelView(p2, at("c7", "chat"), { chapter: "talk" }).coachAnchor, "card-plan-two-ais", "P2 points at Plan with two AIs there");
  assert.equal(panelView(r, at("c1"), { chapter: "talk" }).coachAnchor, "card-tab-chat", "the tour card's own page is a card page too");
  assert.equal(panelView(r, at(null), { chapter: "talk" }).coachAnchor, null, "no card page open: nothing to point at");
  assert.equal(panelView(r, at("c7", null, "inbox"), { chapter: "talk" }).coachAnchor, null, "a card chosen, the Inbox shown: none");
  // Every optional step with a card-* anchor follows this rule.
  const cardAnchored = CHAPTERS.filter((c) => c.id !== "base").flatMap((c) => c.steps).filter((st) => st.anchor?.startsWith("card-"));
  assert.deepEqual(cardAnchored.map((st) => st.id), [OPT.chat, OPT.planTwoAis]);
}

// ── TU-7 Mac walk 2: K3 on a plain website, without the sheet ────────────

{
  // Try it in <project> is offered only with a start command, so its sheet
  // never opens for a plain website: the project's own start-command read
  // (`here.staticSite`) says so instead, and K3 is explain-only.
  const plain = snapshot(baseDone, { mode: "code", here: { staticSite: true } });
  assert.equal(plain.here.projectStaticSite, true, "the read alone is enough");
  const r = completeStep(completeStep(baseDone, OPT.codeFiles, NOW), OPT.codePreview, NOW);
  const pv = panelView(r, plain, { chapter: "code" });
  const k3 = pv.rows.find((row) => row.step.id === OPT.codeTryProject)!;
  assert.equal(k3.status, "current");
  assert.equal(k3.step.kind, "explain", "nothing to start: done by Next");
  assert.equal(k3.copy.body, TRY_PROJECT_STATIC_BODY.replace("{project}", "lyra"));
  assert.match(k3.copy.body, /Open its index\.html in your browser to see it\.$/);
  assert.doesNotMatch(k3.copy.body, /starts your app|Try it in/, "never says Try it starts it");
  assert.equal(k3.copy.why, undefined, "no Skip advice: Next is the way on");
  assert.equal(pv.pointing?.step.kind, "explain", "the coach-mark, if any, has Next");
  assert.equal(observeTour(r, plain, NOW, { chapter: "code" }), null, "the app's state never marks it");
  const next = completeStep(r, OPT.codeTryProject, NOW);
  assert.deepEqual(panelView(next, plain, { chapter: "code" }).finished, CHAPTER_DONE_COPY, "Next ends the chapter");
  // Skipped (Skip chapter) on a plain website: its words.
  const skipped = skipChapter(r, "code", NOW);
  assert.equal(panelView(skipped, plain, { chapter: "code" }).tryFallback?.text, TRY_FALLBACK.staticAfterShip);
  // An app with a start command: K3 as before.
  const app = panelView(r, snapshot(baseDone, { mode: "code" }), { chapter: "code" }).rows.find((row) => row.step.id === OPT.codeTryProject)!;
  assert.equal(app.step.kind, "action");
  assert.match(app.copy.body, /Try it in lyra, on the Ship receipt/);
}

// ── TU-7 walks 3: the words name the real places ─────────────────────────

{
  // A3: Where it's on and Personalize… are on the skill's Library page.
  assert.match(stepById(OPT.plyloftSkills)!.copy.body, /Comes with Plyloft, then Open in the Library\. Its page there/);
  // M2: Clone and add is on a team workspace's row this Mac doesn't have.
  const m2 = stepById(OPT.teamWorkspaces)!.copy.body;
  assert.match(m2, /one this Mac doesn't have yet has Clone and add on its row/);
  assert.match(m2, /Open here/);
  // TU-7 re-walk: a checkout already on this Mac but not added says Register (TeamPage).
  assert.match(m2, /already here but not added has Register/);
  // Windows walk: the menu is More for Code, not "Code › More".
  for (const line of Object.values(TRY_FALLBACK)) assert.doesNotMatch(line, /Code › More/, line);
  assert.match(TRY_FALLBACK.afterShip, /More for Code › Show your running app/);
  assert.match(TRY_FALLBACK.beforeShip, /More for Code › Show your running app/);
}

console.log(`tutorialChapters.test.ts: ${OPTIONAL.length} optional chapters, each walked to its end`);

// ── D17: Settings search finds the second AI ─────────────────────────────

{
  const { SETTINGS_INDEX } = await import("./settingsIndex.ts");
  const { searchSettings } = await import("./settingsSearch.ts");
  for (const q of ["codex", "chatgpt", "connect", "sign in", "second ai"]) {
    const hits = searchSettings(q, SETTINGS_INDEX);
    assert.ok(hits.some((h) => h.entry.page === "setup" && h.entry.label === "Setup"), `${q}: Setup (its AI step)`);
    assert.ok(hits.some((h) => h.entry.page === "claude-codex"), `${q}: This Mac › Claude and Codex`);
  }
  console.log("tutorialChapters.test.ts: D17's search terms find Setup and Claude and Codex");
}
