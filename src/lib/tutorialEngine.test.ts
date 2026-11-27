// Getting started TU-2 (docs/tutorial/TUTORIAL_SPEC.md §4, §6.2, §7, §9,
// §11): the manifest and the engine, Tier 3. Every base step's `done` per
// state, the edge cases of §11 (taking another card, a pull request ship,
// changes requested, the card deleted, its workspace removed), steps done
// out of order, Start over, and unknown step ids kept. Run by
// scripts/ppvp-pure-contracts.sh under node --experimental-strip-types.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import type { PresentationRule, SessionFacts } from "./cardPresentation.ts";
import type { CardPrimaryActionId } from "./cardLifecycle.ts";
import { panelView } from "./tutorial/tourPanel.ts";
import type { TutorialProgress } from "./settingsShape.ts";
import type { CenterMode } from "../store/uiStore.ts";
import { tryRunKey, type TryPhase } from "./tryPanel.ts";
import {
  ALL_STEPS,
  ASK_COPY,
  BASE_STEPS,
  BRIEF_MIN_CHARS,
  CHAPTERS,
  CONTINUE_GUIDED_LINK,
  LOOP_DONE_ALONE_BODY,
  LOOP_DONE_COPY,
  SAFE_EXAMPLE_LINK,
  SECOND_CARD_CHECKLIST,
  SHIP_PR_BODY,
  SHIP_PR_AUTO_MERGE_LINE,
  SHIP_PR_PLYLOFT_MERGE_LINE,
  SHIP_UNKNOWN_BODY,
  SHIP_PR_OPEN_LINE,
  START_BUILD_NOTE,
  START_BUILD_NOTE_CODEX,
  STARTER_TITLES,
  TRY_FALLBACK,
  WHILE_BUILDING_LINE,
  STEP,
  TOUR_ANCHORS,
  TUTORIAL_SINCE,
  WAIT_COPY,
  fillWords,
  stepById,
  stepCopy,
} from "./tutorial/manifest.ts";
import { compareVersions } from "./tutorial/whatsNew.ts";
import {
  buildTutorialSnapshot,
  cardGone,
  completeStep,
  endTour,
  observeTour,
  pauseTour,
  resumeTour,
  skipChapter,
  skipStep,
  startFullTour,
  startOver,
  startQuickTour,
  startTourFromSetup,
  tourResumable,
  tourRunning,
  tourView,
  tourWorkspace,
  unskipStep,
  withTourCard,
  type SnapshotInput,
  type TourCardPresentation,
  type TutorialSnapshot,
} from "./tutorial/tutorialEngine.ts";

const WS = "ws-tour";
const OTHER_WS = "ws-other";
const T0 = "2026-10-21T09:00:00.000Z";
const T0_MS = Date.parse(T0);
const NOW = "2026-10-21T09:30:00.000Z";
const LONG_BRIEF = "Add a contact form to the home page with name, email and a message.";

/** Which base steps a `done` assertion has covered: every one must be. */
const covered = new Set<string>();
function assertDone(snap: TutorialSnapshot, id: string, expected: boolean, why: string): void {
  const step = stepById(id);
  assert.ok(step, `${id} is a step`);
  assert.equal(step.done(snap), expected, `${id}: ${why}`);
  covered.add(id);
}

function card(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    workspaceId: WS,
    title: `Card ${id}`,
    columnId: "todo",
    createdAt: T0_MS + 60_000,
    updatedAt: T0_MS + 60_000,
    ...patch,
  };
}

/** The presentation each card reads as, by id. */
type Shown = { state: CardPresentationState; rule?: PresentationRule; session?: Pick<SessionFacts, "block" | "state"> | null; vendor?: "claude" | "codex"; shipMode?: "merge_live" | "pr" | "ship_it"; shipItToGitHub?: boolean | null; primary?: CardPrimaryActionId };

function input(
  record: TutorialProgress | null,
  opts: {
    cards?: KanbanCard[];
    otherCards?: KanbanCard[];
    shown?: Record<string, Shown>;
    mode?: CenterMode;
    active?: string | null;
    workspaces?: { id: string; name: string }[];
    workspacesLoaded?: boolean;
    boardLoaded?: boolean;
    tryRuns?: Record<string, { phase: TryPhase }>;
    ai?: { claude: boolean; codex: boolean };
    guidedCard?: SnapshotInput["guidedCard"];
  } = {},
): SnapshotInput {
  const shown = opts.shown ?? {};
  return {
    record,
    platform: "mac",
    level: "guided",
    workMode: "solo",
    plan: { teamAllowed: false },
    workspaces: {
      loaded: opts.workspacesLoaded ?? true,
      list: opts.workspaces ?? [
        { id: WS, name: "lyra" },
        { id: OTHER_WS, name: "vega" },
      ],
    },
    activeWorkspaceId: opts.active === undefined ? WS : opts.active,
    mode: opts.mode ?? "board",
    overlays: { allSkills: false, shipBatch: false, settings: false },
    ai: opts.ai ?? { claude: true, codex: true },
    boards: {
      [WS]: { loaded: opts.boardLoaded ?? true, cards: opts.cards ?? [] },
      [OTHER_WS]: { loaded: true, cards: opts.otherCards ?? [] },
    },
    present: (c): TourCardPresentation => {
      const s = shown[c.id] ?? { state: "draft" };
      return {
        state: s.state,
        rule: s.rule ?? "base",
        session: s.session ?? null,
        vendor: s.vendor ?? "claude",
        shipMode: s.shipMode ?? null,
        shipItToGitHub: s.shipItToGitHub ?? null,
        primary: s.primary ?? null,
      };
    },
    tryRuns: opts.tryRuns ?? {},
    guidedCard: opts.guidedCard ?? null,
  };
}

const snapshot = (record: TutorialProgress | null, opts: Parameters<typeof input>[1] = {}) =>
  buildTutorialSnapshot(input(record, opts));

const started: TutorialProgress = startFullTour(null, { now: T0, version: "1.167.0" });
const onCard = (patch: Partial<TutorialProgress> = {}): TutorialProgress => ({ ...withTourCard(started, WS, "c1"), ...patch });

// ── The manifest (§4) ────────────────────────────────────────────────────

{
  const ids = ALL_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "step ids are unique");
  assert.deepEqual(
    BASE_STEPS.map((s) => s.id),
    [
      STEP.howItWorks,
      STEP.openBoard,
      STEP.newCard,
      STEP.brief,
      STEP.startBuild,
      STEP.aiAsks,
      STEP.watchTerminals,
      STEP.whatCodeIs,
      STEP.finishCheck,
      STEP.tryIt,
      STEP.ship,
      STEP.permissions,
      STEP.secondCard,
    ],
    "B1–B11 with B5b and F4's question, in path order",
  );
  assert.equal(BASE_STEPS.filter((s) => s.counted).length, 10, "the base chapter counts 10 (B5b, F4's question and B11 are not)");
  assert.deepEqual(
    CHAPTERS.map((c) => c.id),
    ["base", "inbox-history", "talk", "terminals", "code", "library", "all-skills", "ship-batch", "team", "settings-search"],
    "the base chapter, then §6.1's optional chapters (TU-7); New in this version is each release's highlights, not a chapter",
  );
  const anchors = new Set<string>(TOUR_ANCHORS);
  assert.equal(anchors.size, TOUR_ANCHORS.length, "anchor ids are unique");
  assert.equal(
    TOUR_ANCHORS.length,
    26,
    "§4.3's first set, 1.173.0 A3's terminals-new-copy, B2's sidebar-area and E3's board-next-improvement",
  );
  assert.ok(anchors.has("terminals-new-copy"), "A3: New › In a new copy…");
  assert.ok(anchors.has("sidebar-area"), "B2: the area picker under the workspace's name");
  assert.ok(anchors.has("board-next-improvement"), "E3: Next improvement above the Board");
  assert.ok(anchors.has("card-try-it"), "B9's anchor is Try it's own (tryPanel.ts TRY_IT_TOUR)");
  for (const s of ALL_STEPS) {
    if (s.anchor) assert.ok(anchors.has(s.anchor), `${s.id}'s anchor is listed`);
    // `since`: the release that added or last changed the step's meaning,
    // never before the tour's own.
    assert.ok(compareVersions(s.since, TUTORIAL_SINCE) >= 0, `${s.id}: since the tour's release or later`);
    assert.match(s.since, /^\d+\.\d+\.\d+$/);
    assert.ok(s.copy.title.trim() && s.copy.body.trim(), `${s.id} has words`);
    if (s.cardBound) assert.ok(s.kind !== "explain", `${s.id}: a card step waits on the card`);
  }
  assert.equal(TUTORIAL_SINCE, "1.167.0");
  // The ids are the user guide's `<!-- tour:… -->` markers, exactly (§12.1 (3)).
  assert.deepEqual(
    BASE_STEPS.map((s) => s.id),
    [
      "base.how-it-works",
      "base.open-board",
      "base.new-card",
      "base.brief",
      "base.start-build",
      "base.ai-asks",
      "base.watch-terminals",
      "base.what-code-is",
      "base.finish-check",
      "base.try-it",
      "base.ship",
      "base.permissions",
      "base.second-card",
    ],
  );
  const guide = readFileSync(new URL("../../docs/onboarding/USER_GUIDE.md", import.meta.url), "utf8");
  const markers = [...guide.matchAll(/<!-- tour:([\w.-]+) -->/g)].map((m) => m[1]);
  assert.deepEqual(markers, ALL_STEPS.map((s) => s.id), "every step has its marker in the guide text, in order");
  // §12.1 (4): no banned words in the copy outside Why?.
  const banned = /\b(worktree|snapshot|origin|stash|rebase|fast-forward|PATH|CLI|sandbox|SHA)\b/;
  const lines = [
    ...ALL_STEPS.flatMap((s) => [s.copy.title, s.copy.body]),
    ...Object.values(ASK_COPY),
    ...Object.values(WAIT_COPY),
  ];
  for (const line of lines) assert.doesNotMatch(line, banned, line);
  // And ux-check's own list (it adds HEAD, diff, Build done and the old
  // "To do"), over every line the tour shows outside Why?: ux-check reads
  // the step bodies but not the typed Record constants.
  const { JARGON } = (await import(new URL("../../scripts/ux-check.mjs", import.meta.url).href)) as {
    JARGON: [string, RegExp][];
  };
  const shown = [
    ...lines,
    LOOP_DONE_COPY.title,
    LOOP_DONE_COPY.body,
    SHIP_PR_BODY,
    SHIP_PR_OPEN_LINE,
    SHIP_PR_AUTO_MERGE_LINE,
    SHIP_PR_PLYLOFT_MERGE_LINE,
    SHIP_UNKNOWN_BODY,
    START_BUILD_NOTE,
    START_BUILD_NOTE_CODEX,
    WHILE_BUILDING_LINE,
    SAFE_EXAMPLE_LINK,
    CONTINUE_GUIDED_LINK,
    ...STARTER_TITLES,
    ...SECOND_CARD_CHECKLIST,
    TRY_FALLBACK.beforeShip,
    TRY_FALLBACK.afterShip,
  ];
  // TX5 polish (owner D11): "second opinion" is Next improvement's own word,
  // so its tour step may say it; every other line the tour shows may not.
  const NI_STEP = "talk.next-improvement";
  const niLines = new Set(ALL_STEPS.filter((s) => s.id === NI_STEP).flatMap((s) => [s.copy.title, s.copy.body]));
  assert.equal(niLines.size, 2, `the ${NI_STEP} step exists`);
  const allowedIn = (word: string, line: string) => word === "second opinion" && niLines.has(line);
  for (const line of shown) {
    for (const [word, re] of JARGON) {
      if (allowedIn(word, line)) continue;
      assert.doesNotMatch(line, new RegExp(re.source, re.flags.replace("g", "")), `"${word}" in: ${line}`);
    }
  }
  // The allowance is that step's alone: the same words in another step's
  // body are still caught.
  const secondOpinion = JARGON.find(([word]) => word === "second opinion")![1];
  const elsewhere = "A second opinion sets aside ideas that only add.";
  assert.equal(allowedIn("second opinion", elsewhere), false);
  assert.match(elsewhere, new RegExp(secondOpinion.source, secondOpinion.flags.replace("g", "")));
  assert.equal(
    ALL_STEPS.filter((s) => s.id !== NI_STEP).some((s) => /\bsecond opinions?\b/i.test(`${s.copy.title} ${s.copy.body}`)),
    false,
    "no other step says second opinion",
  );
  // Mac words: "this Mac" and ⌘, never the Windows ones (machineWords maps them).
  for (const line of lines) assert.doesNotMatch(line, /this PC|Ctrl\+|File Explorer/, line);
  // The Builder is named by vendor.
  const b5 = stepById(STEP.startBuild)!;
  assert.match(stepCopy(b5, "claude").body, /^This starts Claude with your own subscription/);
  assert.match(stepCopy(b5, "codex").body, /^This starts Codex with your own subscription/);
  assert.doesNotMatch(stepCopy(stepById(STEP.howItWorks)!, "codex").why!, /\{ai\}/);
  for (const s of ALL_STEPS) {
    const c = stepCopy(s, "codex");
    assert.doesNotMatch(`${c.title} ${c.body} ${c.why ?? ""}`, /\{ai\}/, `${s.id}: every {ai} is filled`);
  }
  assert.equal(fillWords("{ai} and {unknown}", { ai: "Claude" }), "Claude and {unknown}");
  // B10 says pull request when the workspace ships as one (§11).
  assert.equal(stepCopy(stepById(STEP.ship)!, "claude").body, "Ship it puts the change into your project on this Mac.");
  assert.equal(stepCopy(stepById(STEP.ship)!, "claude", { shipsAs: "pr" }).body, "Ship it opens a pull request on GitHub and merges it when the checks pass.");
  // 1.171.0 A3: not known yet — true either way, never "on this Mac" alone.
  assert.equal(stepCopy(stepById(STEP.ship)!, "claude", { shipsAs: null }).body, SHIP_UNKNOWN_BODY);
  assert.equal(stepCopy(stepById(STEP.ship)!, "claude", { shipsAs: "merge" }).body, "Ship it puts the change into your project on this Mac.");
  assert.equal(SHIP_PR_AUTO_MERGE_LINE, "It merges when the checks pass.");
  assert.equal(SHIP_PR_PLYLOFT_MERGE_LINE, "Plyloft merges it when the checks pass — keep Plyloft open.");
}

// ── B1: explain, done by its own button only ─────────────────────────────

{
  const snap = snapshot(started);
  assertDone(snap, STEP.howItWorks, false, "never done by the app's state");
  assert.equal(observeTour(started, snap, NOW)?.done?.[STEP.howItWorks], undefined, "observing never marks B1");
  const next = completeStep(started, STEP.howItWorks, NOW);
  assert.equal(next.done?.[STEP.howItWorks], NOW, "Start marks it");
  assert.equal(completeStep(next, STEP.howItWorks, "2026-10-21T10:00:00Z").done?.[STEP.howItWorks], NOW, "the first time is kept");
  assert.equal(tourView(started, snap).step?.id, STEP.howItWorks, "a new tour starts on B1");
  assert.equal(tourView(next, snapshot(next, { mode: "code" })).step?.id, STEP.openBoard, "then B2");
}

// ── B2: the Board, in the tour workspace ─────────────────────────────────

{
  assertDone(snapshot(started, { mode: "board" }), STEP.openBoard, true, "Board in the tour workspace");
  assertDone(snapshot(started, { mode: "terminals" }), STEP.openBoard, false, "Terminals is not the Board");
  assertDone(snapshot(started, { mode: "board", active: OTHER_WS }), STEP.openBoard, true, "no card yet: the Board where you are (TU-5)");
  assertDone(snapshot(onCard(), { mode: "board", active: OTHER_WS, cards: [card("c1")] }), STEP.openBoard, false, "a card binds it: another workspace's Board");
  // No workspace at all (§11): Add your project first.
  const none = snapshot({ ...started, workspaceId: null }, { active: null, workspaces: [], mode: "board" });
  assertDone(none, STEP.openBoard, false, "no workspace, no Board");
  const r = completeStep({ ...started, workspaceId: null }, STEP.howItWorks, NOW);
  assert.equal(tourView(r, none).step?.id, STEP.openBoard);
  assert.equal(tourView(r, none).wait, "no-workspace");
  assert.equal(WAIT_COPY["no-workspace"], "Add your project first");
  // A workspace list not loaded yet says nothing.
  assert.equal(tourView(r, snapshot(r, { workspaces: [], workspacesLoaded: false, active: null })).wait, null);
}

// ── B3: a card made since the tour started ───────────────────────────────

{
  const before = card("old", { createdAt: T0_MS - 1 });
  assertDone(snapshot(started, { cards: [before] }), STEP.newCard, false, "a card older than the tour is not taken");
  assert.equal(snapshot(started, { cards: [before] }).adopt, null);

  const made = card("c1");
  const later = card("c2", { createdAt: T0_MS + 120_000 });
  const snap = snapshot(started, { cards: [later, made] });
  assertDone(snap, STEP.newCard, true, "a card made in the tour workspace since the start");
  assert.deepEqual(snap.adopt, { workspaceId: WS, cardId: "c1" }, "the first one made is the tour card");
  const next = observeTour(started, snap, NOW)!;
  assert.equal(next.cardId, "c1", "its id becomes tourCardId");
  assert.equal(next.workspaceId, WS);
  assert.equal(next.done?.[STEP.newCard], NOW);

  // Not taken: another workspace's card, an archived one, a pull request
  // review, a skill card.
  assert.equal(snapshot(started, { otherCards: [card("x", { workspaceId: OTHER_WS })] }).adopt, null);
  assert.equal(snapshot(started, { cards: [card("a", { archived: true })] }).adopt, null);
  assert.equal(
    snapshot(started, { cards: [card("p", { prReview: { number: 1 } as unknown as KanbanCard["prReview"] })] }).adopt,
    null,
  );
  assert.equal(
    snapshot(started, { cards: [card("s", { kind: { type: "skill" } as unknown as KanbanCard["kind"] })] }).adopt,
    null,
  );

  // The safe example: the guided first card, even in another workspace.
  const guided = card("g", { workspaceId: OTHER_WS });
  const g = snapshot(started, {
    otherCards: [guided],
    guidedCard: { workspaceId: OTHER_WS, cardId: "g", startedAt: NOW, endedAt: null },
  });
  assert.deepEqual(g.adopt, { workspaceId: OTHER_WS, cardId: "g" });
  assert.equal(observeTour(started, g, NOW)?.workspaceId, OTHER_WS, "the tour follows the guided card's workspace");
  // An older guided card (an old user's) is not taken by itself (§11 offers it).
  const old = snapshot(started, {
    otherCards: [card("g", { workspaceId: OTHER_WS, createdAt: T0_MS - 5 })],
    guidedCard: { workspaceId: OTHER_WS, cardId: "g", startedAt: "2026-09-01T00:00:00Z", endedAt: null },
  });
  assert.equal(old.adopt, null);
  // A tour card already named is never replaced by a newer card.
  assert.equal(snapshot(onCard(), { cards: [made, later] }).adopt, null);
}

// ── §11 Taking another card: it becomes the tour card ────────────────────

{
  const holder = { workspaceId: OTHER_WS, workspaceName: "vega", cardId: "busy", title: "Fix the header" };
  const r = completeStep(completeStep(started, STEP.howItWorks, NOW), STEP.openBoard, NOW);
  const snap = snapshot(r, {});
  const view = tourView(r, snap);
  assert.equal(view.step?.id, STEP.newCard);
  assert.equal(view.wait, null, "B3 never waits on another card: every plan builds in parallel");
  // Continue with a card: it becomes the tour card; B4/B5 are marked if already true.
  const used = withTourCard(r, holder.workspaceId, holder.cardId);
  const busy = card("busy", { workspaceId: OTHER_WS, title: holder.title, notes: LONG_BRIEF, createdAt: T0_MS - 999_999 });
  const after = snapshot(used, {
    otherCards: [busy],
    active: OTHER_WS,
    shown: { busy: { state: "running" } },
  });
  const next = observeTour(used, after, NOW)!;
  assert.equal(next.done?.[STEP.newCard], NOW);
  assert.equal(next.done?.[STEP.brief], NOW, "its brief was already written");
  assert.equal(next.done?.[STEP.startBuild], NOW, "it was already building");
  assert.equal(tourView(next, after).step?.id, STEP.finishCheck, "the tour goes on from there");
  assert.deepEqual(tourView(next, after).aside.map((s) => s.id), [STEP.watchTerminals, STEP.whatCodeIs]);
}

// ── B4: the brief, saved, long enough ────────────────────────────────────

{
  const short = "x".repeat(BRIEF_MIN_CHARS - 1);
  assertDone(snapshot(onCard(), { cards: [card("c1", { notes: short })] }), STEP.brief, false, "39 characters");
  assertDone(snapshot(onCard(), { cards: [card("c1", { notes: `  ${short}  ` })] }), STEP.brief, false, "spaces don't count");
  assertDone(snapshot(onCard(), { cards: [card("c1", { notes: "x".repeat(BRIEF_MIN_CHARS) })] }), STEP.brief, true, "40 characters");
  assertDone(snapshot(onCard(), { cards: [card("c1", { notes: null })] }), STEP.brief, false, "no brief");
  assertDone(snapshot(started), STEP.brief, false, "no tour card");
  // A card step is never marked without the tour card.
  const r = observeTour(started, snapshot(started, { mode: "code" }), NOW);
  assert.equal(r, null, "nothing to record");
}

// ── B5: Start build ──────────────────────────────────────────────────────

{
  const c = card("c1", { notes: LONG_BRIEF });
  for (const state of ["queued", "running"] as const) {
    assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state } } }), STEP.startBuild, true, state);
  }
  assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state: "ready" } } }), STEP.startBuild, false, "ready");
  assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state: "draft" } } }), STEP.startBuild, false, "draft");
  // A stopped card that was built counts: the build was started.
  assertDone(
    snapshot(onCard(), { cards: [{ ...c, lastRunStatus: "failed" } as KanbanCard], shown: { c1: { state: "failed" } } }),
    STEP.startBuild,
    true,
    "a failed run was a start",
  );
  // §11: the card's AI isn't ready — B5 waits with Finish setup.
  const r: TutorialProgress = { ...onCard(), done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW, [STEP.brief]: NOW } };
  const noCodex = snapshot(r, { cards: [c], shown: { c1: { state: "ready", vendor: "codex" } }, ai: { claude: true, codex: false } });
  assert.equal(tourView(r, noCodex).step?.id, STEP.startBuild);
  assert.equal(tourView(r, noCodex).wait, "ai-not-ready");
  assert.equal(fillWords(WAIT_COPY["ai-not-ready"], { ai: "Codex" }), "Codex isn't ready yet");
  assert.equal(tourView(r, snapshot(r, { cards: [c], shown: { c1: { state: "ready", vendor: "codex" } } })).wait, null);
  // In another workspace: Take me there.
  const elsewhere = snapshot(r, { cards: [c], active: OTHER_WS, shown: { c1: { state: "ready" } } });
  assert.equal(tourView(r, elsewhere).wait, "other-workspace");
  assert.equal(elsewhere.tourWorkspaceName, "lyra");
}

// ── B5b: when the AI asks (interrupt, never recorded) ────────────────────

{
  const c = card("c1", { notes: LONG_BRIEF });
  const cases: [Shown, string, string | null][] = [
    [{ state: "running", rule: "session-block", session: { state: null, block: { kind: "trust" } } }, "trust", null],
    [{ state: "running", rule: "session-block", session: { state: null, block: { kind: "bypass" } } }, "bypass", null],
    [
      { state: "running", rule: "session-block", session: { state: null, block: { kind: "usageLimit", resetsAt: "2026-10-21T15:40:00Z" } } },
      "usageLimit",
      "2026-10-21T15:40:00Z",
    ],
    [{ state: "running", rule: "builder-waiting", session: { state: "question", block: null } }, "waiting", null],
  ];
  for (const [shown, kind, resetsAt] of cases) {
    const snap = snapshot(onCard(), { cards: [c], shown: { c1: shown } });
    const view = tourView(onCard(), snap);
    assert.equal(view.interrupt?.step.id, STEP.aiAsks, kind);
    assert.equal(view.interrupt?.kind, kind);
    assert.equal(view.interrupt?.resetsAt, resetsAt);
    assertDone(snap, STEP.aiAsks, false, `held by ${kind}`);
    assert.equal(observeTour(onCard(), snap, NOW)?.done?.[STEP.aiAsks], undefined, "never recorded");
  }
  const clear = snapshot(onCard(), { cards: [c], shown: { c1: { state: "running" } } });
  assertDone(clear, STEP.aiAsks, true, "the state cleared");
  assert.equal(tourView(onCard(), clear).interrupt, null);
  // Not while the tour is ended.
  const heldSnap = snapshot(onCard(), { cards: [c], shown: { c1: cases[0][0] } });
  assert.equal(tourView(endTour(onCard(), NOW), heldSnap).interrupt, null);
  assert.match(fillWords(ASK_COPY.usageLimit, { ai: "Claude" }), /^Your Claude plan reached its limit for now\./);
}

// ── B6, B7: while the build runs, never blocking ─────────────────────────

{
  const c = card("c1", { notes: LONG_BRIEF });
  const running = { c1: { state: "running" as const } };
  assertDone(snapshot(onCard(), { cards: [c], shown: running, mode: "terminals" }), STEP.watchTerminals, true, "Terminals while it runs");
  assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state: "ready" } }, mode: "terminals" }), STEP.watchTerminals, false, "before the build");
  assertDone(snapshot(onCard(), { cards: [c], shown: running, mode: "terminals", active: OTHER_WS }), STEP.watchTerminals, false, "another workspace");
  assertDone(snapshot(onCard(), { cards: [c], shown: running, mode: "code" }), STEP.whatCodeIs, true, "Code while it runs");
  assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state: "ready-to-ship" } }, mode: "code" }), STEP.whatCodeIs, true, "Code once built: still to do, still doable");
  assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state: "draft" } }, mode: "code" }), STEP.whatCodeIs, false, "before the build");

  // While it runs the tour waits on B8 and offers B6/B7 beside it.
  const r: TutorialProgress = {
    ...onCard(),
    done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW, [STEP.brief]: NOW, [STEP.startBuild]: NOW },
  };
  const view = tourView(r, snapshot(r, { cards: [c], shown: running }));
  assert.equal(view.step?.id, STEP.finishCheck);
  assert.deepEqual(view.aside.map((s) => s.id), [STEP.watchTerminals, STEP.whatCodeIs]);
  // Build ended first: they stay to do, offered no more, never blocking.
  const after = tourView(r, snapshot(r, { cards: [c], shown: { c1: { state: "ready-to-ship" } } }));
  assert.deepEqual(after.aside, []);
  assert.notEqual(after.step?.id, STEP.watchTerminals);
  assert.equal(r.done?.[STEP.watchTerminals], undefined);
}

// ── B8: Finish and check ─────────────────────────────────────────────────

{
  const c = card("c1", { notes: LONG_BRIEF });
  for (const state of ["checking", "challenger-reviewing", "result-ready", "changes-requested", "ready-to-ship", "shipping"] as const) {
    assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state } } }), STEP.finishCheck, true, state);
  }
  for (const state of ["running", "queued", "ready", "failed", "paused"] as const) {
    assertDone(snapshot(onCard(), { cards: [c], shown: { c1: { state } } }), STEP.finishCheck, false, state);
  }
}

// ── B9: Try it, and changes requested (§11) ──────────────────────────────

{
  const c = card("c1", { notes: LONG_BRIEF, worktreePath: "/tmp/copy" });
  const ready = { c1: { state: "ready-to-ship" as const } };
  const key = tryRunKey(WS, "c1", null);
  assertDone(snapshot(onCard(), { cards: [c], shown: ready, tryRuns: { [key]: { phase: "running" } } }), STEP.tryIt, true, "Running");
  for (const phase of ["ask", "installing", "starting", "stopped", "failed"] as const) {
    assertDone(snapshot(onCard(), { cards: [c], shown: ready, tryRuns: { [key]: { phase } } }), STEP.tryIt, false, phase);
  }
  assertDone(
    snapshot(onCard(), { cards: [c], shown: ready, tryRuns: { [tryRunKey(WS, "c1", "a")]: { phase: "running" } } }),
    STEP.tryIt,
    true,
    "a Build with both lane's Try it",
  );
  assertDone(
    snapshot(onCard(), { cards: [c], shown: ready, tryRuns: { [tryRunKey(WS, "c10", null)]: { phase: "running" } } }),
    STEP.tryIt,
    false,
    "another card's Try it",
  );
  assert.equal(snapshot(onCard(), { cards: [c], shown: ready }).tourCard?.tryOffered, true, "offered once ready to ship");
  assert.equal(snapshot(onCard(), { cards: [c], shown: { c1: { state: "running" } } }).tourCard?.tryOffered, false);

  const r: TutorialProgress = {
    ...onCard(),
    done: {
      [STEP.howItWorks]: NOW,
      [STEP.openBoard]: NOW,
      [STEP.newCard]: NOW,
      [STEP.brief]: NOW,
      [STEP.startBuild]: NOW,
      [STEP.finishCheck]: NOW,
    },
  };
  const changes = tourView(r, snapshot(r, { cards: [c], shown: { c1: { state: "changes-requested" } } }));
  assert.equal(changes.step?.id, STEP.tryIt);
  assert.equal(changes.wait, "changes-requested", "B9 waits while the Builder has the Reviewer's changes");
  assert.match(WAIT_COPY["changes-requested"], /^The Reviewer asked for changes and the Builder has them\./);
  // 1.175.0 F5 round 2: a card set to "Waits for me" keeps the press's line.
  const waits = tourView(r, buildTutorialSnapshot({ ...input(r, { cards: [c], shown: { c1: { state: "changes-requested" } } }), checksByItself: () => false }));
  assert.equal(waits.wait, "changes-requested-press");
  assert.match(WAIT_COPY["changes-requested-press"], /When it's done, press Finish and check again\.$/);
  assert.match(WAIT_COPY["changes-requested"], /Plyloft checks the fixes by itself\.$/);
  const stopped = tourView(r, snapshot(r, { cards: [c], shown: { c1: { state: "failed" } } }));
  assert.equal(stopped.wait, "stopped");
  assert.equal(tourView(r, snapshot(r, { cards: [c], shown: ready })).wait, null);
  // Skipped: the tour goes on to Ship it (§6.3's fallback is TU-5's).
  assert.equal(tourView(skipStep(r, STEP.tryIt, NOW), snapshot(r, { cards: [c], shown: ready })).step?.id, STEP.ship);
}

// ── B10: Ship it — a local merge, a merged or an open pull request ───────

{
  const ready = { c1: { state: "ready-to-ship" as const } };
  assertDone(snapshot(onCard(), { cards: [card("c1")], shown: ready }), STEP.ship, false, "not shipped yet");
  assertDone(snapshot(onCard(), { cards: [card("c1", { shipStatus: "shipped" })], shown: { c1: { state: "shipped" } } }), STEP.ship, true, "shipped");
  assertDone(snapshot(onCard(), { cards: [card("c1", { reviewStatus: "merged" })], shown: { c1: { state: "shipped" } } }), STEP.ship, true, "merged");
  const pr = (state: "open" | "closed" | "merged") =>
    card("c1", { prUrl: "https://github.com/o/r/pull/7", pr: { number: 7, state } as unknown as KanbanCard["pr"] });
  const open = snapshot(onCard(), { cards: [pr("open")], shown: { c1: { state: "ready-to-ship", shipMode: "pr" } } });
  assertDone(open, STEP.ship, true, "the pull request is open: the loop is complete");
  assert.equal(open.tourCard?.prOpen, true);
  assert.equal(open.tourCard?.shipsAs, "pr");
  // G1: Ship it says where it goes — a pull request on GitHub, a merge
  // here where it lands on this Mac (no GitHub, or Only on this Mac).
  const shipIt = (shipItToGitHub: boolean | null) =>
    snapshot(onCard(), { cards: [card("c1")], shown: { c1: { state: "ready-to-ship", shipMode: "ship_it", shipItToGitHub } } }).tourCard?.shipsAs;
  assert.equal(shipIt(true), "pr", "Ship it on GitHub");
  assert.equal(shipIt(false), "merge", "Ship it that lands here");
  assert.equal(shipIt(null), null, "not known yet");
  assertDone(snapshot(onCard(), { cards: [pr("closed")], shown: ready }), STEP.ship, false, "a closed pull request");
  assertDone(snapshot(onCard(), { cards: [card("c1", { prUrl: "https://github.com/o/r/pull/7" })], shown: ready }), STEP.ship, false, "a link with no state read");
  // An auto-archived landed card still reads shipped.
  const archived = snapshot(onCard(), { cards: [card("c1", { shipStatus: "shipped", archived: true })], shown: { c1: { state: "archived" } } });
  assertDone(archived, STEP.ship, true, "landed, then archived");
  assert.equal(archived.tourCard?.rank, 4);
}

// ── B11: a second card, on your own ──────────────────────────────────────

{
  const shipped = card("c1", { shipStatus: "shipped" });
  const second = card("c2", { shipStatus: "shipped", createdAt: T0_MS + 900_000 });
  const shown = { c1: { state: "shipped" as const }, c2: { state: "shipped" as const } };
  assertDone(snapshot(onCard(), { cards: [shipped, second], shown }), STEP.secondCard, true, "a second card shipped");
  assertDone(snapshot(onCard(), { cards: [shipped, card("c2")], shown }), STEP.secondCard, false, "the second card not shipped");
  assertDone(snapshot(onCard(), { cards: [shipped, card("c2", { shipStatus: "shipped", createdAt: T0_MS - 10 })], shown }), STEP.secondCard, false, "a card older than the tour");
  assertDone(snapshot(onCard(), { cards: [card("c1"), second], shown: { c1: { state: "ready-to-ship" }, c2: { state: "shipped" } } }), STEP.secondCard, false, "before the tour card shipped");
  assertDone(snapshot(onCard(), { cards: [shipped], otherCards: [{ ...second, workspaceId: OTHER_WS }], shown }), STEP.secondCard, true, "in another project too");
  // B10 done → B11 is next; then the chapter is complete.
  const all = Object.fromEntries(BASE_STEPS.filter((s) => s.id !== STEP.secondCard).map((s) => [s.id, NOW]));
  const r: TutorialProgress = { ...onCard(), done: all };
  assert.equal(tourView(r, snapshot(r, { cards: [shipped], shown })).step?.id, STEP.secondCard);
  // 1.175.0 F4: the permissions question is never the step the tour points
  // at, even while it is open; it is the panel's own (tourPanel).
  const open: TutorialProgress = { ...r, done: Object.fromEntries(Object.entries(all).filter(([id]) => id !== STEP.permissions)) };
  assert.equal(tourView(open, snapshot(open, { cards: [shipped], shown })).step?.id, STEP.secondCard, "F4: not pointed at");
  assert.equal(tourView(open, snapshot(open, { cards: [shipped], shown })).total, 10, "F4: not counted");
  const finished = observeTour(r, snapshot(r, { cards: [shipped, second], shown }), NOW)!;
  assert.equal(tourView(finished, snapshot(finished, { cards: [shipped, second], shown })).step, null, "the chapter is complete");
  assert.equal(tourView(finished, snapshot(finished)).doneCount, 10, "10 of 10");
}

// ── Steps done out of order (§7) ─────────────────────────────────────────

{
  // The tour started on a card already ready to ship, with Code open: every
  // step about the card that holds is recorded at once, not only the
  // current one. Where you are (B7: Code) is not: it counts out of order
  // only once it becomes true while the tour runs (TU-4 Mac walk).
  const c = card("c1", { notes: LONG_BRIEF, worktreePath: "/tmp/copy" });
  const snap = snapshot(started, { cards: [c], shown: { c1: { state: "ready-to-ship" } }, mode: "code" });
  const next = observeTour(started, snap, NOW)!;
  assert.deepEqual(
    Object.keys(next.done ?? {}).sort(),
    [STEP.newCard, STEP.brief, STEP.startBuild, STEP.finishCheck].sort(),
  );
  assert.equal(observeTour(next, snap, NOW, { before: snap }), null, "Code still open: no fresh change");
  const onBoard = snapshot(next, { cards: [c], shown: { c1: { state: "ready-to-ship" } }, mode: "board" });
  const toCode = observeTour(next, snap, NOW, { before: onBoard })!;
  assert.equal(toCode.done?.[STEP.whatCodeIs], NOW, "opened Code while the tour runs: B7 out of order");
  // B1 still first (explain), then B2 (Board not open), then Try it.
  assert.equal(tourView(next, snap).step?.id, STEP.howItWorks);
  const later = completeStep(completeStep(next, STEP.howItWorks, NOW), STEP.openBoard, NOW);
  assert.equal(tourView(later, snap).step?.id, STEP.tryIt, "B6 doesn't block: the build is over");
  // A brief that never reached 40 characters is passed once the build began.
  const shortCard = card("c1", { notes: "short", worktreePath: "/tmp/copy" });
  const s2 = snapshot(later, { cards: [shortCard], shown: { c1: { state: "ready-to-ship" } } });
  const r2: TutorialProgress = { ...later, done: { ...later.done } };
  delete r2.done![STEP.brief];
  assert.equal(tourView(r2, s2).step?.id, STEP.tryIt, "B4 stays to do but doesn't hold the tour");
  // Shipped before Try it: B9 is passed (it stays to do).
  const s3 = snapshot(later, { cards: [card("c1", { shipStatus: "shipped" })], shown: { c1: { state: "shipped" } } });
  const r3 = observeTour(later, s3, NOW)!;
  assert.equal(r3.done?.[STEP.ship], NOW);
  assert.equal(r3.done?.[STEP.tryIt], undefined);
  assert.equal(tourView(r3, s3).step?.id, STEP.secondCard);
  // Already recorded: nothing new, no write.
  assert.equal(observeTour(r3, s3, "2026-10-21T11:00:00Z"), null);
}

// ── The card deleted, its workspace removed (§7) ─────────────────────────

{
  const r: TutorialProgress = {
    ...onCard(),
    done: {
      [STEP.howItWorks]: NOW,
      [STEP.openBoard]: NOW,
      [STEP.newCard]: NOW,
      [STEP.brief]: NOW,
      [STEP.startBuild]: NOW,
      [STEP.whatCodeIs]: NOW,
      "z99.from-a-newer-app": NOW,
    },
    skipped: { [STEP.watchTerminals]: NOW, "q.unknown": NOW },
  };
  const deleted = snapshot(r, { cards: [card("other", { createdAt: T0_MS - 5 })] });
  assert.equal(deleted.tourCardGone, "board", "the loaded board lacks it: the disk is asked");
  assert.equal(deleted.tourCard, null);
  assert.equal(snapshot(r, { cards: [], boardLoaded: false }).tourCardGone, null, "a board not loaded concludes nothing");
  const back = cardGone(r);
  assert.equal(back.cardId, null);
  assert.equal(back.workspaceId, null, "its workspace goes with it (TU-5): B3 follows the active one");
  assert.deepEqual(Object.keys(back.done ?? {}).sort(), [STEP.howItWorks, STEP.openBoard, "z99.from-a-newer-app"].sort());
  assert.deepEqual(Object.keys(back.skipped ?? {}), ["q.unknown"]);
  const view = tourView(back, snapshot(back), { cardGone: true });
  assert.equal(view.step?.id, STEP.newCard, "back to B3");
  assert.equal(view.wait, "card-gone");
  assert.equal(WAIT_COPY["card-gone"], "That card is gone. Start another one.");
  // The old card doesn't come back as a new one.
  assert.equal(snapshot(back, { cards: [card("other", { createdAt: T0_MS - 5 })] }).adopt, null);

  const removed = snapshot(r, { workspaces: [{ id: OTHER_WS, name: "vega" }] });
  assert.equal(removed.tourCardGone, "workspace", "its workspace is gone: final");
  const back2 = cardGone(r);
  assert.equal(back2.workspaceId, null);
  assert.equal(back2.cardId, null);
  assert.equal(
    snapshot(r, { workspaces: [], workspacesLoaded: false, cards: [card("c1")] }).tourCardGone,
    null,
    "the list not loaded concludes nothing",
  );
}

// ── Pause, resume, skip, end, start over (§9) ────────────────────────────

{
  assert.equal(tourRunning(null), false);
  assert.equal(tourRunning({ tips: true }), false, "a record alone is not a started tour");
  assert.equal(started.startedAt, T0);
  assert.equal(started.startedVersion, "1.167.0", "the version the tour first started on");
  assert.equal(started.path, "full");
  assert.equal(tourRunning(started), true);

  const paused = pauseTour(started);
  assert.equal(paused.paused, true);
  assert.equal(tourRunning(paused), true, "a paused tour is still under way");
  assert.equal(resumeTour(paused).paused, false);

  const ended = endTour(onCard({ done: { [STEP.howItWorks]: NOW } }), NOW);
  assert.equal(ended.endedAt, NOW);
  assert.equal(tourRunning(ended), false);
  assert.equal(endTour(ended, "2026-10-22T00:00:00Z").endedAt, NOW, "ending twice keeps the first time");
  assert.equal(observeTour(ended, snapshot(ended, { cards: [card("c1", { notes: LONG_BRIEF })] }), NOW), null, "no-op once ended");
  assert.equal(observeTour(null, snapshot(null, { cards: [card("c1")] }), NOW), null, "no-op before any start");
  assert.equal(observeTour({ tips: true }, snapshot({ tips: true }, { cards: [card("c1")] }), NOW), null);
  // Start again after an end: reversible, where it was.
  const again = startFullTour(ended, { now: "2026-10-23T00:00:00Z", version: "1.170.0" });
  assert.equal(again.endedAt, null);
  assert.equal(again.startedAt, T0);
  assert.equal(again.startedVersion, "1.167.0", "set once");
  assert.equal(again.workspaceId, WS, "the card's workspace stays with its card");
  assert.equal(again.done?.[STEP.howItWorks], NOW);
  // The quick tour only says which was last started.
  const quick = startQuickTour({ tips: false });
  assert.deepEqual(quick, { tips: false, path: "quick" });
  assert.equal(tourRunning(quick), false);
  // A first start keeps an earlier record's keys.
  assert.equal(startFullTour({ tips: false, seenSections: ["board"] }, { now: T0, version: "1.167.0" }).tips, false);

  const skipped = skipStep(started, STEP.openBoard, NOW);
  assert.equal(skipped.skipped?.[STEP.openBoard], NOW);
  assert.equal(skipStep(completeStep(started, STEP.howItWorks, NOW), STEP.howItWorks, NOW).skipped?.[STEP.howItWorks], undefined, "a done step isn't skipped");
  const r = completeStep(skipped, STEP.howItWorks, NOW);
  assert.equal(tourView(r, snapshot(r, { mode: "code" })).step?.id, STEP.newCard, "a skipped step is passed");
  assert.equal(unskipStep(r, STEP.openBoard).skipped?.[STEP.openBoard], undefined, "Do it now");
  assert.equal(tourView(unskipStep(r, STEP.openBoard), snapshot(r, { mode: "code" })).step?.id, STEP.openBoard);

  const chapter = skipChapter(completeStep(started, STEP.howItWorks, NOW), "base", NOW);
  assert.equal(chapter.done?.[STEP.howItWorks], NOW);
  assert.equal(chapter.skipped?.[STEP.howItWorks], undefined, "done steps stay done");
  assert.equal(chapter.skipped?.[STEP.aiAsks], undefined, "B5b is never recorded");
  assert.equal(Object.keys(chapter.skipped ?? {}).length, BASE_STEPS.length - 2);
  assert.equal(tourView(chapter, snapshot(chapter)).step, null);

  // Start over: done, skipped, the card and the end go; the rest stays.
  const full: TutorialProgress & Record<string, unknown> = {
    ...onCard(),
    done: { [STEP.howItWorks]: NOW, "z99.from-a-newer-app": NOW },
    skipped: { [STEP.watchTerminals]: NOW },
    endedAt: NOW,
    paused: true,
    seenVersion: "1.166.0",
    tips: false,
    seenSections: ["board", "inbox"],
    lastChapter: "terminals",
  };
  const over = startOver(full, "2026-10-24T00:00:00Z") as TutorialProgress & Record<string, unknown>;
  assert.deepEqual(over.done, {});
  assert.deepEqual(over.skipped, {});
  assert.equal(over.cardId, null);
  assert.equal(over.endedAt, null);
  assert.equal(over.paused, false);
  assert.equal(over.startedAt, "2026-10-24T00:00:00Z", "B3 looks for a card made from now on");
  assert.equal(over.seenVersion, "1.166.0");
  assert.equal(over.tips, false);
  assert.deepEqual(over.seenSections, ["board", "inbox"]);
  assert.equal(over.startedVersion, "1.167.0");
  assert.equal(over.workspaceId, null, "the card's workspace goes with it (TU-5)");
  assert.equal(over.path, "full");
  assert.equal(over.lastChapter, "terminals", "a newer app's key survives");
  assert.equal(tourRunning(over), true);
  assert.equal(tourView(over, snapshot(over)).step?.id, STEP.howItWorks, "from the top");
}

// ── Unknown step ids and keys survive every reducer ──────────────────────

{
  const odd = {
    ...onCard(),
    done: { "z99.from-a-newer-app": NOW },
    skipped: { "q.unknown": NOW },
    lastChapter: "terminals",
  } as TutorialProgress & Record<string, unknown>;
  const c = card("c1", { notes: LONG_BRIEF });
  const reducers: [string, (r: TutorialProgress) => TutorialProgress | null][] = [
    ["observeTour", (r) => observeTour(r, snapshot(r, { cards: [c], shown: { c1: { state: "running" } } }), NOW)],
    ["completeStep", (r) => completeStep(r, STEP.howItWorks, NOW)],
    ["skipStep", (r) => skipStep(r, STEP.openBoard, NOW)],
    ["unskipStep", (r) => unskipStep(skipStep(r, STEP.openBoard, NOW), STEP.openBoard)],
    ["skipChapter", (r) => skipChapter(r, "base", NOW)],
    ["pauseTour", pauseTour],
    ["resumeTour", resumeTour],
    ["endTour", (r) => endTour(r, NOW)],
    ["cardGone", (r) => cardGone(r)],
    ["withTourCard", (r) => withTourCard(r, WS, "c9")],
    ["startFullTour", (r) => startFullTour(r, { now: NOW, version: "1.170.0" })],
  ];
  for (const [name, reduce] of reducers) {
    const out = reduce(odd) as (TutorialProgress & Record<string, unknown>) | null;
    assert.ok(out, `${name} changes something`);
    assert.equal(out.done?.["z99.from-a-newer-app"], NOW, `${name} keeps an unknown done id`);
    assert.equal(out.skipped?.["q.unknown"], NOW, `${name} keeps an unknown skipped id`);
    assert.equal(out.lastChapter, "terminals", `${name} keeps a newer app's key`);
    assert.notEqual(out, odd, `${name} returns a new record`);
  }
  // The input is never changed in place.
  assert.deepEqual(odd.done, { "z99.from-a-newer-app": NOW });
  // An unknown id doesn't count as a step or hold the tour.
  assert.equal(tourView(odd, snapshot(odd)).doneCount, 0);
}

// ── Challenger round 1: the gaps ─────────────────────────────────────────

{
  const b2 = completeStep(started, STEP.howItWorks, NOW);
  // B2/B3 count where the user is before a card (TU-5): no Take me there.
  const elsewhere = tourView(b2, snapshot(b2, { active: OTHER_WS }));
  assert.equal(elsewhere.step?.id, STEP.openBoard);
  assert.equal(elsewhere.wait, null);
  assert.equal(tourView(b2, snapshot(b2)).wait, null, "in the tour workspace: nothing to wait on");
  // Once a card binds the tour, a B2 done again (Do it now) elsewhere says where.
  const boundB2 = unskipStep(skipStep(onCard({ done: { [STEP.howItWorks]: NOW } }), STEP.openBoard, NOW), STEP.openBoard);
  assert.equal(tourView(boundB2, snapshot(boundB2, { active: OTHER_WS, cards: [card("c1")] })).wait, "other-workspace");

  // The record's workspace removed before any card: the active one stands
  // in, so B2/B3 can still be done (and B3's card names the workspace).
  const stale: TutorialProgress = { ...b2, workspaceId: "ws-removed" };
  const ss = snapshot(stale, { cards: [card("n1")] });
  assert.equal(ss.tourWorkspaceId, WS);
  assert.equal(ss.tourCardGone, null);
  assert.deepEqual(ss.adopt, { workspaceId: WS, cardId: "n1" });
  assert.equal(observeTour(stale, ss, NOW)?.workspaceId, WS);
  assert.equal(snapshot(stale, { workspacesLoaded: false }).tourWorkspaceId, WS, "no card: the active one, loaded or not");

  // A new card made while another builds is the tour card, and B5 doesn't wait.
  const r5: TutorialProgress = { ...onCard(), done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW, [STEP.brief]: NOW } };
  const v5 = tourView(r5, snapshot(r5, { cards: [card("c1", { notes: LONG_BRIEF })], shown: { c1: { state: "ready" } } }));
  assert.equal(v5.step?.id, STEP.startBuild);
  assert.equal(v5.wait, null);

  // Ship it recorded, then the card deleted (or its workspace removed):
  // nothing is taken back, and the leftovers don't hold the tour.
  const shippedRecord: TutorialProgress = {
    ...onCard(),
    done: Object.fromEntries(
      [STEP.howItWorks, STEP.openBoard, STEP.newCard, STEP.brief, STEP.startBuild, STEP.finishCheck, STEP.ship].map((id) => [id, NOW]),
    ),
  };
  const deletedAfter = snapshot(shippedRecord, { cards: [] });
  assert.equal(deletedAfter.tourCardGone, null, "deleted after Ship it: not gone for the tour");
  assert.equal(snapshot(shippedRecord, { workspaces: [{ id: OTHER_WS, name: "vega" }] }).tourCardGone, null);
  assert.equal(tourView(shippedRecord, deletedAfter).step?.id, STEP.secondCard, "B9 left to do is past");
  assert.equal(observeTour(shippedRecord, deletedAfter, NOW), null, "no write");
  // B11 still ticks from the record once the tour card is gone.
  const second = card("c2", { shipStatus: "shipped", createdAt: T0_MS + 900_000 });
  assert.equal(snapshot(shippedRecord, { cards: [second] }).secondCardLanded, true);
  // B11 counts B10's way (a pull request open), and only ordinary cards.
  const shippedC1 = card("c1", { shipStatus: "shipped" });
  const prOpen = card("c2", { createdAt: T0_MS + 900_000, prUrl: "https://github.com/o/r/pull/8", pr: { state: "open" } as KanbanCard["pr"] });
  assert.equal(snapshot(onCard(), { cards: [shippedC1, prOpen], shown: { c1: { state: "shipped" } } }).secondCardLanded, true, "an open pull request");
  const review = card("c2", { shipStatus: "shipped", createdAt: T0_MS + 900_000, prReview: { number: 1 } as unknown as KanbanCard["prReview"] });
  assert.equal(snapshot(onCard(), { cards: [shippedC1, review], shown: { c1: { state: "shipped" } } }).secondCardLanded, false, "a pull request review is not a second card");
  // The record's own card, read back after a deletion, is not a second card.
  assert.equal(snapshot(shippedRecord, { cards: [shippedC1] }).secondCardLanded, false);

  // Start over after the quick tour: the full tour again.
  assert.equal(startOver(startQuickTour(onCard()), NOW).path, "full");
  // Start over wipes every done and skipped id, a newer app's too (§9:
  // "clears done, skipped"; §8.1's rule is about saves, not a reset).
  const wiped = startOver({ ...onCard(), done: { "z99.from-a-newer-app": NOW }, skipped: { "q.unknown": NOW } }, NOW);
  assert.deepEqual([wiped.done, wiped.skipped], [{}, {}]);
}

// ── TU-4 Mac walk 1: Do it now makes its step the current one ────────────

{
  const NOW2 = "2026-10-21T10:00:00.000Z";
  const chapter = skipChapter(completeStep(onCard(), STEP.howItWorks, NOW), "base", NOW);
  const ready = card("c1", { notes: LONG_BRIEF });
  const readyShown = { c1: { state: "ready" as const, primary: "start-build" as const } };
  const runningShown = { c1: { state: "running" as const, primary: "inspect-run" as const } };
  for (const id of [STEP.watchTerminals, STEP.whatCodeIs]) {
    const r = unskipStep(chapter, id);
    // Before: Do it now only took "Skipped" away — no step, That's the loop.
    const limbo = snapshot(r, { cards: [ready], shown: readyShown });
    assert.equal(tourView(r, limbo).step, null, `${id}: no focus, the old limbo`);
    // With the press remembered: the step is the current one, even offered
    // beside the current one (aside), and the panel is not "finished".
    const v = tourView(r, limbo, { focus: id });
    assert.equal(v.step?.id, id, `${id}: Do it now makes it current`);
    assert.equal(v.wait, "build-not-started", `${id}: before the build, the panel says what comes first`);
    const pv = panelView(r, limbo, { focus: id });
    assert.equal(pv.rows.find((row) => row.step.id === id)?.status, "current");
    assert.equal(pv.finished, null, "not That's the loop");
    assert.equal(pv.pointing?.step.id, id, "the coach-mark's step");
    // While the build runs it points at the row, nothing to wait on.
    const run = snapshot(r, { cards: [ready], shown: runningShown });
    const vr = tourView(r, run, { focus: id });
    assert.equal(vr.step?.id, id);
    assert.equal(vr.wait, null);
    assert.equal(panelView(r, run, { focus: id }).pointing?.ready, true);
    assert.ok(!vr.aside.some((st) => st.id === id), "not offered twice");
    // Done or skipped again: the focus no longer holds.
    assert.equal(tourView(skipStep(r, id, NOW2), run, { focus: id }).step, null);
    // As the current step, being there counts as it is (no fresh change needed).
    const there = snapshot(r, { cards: [ready], shown: runningShown, mode: id === STEP.watchTerminals ? "terminals" : "code" });
    assert.equal(observeTour(r, there, NOW2, { focus: id })?.done?.[id], NOW2, `${id} done while focused`);
  }
  // No card yet: the card's steps say to make one first.
  const noCard = unskipStep(skipChapter(completeStep(started, STEP.howItWorks, NOW), "base", NOW), STEP.watchTerminals);
  assert.equal(tourView(noCard, snapshot(noCard), { focus: STEP.watchTerminals }).wait, "no-card");
  // A passed step (B4 once the build began) is current again with Do it now.
  const passedR: TutorialProgress = {
    ...onCard(),
    done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW, [STEP.startBuild]: NOW },
  };
  const shortRun = snapshot(passedR, { cards: [card("c1", { notes: "short" })], shown: runningShown });
  assert.equal(tourView(passedR, shortRun).step?.id, STEP.finishCheck, "B4 passed");
  assert.equal(tourView(passedR, shortRun, { focus: STEP.brief }).step?.id, STEP.brief, "Do it now on a passed step");
}

// ── TU-4 Mac walk 2: card steps wait for the card, card-primary checked ──

{
  const four: TutorialProgress = {
    ...onCard(),
    done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW, [STEP.brief]: NOW },
  };
  const c = card("c1", { notes: LONG_BRIEF });
  // B5 on its own button: pointed at.
  const b5 = snapshot(four, { cards: [c], shown: { c1: { state: "ready", primary: "start-build" } } });
  assert.equal(tourView(four, b5).step?.id, STEP.startBuild);
  assert.equal(panelView(four, b5).pointing?.ready, true);
  // 1.171.0 C1 (CF5): B5 on a card with only its title — Start build is its
  // primary, so B5 points at it.
  const draft = snapshot(four, { cards: [card("c1")], shown: { c1: { state: "draft", primary: "start-build" } } });
  assert.equal(tourView(four, draft).wait, null);
  assert.equal(panelView(four, draft).pointing?.ready, true);
  // B5 while the card is still being planned: it waits.
  const planning = snapshot(four, { cards: [card("c1")], shown: { c1: { state: "intake-live", primary: "open-conversation" } } });
  assert.equal(tourView(four, planning).wait, "brief-first");
  assert.equal(panelView(four, planning).pointing?.ready, false);
  // B5 skipped, the build never started: B8 waits, and never points at Start build.
  const skipped = skipStep(four, STEP.startBuild, NOW);
  const v = tourView(skipped, b5);
  assert.equal(v.step?.id, STEP.finishCheck);
  assert.equal(v.wait, "build-not-started");
  assert.equal(WAIT_COPY["build-not-started"], "Start the build first");
  const pv = panelView(skipped, b5);
  assert.equal(pv.pointing?.ready, false, "Start build is not B8's control");
  assert.equal(pv.progress, "4 of 10", "four done; skipped is not done");
  assert.deepEqual(
    pv.rows.filter((row) => row.step.aside).map((row) => row.status),
    ["todo", "todo"],
    "B6/B7 stay to do: they are offered once the build runs",
  );
  // B8 while the Builder works: Open session is not Finish and check.
  const b8 = { ...four, done: { ...four.done, [STEP.startBuild]: NOW } };
  const working = snapshot(b8, { cards: [c], shown: { c1: { state: "running", primary: "inspect-run" } } });
  assert.equal(tourView(b8, working).wait, "still-building");
  assert.equal(panelView(b8, working).pointing?.ready, false);
  const stoppedTurn = snapshot(b8, { cards: [c], shown: { c1: { state: "running", primary: "finish-and-check" } } });
  assert.equal(tourView(b8, stoppedTurn).wait, null);
  assert.equal(panelView(b8, stoppedTurn).pointing?.ready, true, "Finish and check: pointed at");
  // B10 made current early (B8, B9 skipped): it waits until ready to ship.
  const b10 = skipStep(skipStep(b8, STEP.finishCheck, NOW), STEP.tryIt, NOW);
  assert.equal(tourView(b10, working).step?.id, STEP.ship);
  assert.equal(tourView(b10, working).wait, "not-checked");
  assert.equal(panelView(b10, working).pointing?.ready, false);
  const shipNow = snapshot(b10, { cards: [c], shown: { c1: { state: "ready-to-ship", primary: "ship" } } });
  assert.equal(tourView(b10, shipNow).wait, null);
  assert.equal(panelView(b10, shipNow).pointing?.ready, true);
  // The card the record names, its board not loaded yet: no "no card" flash.
  assert.equal(tourView(four, snapshot(four, { boardLoaded: false })).wait, null);
}

// ── TU-4 Mac walk 3: Start over is a real restart ────────────────────────

{
  const NOW2 = "2026-10-21T10:00:00.000Z";
  const was = onCard({ done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW } });
  const over = startOver(was, NOW2);
  const onBoard = snapshot(over, { mode: "board" });
  // The Board already open is not B2 done: 0 of 10, B1.
  assert.equal(observeTour(over, onBoard, NOW2), null, "the first look after Start over");
  assert.equal(observeTour(over, onBoard, NOW2, { before: onBoard }), null, "still the same place");
  assert.equal(tourView(over, onBoard).step?.id, STEP.howItWorks);
  assert.equal(panelView(over, onBoard).progress, "0 of 10");
  // The same on a first start from the Board.
  assert.equal(observeTour(started, snapshot(started, { mode: "board" }), NOW2), null);
  // After B1, B2 is the current step: being on the Board counts as it is.
  const b1 = completeStep(over, STEP.howItWorks, NOW2);
  assert.equal(observeTour(b1, onBoard, NOW2, { before: onBoard })?.done?.[STEP.openBoard], NOW2);
  // Out of order (§7) still works: the Board opened while B1 is current.
  const inCode = snapshot(over, { mode: "code" });
  assert.equal(observeTour(over, onBoard, NOW2, { before: inCode })?.done?.[STEP.openBoard], NOW2);
}

// ── TU-4 Mac walk 3b: a place known only as the stores load is not a visit ──

{
  const NOW2 = "2026-10-21T10:00:00.000Z";
  const over = startOver(onCard({ done: { [STEP.howItWorks]: NOW } }), NOW2);
  const onBoard = snapshot(over, { mode: "board" });
  // A relaunch on the Board: the workspaces load after the first look.
  const loading = snapshot(over, { workspacesLoaded: false, active: null, workspaces: [] });
  assert.equal(observeTour(over, onBoard, NOW2, { before: loading }), null, "the Board open at launch is not B2");
  // The Board opened from Code once everything is known still counts (§7).
  assert.equal(observeTour(over, onBoard, NOW2, { before: snapshot(over, { mode: "code" }) })?.done?.[STEP.openBoard], NOW2);

  const r = onCard({ done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW, [STEP.brief]: NOW } });
  const c = card("c1", { notes: LONG_BRIEF });
  const inTerminalsReady = snapshot(r, { cards: [c], shown: { c1: { state: "ready" } }, mode: "terminals" });
  const inTerminalsRunning = snapshot(r, { cards: [c], shown: { c1: { state: "running" } }, mode: "terminals" });
  // Terminals already open when the build starts: B6 counts (it became true).
  assert.equal(
    observeTour(r, inTerminalsRunning, NOW2, { before: inTerminalsReady })?.done?.[STEP.watchTerminals],
    NOW2,
    "Terminals open as the build starts: B6",
  );
  // The card's board read after the first look: not a visit.
  const boardLoading = snapshot(r, { cards: [], boardLoaded: false, mode: "terminals" });
  const v = observeTour(r, inTerminalsRunning, NOW2, { before: boardLoading });
  assert.equal(v?.done?.[STEP.watchTerminals], undefined, "the board loading is not B6");
}

// ── TU-4 Mac walk 4, TU-7: "Pick a chapter below" now that there are ─────

{
  const done = Object.fromEntries(BASE_STEPS.filter((st) => st.kind !== "interrupt").map((st) => [st.id, NOW]));
  const r = onCard({ done });
  const pv = panelView(r, snapshot(r));
  assert.ok(CHAPTERS.length > 1, "TU-7 wrote the optional chapters");
  assert.equal(pv.finished?.title, "That's the loop");
  assert.equal(pv.finished?.body, LOOP_DONE_COPY.body);
  assert.notEqual(pv.finished?.body, LOOP_DONE_ALONE_BODY);
  assert.match(pv.finished?.body ?? "", /Pick a chapter below/);
  assert.ok(pv.chapters.length > 0, "and the chapters are below it");
}

// ── 1.175.0 F4: the permissions question under "That's the loop" ───────

{
  const done = Object.fromEntries(
    BASE_STEPS.filter((st) => st.kind !== "interrupt" && st.id !== STEP.permissions).map((st) => [st.id, NOW]),
  );
  const r = onCard({ done });
  const asked = panelView(r, snapshot(r));
  assert.equal(asked.finished?.title, "That's the loop");
  assert.equal(asked.finished?.body, "Describe, build, check, ship.", "short while the question is open");
  assert.equal(asked.permissions?.title, "How should Claude work on your next cards?");
  assert.equal(
    asked.permissions?.lede,
    "On this first card Claude changed files in the card's copy without asking. New cards start with Claude's own permission setting.",
  );
  assert.deepEqual(
    asked.permissions?.choices.map((c) => [c.name, c.mark, c.button, c.use]),
    [
      ["Uses Claude's own setting", "New cards do this now", "Keep this", false],
      ["Edits its copy without asking", null, "Use this", true],
    ],
  );
  assert.equal(asked.permissions?.footer, "You can change it in Settings › Cards › AI and models, and on any card before Start build.");
  assert.equal(asked.permissionsAnswered, null);
  assert.ok(!asked.rows.some((row) => row.step.id === STEP.permissions), "not a row, not counted");

  // Codex built the tour card: Codex's words.
  const codex = snapshot(r);
  const withCodex = panelView(r, { ...codex, tourCard: codex.tourCard ? { ...codex.tourCard, vendor: "codex" } : null, defaultBuilder: "codex" });
  assert.equal(withCodex.permissions?.title, "How should Codex work on your next cards?");
  assert.deepEqual(
    withCodex.permissions?.choices.map((c) => c.name),
    ["Asks before every change", "Edits its copy without asking"],
  );
  assert.match(withCodex.permissions?.lede ?? "", /New cards start by asking first\./);

  // Answered ("Use this"): the line after, and the whole sentence back.
  const after = panelView(r, { ...snapshot(r), builderPermissionsAsked: true, builderPermissions: "editsCopy" });
  assert.equal(after.permissions, null);
  assert.equal(
    after.permissionsAnswered,
    "New cards: Edits its copy without asking. Change it in Settings › Cards › AI and models › How the Builder asks you.",
  );
  assert.equal(after.finished?.body, LOOP_DONE_COPY.body);
  // Skipped (the tour's Skip chapter), or before the ship: never asked.
  assert.equal(panelView({ ...r, skipped: { [STEP.permissions]: NOW } }, snapshot(r)).permissions, null);
  const beforeShip = onCard({ done: Object.fromEntries(Object.entries(done).filter(([id]) => id !== STEP.ship)) });
  assert.equal(panelView(beforeShip, snapshot(beforeShip)).permissions, null);
  // The tour ended: not asked.
  assert.equal(panelView({ ...r, endedAt: NOW }, snapshot(r)).permissions, null);
  // F4 round 2: someone who already chose another way in Settings isn't
  // asked — no question, no line after, the whole sentence.
  for (const chosen of ["editsCopy", "neverAsks"] as const) {
    const already = panelView(r, { ...snapshot(r), builderPermissions: chosen });
    assert.equal(already.permissions, null, `${chosen}: not asked`);
    assert.equal(already.permissionsAnswered, null, `${chosen}: nothing said after`);
    assert.equal(already.finished?.body, LOOP_DONE_COPY.body, `${chosen}: the whole sentence`);
  }
}

/** A rule of the TU-5 walk fix, run as its own check. */
const rule = (_name: string, check: () => void): void => check();

// ── TU-5 walk: the tour follows where you are until it has a card ────────
// A tour begun in one project (vega), then Setup rerun with a new one
// (lyra, active): Resume, Start over and Help › Getting started all
// stayed in vega — B2 said *This step is in vega* and no coach-mark came.

{
  const NOW2 = "2026-10-22T09:00:00.000Z";
  const NOW2_MS = Date.parse(NOW2);
  const AT = { now: NOW2, version: "1.170.0" };
  // An old record: a workspace named, no card (TU-4's start recorded it).
  const oldBound: TutorialProgress = { ...completeStep(started, STEP.howItWorks, NOW), workspaceId: OTHER_WS };
  // A card under way in vega.
  const vegaCard: TutorialProgress = {
    ...withTourCard(started, OTHER_WS, "v9"),
    done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW, [STEP.newCard]: NOW },
  };

  rule("rule 1: before a card, B2/B3 count where you are", () => {
    // Rule 1: before a card, B2 and B3 count in the active workspace.
    const s1 = snapshot(oldBound, { active: WS, mode: "board" });
    assert.equal(s1.tourWorkspaceId, WS, "no card: the active workspace");
    assert.equal(s1.tourWorkspaceName, "lyra");
    const v1 = tourView(oldBound, snapshot(oldBound, { active: WS, mode: "code" }));
    assert.equal(v1.step?.id, STEP.openBoard);
    assert.equal(v1.wait, null, "no Take me there before a card");
    assert.equal(panelView(oldBound, snapshot(oldBound, { active: WS, mode: "code" })).waitLine, null, "not \"This step is in vega\"");
    assertDone(s1, STEP.openBoard, true, "the active workspace's Board, an old record naming another");
    // B3 takes a card made in the active workspace, and binds the tour there.
    const b3: TutorialProgress = completeStep(oldBound, STEP.openBoard, NOW);
    const s3 = snapshot(b3, { active: WS, cards: [card("n1")] });
    assert.deepEqual(s3.adopt, { workspaceId: WS, cardId: "n1" }, "a card made where you are");
    assert.equal(snapshot(b3, { active: WS, otherCards: [card("x", { workspaceId: OTHER_WS })] }).adopt, null, "not the old workspace's");
    const taken = observeTour(b3, s3, NOW)!;
    assert.equal(taken.cardId, "n1");
    assert.equal(taken.workspaceId, WS, "the card's workspace binds the tour");
    // The tour follows a switch: active vega now, a card made there.
    const s3b = snapshot(b3, { active: OTHER_WS, otherCards: [card("v1", { workspaceId: OTHER_WS })] });
    assert.equal(s3b.tourWorkspaceId, OTHER_WS);
    assert.deepEqual(s3b.adopt, { workspaceId: OTHER_WS, cardId: "v1" });
    // The guided first card made for this tour in another workspace binds
    // the tour to that one, and the snapshot already says so.
    const g = snapshot(b3, {
      active: WS,
      otherCards: [card("g", { workspaceId: OTHER_WS })],
      guidedCard: { workspaceId: OTHER_WS, cardId: "g", startedAt: NOW, endedAt: null },
  });
  assert.equal(g.tourWorkspaceId, OTHER_WS, "the card taken names the workspace");
  assert.equal(g.tourWorkspaceName, "vega");
  });
  rule("tourWorkspace", () => {
    // tourWorkspace: no card → active, a list not loaded or not; a card →
    // its workspace; that workspace removed → active, gone.
    const list = { loaded: true, list: [{ id: WS }, { id: OTHER_WS }] };
    assert.deepEqual(tourWorkspace({ workspaceId: OTHER_WS }, list, WS), { workspaceId: WS, bound: false, gone: false });
    assert.deepEqual(tourWorkspace({ workspaceId: OTHER_WS, cardId: "c" }, list, WS), { workspaceId: OTHER_WS, bound: true, gone: false });
    assert.deepEqual(tourWorkspace({ workspaceId: "ws-x", cardId: "c" }, list, WS), { workspaceId: WS, bound: false, gone: true });
    assert.deepEqual(tourWorkspace({ workspaceId: "ws-x", cardId: "c" }, { loaded: false, list: [] }, WS), { workspaceId: "ws-x", bound: true, gone: false });
    assert.deepEqual(tourWorkspace(null, list, null), { workspaceId: null, bound: false, gone: false });

  });
  rule("rule 1: Help › Getting started reopens unbound", () => {
    // Help › Getting started / Resume: a tour with no card is reopened unbound.
    const reopened = startFullTour(oldBound, AT);
    assert.equal(reopened.workspaceId, null, "a workspace with no card is dropped");
    assert.equal(reopened.done?.[STEP.howItWorks], NOW, "progress kept");
    assert.equal(startFullTour(null, AT).workspaceId, undefined, "a first start records no workspace");
    assert.equal(startFullTour(endTour(onCard(), NOW), AT).workspaceId, WS, "a card's workspace stays with its card");

  });
  rule("rule 2: Start over", () => {
    // Rule 2: Start over drops the card and its workspace: the active one.
    const over = startOver(onCard({ done: { [STEP.howItWorks]: NOW, [STEP.openBoard]: NOW } }), NOW2);
    assert.equal(over.cardId, null);
    assert.equal(over.workspaceId, null);
    const overB1 = completeStep(over, STEP.howItWorks, NOW2);
    const so = snapshot(overB1, { active: OTHER_WS, mode: "code" });
    assert.equal(so.tourWorkspaceId, OTHER_WS);
    assert.equal(tourView(overB1, so).step?.id, STEP.openBoard);
    assert.equal(tourView(overB1, so).wait, null, "B2 in the workspace you started over in");
    assert.deepEqual(
      snapshot(completeStep(overB1, STEP.openBoard, NOW2), {
        active: OTHER_WS,
        otherCards: [card("v2", { workspaceId: OTHER_WS, createdAt: NOW2_MS + 1 })],
      }).adopt,
      { workspaceId: OTHER_WS, cardId: "v2" },
    );

  });
  rule("rule 3: Ready's label and press", () => {
    // Rule 3: Ready's label and press. Resume only past B1 or with a card.
    assert.equal(tourResumable(null), false);
    assert.equal(tourResumable(started), false, "started, nothing done");
    assert.equal(tourResumable(completeStep(started, STEP.howItWorks, NOW)), false, "B1 alone is not progress");
    assert.equal(tourResumable(completeStep(started, STEP.openBoard, NOW)), true, "B2 done");
    assert.equal(tourResumable(skipStep(started, STEP.openBoard, NOW)), true, "B2 skipped");
    assert.equal(tourResumable(onCard()), true, "a card taken");
    assert.equal(tourResumable(pauseTour(onCard())), true, "paused is under way");
    assert.equal(tourResumable(endTour(onCard({ done: { [STEP.openBoard]: NOW } }), NOW)), false, "ended");
    // Start the tour on a record that got nowhere: from B1, unbound.
    const fresh = startTourFromSetup(oldBound, AT);
    assert.equal(fresh.startedAt, NOW2, "starts now: B3 takes cards made from now");
    assert.deepEqual(fresh.done, {});
    assert.equal(fresh.workspaceId, null);
    assert.equal(fresh.startedVersion, "1.167.0", "set once");
    // Start the tour on an ended tour with a card elsewhere: from B1, unbound.
    const endedElsewhere = endTour({ ...onCard({ done: { [STEP.howItWorks]: NOW, [STEP.newCard]: NOW } }), workspaceId: OTHER_WS }, NOW);
    const restarted = startTourFromSetup(endedElsewhere, AT);
    assert.equal(restarted.endedAt, null);
    assert.equal(restarted.cardId, null, "not reopened on the old card");
    assert.equal(restarted.workspaceId, null);
    assert.deepEqual(restarted.done, {});
    assert.equal(tourView(restarted, snapshot(restarted, { active: WS })).step?.id, STEP.howItWorks);
    // Resume the tour with no card, past B1: progress kept, follows the active one.
    const noCardPast: TutorialProgress = { ...completeStep(oldBound, STEP.openBoard, NOW) };
    const resumedNoCard = startTourFromSetup(noCardPast, AT);
    assert.equal(resumedNoCard.startedAt, T0);
    assert.equal(resumedNoCard.done?.[STEP.openBoard], NOW);
    assert.equal(resumedNoCard.workspaceId, null);
    assert.equal(snapshot(resumedNoCard, { active: WS }).tourWorkspaceId, WS);
    // Resume the tour with a card under way elsewhere: kept, its steps say where.
    const resumed = startTourFromSetup(vegaCard, AT);
    assert.equal(resumed.cardId, "v9");
    assert.equal(resumed.workspaceId, OTHER_WS);
    const sv = snapshot(resumed, { active: WS, otherCards: [card("v9", { workspaceId: OTHER_WS })] });
    assert.equal(sv.tourWorkspaceName, "vega");
    assert.equal(tourView(resumed, sv).step?.id, STEP.brief);
    assert.equal(tourView(resumed, sv).wait, "other-workspace");
    assert.equal(panelView(resumed, sv).waitLine, "This step is in vega");
    assert.equal(startTourFromSetup(null, AT).startedAt, NOW2, "a first start");

  });
  rule("rule 4: a card gone", () => {
    // Rule 4: a card gone takes its workspace: B3 follows the active one.
    const gone = cardGone(vegaCard);
    assert.equal(gone.workspaceId, null);
    const sg = snapshot(gone, { active: WS, cards: [card("n2")] });
    assert.equal(sg.tourWorkspaceId, WS);
    assert.deepEqual(sg.adopt, { workspaceId: WS, cardId: "n2" }, "B3 takes a card made where you are");
    // A card under way keeps the tour where it is, wherever you are.
    const bound = snapshot(onCard(), { active: OTHER_WS, cards: [card("c1")] });
    assert.equal(bound.tourWorkspaceId, WS);
    assert.equal(bound.adopt, null);

  });
  rule("rule 5: B11's second card", () => {
    // Rule 5 (B11): the tour card shipped in lyra, the user now in vega: the
    // second card made there counts, and the tour card is still the tour's.
    const shippedDone = Object.fromEntries(BASE_STEPS.filter((st) => st.id !== STEP.secondCard).map((st) => [st.id, NOW]));
    const sr: TutorialProgress = onCard({ done: shippedDone });
    const second = card("v3", { workspaceId: OTHER_WS, shipStatus: "shipped", createdAt: T0_MS + 900_000 });
    const s11 = snapshot(sr, {
      active: OTHER_WS,
      cards: [card("c1", { shipStatus: "shipped" })],
      otherCards: [second],
      shown: { c1: { state: "shipped" }, v3: { state: "shipped" } },
  });
  assert.equal(s11.tourWorkspaceId, WS, "a shipped tour card keeps its workspace");
  assert.equal(s11.secondCard?.id, "v3");
  assert.equal(s11.secondCardLanded, true);
  assert.equal(s11.adopt, null);
  });
}

// ── 1.175.0 F4: the permissions question is done once it is answered ───
{
  const r = onCard();
  assertDone({ ...snapshot(r), builderPermissionsAsked: false }, STEP.permissions, false, "not answered yet");
  assertDone({ ...snapshot(r), builderPermissionsAsked: true }, STEP.permissions, true, "answered or closed");
  // The snapshot reads it from Settings; absent: not asked, the default "asks".
  assert.equal(snapshot(r).builderPermissionsAsked, false);
  assert.equal(snapshot(r).builderPermissions, "asks");
  // Observed done once answered, and never back.
  const observed = observeTour(r, { ...snapshot(r), builderPermissionsAsked: true }, NOW)!;
  assert.ok(observed.done?.[STEP.permissions], "recorded done");
}

// ── Every base step's `done` is covered above ────────────────────────────

assert.deepEqual(
  [...covered].sort(),
  BASE_STEPS.map((s) => s.id).sort(),
  "every base step's done has a test per state",
);

console.log(`tutorialEngine.test.ts: ${BASE_STEPS.length} base steps, all covered`);
