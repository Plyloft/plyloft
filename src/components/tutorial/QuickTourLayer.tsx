import { useEffect, useId, useRef, useState } from "react";
import { CBtn } from "../ui/primitives";
import { useEscapeFirst } from "../ux/useEscapeFirst";
import { machineWords } from "../../lib/platform";
import {
  QUICK_CLOSE_LABEL,
  QUICK_DONE_LABEL,
  TIP_GOT_IT_LABEL,
  sectionTip,
  type QuickMark,
} from "../../lib/tutorial/quickTour";
import { findTourAnchor, PAGE_POPUPS, tourAnchorShown } from "../../lib/tutorial/tourAnchors";
import { dismissTip, endQuickTour, markTipSeen, nextQuickMark, useQuickTour } from "../../store/quickTourStore";
import { effectiveCenterMode, useUi } from "../../store/uiStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { tourRunning } from "../../lib/tutorial/tutorialEngine";
import { useSettings } from "../../store/settingsStore";
import { CoachMark } from "./CoachMark";
import { useModalShown, usePopupShown, useTourTarget } from "./TutorialLayer";

/**
 * Getting started TU-6 (TUTORIAL_SPEC §6.4, §6.5, §10): the Quick tour's
 * marks and the first-visit tip, beside the shell like the full tour's layer
 * (it mounts and unmounts only its own nodes). Hidden while Setup or Sign in
 * covers the shell (`covered`), and the tip while a sheet is up.
 *
 * - A Quick tour mark is the coach-mark with Next (Done on the last) and
 *   Close; Esc closes it too. Next takes the keyboard on each mark, since
 *   Next is the one thing to do. A control not on screen (a Ship in a batch
 *   row with nothing to ship, a mode with no project) shows the same words
 *   docked where the Guide panel sits.
 * - A tip is one coach-mark with Got it, on the section just opened. It
 *   never takes the keyboard (the member just went there); it is recorded
 *   as seen once it is on screen, so it shows once.
 */
export function QuickTourLayer({ covered }: { covered: boolean }) {
  const quick = useQuickTour((s) => s.quick);
  const tip = useQuickTour((s) => s.tip);
  // §3.1 (Challenger): while a modal is up — Search, Settings, a sheet —
  // the marks stand aside like the panel, and never take its keyboard.
  const modalUp = useModalShown((quick != null || tip != null) && !covered);
  const mark = quick && !covered && !modalUp ? quick.marks[quick.index] : null;
  // §6.5: never beside a full tour (one guide at a time).
  const fullTour = useSettings((s) => tourRunning(s.settings.onboarding?.tutorial));
  const tipShown = tip != null && !covered && !quick && !modalUp && !fullTour ? sectionTip(tip) : null;
  const { el: markTarget, watch: watchMark } = useTourTarget(mark?.anchor ?? null);
  const { el: tipTarget, watch: watchTip } = useTourTarget(tipShown?.anchor ?? null);
  // 1.171.0 (E2 walk fix, 2026-10-27 step 5): while a menu or a popover of
  // the page is open (the card's ⋯, Start build ▾, Ship ▾, Finish and
  // check ▾, a picker) the mark, its ring and the tip step aside, and come
  // back when it closes — as the full tour's coach-mark does. A mark whose
  // control is inside the open menu still points at it.
  const popupOpen = usePopupShown((mark != null || tipShown != null) && !covered);
  const shownTarget = mark ? markTarget : tipTarget;
  const popupUp = popupOpen && shownTarget?.closest(PAGE_POPUPS) == null;
  // Code's status bar runs along the bottom: the docked words sit above it.
  const activeId = useWorkspaces((s) => s.activeId);
  const lift = useUi((s) => activeId != null && effectiveCenterMode(s.centerMode, activeId) === "code");

  // A mark's control is drawn a frame or two after its mode opens: the
  // docked fallback waits a moment before standing in for it — again after
  // a modal closes.
  const markKey = quick ? `${quick.marks[quick.index]?.id}:${quick.shown}` : null;
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!markKey || modalUp) {
      setSettled(null);
      return;
    }
    const t = window.setTimeout(() => setSettled(markKey), FALLBACK_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [markKey, modalUp]);

  // Seen once on screen, never before: a tip whose control never showed
  // has not been shown. A tip never takes the keyboard, so it is said
  // politely (§10), a frame after it shows, in a region always mounted.
  const tipOnScreen = tipShown != null && tipTarget != null ? tipShown.section : null;
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!tipOnScreen) {
      setSaid("");
      return;
    }
    void markTipSeen(tipOnScreen).catch(() => {});
    const { title, body } = sectionTip(tipOnScreen);
    const frame = requestAnimationFrame(() => setSaid(machineWords(`${title}. ${body}`)));
    return () => cancelAnimationFrame(frame);
  }, [tipOnScreen]);

  let surface = null;
  if (popupUp) {
    surface = null;
  } else if (quick && mark) {
    const last = quick.index + 1 >= quick.marks.length;
    const next = { label: last ? QUICK_DONE_LABEL : "Next", onClick: last ? closeQuickTour : nextQuickMark };
    // No live region: each mark is a new dialog and Next takes the focus
    // in it, which says its name (Challenger: said twice otherwise).
    surface = markTarget ? (
      <CoachMark
        key={markKey}
        target={markTarget}
        anchor={mark.anchor}
        copy={{ title: mark.title, body: mark.body }}
        number={quick.index + 1}
        total={quick.marks.length}
        next={next}
        onSkip={last ? undefined : closeQuickTour}
        skipLabel={QUICK_CLOSE_LABEL}
        focusNext
        // Esc: the page stays as it is, the keyboard on this control.
        onHide={() => endQuickTour({ restore: false })}
        watch={watchMark}
      />
    ) : settled === markKey ? (
      <DockedMark
        key={markKey}
        mark={mark}
        number={quick.index + 1}
        total={quick.marks.length}
        next={next}
        onClose={last ? undefined : closeQuickTour}
        lift={lift}
      />
    ) : null;
  } else if (tipShown && tipTarget) {
    surface = (
      <CoachMark
        key={tipShown.section}
        target={tipTarget}
        anchor={tipShown.anchor}
        copy={{ title: tipShown.title, body: tipShown.body }}
        number={null}
        total={0}
        next={{
          label: TIP_GOT_IT_LABEL,
          // The button goes with the tip: the keyboard goes to the control
          // it pointed at, never dropped on the page.
          onClick: () => {
            if (tipTarget.isConnected) tipTarget.focus({ preventScroll: true });
            dismissTip();
          },
        }}
        onHide={dismissTip}
        watch={watchTip}
      />
    );
  }
  return (
    <>
      <p className="ux-sr-only" aria-live="polite">
        {said}
      </p>
      {surface}
    </>
  );
}

/** Done or Close: the tour ends, the page put back. */
function closeQuickTour(): void {
  // The keyboard first, then the page: the shell gives a host's remembered
  // focus back when it is shown and nothing else has the keyboard
  // (`lib/hiddenFocus`) — back on Code the editor would take it (Mac walk).
  focusAfter();
  endQuickTour();
  settleFocusAfter();
}

/** Esc on a docked mark: as on a pointed one, the page stays as it is. */
function escapeQuickTour(): void {
  focusAfter();
  endQuickTour({ restore: false });
  settleFocusAfter();
}

/** The keyboard after the tour, never dropped on the page: Help, where it
 *  is started again (as End the tour does, §9); with the sidebar folded
 *  away, the button that shows it (Challenger round 2). */
function focusAfter(): void {
  const toggle = document.querySelector<HTMLElement>(".shell-sidebar-toggle");
  const to = findTourAnchor("help") ?? (toggle && tourAnchorShown(toggle) ? toggle : null);
  to?.focus({ preventScroll: true });
}

/** Once the page has settled: dropped on the page after all, try again. */
function settleFocusAfter(): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body) focusAfter();
  });
}

/** How long a mark's control may take to show before the docked words
 *  stand in for it. */
const FALLBACK_AFTER_MS = 400;

/**
 * A Quick tour mark whose control is not on screen: the same words, docked
 * at the bottom right of the centre (where the Guide panel sits), with Next
 * and Close. Not modal; Esc closes the tour.
 */
function DockedMark({
  mark,
  number,
  total,
  next,
  onClose,
  lift = false,
}: {
  mark: QuickMark;
  number: number;
  total: number;
  next: { label: string; onClick: () => void };
  onClose?: () => void;
  lift?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEscapeFirst(true, ref, escapeQuickTour);
  useEffect(() => nextRef.current?.focus({ preventScroll: true }), []);
  return (
    <section
      ref={ref}
      className={lift ? "ux-tour ux-tour--quick ux-tour--lift" : "ux-tour ux-tour--quick"}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      data-ply-tour-coach={mark.anchor}
    >
      <p className="ux-tour-coach-step">{`Step ${number} of ${total}`}</p>
      <p className="ux-tour-coach-title" id={`${id}-title`}>
        {machineWords(mark.title)}
      </p>
      <p className="ux-tour-coach-text" id={`${id}-body`}>
        {machineWords(mark.body)}
      </p>
      <div className="ux-tour-coach-foot">
        <span className="ux-tour-spacer" />
        {onClose && (
          <CBtn tone="quiet" onClick={onClose}>
            {QUICK_CLOSE_LABEL}
          </CBtn>
        )}
        <CBtn ref={nextRef} tone="accent" onClick={next.onClick}>
          {next.label}
        </CBtn>
      </div>
    </section>
  );
}
