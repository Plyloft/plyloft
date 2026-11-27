// Getting started TU-5 (docs/tutorial/TUTORIAL_SPEC.md §6.2, §6.3, §11): the
// base chapter end to end, Tier 3 over the pure engine and the panel's
// words. B3's other ways (the safe example, the guided card under way, the
// starter titles in an empty project), B5's subscription
// sentence and note, B5b by kind (a Builder done with its turn is B8, not a
// question), the live line (minutes, in line, paused until), B8 in line,
// B9's Try it and its fallback, B10's pull request words, B11's checklist,
// and the FirstCardGuide rule (one guide at a time). Run by
// scripts/ppvp-pure-contracts.sh under node --experimental-strip-types.
import assert from "node:assert/strict";
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import type { PresentationRule, SessionFacts } from "./cardPresentation.ts";
import type { CardPrimaryActionId } from "./cardLifecycle.ts";
import type { BuilderWaitingState } from "./needsYou.ts";
import type { TutorialProgress } from "./settingsShape.ts";
import type { CenterMode } from "../store/uiStore.ts";
import { tryRunKey, type TryPhase } from "./tryPanel.ts";
import { FIRST_CARD_BRIEF, FIRST_CARD_TITLE } from "./firstCardGuide.ts";
import { buildMinutes, panelView, tourQuiet, tourVendor } from "./tutorial/tourPanel.ts";
import {
  ASK_NEVER_ANSWERS,
  BASE_STEPS,
  SAFE_EXAMPLE_LINK,
  START_BUILD_NOTE,
  TOUR_BOUNDED_NOTE,
  STARTER_BODY,
  STARTER_TITLES,
  STEP,
  SUBSCRIPTION_LINE,
  CONTINUE_GUIDED_GENERIC,
  TRY_FALLBACK,
  WAIT_COPY,
  stepById,
  stepCopy,
  type TutorialStep,
} from "./tutorial/manifest.ts";
import {
  buildTutorialSnapshot,
  cardKey,
  completeStep,
  hasSourceFiles,
  observeTour,
  projectHasSourceFiles,
  skipStep,
  startFullTour,
  tourOnCard,
  tourView,
  withTourCard,
  type SnapshotInput,
  type TourCardPresentation,
} from "./tutorial/tutorialEngine.ts";

const WS = "ws-tour";
const OTHER_WS = "ws-other";
const T0 = "2026-10-21T09:00:00.000Z";
const T0_MS = Date.parse(T0);
const NOW = "2026-10-21T09:30:00.000Z";
const LONG_BRIEF = "Add a contact form to the home page with name, email and a message.";

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

type Shown = {
  state: CardPresentationState;
  rule?: PresentationRule;
  session?: Pick<SessionFacts, "block" | "state"> | null;
  vendor?: "claude" | "codex";
  shipMode?: "merge_live" | "pr";
  primary?: CardPrimaryActionId;
  waiting?: BuilderWaitingState;
};

function input(
  record: TutorialProgress | null,
  opts: {
    cards?: KanbanCard[];
    otherCards?: KanbanCard[];
    shown?: Record<string, Shown>;
    mode?: CenterMode;
    tryRuns?: Record<string, { phase: TryPhase }>;
    guidedCard?: SnapshotInput["guidedCard"];
    trySheet?: SnapshotInput["trySheet"];
    trySheetSeen?: Set<string>;
    tried?: Set<string>;
    emptyProject?: boolean | null;
    openCardId?: string | null;
    tryOpened?: Set<string>;
    staticSites?: Set<string>;
    finishing?: Record<string, "self-check" | "saving">;
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
      loaded: true,
      list: [
        { id: WS, name: "lyra" },
        { id: OTHER_WS, name: "vega" },
      ],
    },
    activeWorkspaceId: WS,
    mode: opts.mode ?? "board",
    overlays: { allSkills: false, shipBatch: false, settings: false },
    ai: { claude: true, codex: true },
    boards: {
      [WS]: { loaded: true, cards: opts.cards ?? [] },
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
        primary: s.primary ?? null,
        waiting: s.waiting ?? null,
      };
    },
    tryRuns: opts.tryRuns ?? {},
    guidedCard: opts.guidedCard ?? null,
    trySheet: opts.trySheet ?? null,
    trySheetSeen: opts.trySheetSeen,
    tried: opts.tried,
    emptyProject: opts.emptyProject ?? null,
    openCardId: opts.openCardId ?? null,
    tryOpened: opts.tryOpened,
    staticSites: opts.staticSites,
    finishing: opts.finishing ? (c) => opts.finishing?.[c.id] ?? null : undefined,
  };
}

const snapshot = (record: TutorialProgress | null, opts: Parameters<typeof input>[1] = {}) =>
  buildTutorialSnapshot(input(record, opts));

const started: TutorialProgress = startFullTour(null, { now: T0, version: "1.167.0" });
/** Steps done up to (not including) `upTo`, in path order, on card c1. */
function doneUpTo(upTo: string, patch: Partial<TutorialProgress> = {}): TutorialProgress {
  let r: TutorialProgress = withTourCard(started, WS, "c1");
  for (const st of BASE_STEPS) {
    if (st.id === upTo) break;
    if (st.kind === "interrupt" || st.aside) continue;
    r = completeStep(r, st.id, T0);
  }
  return { ...r, ...patch };
}
const built = { builder: { vendor: "claude", startedAt: T0_MS + 120_000 } as unknown as KanbanCard["builder"] };

let checks = 0;
const ok = (cond: unknown, why: string) => {
  assert.ok(cond, why);
  checks++;
};
const eq = <T>(a: T, b: T, why: string) => {
  assert.deepEqual(a, b, why);
  checks++;
};

// ── B3: the safe example, Continue with, starter titles ────

{
  const r = completeStep(completeStep(started, STEP.howItWorks, T0), STEP.openBoard, T0);
  const plain = panelView(r, snapshot(r));
  eq(plain.view.step?.id, STEP.newCard, "B3 is current");
  eq(plain.b3?.safeExample, SAFE_EXAMPLE_LINK, "B3 offers the safe example (§2: the guided first card)");
  eq(plain.b3?.continueWith, null, "no guided card under way: nothing to continue");
  ok(!plain.rows.find((x) => x.step.id === STEP.newCard)?.copy.examples, "a project with files: the contact-form example");

  // §11: the guided README card already under way (an old user, or one made
  // from Setup before the tour) — Continue with it, no second safe example.
  const guided = card("g", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF, createdAt: T0_MS - 600_000 });
  const withGuided = panelView(
    r,
    snapshot(r, { cards: [guided], guidedCard: { workspaceId: WS, cardId: "g", startedAt: "2026-10-20T08:00:00Z" } }),
  );
  eq(
    withGuided.b3?.continueWith,
    { label: `Continue with "${FIRST_CARD_TITLE}"`, workspaceId: WS, cardId: "g" },
    "Continue with the guided card (§11)",
  );
  eq(withGuided.b3?.safeExample, null, "and not a second README card");
  // A guide that ended is not offered again.
  const ended = panelView(
    r,
    snapshot(r, {
      cards: [guided],
      guidedCard: { workspaceId: WS, cardId: "g", endedAt: "2026-10-20T09:00:00Z", outcome: "dismissed" },
    }),
  );
  eq(ended.b3?.continueWith, null, "an ended guide is not continued");
  eq(ended.b3?.safeExample, SAFE_EXAMPLE_LINK, "dismissed: the safe example again, as Setup offers it");
  // (Challenger) A guided card that shipped is not made a second time:
  // Setup offers nothing then (`firstCardOffer`), and a new one would
  // overwrite the shipped record.
  for (const g of [
    { workspaceId: WS, cardId: "g", endedAt: "2026-10-20T09:00:00Z", outcome: "shipped" },
    { workspaceId: WS, cardId: "g", outcome: "shipped" },
  ]) {
    const shippedGuide = panelView(r, snapshot(r, { cards: [{ ...guided, shipStatus: "shipped" }], guidedCard: g }));
    eq(shippedGuide.b3?.safeExample, null, `a shipped guided card (${g.endedAt ? "ended" : "not ended"}): no safe example`);
    eq(shippedGuide.b3?.continueWith, null, "nor Continue with a shipped card");
  }

  // Taking a card (Continue with) makes it the tour card; the steps it already meets are marked.
  const busy = card("busy", { workspaceId: OTHER_WS, title: "Add a farewell function", notes: LONG_BRIEF, createdAt: T0_MS - 1, ...built });
  const taken = withTourCard(r, OTHER_WS, "busy");
  const after = observeTour(taken, snapshot(taken, { otherCards: [busy], shown: { busy: { state: "running", primary: "inspect-run" } } }), NOW)!;
  ok(after.done?.[STEP.brief] && after.done?.[STEP.startBuild], "B4/B5 marked done when already true (§11)");
  eq(after.cardId, "busy", "the card taken is the tour card");
  // Other cards running never stop B5: every plan builds in parallel.
  const mine = withTourCard(completeStep(r, STEP.newCard, T0), WS, "c1");
  const b5 = panelView(
    completeStep(mine, STEP.brief, T0),
    snapshot(completeStep(mine, STEP.brief, T0), { cards: [card("c1", { notes: LONG_BRIEF })], otherCards: [busy], shown: { c1: { state: "ready", primary: "start-build" } } }),
  );
  eq(b5.view.step?.id, STEP.startBuild, "B5 current");
  eq(b5.view.wait, null, "B5 does not wait on another card");
  eq(b5.b3?.safeExample ?? null, null, "no safe example past B3");

  // D25: a new, empty project — starter titles instead of the example.
  const empty = panelView(r, snapshot(r, { emptyProject: true }));
  const b3 = empty.rows.find((x) => x.step.id === STEP.newCard)!.copy;
  eq(b3.body, STARTER_BODY, "the starter sentence");
  eq(b3.examples, STARTER_TITLES, "the three starter titles");
  eq(empty.pointing?.copy.examples, STARTER_TITLES, "the coach-mark offers them (§6.2 B3)");
  ok(!hasSourceFiles([]), "nothing: empty");
  ok(!hasSourceFiles(["README.md", "LICENSE", "docs/readme.txt"]), "only a README and a licence: empty");
  ok(hasSourceFiles(["README.md", "index.html"]), "a page: not empty");
}

// D25 (Challenger): the empty-project look reads a few folders at most and
// stops at the first source file — never the whole tree.
{
  type E = { name: string; path: string; isDir: boolean; isSymlink?: boolean };
  const tree: Record<string, E[]> = {
    "/p": [
      { name: "node_modules", path: "/p/node_modules", isDir: true },
      { name: "docs", path: "/p/docs", isDir: true },
      { name: "README.md", path: "/p/README.md", isDir: false },
      { name: "LICENSE", path: "/p/LICENSE", isDir: false },
    ],
    "/p/docs": [{ name: "CHANGELOG.md", path: "/p/docs/CHANGELOG.md", isDir: false }],
    "/p/node_modules": [{ name: "x.js", path: "/p/node_modules/x.js", isDir: false }],
  };
  const read: string[] = [];
  const lister = async (dir: string) => {
    read.push(dir);
    if (!(dir in tree)) throw new Error("no such folder");
    return tree[dir];
  };
  eq(await projectHasSourceFiles("/p", lister), false, "a README, a licence and a changelog: empty");
  eq(read, ["/p", "/p/docs"], "build output and package folders are never entered");
  read.length = 0;
  tree["/p"] = [{ name: "index.html", path: "/p/index.html", isDir: false }, { name: "src", path: "/p/src", isDir: true }];
  eq(await projectHasSourceFiles("/p", lister), true, "a page: not empty");
  eq(read, ["/p"], "stops at the first source file");
  // A deep tree of folders and no file: the budget, then "plenty".
  read.length = 0;
  const deep = async (dir: string) => {
    read.push(dir);
    return [{ name: "a", path: `${dir}/a`, isDir: true }, { name: "b", path: `${dir}/b`, isDir: true }];
  };
  eq(await projectHasSourceFiles("/deep", deep, 5), true, "more folders than the budget: not empty");
  eq(read.length, 5, "the budget bounds the reads");
  eq(await projectHasSourceFiles("/gone", lister), null, "an unreadable folder: unknown");
  tree["/q"] = [{ name: "link", path: "/q/link", isDir: true, isSymlink: true }, { name: ".git", path: "/q/.git", isDir: true }];
  read.length = 0;
  eq(await projectHasSourceFiles("/q", lister), false, "symlinks and dot folders are not followed");
  eq(read, ["/q"], "only the root read");
}

// §3.1 (Challenger): the live line counts from the session's own start — a
// session resumed after a quit keeps the card's first `startedAt`.
{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const shown = { c1: { state: "running" as const, primary: "inspect-run" as const } };
  eq(snapshot(r, { cards: [c1], shown }).tourCard?.buildStartedAt, T0_MS + 120_000, "the card's start by default");
  const resumedAt = T0_MS + 3_600_000;
  const s = buildTutorialSnapshot({ ...input(r, { cards: [c1], shown }), buildStart: () => resumedAt });
  eq(s.tourCard?.buildStartedAt, resumedAt, "the store's start of this session when it gives one");
  eq(panelView(r, s, { now: resumedAt + 3 * 60_000 }).live?.text, "Claude is working · 3 min", "minutes since the resume");
}

// ── B5: the subscription sentence first (D8), and the note under it ──────

{
  for (const st of BASE_STEPS.filter((x: TutorialStep) => x.startsAi)) {
    for (const vendor of ["claude", "codex"] as const) {
      const c = stepCopy(st, vendor);
      ok(/subscription/.test(c.body), `${st.id} (${vendor}) says it uses the member's own subscription`);
    }
  }
  // A startsAi step whose words don't say it gets the line first.
  const bare: TutorialStep = { ...stepById(STEP.startBuild)!, id: "x.ai", copy: { title: "Plan it", body: "One AI plans." } };
  eq(stepCopy(bare, "codex").body, `${SUBSCRIPTION_LINE.replace("{ai}", "Codex")} One AI plans.`, "D8 line prepended");
  const b5 = stepCopy(stepById(STEP.startBuild)!, "claude");
  eq(b5.notes, [START_BUILD_NOTE.replace("{ai}", "Claude")], "Leave Build without asking off, under the button");
  eq(stepCopy(stepById(STEP.startBuild)!, "claude", { guidedStart: true }).notes, undefined, "the unedited guided card says its own sentence");
  // The guided card's facts say so.
  const guided = card("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
  const r = doneUpTo(STEP.startBuild);
  const gv = panelView(
    r,
    snapshot(r, { cards: [guided], shown: { c1: { state: "ready", primary: "start-build" } }, guidedCard: { workspaceId: WS, cardId: "c1", startedAt: T0 } }),
  );
  ok(gv.view.step?.id === STEP.startBuild && !gv.pointing?.copy.notes, "B5 on the unedited guided card: no toggle note");
  const edited = panelView(
    r,
    snapshot(r, { cards: [{ ...guided, notes: LONG_BRIEF }], shown: { c1: { state: "ready", primary: "start-build" } }, guidedCard: { workspaceId: WS, cardId: "c1", startedAt: T0 } }),
  );
  // QoL 7.4 (D10): the recorded tour card is bounded on the member's own
  // idea too, so an edited task says the sentence, not the toggle note.
  // QoL 7.4 (D10): the tour's own card (made during the tour) starts bounded
  // on any task, so B5 keeps only the short note.
  // 1.175.0 F10: it names the line under What you want, and the AI.
  eq(edited.pointing?.copy.notes, [TOUR_BOUNDED_NOTE.replace("{ai}", "Claude")], "the tour's own card, edited: bounded, the short note");
  eq(stepCopy(stepById(STEP.startBuild)!, "codex", { tourBounded: true }).notes, [TOUR_BOUNDED_NOTE.replace("{ai}", "Codex")], "the short note");
  // Made before the tour started: an ordinary card, the full note.
  const older = panelView(
    r,
    snapshot(r, { cards: [{ ...guided, notes: LONG_BRIEF, createdAt: T0_MS - 60_000 }], shown: { c1: { state: "ready", primary: "start-build" } }, guidedCard: { workspaceId: WS, cardId: "c1", startedAt: T0 } }),
  );
  eq(older.pointing?.copy.notes, [START_BUILD_NOTE.replace("{ai}", "Claude")], "a card from before the tour: ordinary");
}

// ── B5b: by kind; a Builder done with its turn is B8, not a question ────

{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const at = (s: Shown) => panelView(r, snapshot(r, { cards: [c1], shown: { c1: s } }), { now: T0_MS + 300_000 });

  const question = at({ state: "running", rule: "builder-waiting", waiting: "question", primary: "inspect-run" });
  eq(question.view.interrupt?.kind, "waiting", "a question: B5b waiting");
  ok(question.ask?.body.includes('"Yes" lets it go on') && question.ask.body.endsWith(ASK_NEVER_ANSWERS), "waiting words, never answered for");
  eq(question.pointing?.step.id, STEP.aiAsks, "the coach-mark points at Open session");
  ok(question.pointing?.ready, "Open session is the primary");

  const stopped = at({ state: "running", rule: "builder-waiting", waiting: "stopped", primary: "finish-and-check" });
  eq(stopped.view.interrupt, null, "its turn over: no question (TU-5)");
  eq(stopped.pointing?.step.id, STEP.finishCheck, "B8 points at Finish and check");
  ok(stopped.pointing?.ready, "and Finish and check is the primary");

  const quiet = at({ state: "running", rule: "builder-waiting", waiting: "quiet", primary: "inspect-run" });
  eq(quiet.view.interrupt?.kind, "waiting", "quiet for a while: look at the session");

  const trust = at({ state: "running", rule: "session-block", session: { block: { kind: "trust" }, state: "question" }, primary: "inspect-run" });
  eq(trust.view.interrupt?.kind, "trust", "folder trust");
  ok(trust.ask?.body.startsWith("Claude asks whether you trust this folder"), "trust words");

  const bypass = at({ state: "running", rule: "session-block", session: { block: { kind: "bypass" }, state: "question" }, primary: "inspect-run", vendor: "codex" });
  eq(bypass.view.interrupt?.kind, "bypass", "bypass warning");
  ok(bypass.ask?.body.startsWith("Codex shows a warning"), "Codex words follow the vendor");

  const limit = at({ state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: "15:40" }, state: "question" }, primary: "inspect-run" });
  eq(limit.view.interrupt?.kind, "usageLimit", "usage limit");
  ok(limit.ask?.body.startsWith("Your Claude plan reached its limit for now"), "usage-limit words");
  eq(limit.live, { tone: "paused", text: "Paused · your plan's limit resets at 15:40" }, "§11: the live line says Paused until 15:40");
  const unknownReset = at({ state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: null }, state: "question" }, primary: "inspect-run" });
  eq(unknownReset.live, { tone: "paused", text: "Paused · your plan's limit resets soon" }, "a reset not known yet");
  // Never recorded.
  ok(observeTour(r, snapshot(r, { cards: [c1], shown: { c1: { state: "running", rule: "builder-waiting", waiting: "question" } } }), NOW)?.done?.[STEP.aiAsks] == null, "B5b is never recorded");
}

// ── The live line: minutes, in line (§3.1) ───────────────────────────────

{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const running = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "running", primary: "inspect-run" } } }), {
    now: T0_MS + 120_000 + 3 * 60_000 + 20_000,
  });
  eq(running.live, { tone: "running", text: "Claude is working · 3 min" }, "Claude is working · 3 min");
  const codex = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "running", vendor: "codex", primary: "inspect-run" } } }), {
    now: T0_MS + 120_000 + 30_000,
  });
  eq(codex.live?.text, "Codex is working · under a minute", "Codex words, under a minute");
  const noClock = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "running", primary: "inspect-run" } } }));
  eq(noClock.live?.text, "Claude is working", "no clock: the Builder only");
  eq(buildMinutes(65 * 60_000), "1 h 5 min", "over an hour");
  eq(buildMinutes(120 * 60_000), "2 h", "whole hours");

  // B8 for a card in line (TU-4 walk): its own wait, not "still working".
  const queued = panelView(r, snapshot(r, { cards: [card("c1", { notes: LONG_BRIEF })], shown: { c1: { state: "queued", primary: "see-queue" } } }));
  eq(queued.view.step?.id, STEP.finishCheck, "B8 current");
  eq(queued.view.wait, "queued", "a card in line waits for a slot");
  eq(queued.waitLine, WAIT_COPY.queued.replace("{ai}", "Claude"), "its words");
  eq(queued.live, { tone: "running", text: "In line: it starts when a slot is free" }, "the live line says in line");
  const working = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "running", primary: "inspect-run" } } }));
  eq(working.view.wait, "still-building", "working: still building");
  // Nothing live once it is checked.
  const checked = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "checking" } } }));
  eq(checked.live, null, "no live line once the build ended");
}

// ── B9: Try it, and §6.3's fallback ──────────────────────────────────────

{
  const r = doneUpTo(STEP.tryIt);
  const changed = card("c1", { notes: LONG_BRIEF, worktreePath: "/tmp/lyra-c1", ...built });
  const ready: Shown = { state: "ready-to-ship", primary: "ship", shipMode: "merge_live" };
  const at = (opts: Parameters<typeof input>[1], rec = r) => panelView(rec, snapshot(rec, { cards: [changed], shown: { c1: ready }, ...opts }));
  const plain = at({});
  eq(plain.view.step?.id, STEP.tryIt, "B9 current");
  eq(plain.view.wait, null, "Try it is offered on a ready card with changes");
  eq(plain.pointing?.step.anchor, "card-try-it", "points at Now's Try it (TRY_IT_TOUR)");
  eq(plain.tryFallback, null, "no fallback while Try it can start it");
  // Running: done.
  const running = at({ tryRuns: { [tryRunKey(WS, "c1", null)]: { phase: "running" } } });
  ok(observeTour(r, snapshot(r, { cards: [changed], shown: { c1: ready }, tryRuns: { [tryRunKey(WS, "c1", null)]: { phase: "running" } } }), NOW)?.done?.[STEP.tryIt], "Running marks B9");
  eq(running.tryFallback, null, "and no fallback");
  // Couldn't start: the fallback, with Details.
  const failed = at({ tryRuns: { [tryRunKey(WS, "c1", null)]: { phase: "failed" } } });
  eq(failed.tryFallback, { text: TRY_FALLBACK.beforeShip, details: TRY_FALLBACK.beforeShipDetails }, "Couldn't start: §6.3 before shipping");
  // The sheet closed with nothing saved (no start command): the fallback.
  const key = cardKey(WS, "c1");
  const sheetOpen = at({ trySheet: { workspaceId: WS, cardId: "c1" }, trySheetSeen: new Set([key]) });
  eq(sheetOpen.tryFallback, null, "the sheet open: no fallback yet");
  const sheetClosed = at({ trySheet: null, trySheetSeen: new Set([key]) });
  eq(sheetClosed.tryFallback?.text, TRY_FALLBACK.beforeShip, "the sheet closed unsaved: the fallback");
  // Skipped: the fallback under its row; after shipping, the after-ship words.
  const skipped = skipStep(r, STEP.tryIt, NOW);
  eq(at({}, skipped).tryFallback?.text, TRY_FALLBACK.beforeShip, "skipped before shipping");
  const shipped = completeStep(skipped, STEP.ship, NOW);
  const landed = panelView(shipped, snapshot(shipped, { cards: [{ ...changed, shipStatus: "shipped" }], shown: { c1: { state: "shipped" } } }));
  eq(landed.tryFallback, { text: TRY_FALLBACK.afterShip, details: null }, "skipped, after shipping");
  // G1 Challenger (10): shipped as a pull request still open — the change
  // isn't in the project here yet, so the card's copy is the way.
  const prCard = { ...changed, prUrl: "https://github.com/o/r/pull/7", pr: { state: "open", autoMerge: true } as unknown as KanbanCard["pr"] };
  const prOpen = panelView(shipped, snapshot(shipped, { cards: [prCard], shown: { c1: { state: "shipped" } } }));
  eq(prOpen.tryFallback?.text, TRY_FALLBACK.beforeShip, "skipped, the pull request still open");
  // Not offered yet (no changes in the copy).
  const noChanges = panelView(r, snapshot(r, { cards: [card("c1", { notes: LONG_BRIEF, ...built })], shown: { c1: { state: "checking" } } }));
  eq(noChanges.view.wait, "try-not-yet", "Try it shows once the card has changes");
}

// ── B10: the pull request words; the loop ────────────────────────────────

{
  const r = doneUpTo(STEP.ship);
  const c1 = card("c1", { notes: LONG_BRIEF, worktreePath: "/tmp/c1", ...built });
  const pr = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "ready-to-ship", primary: "ship", shipMode: "pr" } } }));
  eq(pr.pointing?.copy.body, "Ship it opens a pull request on GitHub and merges it when the checks pass.", "PR workspace: B10 says pull request (shipsAs)");
  const merge = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "ready-to-ship", primary: "ship", shipMode: "merge_live" } } }));
  eq(merge.pointing?.copy.body, "Ship it puts the change into your project on this Mac.", "a local ship");
  // The PR open: done, and the loop says merge it on GitHub.
  const open = { ...c1, prUrl: "https://github.com/o/r/pull/7", pr: { state: "open" } as unknown as KanbanCard["pr"] };
  const after = observeTour(r, snapshot(r, { cards: [open], shown: { c1: { state: "shipped" } } }), NOW)!;
  ok(after.done?.[STEP.ship], "an open pull request completes B10 (§11)");
  const loop = panelView(after, snapshot(after, { cards: [open], shown: { c1: { state: "shipped" } } }));
  ok(loop.finished?.body.endsWith("Merge it on GitHub when you're ready."), "Merge it on GitHub when you're ready");
  // G1 Challenger (10): a pull request GitHub merges by itself says so.
  const auto = { ...c1, prUrl: "https://github.com/o/r/pull/7", pr: { state: "open", autoMerge: true } as unknown as KanbanCard["pr"] };
  const autoAfter = observeTour(r, snapshot(r, { cards: [auto], shown: { c1: { state: "shipped" } } }), NOW)!;
  const autoLoop = panelView(autoAfter, snapshot(autoAfter, { cards: [auto], shown: { c1: { state: "shipped" } } }));
  ok(autoLoop.finished?.body.endsWith("It merges when the checks pass."), "it merges when the checks pass");
  // 1.171.0 A3: Plyloft's own merge says Plyloft merges it, while it's open.
  const own = { ...c1, prUrl: "https://github.com/o/r/pull/7", pr: { state: "open", plyloftAutoMerge: true } as unknown as KanbanCard["pr"] };
  const ownAfter = observeTour(r, snapshot(r, { cards: [own], shown: { c1: { state: "shipped" } } }), NOW)!;
  const ownLoop = panelView(ownAfter, snapshot(ownAfter, { cards: [own], shown: { c1: { state: "shipped" } } }));
  ok(ownLoop.finished?.body.endsWith("Plyloft merges it when the checks pass — keep Plyloft open."), "Plyloft merges it");
  // {workspace} is filled.
  const elsewhere = panelView(r, { ...snapshot(r, { cards: [c1], shown: { c1: { state: "ready-to-ship", primary: "ship" } } }), activeWorkspaceId: OTHER_WS });
  eq(elsewhere.waitLine, "This step is in lyra", "{workspace} is the tour card's");
}

// ── B11: the checklist ticks itself; then quiet ──────────────────────────

{
  const shippedFirst = { ...card("c1", { notes: LONG_BRIEF, shipStatus: "shipped" }), ...built };
  const r = completeStep(doneUpTo(STEP.ship), STEP.ship, NOW);
  const rows = (cards: KanbanCard[], shown: Record<string, Shown> = {}, more: Parameters<typeof input>[1] = {}) =>
    panelView(r, snapshot(r, { cards: [shippedFirst, ...cards], shown: { c1: { state: "shipped" }, ...shown }, ...more })).checklist;
  const none = rows([]);
  ok(none && none.rows.every((x) => !x.done), "nothing made yet: nothing ticked");
  eq(none?.rows.map((x) => x.item), ["Title", "What you want", "Start build", "Finish and check", "Try it", "Ship it"], "the list, in order");
  ok(none?.rows.every((x) => x.hint.length > 0 && !x.hint.includes("{ai}")), "a hint per row, words filled");
  eq(panelView(r, snapshot(r, { cards: [shippedFirst], shown: { c1: { state: "shipped" } } })).pointing, null, "no coach-marks on B11");
  const second = card("c2", { createdAt: T0_MS + 3_600_000, title: "Add a footer" });
  eq(rows([second])?.rows.filter((x) => x.done).map((x) => x.item), ["Title"], "a title");
  // TU-7 Mac walk (§6.2 B11): a draft made for an optional chapter (P1's
  // card to Chat on) is a new card like any other — it ticks Title, and only
  // its ship would do B11. The list itself is the base chapter's only.
  const talkDraft = card("c3", { createdAt: T0_MS + 7_200_000, title: "TU-7 walk chat draft" });
  eq(rows([talkDraft])?.rows.filter((x) => x.done).map((x) => x.item), ["Title"], "an optional chapter's draft: its title");
  eq(
    observeTour(r, snapshot(r, { cards: [shippedFirst, talkDraft], shown: { c1: { state: "shipped" } } }), NOW)?.done?.[STEP.secondCard],
    undefined,
    "a draft never does B11",
  );
  eq(
    rows([{ ...second, notes: LONG_BRIEF, ...built }], { c2: { state: "checking" } })?.rows.filter((x) => x.done).map((x) => x.item),
    ["Title", "What you want", "Start build", "Finish and check"],
    "built and checked",
  );
  eq(
    rows([{ ...second, notes: LONG_BRIEF, ...built }], { c2: { state: "ready-to-ship" } }, { tried: new Set([cardKey(WS, "c2")]) })
      ?.rows.find((x) => x.item === "Try it")?.done,
    true,
    "Try it seen running in this launch stays ticked",
  );
  const shippedSecond = { ...second, notes: LONG_BRIEF, shipStatus: "shipped" as const, ...built };
  const done = observeTour(r, snapshot(r, { cards: [shippedFirst, shippedSecond], shown: { c1: { state: "shipped" }, c2: { state: "shipped" } } }), NOW)!;
  ok(done.done?.[STEP.secondCard], "a second card shipped: B11 done");
  const quiet = panelView(done, snapshot(done, { cards: [shippedFirst, shippedSecond], shown: { c1: { state: "shipped" }, c2: { state: "shipped" } } }));
  ok(quiet.checklist?.quiet && quiet.checklist.done, "then the panel goes quiet");
  ok(tourQuiet(done) && !tourQuiet(r), "the tour is quiet once B11 is done");
  ok(tourQuiet(skipStep(r, STEP.secondCard, NOW)), "or skipped");
  ok(!tourQuiet(doneUpTo(STEP.ship)), "not at B10 alone: the sidebar row stays for B11");
  // Not before B10.
  eq(panelView(doneUpTo(STEP.ship), snapshot(doneUpTo(STEP.ship))).checklist, null, "B11 only after B10");
}

// ── One guide at a time (§2) ─────────────────────────────────────────────

{
  const r = withTourCard(started, WS, "g");
  ok(tourOnCard(r, WS, "g"), "the tour runs on the guided card: the callout stands aside");
  ok(!tourOnCard(r, WS, "other"), "another card: the callout as today");
  ok(!tourOnCard({ ...r, endedAt: NOW }, WS, "g"), "the tour ended: the callout as today");
  ok(!tourOnCard(null, WS, "g"), "no tour: as today");
  ok(tourOnCard({ ...r, paused: true }, WS, "g"), "a paused tour still holds the card");
}

// B3's wait words fill the Builder (tourView's waits are words, §7).
{
  const r = completeStep(completeStep(started, STEP.howItWorks, T0), STEP.openBoard, T0);
  eq(tourView(r, snapshot(r)).step?.id, STEP.newCard, "sanity: B3");
}

// ── TU-5 Mac walk fixes (2026-10-21 walk report) ─────────────────────────

// 1: the live line follows the card's real state — building only while the
// Builder works; no line once its turn is over or while a prompt holds it;
// "Paused until …" for the usage limit. "While Claude works" only while it
// does; B8 does not say "still working" while held.
{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const at = (sh: Shown) => panelView(r, snapshot(r, { cards: [c1], shown: { c1: sh } }), { now: T0_MS + 300_000 });

  const working = at({ state: "running", primary: "inspect-run" });
  eq(working.live?.text, "Claude is working · 3 min", "1: working: building");
  eq(working.whileBuilding, "While Claude works: two things worth seeing", "1: and the line for B6/B7");

  const stopped = at({ state: "running", rule: "builder-waiting", waiting: "stopped", primary: "finish-and-check" });
  eq(stopped.live, null, "1: its turn over (Builder stopped): no building line");
  eq(stopped.whileBuilding, null, "1: nor While Claude works");
  ok(stopped.view.aside.length > 0, "1: B6/B7 are still offered");

  for (const kind of ["trust", "bypass"] as const) {
    const held = at({ state: "running", rule: "session-block", session: { block: { kind }, state: "question" }, primary: "inspect-run" });
    eq(held.live, null, `1: a ${kind} prompt: no building line`);
    eq(held.whileBuilding, null, `1: a ${kind} prompt: no While Claude works`);
    eq(held.view.wait, null, `1: a ${kind} prompt: B8 does not say still working`);
  }
  const question = at({ state: "running", rule: "builder-waiting", waiting: "question", primary: "inspect-run" });
  eq(question.live, null, "1: a question: no building line");

  const limit = at({ state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: "15:40" }, state: "question" }, primary: "inspect-run" });
  eq(limit.live, { tone: "paused", text: "Paused · your plan's limit resets at 15:40" }, "1: the usage limit: Paused until");
  eq(limit.whileBuilding, null, "1: paused: no While Claude works");
  eq(limit.view.wait, null, "1: paused: B8 does not say still working");
}

// 2: B9 on a plain website — Open index.html showed it: done, no fallback;
// the fallback, where it applies, says to open the page, not to start it.
{
  const r = doneUpTo(STEP.tryIt);
  const changed = card("c1", { notes: LONG_BRIEF, worktreePath: "/tmp/lyra-c1", ...built });
  const ready: Shown = { state: "ready-to-ship", primary: "ship", shipMode: "merge_live" };
  const key = cardKey(WS, "c1");
  const opened = { cards: [changed], shown: { c1: ready }, trySheetSeen: new Set([key]), tryOpened: new Set([key]), staticSites: new Set([key]) };
  ok(observeTour(r, snapshot(r, opened), NOW)?.done?.[STEP.tryIt], "2: Open index.html marks B9");
  eq(panelView(r, snapshot(r, opened)).tryFallback, null, "2: and no terminal fallback after it");
  // The sheet closed with nothing opened on a plain website: open the page.
  const cancelled = { ...opened, tryOpened: new Set<string>() };
  eq(panelView(r, snapshot(r, cancelled)).tryFallback, { text: TRY_FALLBACK.staticBeforeShip, details: null }, "2: a plain website: open index.html, no terminal");
  ok(!TRY_FALLBACK.staticBeforeShip.includes("localhost"), "2: no localhost preview for a page");
  const skipped = skipStep(r, STEP.tryIt, NOW);
  const shipped = completeStep(skipped, STEP.ship, NOW);
  eq(
    panelView(shipped, snapshot(shipped, { ...cancelled, cards: [{ ...changed, shipStatus: "shipped" }], shown: { c1: { state: "shipped" } } })).tryFallback,
    { text: TRY_FALLBACK.staticAfterShip, details: null },
    "2: skipped, after shipping: open its index.html",
  );
  // Skipped and then opened: no fallback.
  eq(panelView(skipped, snapshot(skipped, opened)).tryFallback, null, "2: skipped, then opened: no fallback");
}

// 3: a card step while its card's page is not on screen — Take me there to
// it (B4–B10, B5b), whatever it waits on.
{
  const c1 = card("c1", { notes: LONG_BRIEF, worktreePath: "/tmp/lyra-c1", ...built });
  const cases: [string, Shown][] = [
    [STEP.brief, { state: "draft" }],
    [STEP.startBuild, { state: "ready", primary: "start-build" }],
    [STEP.finishCheck, { state: "session-closed", primary: "resume" as CardPrimaryActionId }],
    [STEP.finishCheck, { state: "running", primary: "inspect-run" }],
    [STEP.tryIt, { state: "ready-to-ship", primary: "ship" }],
    [STEP.ship, { state: "ready-to-ship", primary: "ship" }],
  ];
  for (const [id, sh] of cases) {
    const r = doneUpTo(id);
    const cardOf = id === STEP.brief ? card("c1") : c1;
    const away = panelView(r, snapshot(r, { cards: [cardOf], shown: { c1: sh }, mode: "inbox" as CenterMode }));
    eq(away.view.step?.id, id, `3: ${id} current`);
    ok(away.cardElsewhere, `3: ${id} (${sh.state}) on the Inbox: Take me there to the card`);
    const here = panelView(r, snapshot(r, { cards: [cardOf], shown: { c1: sh }, openCardId: "c1" }));
    ok(!here.cardElsewhere, `3: ${id} on the card's page: no Take me there`);
  }
  const stopped = doneUpTo(STEP.finishCheck);
  const away = panelView(stopped, snapshot(stopped, { cards: [c1], shown: { c1: { state: "session-closed" } }, mode: "inbox" as CenterMode }));
  eq(away.view.wait, "stopped", "3: B8 after a quit: Something stopped");
  ok(away.cardElsewhere, "3: and Take me there to its card");
  // B5b: its coach-mark only on the tour card's own page.
  const limit: Shown = { state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: null }, state: "question" }, primary: "inspect-run" };
  eq(panelView(stopped, snapshot(stopped, { cards: [c1], shown: { c1: limit }, openCardId: "other" })).coachAnchor, null, "3: B5b never points at another card's Open session");
}

// 4: the usage limit — B5b's coach-mark points at the Now box's Open session
// (`inspect-run`), whatever B8 under it waits on.
{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const limit = panelView(
    r,
    snapshot(r, {
      cards: [c1],
      shown: { c1: { state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: "3:40pm" }, state: "question" }, primary: "inspect-run" } },
      openCardId: "c1",
    }),
  );
  eq(limit.pointing?.step.id, STEP.aiAsks, "4: B5b is pointed at");
  eq(limit.coachAnchor, "card-primary", "4: its coach-mark is drawn on Open session");
  const notYet = panelView(
    r,
    snapshot(r, {
      cards: [c1],
      shown: { c1: { state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: null }, state: "question" }, primary: "finish-and-check" } },
      openCardId: "c1",
    }),
  );
  eq(notYet.coachAnchor, null, "4: never on a primary that says something else (TU-4 rule)");
}

// 5: the guided first card in a project whose board is not loaded —
// Continue with it, in general words until its board is read.
{
  const r = completeStep(completeStep(started, STEP.howItWorks, T0), STEP.openBoard, T0);
  const guide = { workspaceId: OTHER_WS, cardId: "g", startedAt: "2026-10-20T08:00:00Z" };
  const base = input(r, { guidedCard: guide });
  const unloaded = { ...base, boards: { [WS]: { loaded: true, cards: [] } } };
  const before = panelView(r, buildTutorialSnapshot(unloaded));
  eq(before.b3?.continueWith, { label: CONTINUE_GUIDED_GENERIC, workspaceId: OTHER_WS, cardId: "g" }, "5: its board not loaded: Continue with, general words");
  eq(before.b3?.safeExample, null, "5: and not a second README card");
  const read = panelView(
    r,
    buildTutorialSnapshot({ ...unloaded, guidedBoard: { workspaceId: OTHER_WS, cards: [card("g", { workspaceId: OTHER_WS, title: FIRST_CARD_TITLE })] } }),
  );
  eq(read.b3?.continueWith?.label, `Continue with "${FIRST_CARD_TITLE}"`, "5: its board read: its title");
  const gone = panelView(r, buildTutorialSnapshot({ ...unloaded, guidedBoard: { workspaceId: OTHER_WS, cards: [] } }));
  eq(gone.b3?.continueWith, null, "5: the card gone from its board: nothing to continue");
  eq(gone.b3?.safeExample, SAFE_EXAMPLE_LINK, "5: then the safe example, so B3 is never left with neither");
}

// ── TU-5 Mac walk fixes, Challenger round 1 ─────────────────────────────

// 1: `building` for both AIs, a card in line, a turn over and a relaunch.
{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const facts = (sh: Shown) => snapshot(r, { cards: [c1], shown: { c1: sh } }).tourCard;
  const at = (sh: Shown) => panelView(r, snapshot(r, { cards: [c1], shown: { c1: sh } }), { now: T0_MS + 300_000 });
  for (const vendor of ["claude", "codex"] as const) {
    const who = vendor === "claude" ? "Claude" : "Codex";
    eq(facts({ state: "running", vendor, primary: "inspect-run" })?.building, true, `C1: ${vendor} at work: building`);
    eq(at({ state: "running", vendor, primary: "inspect-run" }).live?.text, `${who} is working · 3 min`, `C1: ${vendor}: its own name`);
    const over: Shown = { state: "running", vendor, rule: "builder-waiting", waiting: "stopped", primary: "finish-and-check" };
    eq(facts(over)?.building, false, `C1: ${vendor} turn over: not building`);
    eq(at(over).live, null, `C1: ${vendor} turn over: no line`);
    // Quiet past the threshold (Codex's turn over, no prompt box): B5b
    // says it may be waiting, so not "building".
    const quiet: Shown = { state: "running", vendor, rule: "builder-waiting", waiting: "quiet", primary: "inspect-run" };
    eq(facts(quiet)?.building, false, `C1: ${vendor} quiet: not building`);
  }
  const queued = at({ state: "queued", primary: "see-queue" as CardPrimaryActionId });
  eq(snapshot(r, { cards: [c1], shown: { c1: { state: "queued" } } }).tourCard?.building, false, "C1: in line: not building");
  eq(queued.live, { tone: "running", text: "In line: it starts when a slot is free" }, "C1: in line: its own line");
  eq(queued.whileBuilding, null, "C1: in line: no While Claude works");
  // After a relaunch the session is gone (Resume on the card).
  const closed: Shown = { state: "session-closed", primary: "resume" as CardPrimaryActionId };
  eq(facts(closed)?.building, false, "C1: after a relaunch: not building");
  eq(at(closed).live, null, "C1: after a relaunch: no building line");
  // Landed: nothing is built any more.
  eq(snapshot(r, { cards: [{ ...c1, shipStatus: "shipped" }], shown: { c1: { state: "running" } } }).tourCard?.building, false, "C1: landed: not building");
}

// 2: Take me there to the card only for a step on the card's page — B6/B7
// (a mode) never open the card.
{
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const r = { ...doneUpTo(STEP.finishCheck) };
  const v = panelView(r, snapshot(r, { cards: [c1], shown: { c1: { state: "running", primary: "inspect-run" } }, mode: "code" as CenterMode }));
  eq(v.view.step?.id, STEP.finishCheck, "C2: B8 current");
  ok(v.cardElsewhere, "C2: B8 in Code: Take me there to the card");
  for (const id of [STEP.watchTerminals, STEP.whatCodeIs]) {
    const nav = stepById(id)?.navigate;
    ok(nav != null && !("card" in nav), `C2: ${id} goes to a mode, not the card`);
  }
}

// 3: the guided card's board couldn't be read: not offered, and no second
// README card (it may well be there).
{
  const r = completeStep(completeStep(started, STEP.howItWorks, T0), STEP.openBoard, T0);
  const guide = { workspaceId: OTHER_WS, cardId: "g", startedAt: "2026-10-20T08:00:00Z" };
  const unloaded = { ...input(r, { guidedCard: guide }), boards: { [WS]: { loaded: true, cards: [] } } };
  const failed = panelView(r, buildTutorialSnapshot({ ...unloaded, guidedBoard: { workspaceId: OTHER_WS, cards: null } }));
  eq(failed.b3?.continueWith ?? null, null, "C3: read failed: Continue with not offered");
  eq(failed.b3?.safeExample ?? null, null, "C3: read failed: no second README card");
  // A read of another project's board says nothing about this one.
  const elsewhere = panelView(r, buildTutorialSnapshot({ ...unloaded, guidedBoard: { workspaceId: WS, cards: [] } }));
  eq(elsewhere.b3?.continueWith?.label, CONTINUE_GUIDED_GENERIC, "C3: another board's read: still the general words");
  // The guided card's project removed from the list: gone, the safe example.
  const removed = panelView(r, buildTutorialSnapshot({ ...unloaded, workspaces: { loaded: true, list: [{ id: WS, name: "lyra" }] } }));
  eq(removed.b3?.continueWith ?? null, null, "C3: its project removed: not offered");
  eq(removed.b3?.safeExample, SAFE_EXAMPLE_LINK, "C3: its project removed: the safe example");
}

// ── TU-5 Mac re-walk (2026-10-21-111218, step 8) ─────────────────────────

// 1: Finish and check pressed — the self-check (ADR 0006), then the save and
// the checks' hand-off. The card still says Working (its turn-over is no
// longer "stopped" for the person), but nobody is building: the live line
// says the check, no "While Claude works", and B8 never asks for the press
// it already had.
{
  const r = doneUpTo(STEP.finishCheck);
  const c1 = card("c1", { notes: LONG_BRIEF, ...built });
  const working: Shown = { state: "running", primary: "inspect-run" };
  const at = (finishing?: "self-check" | "saving") =>
    panelView(r, snapshot(r, { cards: [c1], shown: { c1: working }, finishing: finishing ? { c1: finishing } : undefined }), {
      now: T0_MS + 300_000,
    });
  const self = at("self-check");
  eq(self.view.step?.id, STEP.finishCheck, "R1: B8 current");
  const selfFacts = snapshot(r, { cards: [c1], shown: { c1: working }, finishing: { c1: "self-check" } }).tourCard;
  eq(selfFacts?.building, false, "R1: self-check: not building");
  eq(selfFacts?.finishing, "self-check", "R1: self-check: finishing");
  eq(self.live, { tone: "running", text: "Claude is re-reading its work" }, "R1: self-check: the card's own words");
  eq(self.whileBuilding, null, "R1: self-check: no While Claude works");
  eq(self.view.wait, "checking", "R1: self-check: B8 says the check is under way");
  ok(!/press|shows on the card/i.test(self.waitLine ?? ""), "R1: B8's wait asks for no press");
  ok(self.view.aside.length > 0, "R1: B6/B7 still offered");
  const saving = at("saving");
  eq(saving.live, { tone: "running", text: "Saving and checking…" }, "R1: saving: Finish and check's busy words");
  eq(saving.whileBuilding, null, "R1: saving: no While Claude works");
  eq(saving.view.wait, "checking", "R1: saving: the check under way");
  // A question in view during the self-check is still B5b's, not the check.
  const asked = panelView(
    r,
    snapshot(r, { cards: [c1], shown: { c1: { state: "running", rule: "builder-waiting", waiting: "question", primary: "inspect-run" } }, finishing: { c1: "self-check" } }),
  );
  eq(asked.live, null, "R1: a question during the self-check: no live line");
  eq(asked.view.wait, null, "R1: a question during the self-check: B5b says it");
  // Without Finish and check, B5–B7 keep their building words.
  const plain = at();
  eq(plain.live?.text, "Claude is working · 3 min", "R1: not finishing: still building");
  eq(plain.whileBuilding, "While Claude works: two things worth seeing", "R1: not finishing: While Claude works");
  eq(plain.view.wait, "still-building", "R1: not finishing: still working");
}

// TU-5 Windows walk: before a card, the words name Setup's default Builder.
{
  const r = { startedAt: T0, path: "full" } as TutorialProgress;
  const base = input(r, {});
  eq(tourVendor(buildTutorialSnapshot({ ...base, defaultBuilder: "codex" })), "codex", "W1: default Builder Codex, both ready: Codex");
  eq(tourVendor(buildTutorialSnapshot({ ...base, defaultBuilder: "claude" })), "claude", "W1: default Builder Claude: Claude");
  eq(
    tourVendor(buildTutorialSnapshot({ ...base, defaultBuilder: "codex", ai: { claude: true, codex: false } })),
    "claude",
    "W1: default Codex not ready: the ready AI",
  );
  eq(tourVendor(buildTutorialSnapshot({ ...base, defaultBuilder: null })), "claude", "W1: no default: Claude");
}

console.log(`tutorialBase.test.ts: ${checks} checks`);
