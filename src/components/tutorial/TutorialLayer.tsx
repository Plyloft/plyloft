import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { revealElement } from "../ux/useReveal";
import { useSettings } from "../../store/settingsStore";
import {
  chooseTourChapter,
  completeTourStep,
  endGuide,
  logMissingAnchor,
  pauseGuide,
  answerPermissionsQuestion,
  skipTourChapter,
  skipTourStep,
  startGuideOver,
  startSafeExample,
  takeTourCard,
  tourFinishSetup,
  tourNavigate,
  unskipTourStep,
  useTutorialRuntime,
} from "../../store/tutorialStore";
import { tourRunning } from "../../lib/tutorial/tutorialEngine";
import { OPT, followsActive } from "../../lib/tutorial/manifest";
import { niKey, openNextImprovementEarly } from "../../store/nextImprovementStore";
import { currentAreaFor } from "../../store/areaStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { machineWords } from "../../lib/platform";
import { TAKE_ME_THERE_NOT_ON_CARD, panelCap, panelView, takeMeThereNowhere } from "../../lib/tutorial/tourPanel";
import {
  findTourAnchor,
  fieldBoxes,
  keepClearElements,
  KEEP_CLEAR_FIELDS,
  modalShown,
  PAGE_POPUPS,
  popupShown,
} from "../../lib/tutorial/tourAnchors";
import type { TourAnchor, TutorialStep } from "../../lib/tutorial/manifest";
import { useQuickTour } from "../../store/quickTourStore";
import { CoachMark } from "./CoachMark";
import { GuidePanel, type GuideActions } from "./GuidePanel";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * Getting started TU-4: the tour's surfaces over the shell — the Guide
 * panel, the coach-mark and the polite announcement of each step — paused,
 * nothing here: the sidebar row resumes it (TUTORIAL_SPEC §3, §9, §10).
 *
 * Drawn beside the shell, never in place of anything: it mounts and
 * unmounts only its own nodes, so opening or closing it leaves every
 * warmed host — terminals with their scrollback, the editor with its view —
 * as it was (AGENTS.md UI invariants). It moves nothing either: the tour
 * navigates through `tourNavigate`, the existing helpers.
 *
 * `covered`: Setup is up; the shell is inert behind it, and the tour hides
 * until it closes (§9). (1.178.0 A3: no Sign-in screen covers it any more —
 * the tour runs signed out.)
 */
export function TutorialLayer({ covered }: { covered: boolean }) {
  const record = useSettings((s) => s.settings.onboarding?.tutorial ?? null);
  const snapshot = useTutorialRuntime((s) => s.snapshot);
  const cardGone = useTutorialRuntime((s) => s.cardGone);
  const panelOpen = useTutorialRuntime((s) => s.panelOpen);
  const focusRequest = useTutorialRuntime((s) => s.focusRequest);
  const focus = useTutorialRuntime((s) => s.focus);
  const chapter = useTutorialRuntime((s) => s.chapter);
  const running = tourRunning(record);
  // §3.1: the live line's minutes follow a clock, only while a build runs.
  const building = snapshot?.tourCard?.building === true && snapshot.tourCard.buildStartedAt != null;
  const now = useMinuteClock(running && building);
  const pv = useMemo(
    () => (running && snapshot ? panelView(record, snapshot, { cardGone, focus, now, chapter }) : null),
    [running, record, snapshot, cardGone, focus, now, chapter],
  );
  // TU-4 walk: a sheet drawn inside the card's page (Try it's How to start
  // your app, with Save and try) sits in that page's own layer, under the
  // tour's: while one is up the tour stands aside, as it does under Setup.
  const sheetUp = useModalShown(running && !covered);
  // TU-6: one guide at a time — the Quick tour, while it runs, has the
  // screen; the panel comes back as it was when it ends.
  const quick = useQuickTour((s) => s.quick != null);
  const hidden = covered || sheetUp || quick;
  const open = running && panelOpen && !record?.paused && !hidden;

  // The control the coach-mark points at, while the panel is open, the
  // tour waits on that control (not on another workspace, the AI, …) and
  // the control says what the step asks for (the Now box's primary changes
  // its words with the card: B8 never points at Start build).
  // B5b's own control is pointed at whatever the step under it waits on
  // (`coachAnchor`, TU-5 Mac walk).
  const pointing = pv?.pointing ?? null;
  const anchor: TourAnchor | null = open ? (pv?.coachAnchor ?? null) : null;
  const { el: target, watch } = useTourTarget(anchor);
  // 1.171.0 (E2; walk 2026-10-27 #2/#3): while a menu or popover of the
  // page is open the coach-mark steps aside, and comes back when it closes.
  // A step whose control is inside the open menu still points at it.
  const popupOpen = usePopupShown(open);
  const popupUp = popupOpen && target?.closest(PAGE_POPUPS) == null;

  // The panel never covers the control the step asks for (§3.1): when that
  // control sits where the panel docks (a short window, a control at the
  // bottom right), the panel docks at the bottom left of the centre instead.
  // Decided from the docked box, so it never flips back and forth.
  const [aside, setAside] = useState<number | null>(null);
  useEffect(() => {
    if (!target) setAside(null);
  }, [target]);
  const onPlaced = useCallback((ring: DOMRect) => {
    const panel = document.querySelector<HTMLElement>("[data-ply-tour-panel]");
    if (!panel) return;
    const view = document.documentElement;
    const margin = parseFloat(getComputedStyle(panel).bottom) || 16;
    const right = view.clientWidth - margin;
    const bottom = view.clientHeight - margin;
    const covers =
      ring.left < right &&
      ring.right > right - panel.offsetWidth &&
      ring.top < bottom &&
      ring.bottom > bottom - panel.offsetHeight;
    const stage = document.querySelector(".shell-stage")?.getBoundingClientRect().left ?? 0;
    const next = covers ? Math.round(stage + margin) : null;
    // Docked aside and shortened there (`--ux-tour-cap`, a field over the
    // left column): its height is that column's, not the right dock's, so
    // "would it cover" can't be answered from it — stay, or the two rules
    // would hand the panel back and forth (Challenger). A new control
    // decides again (`target` above).
    const cappedAside = !covers && panel.style.getPropertyValue("--ux-tour-cap") !== "";
    setAside((cur) => (cur === next || (cappedAside && cur != null) ? cur : next));
  }, []);
  // TU-5 Mac walk: the rule holds for the step's control whether or not its
  // coach-mark is drawn (hidden with Esc, or not placed yet).
  useEffect(() => {
    if (!target) return;
    const run = () => {
      if (target.isConnected) onPlaced(target.getBoundingClientRect());
    };
    run();
    return watch(run);
  }, [target, watch, onPlaced]);
  // TU-5 Mac walk: and it never covers a field being written in (the empty
  // Board's, the card's What you want): the panel ends below it.
  const cap = usePanelCap(open, aside);

  // Esc hides the coach-mark of this step (§10); Show me brings it back. A
  // new step shows its own.
  const pointingId = pointing?.step.id ?? null;
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  useEffect(() => setHiddenFor(null), [pointingId]);

  // The keyboard goes where the press sent it, never dropped with the
  // surface that held it: Resume and Help › Getting started → the panel's
  // heading; Pause → the sidebar row's Resume (1.174.0, D3b: no pill), which
  // takes its own request (`TutorialStatusRow`).
  // Each request is used once, when its surface is drawn, then forgotten:
  // the panel coming back after Setup closes does not take focus again.
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const shown = running && !hidden && pv != null;
  const focusTo = shown && open && focusRequest?.to === "panel" ? "panel" : null;
  useEffect(() => {
    if (!focusTo) return;
    const el = panelHeading.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    useTutorialRuntime.setState({ focusRequest: null });
  }, [focusTo, focusRequest]);
  // Pause with no sidebar row to take it (Setup's row in its slot): the
  // keyboard lands on Help, where the tour is resumed, as after End the
  // tour. With the sidebar hidden (⌘\, or a narrow window) Help is not drawn
  // either: it lands on the stage header's sidebar button, which shows it.
  useEffect(() => {
    if (focusRequest?.to !== "sidebar") return;
    const n = focusRequest.n;
    const id = requestAnimationFrame(() => {
      const cur = useTutorialRuntime.getState().focusRequest;
      if (cur?.to !== "sidebar" || cur.n !== n) return;
      useTutorialRuntime.setState({ focusRequest: null });
      const to = findTourAnchor("help") ?? document.querySelector<HTMLElement>(".shell-sidebar-toggle");
      to?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [focusRequest]);

  // §10: a press in the panel or the coach-mark that removes its own button
  // (Start, Next, Skip this step, Do it now, a step done) never drops the
  // keyboard on the page: it goes to the panel's heading. Only when the focused node went with the render — a click away
  // leaves it connected and is left alone.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      lastFocused.current = el?.closest(LAYER) ? el : null;
    };
    const onOut = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || el !== lastFocused.current || e.relatedTarget) return;
      // Still in the page after the blur: the user clicked away.
      queueMicrotask(() => {
        if (el.isConnected && lastFocused.current === el) lastFocused.current = null;
      });
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  useLayoutEffect(() => {
    const was = lastFocused.current;
    if (!was || was.isConnected) return;
    lastFocused.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    panelHeading.current?.focus({ preventScroll: true });
  });

  // §11: after Take me there, an anchor still not on screen is a renamed or
  // moved control: logged once (Diagnostics' log), the panel's words stay.
  const [sentTo, setSentTo] = useState<{ anchor: TourAnchor; step: TutorialStep } | null>(null);
  // 1.172.0 walk (E1): Take me there is never silent — when it finds
  // nowhere to go, or a card step's control never comes on screen there,
  // the step's row says so in one plain line.
  const [nowhere, setNowhere] = useState<{ stepId: string; anchor: TourAnchor | null; text: string } | null>(null);
  const currentStepId = pv?.rows.find((r) => r.status === "current")?.step.id ?? null;
  useEffect(() => {
    setNowhere(null);
  }, [currentStepId]);
  // Once the step's control is on screen, the line is no longer true.
  const { el: nowhereTarget } = useTourTarget(nowhere?.anchor ?? null);
  useEffect(() => {
    if (nowhereTarget) setNowhere(null);
  }, [nowhereTarget]);
  useEffect(() => {
    if (!sentTo) return;
    const t = window.setTimeout(() => {
      if (!findTourAnchor(sentTo.anchor)) {
        logMissingAnchor(sentTo.anchor);
        const nav = sentTo.step.navigate;
        if (nav && "card" in nav && nav.card === "any") {
          setNowhere({ stepId: sentTo.step.id, anchor: sentTo.anchor, text: TAKE_ME_THERE_NOT_ON_CARD });
        }
      }
      setSentTo(null);
    }, MISSING_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [sentTo]);

  if (!running || hidden || !pv) return null;

  // Code's status bar (Wrap) runs along the window's bottom: the panel sits
  // above it there, never on its controls (TU-4 Mac walk).
  const lift = snapshot?.mode === "code";

  const actions: GuideActions = {
    pause: () => void pauseGuide(),
    answerPermissions: (use) => void answerPermissionsQuestion(use),
    skip: (step) => void skipTourStep(step.id),
    unskip: (step) => void unskipTourStep(step.id),
    complete: (step) => void completeTourStep(step.id),
    showMe: () => {
      setHiddenFor(null);
      if (target) focusControl(target);
    },
    takeMeThere: (step) => {
      if (!step.navigate) return;
      setNowhere(null);
      // 1.174.0 (A6, D2c): before the first shipped card Next improvement
      // isn't on the Board by itself; the step opens it, as ⋯ ›
      // Next improvement… does.
      if (step.id === OPT.nextImprovement) {
        const here = useWorkspaces.getState().activeId;
        if (here) openNextImprovementEarly(here, niKey(here, currentAreaFor(here)));
      }
      if (!tourNavigate(step.navigate, { active: followsActive(step) })) {
        setNowhere({ stepId: step.id, anchor: step.anchor ?? null, text: takeMeThereNowhere(step.navigate) });
      } else if (step.anchor) {
        setSentTo({ anchor: step.anchor, step });
      }
    },
    goToTourWorkspace: () => void tourNavigate({ workspace: "tour" }),
    skipChapter: () => void skipTourChapter(pv.chapter.id),
    startOver: () => void startGuideOver(),
    finishSetup: (step) => tourFinishSetup(step),
    takeCard: (workspaceId, cardId) =>
      void takeTourCard(workspaceId, cardId).catch((e) =>
        pushErrorToast("Couldn't use that card", e),
      ),
    // The guided card's own store says why when it can't be made.
    safeExample: () => void startSafeExample().catch(() => {}),
    chooseChapter: (id) => chooseTourChapter(id),
    end: () => {
      void endGuide();
      // The panel goes: the keyboard lands on Help, where the tour is
      // reopened (§9).
      requestAnimationFrame(() => findTourAnchor("help")?.focus({ preventScroll: true }));
    },
  };

  const coach =
    open && !popupUp && target && pointing && pointing.step.anchor && hiddenFor !== pointing.step.id ? (
      <CoachMark
        key={pointing.step.id}
        target={target}
        anchor={pointing.step.anchor}
        copy={pointing.copy}
        number={pointing.number}
        total={pv.view.total}
        next={
          pointing.step.kind === "explain"
            ? { label: "Next", onClick: () => actions.complete(pointing.step) }
            : undefined
        }
        onSkip={pointing.step.kind === "interrupt" ? undefined : () => actions.skip(pointing.step)}
        onHide={() => setHiddenFor(pointing.step.id)}
        watch={watch}
        onPlaced={onPlaced}
      />
    ) : null;

  return (
    <>
      {/* §10: step changes are announced politely, without moving focus. */}
      <p className="ux-sr-only" aria-live="polite">
        {open ? machineWords(pv.announcement) : ""}
      </p>
      {open ? (
        <GuidePanel
          pv={pv}
          targetShown={target != null}
          headingRef={panelHeading}
          actions={actions}
          nowhere={nowhere}
          asideLeft={aside}
          lift={lift}
          cap={cap}
        />
      ) : null}
      {/* 1.174.0 (D3b): paused, or closed after a launch, the tour leaves no
          pill — only the sidebar row (`TutorialStatusRow`). */}
      {coach}
    </>
  );
}

/** §11: how long Take me there waits for its control before it counts as
 *  missing. */
const MISSING_AFTER_MS = 1_500;

/** A clock that moves once a minute while `on`. */
function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/**
 * TU-5 Mac walk: how tall the docked panel may be (`panelCap`) so it ends
 * below the fields it keeps clear of, followed as the page changes (at most
 * once per `LOOK_MS`) and on resize. Null: no cap.
 */
function usePanelCap(on: boolean, aside: number | null): number | null {
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    if (!on) {
      setCap(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A field resized by hand (the brief's grip) moves its bottom edge
    // without a mutation the observer below sees.
    const sized = new Set<Element>();
    const sizes = typeof ResizeObserver === "function" ? new ResizeObserver(() => soon()) : null;
    const look = () => {
      timer = null;
      const fields = keepClearElements();
      if (sizes) {
        for (const el of sized) {
          if (fields.includes(el)) continue;
          sizes.unobserve(el);
          sized.delete(el);
        }
        for (const el of fields) {
          if (sized.has(el)) continue;
          sizes.observe(el);
          sized.add(el);
        }
      }
      const panel = document.querySelector<HTMLElement>("[data-ply-tour-panel]");
      if (!panel) return;
      const view = document.documentElement;
      // Where the panel is now (docked right, or aside): its box, not a
      // guess from the margins (the lifted dock's bottom is higher).
      const box = panel.getBoundingClientRect();
      const margin = view.clientHeight - box.bottom;
      const next = panelCap({ left: box.left, width: box.width }, fieldBoxes(fields), { height: view.clientHeight }, margin);
      setCap((cur) => (cur === next ? cur : next));
    };
    const soon = () => {
      if (timer == null) timer = setTimeout(look, LOOK_MS);
    };
    // A scroll that moves such a field (the card page): one look, as for a
    // mutation; a terminal or a list scrolling elsewhere costs nothing.
    const onScroll = (e: Event) => {
      if (timer != null) return;
      const t = e.target;
      if (t instanceof Element && t.querySelector(KEEP_CLEAR_FIELDS) == null) return;
      soon();
    };
    look();
    const observer = new MutationObserver((records) => {
      if (records.every(quietRecord)) return;
      soon();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "inert"] });
    window.addEventListener("resize", soon);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      sizes?.disconnect();
      window.removeEventListener("resize", soon);
      document.removeEventListener("scroll", onScroll, { capture: true });
      if (timer != null) clearTimeout(timer);
    };
  }, [on, aside]);
  return cap;
}

/** Whether a modal (a sheet, Settings, Search) is on screen, followed as the
 *  page changes (at most once per `LOOK_MS`). */
export function useModalShown(on: boolean): boolean {
  return useShownOnPage(on, modalShown);
}

/** Whether a menu or a popover of the page is open (`popupShown`). */
export function usePopupShown(on: boolean): boolean {
  return useShownOnPage(on, popupShown);
}

function useShownOnPage(on: boolean, shown: () => boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!on) {
      setUp(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      timer = null;
      setUp(shown());
    };
    look();
    const observer = new MutationObserver((records) => {
      if (records.every(quietRecord) || timer != null) return;
      timer = setTimeout(look, LOOK_MS);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "inert", "aria-hidden", "aria-modal"],
    });
    return () => {
      observer.disconnect();
      if (timer != null) clearTimeout(timer);
    };
  }, [on, shown]);
  return up;
}

/** Show me (§3.1): the control scrolled into view and focused — a control
 *  itself, or a section's heading (`revealElement`). Nothing is pressed. */
function focusControl(el: HTMLElement): void {
  if (el.matches("button, input, textarea, select, a[href], [tabindex]")) {
    revealElement(el, { focus: false });
    el.focus({ preventScroll: true });
  } else {
    revealElement(el);
  }
}

/** The tour's own surfaces: focus inside them is the layer's to keep. */
const LAYER = "[data-ply-tour-panel], [data-ply-tour-coach]";

/**
 * Mutations that never change whether, or where, an anchor is on screen: a
 * terminal writing output, the editor typing, the tour's own surfaces, a
 * toast. A live xterm changes its DOM all the time; looking again for each
 * of those would cost a style pass many times a second for nothing.
 */
const QUIET = ".xterm, .cm-editor, [data-ply-tour-panel], [data-ply-tour-coach], .toast-stack";

function quietRecord(r: MutationRecord): boolean {
  const node = r.target instanceof Element ? r.target : r.target.parentElement;
  return node != null && node.closest(QUIET) != null;
}

/** At most one look this often, while the page keeps changing. */
const LOOK_MS = 100;

/**
 * The anchor's one element on screen (`findTourAnchor`), followed as the
 * page changes: a mode switch, a section opening, a host hidden, the window
 * resized. Only while there is an anchor to follow (the panel open, the step
 * waiting on a control); looked up at most once per `LOOK_MS`, and not at
 * all for changes inside a terminal, the editor or the tour itself. null when
 * it is not on screen.
 *
 * `watch`: the coach-mark measures its place again after each look, so it
 * follows a control that moved without resizing (a box above it grew).
 */
export function useTourTarget(anchor: TourAnchor | null): {
  el: HTMLElement | null;
  watch: (fn: () => void) => () => void;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const listeners = useRef(new Set<() => void>());
  const watch = useCallback((fn: () => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  useEffect(() => {
    if (!anchor) {
      setEl(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      timer = null;
      setEl(findTourAnchor(anchor));
      for (const fn of listeners.current) fn();
    };
    const soon = () => {
      if (timer == null) timer = setTimeout(look, LOOK_MS);
    };
    look();
    const observer = new MutationObserver((records) => {
      if (records.every(quietRecord)) return;
      soon();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "inert", "aria-hidden", "aria-modal", "open", "data-ply-tour"],
    });
    window.addEventListener("resize", soon);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", soon);
      if (timer != null) clearTimeout(timer);
    };
  }, [anchor]);
  return { el, watch };
}
