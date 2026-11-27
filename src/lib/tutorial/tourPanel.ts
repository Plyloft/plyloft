/**
 * Getting started TU-4 (docs/tutorial/TUTORIAL_SPEC.md §3.1, §3.2, §10): what
 * the Guide panel and the coach-mark say, from the record and the snapshot.
 * Pure — no React, no store, no DOM — so the words and the order are decided
 * once and both surfaces read them.
 */
import type { TutorialProgress } from "../settingsShape.ts";
import type { AgentVendor } from "../roleModels.ts";
import { formatKeys } from "../platform.ts";
import {
  ASK_COPY,
  ASK_NEVER_ANSWERS,
  ASK_TITLE,
  CHAPTER_DONE_COPY,
  CHAPTERS,
  CONTINUE_GUIDED_GENERIC,
  CONTINUE_GUIDED_LINK,
  OPT,
  SECOND_AI_OFFER,
  LIVE_COPY,
  SAFE_EXAMPLE_LINK,
  SECOND_CARD_CHECKLIST,
  SECOND_CARD_DONE,
  SECOND_CARD_HINTS,
  SECOND_CARD_OFFER,
  TRY_FALLBACK,
  LOOP_DONE_ALONE_BODY,
  LOOP_DONE_COPY,
  LOOP_DONE_SHORT_BODY,
  PERMISSIONS_ANSWERED,
  PERMISSIONS_QUESTION,
  SHIP_PR_AUTO_MERGE_LINE,
  SHIP_PR_PLYLOFT_MERGE_LINE,
  SHIP_PR_OPEN_LINE,
  STEP,
  WAIT_COPY,
  WHILE_BUILDING_LINE,
  fillWords,
  stepAsShown,
  stepCopy,
  type ChapterId,
  type ChecklistItem,
  type StepCopy,
  type TourAnchor,
  type TourNav,
  type TutorialStep,
} from "./manifest.ts";
import {
  chapterProgress,
  chapterSteps,
  currentChapter,
  isDone,
  optionalChapters,
  stepApplies,
  type ChapterProgress,
  isSkipped,
  pointable,
  tourRunning,
  tourView,
  type TourView,
  type TutorialSnapshot,
} from "./tutorialEngine.ts";
import { builderPermissionsLabel, type BuilderPermissions } from "../builderPermissions.ts";

/** 1.175.0 F4: the permissions question shows once the tour card shipped,
 *  while the tour runs, until it is answered or closed — and only while
 *  new cards still ask (round 2): someone who already chose another way in
 *  Settings would read a false lede, and "Keep this" would keep it under
 *  another row's name. */
export function permissionsQuestionShown(record: TutorialProgress | null | undefined, s: TutorialSnapshot): boolean {
  return (
    tourRunning(record) &&
    isDone(record, STEP.ship) &&
    !isDone(record, STEP.permissions) &&
    !isSkipped(record, STEP.permissions) &&
    !s.builderPermissionsAsked &&
    s.builderPermissions === "asks"
  );
}

/** F4: the question's view, in the words of the AI that built the tour card. */
export function permissionsQuestion(s: TutorialSnapshot): NonNullable<PanelView["permissions"]> {
  const vendor: AgentVendor = s.tourCard?.vendor ?? s.defaultBuilder ?? "claude";
  const words = PERMISSIONS_QUESTION[vendor];
  const now = (choice: BuilderPermissions) => (s.builderPermissions === choice ? PERMISSIONS_QUESTION.now : null);
  return {
    title: `How should ${AI_NAME_OF[vendor]} work on your next cards?`,
    lede: words.lede,
    choices: [
      { use: false, name: builderPermissionsLabel("asks", vendor), mark: now("asks"), text: words.keep, button: PERMISSIONS_QUESTION.keepLabel },
      { use: true, name: builderPermissionsLabel("editsCopy", vendor), mark: now("editsCopy"), text: words.use, button: PERMISSIONS_QUESTION.useLabel },
    ],
    footer: "You can change it in Settings › Cards › AI and models, and on any card before Start build.",
  };
}

const AI_NAME_OF: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

const AI_NAME: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

/** Who the words name: the tour card's Builder, else the default Builder
 *  Setup or Settings chose while it is ready (TU-5 Windows walk), else the
 *  AI that is ready here (Codex-only: every word says Codex, §11), else
 *  Claude. */
export function tourVendor(s: TutorialSnapshot): AgentVendor {
  if (s.tourCard) return s.tourCard.vendor;
  if (s.defaultBuilder && s.ai[s.defaultBuilder]) return s.defaultBuilder;
  if (!s.ai.claude && s.ai.codex) return "codex";
  return "claude";
}

export type RowStatus = "done" | "skipped" | "current" | "offered" | "todo";

export interface PanelRow {
  step: TutorialStep;
  /** The step's words for this Builder. */
  copy: StepCopy;
  status: RowStatus;
  /** "4" of "Step 4 of 10"; null for a step not counted. */
  number: number | null;
}

export interface PanelView {
  chapter: { id: ChapterId; title: string };
  view: TourView;
  rows: PanelRow[];
  /** "4 of 10". */
  progress: string;
  /** What the panel says while the tour waits on something else (§7, §11). */
  waitLine: string | null;
  /** B5b while the card's session asks (D22). */
  ask: { title: string; body: string } | null;
  /** B6/B7's line while the build runs. */
  whileBuilding: string | null;
  /** TU-5 (§3.1, §11): the live line while the tour card's Builder works —
   *  *Claude is building · 3 min*, *In line…*, *Paused until 15:40*. */
  live: { text: string; tone: "running" | "paused" } | null;
  /** TU-5 (B3): what the current B3 offers besides New card. */
  b3: {
    /** *No idea yet? Use a safe example* (the guided first card, §2). */
    safeExample: string | null;
    /** §11: the guided first card under way — Continue with it. */
    continueWith: { label: string; workspaceId: string; cardId: string } | null;
  } | null;
  /** TU-5 (§6.3): the fallback for B9, drawn under its row. */
  tryFallback: { text: string; details: string | null } | null;
  /** 1.175.0 F4: the question under "That's the loop", once the tour card
   *  shipped; null otherwise. */
  permissions: {
    title: string;
    lede: string;
    choices: { use: boolean; name: string; mark: string | null; text: string; button: string }[];
    footer: string;
  } | null;
  /** F4: the line after the answer, while "That's the loop" shows. */
  permissionsAnswered: string | null;
  /** TU-5 (B11, D24): the second card's checklist, once B10 is done. */
  checklist: {
    step: TutorialStep;
    offer: string;
    rows: { item: ChecklistItem; done: boolean; hint: string }[];
    done: boolean;
    /** B11 done or skipped: the tour is quiet now. */
    quiet: string | null;
  } | null;
  /** The step the coach-mark points at: B5b over the current step.
   *  `ready`: its control says what the step asks for now (`pointable`);
   *  when not, the coach-mark waits and the panel says why. */
  pointing: { step: TutorialStep; copy: StepCopy; number: number | null; ready: boolean } | null;
  /** The anchor the coach-mark is drawn on now: the pointed-at step's, when
   *  its control says what the step asks for and nothing else is waited on.
   *  B5b is about the card's session, not the step under it: what that step
   *  waits on never holds B5b's coach-mark back (TU-5 Mac walk: the usage
   *  limit had none on Open session). */
  coachAnchor: TourAnchor | null;
  /** TU-5 Mac walk: the current step is about the tour card and its page is
   *  not on screen — the panel offers Take me there to it, whatever the step
   *  waits on (B8 after Resume on the Inbox). */
  cardElsewhere: boolean;
  /** Every step is done or skipped: *That's the loop*, or the line for an
   *  open pull request (§11). */
  finished: StepCopy | null;
  /** The polite announcement (§10): "Step 4 of 10: Say what you want". */
  announcement: string;
  /** TU-7 (§3.1): the other chapters, listed under *More, when you're
   *  ready* — the optional ones that apply here, and the base chapter when
   *  another one is shown. */
  chapters: (ChapterProgress & { length: string })[];
  /** TU-7 (§6.6 G3): after B10, while only one AI is ready — *Add a second
   *  AI*, once (until G3 is done or skipped: *Not now* skips it). */
  secondAi: (StepCopy & { step: TutorialStep }) | null;
}

const BASE = CHAPTERS[0];

/** "3 steps", "1 of 3", "Done" — a chapter's line in the list (§3.1). */
export function chapterLength(p: ChapterProgress): string {
  if (p.complete) return "Done";
  if (p.closed > 0) return `${p.done} of ${p.total}`;
  return p.total === 1 ? "1 step" : `${p.total} steps`;
}

/** The step's words as drawn: ⌘ as this machine writes it (`formatKeys`);
 *  *this Mac* stays for `machineWords` where it is drawn. */
function keysFor(copy: StepCopy, s: TutorialSnapshot): StepCopy {
  if (s.platform === "mac") return copy;
  const k = (t: string) => formatKeys(t, s.platform);
  return {
    ...copy,
    title: k(copy.title),
    body: k(copy.body),
    ...(copy.why ? { why: k(copy.why) } : {}),
    ...(copy.notes ? { notes: copy.notes.map(k) } : {}),
  };
}

/** The panel, from the record and the snapshot. `chapter`: the one the
 *  person picked (TU-7, in memory); `currentChapter` decides. */
export function panelView(
  record: TutorialProgress | null | undefined,
  s: TutorialSnapshot,
  opts: { cardGone?: boolean; focus?: string | null; now?: number; chapter?: ChapterId | null } = {},
): PanelView {
  const chapterId = currentChapter(record, s, opts.chapter);
  const shown = CHAPTERS.find((c) => c.id === chapterId) ?? BASE;
  const isBase = shown.id === BASE.id;
  const view = tourView(record, s, { chapter: shown.id, cardGone: opts.cardGone, focus: opts.focus });
  const vendor = tourVendor(s);
  // 1.171.0 A3: null (not known yet) has its own words.
  const shipsAs = s.tourCard ? s.tourCard.shipsAs : undefined;
  const words = { ai: AI_NAME[vendor] };
  const copyOpts = {
    shipsAs,
    emptyProject: s.emptyProject === true,
    guidedStart: s.tourCard?.guidedUnedited === true,
    tourBounded: s.tourCard?.tourBounded === true,
    oneAi: s.ai.claude !== s.ai.codex,
    project: s.here.workspaceName,
  };
  // K3 on a plain website is explain-only (`stepAsShown`).
  const steps = chapterSteps(shown.id, s)
    .filter((st) => st.kind !== "interrupt" && st.kind !== "checklist" && st.kind !== "question")
    .map((st) => stepAsShown(st, s));
  const counted = steps.filter((st) => st.counted);
  const offered = new Set(view.aside.map((st) => st.id));
  const rows = steps.map<PanelRow>((step) => {
    const status: RowStatus = isDone(record, step.id)
      ? "done"
      : isSkipped(record, step.id)
        ? "skipped"
        : view.step?.id === step.id
          ? "current"
          : offered.has(step.id)
            ? "offered"
            : "todo";
    const index = counted.indexOf(step);
    return {
      step,
      copy: keysFor(stepCopy(step, vendor, copyOpts), s),
      status,
      number: index >= 0 ? index + 1 : null,
    };
  });

  let waitLine: string | null = null;
  if (view.wait) {
    waitLine = fillWords(WAIT_COPY[view.wait], {
      ...words,
      workspace: s.tourWorkspaceName ?? "your project",
    });
  }

  const ask = view.interrupt
    ? {
        title: fillWords(ASK_TITLE[view.interrupt.kind], words),
        body: `${fillWords(ASK_COPY[view.interrupt.kind], words)} ${ASK_NEVER_ANSWERS}`,
      }
    : null;

  const current = rows.find((r) => r.status === "current") ?? null;
  const pointing = view.interrupt
    ? {
        step: view.interrupt.step,
        copy: { title: ask!.title, body: ask!.body },
        number: null,
        ready: pointable(view.interrupt.step, s),
      }
    : current
      ? { step: current.step, copy: current.copy, number: current.number, ready: pointable(current.step, s) }
      : null;

  // "Pick a chapter below" only once there are chapters below (TU-7).
  // F4: shortened while the permissions question is open under it.
  const asking = isBase && permissionsQuestionShown(record, s);
  const loopBody = asking ? LOOP_DONE_SHORT_BODY : CHAPTERS.length > 1 ? LOOP_DONE_COPY.body : LOOP_DONE_ALONE_BODY;
  // B11 is the panel's own checklist, never a pointed-at step: the loop is
  // complete once only it (or nothing) is left.
  const onlyChecklist = !view.step || view.step.kind === "checklist";
  const finished = !isBase
    ? view.step
      ? null
      : CHAPTER_DONE_COPY
    : onlyChecklist && view.aside.length === 0
      ? {
          title: LOOP_DONE_COPY.title,
          // G1 Challenger (10): GitHub merges it by itself, or it waits for you.
          body:
            s.tourCard?.prOpen && !s.tourCard.landed
              ? `${loopBody} ${
                  s.tourCard.plyloftMerges
                    ? SHIP_PR_PLYLOFT_MERGE_LINE
                    : s.tourCard.prAutoMerge
                      ? SHIP_PR_AUTO_MERGE_LINE
                      : SHIP_PR_OPEN_LINE
                }`
              : loopBody,
        }
      : null;

  // §3.1, §11: the live line. The usage limit first: the session says when
  // it resets, and the line says it too when the reset is known.
  const card = s.tourCard;
  let live: PanelView["live"] = null;
  if (view.interrupt?.kind === "usageLimit") {
    live = {
      tone: "paused",
      text: view.interrupt.resetsAt
        ? fillWords(LIVE_COPY.pausedUntil, { time: view.interrupt.resetsAt })
        : fillWords(LIVE_COPY.paused, words),
    };
  } else if (card && card.queued && !card.landed && !card.prOpen) {
    live = { tone: "running", text: LIVE_COPY.queued };
  } else if (card?.finishing && card.asks == null) {
    // TU-5 Mac re-walk: Finish and check pressed — the check, not a build.
    live = { tone: "running", text: fillWords(card.finishing === "self-check" ? LIVE_COPY.selfCheck : LIVE_COPY.saving, words) };
  } else if (card?.building) {
    // TU-5 Mac walk: only while the Builder really works — not once its turn
    // is over (Builder stopped), nor while a question or a prompt holds it.
    const since = card.buildStartedAt != null && opts.now != null ? buildMinutes(opts.now - card.buildStartedAt) : null;
    const text = fillWords(LIVE_COPY.building, words);
    live = { tone: "running", text: since ? `${text} · ${since}` : text };
  }

  // B3's other ways (§6.2, §11): the safe example, the guided card under
  // way.
  const b3Current = view.step?.id === STEP.newCard;
  const b3: PanelView["b3"] = isBase && b3Current
    ? {
        safeExample: !b3Current || s.guidedCard || !s.safeExampleOffered ? null : SAFE_EXAMPLE_LINK,
        continueWith: b3Current && s.guidedCard
          ? {
              label: s.guidedCard.title
                ? fillWords(CONTINUE_GUIDED_LINK, { title: s.guidedCard.title })
                : CONTINUE_GUIDED_GENERIC,
              workspaceId: s.guidedCard.workspaceId,
              cardId: s.guidedCard.cardId,
            }
          : null,
      }
    : null;

  // §6.3: B9 skipped, or Try it can't start this project.
  const tryStep = steps.find((st) => st.id === STEP.tryIt);
  let tryFallback: PanelView["tryFallback"] = null;
  if (tryStep && card) {
    // G1 Challenger (10): a pull request still open isn't in the project
    // here yet — the card's copy is where the change runs until it merges.
    const shipped = card.landed || (!card.prOpen && isDone(record, STEP.ship));
    // TU-5 Mac walk: seen (Running, or a plain website opened): nothing to
    // fall back on. A plain website is opened, never started in a terminal.
    const skipped = isSkipped(record, STEP.tryIt) && !isDone(record, STEP.tryIt) && !card.tryOpened;
    const stuck = view.step?.id === STEP.tryIt && card.tryFallback;
    if (skipped || stuck) {
      tryFallback = card.staticSite
        ? { text: shipped ? TRY_FALLBACK.staticAfterShip : TRY_FALLBACK.staticBeforeShip, details: null }
        : shipped
          ? { text: TRY_FALLBACK.afterShip, details: null }
          : { text: TRY_FALLBACK.beforeShip, details: TRY_FALLBACK.beforeShipDetails };
    }
  }

  // §6.3, K3: Try it in <project> skipped — how to see it running by hand.
  // A plain website (its start-command read, or the sheet, said so) is
  // opened, never started.
  if (
    !isBase &&
    isSkipped(record, OPT.codeTryProject) &&
    !isDone(record, OPT.codeTryProject) &&
    !s.here.projectTryOpened &&
    steps.some((st) => st.id === OPT.codeTryProject)
  ) {
    const prWaits = s.tourCard?.prOpen === true && !s.tourCard.landed;
    tryFallback = {
      text: prWaits
        ? TRY_FALLBACK.afterPrShip
        : s.here.projectStaticSite
          ? TRY_FALLBACK.staticAfterShip
          : TRY_FALLBACK.afterShip,
      details: null,
    };
  }

  // B11 (D24): after B10, the second card on its own — the panel's list only.
  let checklist: PanelView["checklist"] = null;
  const second = chapterSteps(BASE.id, s).find((st) => st.kind === "checklist");
  if (isBase && second && isDone(record, STEP.ship)) {
    const ticks = s.secondCard?.ticks;
    const tick: Record<ChecklistItem, boolean> = {
      Title: ticks?.title ?? false,
      "What you want": ticks?.brief ?? false,
      "Start build": ticks?.started ?? false,
      "Finish and check": ticks?.checked ?? false,
      "Try it": ticks?.tried ?? false,
      "Ship it": ticks?.shipped ?? false,
    };
    const over = isDone(record, second.id) || isSkipped(record, second.id);
    checklist = {
      step: second,
      offer: SECOND_CARD_OFFER,
      rows: SECOND_CARD_CHECKLIST.map((item) => ({
        item,
        done: isDone(record, second.id) || tick[item],
        hint: fillWords(SECOND_CARD_HINTS[item], words),
      })),
      done: isDone(record, second.id),
      quiet: over ? SECOND_CARD_DONE : null,
    };
  }

  const progress = `${view.doneCount} of ${view.total}`;
  // A control of the card page. A card-bound step (the base chapter's
  // B4–B10, B5b) points only while the tour card's page is the one on
  // screen: never another card's button of the same name. An optional
  // chapter's step (P1, P2: `followsActive`) is about the card open where
  // the person is (§6.6), so it points on whatever card page is open in the
  // active workspace (TU-7 Mac walk), and on none while none is.
  const onAnotherPage = (step: TutorialStep, anchor: TourAnchor) =>
    anchor.startsWith("card-") && (step.cardBound ? card != null && !s.tourCardOpen : s.here.openCard == null);
  const coachAnchor =
    pointing?.step.anchor &&
    pointing.ready &&
    (pointing.step.kind === "interrupt" || !view.wait) &&
    !onAnotherPage(pointing.step, pointing.step.anchor)
      ? pointing.step.anchor
      : null;
  // A step on the card's page (its Take me there opens the card): B6/B7 are
  // card-bound too, but their place is a mode, not the card's page.
  const cardElsewhere =
    view.step != null &&
    view.step.cardBound === true &&
    view.step.navigate != null &&
    "card" in view.step.navigate &&
    card != null &&
    !s.tourCardOpen &&
    s.workspacesLoaded &&
    view.wait !== "no-workspace" &&
    view.wait !== "ai-not-ready";
  const announcement = pointing
    ? pointing.number != null
      ? `Step ${pointing.number} of ${view.total}: ${pointing.copy.title}`
      : pointing.copy.title
    : finished
      ? finished.title
      : "";

  // §3.1: the other chapters. The team chapter only where it applies.
  const listed: ChapterId[] = [...(isBase ? [] : [BASE.id]), ...optionalChapters(s).filter((id) => id !== shown.id)];
  const chapters = listed.map((id) => {
    const p = chapterProgress(record, s, id);
    return { ...p, length: chapterLength(p) };
  });

  // §6.6 G3: after B10, while only one AI is ready, the offer once.
  const g3 = ALL_G3.find((st) => stepApplies(st, s));
  const secondAi =
    isBase && finished && g3 && !isDone(record, g3.id) && !isSkipped(record, g3.id)
      ? { title: SECOND_AI_OFFER, body: stepCopy(g3, vendor, copyOpts).body, step: g3 }
      : null;

  return {
    chapter: { id: shown.id, title: shown.title },
    view,
    rows,
    progress,
    waitLine,
    ask,
    // TU-5 Mac walk: B6/B7 stay offered, but "While Claude works" only while
    // it does.
    whileBuilding: view.aside.length > 0 && card?.building ? fillWords(WHILE_BUILDING_LINE, words) : null,
    live,
    b3,
    tryFallback,
    checklist,
    permissions: asking && finished ? permissionsQuestion(s) : null,
    permissionsAnswered:
      isBase && finished && !asking && s.builderPermissionsAsked && isDone(record, STEP.ship)
        ? PERMISSIONS_ANSWERED(
            builderPermissionsLabel(s.builderPermissions, s.tourCard?.vendor ?? s.defaultBuilder ?? "claude"),
          )
        : null,
    pointing,
    coachAnchor,
    cardElsewhere,
    finished,
    announcement,
    chapters,
    secondAi,
  };
}

const ALL_G3 = CHAPTERS.flatMap((c) => c.steps).filter((st) => st.id === OPT.secondAi);

/** §3.1: the live line's minutes — "3 min", "1 h 5 min"; "under a minute". */
export function buildMinutes(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * 1.172.0 walk (E1): Take me there found nowhere to go — the step's line in
 * the panel says why and what to do, in one plain line (never silent).
 */
export function takeMeThereNowhere(nav: TourNav): string {
  if ("card" in nav && nav.card === "any") {
    return nav.unbuilt
      ? "No card here is waiting to be built. Make a new card on the Board, then press Take me there again."
      : "Open a card on the Board, then press Take me there again.";
  }
  return "There's nowhere to go for this step yet. Start your first card, then press Take me there again.";
}

/** 1.172.0 walk (E1): Take me there opened a card, but the step's control
 *  never came on screen there. */
export const TAKE_ME_THERE_NOT_ON_CARD = "It isn't on this card. Open another card on the Board, then press Take me there again.";

/** Nothing is left for the tour to offer: B10 done and B11 done or skipped
 *  (§3.4, D24). The sidebar row goes quiet then — not at B10 alone (owner,
 *  1.174.0 A8: with no pill, the row is where a paused B11 resumes). */
export function tourQuiet(record: TutorialProgress | null | undefined): boolean {
  return isDone(record, STEP.ship) && (isDone(record, STEP.secondCard) || isSkipped(record, STEP.secondCard));
}

/**
 * §3.2: the coach-mark's first line names the control, so the ring has a
 * cue that is not its colour. `card-primary` changes its words with the
 * card's state, so it is named by what it says now.
 */
const CONTROL_NAMES: Record<TourAnchor, string> = {
  "nav-board": "The Board row",
  "nav-code": "The Code row",
  "nav-terminals": "The Terminals row",
  "nav-library": "The Library row",
  "nav-inbox": "The Inbox row",
  "nav-history": "The History row",
  "nav-all-skills": "The All skills row",
  "nav-search": "The Search row",
  "ship-batch": "The Release N cards… row",
  help: "The Help row",
  "board-new-card": "The New card button",
  "card-brief": "The What you want field",
  "card-primary": "The card's main button",
  "card-tab-chat": "The Ask about this card button",
  // 1.172.0 (C1): Plan with two AIs is in Plan it first ▾.
  "card-plan-two-ais": "The Plan it first button",
  // 1.172.0 (C2; CP B2): the checks, the Challenger, the changes, Try it.
  "card-review": "The Review section",
  "card-try-it": "The Try it button",
  "card-more": "The card's More button",
  "terminals-new": "The New button",
  "terminals-new-copy": "The In a new copy item",
  // 1.173.0 B2: under the workspace's name, with two areas or more.
  "sidebar-area": "The Area row",
  "board-next-improvement": "Next improvement, above the Board",
  "terminals-card-sessions": "Your card's session",
  "code-more": "The More for Code button",
  "library-tabs": "The Library's pages",
  settings: "The Settings row",
};

export function controlName(anchor: TourAnchor, label?: string | null): string {
  const words = label?.replace(/\s+/g, " ").trim();
  if (anchor === "card-primary" && words) return `The ${words} button`;
  return CONTROL_NAMES[anchor];
}

// ── Where the coach-mark goes (§3.2) ─────────────────────────────────────

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How much covering it costs per px² (`placeCoach`'s `avoid`): a field
   *  being written in costs more than a button (TU-5 Mac walk: B5's
   *  coach-mark sat on the end of the brief). Default 1. */
  weight?: number;
}

export type CoachSide = "right" | "left" | "below" | "above";

export interface CoachPlace {
  left: number;
  top: number;
  side: CoachSide;
  /** The arrow's offset along the side that touches the ring, in px from
   *  the coach-mark's top (right/left) or left edge (below/above). */
  arrow: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** The ring is drawn this far outside the control, 2 px thick (ux.css). */
export const RING_OUTSET = 3;
export const RING_WIDTH = 2;
/** How far the arrow's tip reaches past the coach-mark's edge: a 12 px
 *  square turned 45°, its centre on the edge (ux.css `.ux-tour-coach-arrow`,
 *  `-7px` inside a 1 px border) — half its diagonal. */
export const ARROW_REACH = 6 * Math.SQRT2;
/** Coach-mark to control: the tip lands inside the ring's line, so the
 *  arrow touches it (TU-4 Mac walk: it stopped a few px short at 12). */
export const COACH_GAP = Math.round(RING_OUTSET + ARROW_REACH - RING_WIDTH / 2);

/** 1.172 A3 (Windows walk 2026-10-27-211141, steps C–F): whether the
 *  control is not wholly in view — outside the window, or outside a box
 *  that clips it (a scrolled card page). A box with no size (not laid out)
 *  is never "off view": nothing is scrolled for it. */
export function offView(target: Box, clips: readonly Box[]): boolean {
  if (target.width <= 0 && target.height <= 0) return false;
  return clips.some(
    (c) =>
      c.width > 0 &&
      c.height > 0 &&
      (target.top < c.top || target.left < c.left || target.top + target.height > c.top + c.height || target.left + target.width > c.left + c.width),
  );
}

/** How much of `b` the box `a` covers, in px². */
const covered = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/**
 * Beside the control, so the arrow touches its ring. The sides are tried in
 * order — right, left, below, above — and of those that fit the window the
 * one that covers least of `avoid` (the other controls near it: a header
 * button's neighbour, the field under the Now box) wins, the earlier on a
 * tie; so a free side is always taken over a covering one (TU-4 Mac walk).
 * Always inside the window by `margin`.
 */
export function placeCoach(
  target: Box,
  size: { width: number; height: number },
  view: { width: number; height: number },
  { gap = COACH_GAP, margin = 8, avoid = [] }: { gap?: number; margin?: number; avoid?: readonly Box[] } = {},
): CoachPlace {
  const midY = target.top + target.height / 2;
  const midX = target.left + target.width / 2;
  const sideTop = clamp(midY - 22, margin, view.height - size.height - margin);
  const sideArrow = clamp(midY - sideTop - 6, 10, size.height - 22);
  const x = clamp(midX - size.width / 2, margin, view.width - size.width - margin);
  const arrow = clamp(midX - x - 6, 10, size.width - 22);
  const right: CoachPlace = { left: target.left + target.width + gap, top: sideTop, side: "right", arrow: sideArrow };
  const left: CoachPlace = { left: target.left - gap - size.width, top: sideTop, side: "left", arrow: sideArrow };
  const below: CoachPlace = { left: x, top: target.top + target.height + gap, side: "below", arrow };
  const above: CoachPlace = { left: x, top: target.top - gap - size.height, side: "above", arrow };
  const fits = (p: CoachPlace) =>
    p.left >= margin &&
    p.top >= margin &&
    p.left + size.width <= view.width - margin &&
    p.top + size.height <= view.height - margin;
  const cost = (p: CoachPlace) => {
    const box = { left: p.left, top: p.top, width: size.width, height: size.height };
    return avoid.reduce((sum, b) => sum + covered(box, b) * (b.weight ?? 1), 0);
  };
  let best: CoachPlace | null = null;
  let least = Infinity;
  for (const p of [right, left, below, above]) {
    if (!fits(p)) continue;
    const c = cost(p);
    if (c < least) {
      best = p;
      least = c;
    }
    if (c === 0) break;
  }
  return best ?? { ...above, top: Math.max(margin, above.top) };
}

// ── The panel and the fields it keeps clear of (§3.1) ────────────────────

/** Below this the panel is too short to read: it is not shortened then. */
export const PANEL_MIN_HEIGHT = 200;
/** Between a field kept clear and the panel's top. */
export const PANEL_FIELD_GAP = 12;

/**
 * TU-5 Mac walk: how tall the panel may be so it ends below a field the user
 * writes in (the empty Board's *What do you want to build?*, the card's What
 * you want) that sits over its column — the panel is docked at the bottom,
 * so a shorter panel uncovers it and its list scrolls on its own. Null:
 * no cap (no such field over it, or the room left is too short to read).
 */
export function panelCap(
  panel: { left: number; width: number },
  fields: readonly Box[],
  view: { height: number },
  margin: number,
): number | null {
  const bottom = view.height - margin;
  let cap: number | null = null;
  for (const f of fields) {
    if (f.width === 0 || f.height === 0) continue;
    if (f.left >= panel.left + panel.width || f.left + f.width <= panel.left) continue;
    if (f.top >= bottom) continue;
    const room = bottom - (f.top + f.height) - PANEL_FIELD_GAP;
    cap = cap == null ? room : Math.min(cap, room);
  }
  return cap != null && cap >= PANEL_MIN_HEIGHT ? Math.floor(cap) : null;
}
