import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CBtn } from "../ui/primitives";
import { useEscapeFirst } from "../ux/useEscapeFirst";
import { machineWords } from "../../lib/platform";
import type { StepCopy, TourAnchor } from "../../lib/tutorial/manifest";
import { nearbyControls, nowBoxes } from "../../lib/tutorial/tourAnchors";
import {
  RING_OUTSET,
  controlName,
  offView,
  placeCoach,
  type CoachPlace,
  type CoachSide,
} from "../../lib/tutorial/tourPanel";

const SIDE_CLASS: Record<CoachSide, string> = {
  right: "ux-tour-coach ux-tour-coach--right",
  left: "ux-tour-coach ux-tour-coach--left",
  below: "ux-tour-coach ux-tour-coach--below",
  above: "ux-tour-coach ux-tour-coach--above",
};

/** What answers Esc itself when it has the focus inside a pointed-at section. */
const OWN_ESCAPE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], .xterm, .cm-editor';

type Place = { ring: DOMRect; at: CoachPlace; top: boolean };

function samePlace(cur: Place, ring: DOMRect, at: CoachPlace, top: boolean): boolean {
  const a = cur.ring;
  return (
    cur.top === top &&
    a.left === ring.left &&
    a.top === ring.top &&
    a.width === ring.width &&
    a.height === ring.height &&
    cur.at.left === at.left &&
    cur.at.top === at.top &&
    cur.at.side === at.side &&
    cur.at.arrow === at.arrow
  );
}

/** The boxes of the control's ancestors that scroll (and so clip it). */
function clippingBoxes(target: HTMLElement): DOMRect[] {
  const view = target.ownerDocument.defaultView ?? window;
  const out: DOMRect[] = [];
  for (let el = target.parentElement; el && el !== target.ownerDocument.body; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)) out.push(el.getBoundingClientRect());
  }
  return out;
}

/**
 * Getting started TU-4 (TUTORIAL_SPEC §3.2, §10): the coach-mark — a
 * popover's surface beside the real control, a 2 px accent ring around it,
 * no scrim. Never modal: `role="dialog"` with `aria-modal="false"`, and focus
 * is never moved into it on appear. The control is named in its first line
 * and points at it with `aria-describedby`, so a screen reader landing on
 * the control hears the instruction. Esc (focus in it or on the control)
 * hides it; the panel's Show me brings it back.
 *
 * The primary action is always the real control: only an explain step has a
 * Next here.
 */
export function CoachMark({
  target,
  anchor,
  copy,
  number,
  total,
  next,
  onSkip,
  skipLabel = "Skip this step",
  focusNext = false,
  onHide,
  watch,
  onPlaced,
}: {
  target: HTMLElement;
  anchor: TourAnchor;
  copy: StepCopy;
  /** "Step 3 of 10"; null for a step not counted (B5b). */
  number: number | null;
  total: number;
  /** An explain step's Next. */
  next?: { label: string; onClick: () => void };
  onSkip?: () => void;
  /** TU-6: the Quick tour's Close in place of Skip this step. */
  skipLabel?: string;
  /** TU-6 (§6.4): an explain-only mark whose one action is Next takes the
   *  keyboard on Next when it shows — the Quick tour, pressed through with
   *  Next alone. The full tour never does (§10: the member acts on the
   *  real control). */
  focusNext?: boolean;
  onHide: () => void;
  /** Called after each look of the layer's anchor lookup: measure again. */
  watch?: (fn: () => void) => () => void;
  /** The control's box, each time it is placed (the panel moves off it). */
  onPlaced?: (ring: DOMRect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const [why, setWhy] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const hide = useRef(onHide);
  hide.current = onHide;
  const placed = useRef(onPlaced);
  placed.current = onPlaced;

  // Esc inside the coach-mark hides it, and the keyboard goes back to the
  // control it pointed at (never dropped on the page with it).
  useEscapeFirst(true, ref, () => {
    if (target.isConnected) target.focus({ preventScroll: true });
    hide.current();
  });

  // Esc on the control hides it too — but only on the control itself, or a
  // plain button inside a section the step points at. A field, an open
  // menu, a terminal or the editor inside it keeps its own Esc: the Claude
  // session's Esc, a menu closing, a comment cancelled. Before the page's own
  // Esc (window, capture), like `useEscapeFirst`; below open menus, whose
  // focus is never on the control.
  useEffect(() => {
    const view = target.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = target.ownerDocument.activeElement;
      if (!active || !target.contains(active)) return;
      if (active !== target && active.closest(OWN_ESCAPE)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hide.current();
    };
    view.addEventListener("keydown", onKey, true);
    return () => view.removeEventListener("keydown", onKey, true);
  }, [target]);

  // 1.172 A3 (Windows walk C–F): a step whose control is scrolled out of
  // view brings it in first, once per step — the coach-mark then follows
  // the scroll below. Before paint, so the step never shows pointing off
  // screen.
  useLayoutEffect(() => {
    if (!target.isConnected) return;
    const doc = target.ownerDocument;
    const view = doc.defaultView ?? window;
    const clips = [
      { left: 0, top: 0, width: doc.documentElement.clientWidth || view.innerWidth, height: doc.documentElement.clientHeight || view.innerHeight },
      ...clippingBoxes(target),
    ];
    if (offView(target.getBoundingClientRect(), clips)) {
      target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }, [target]);

  // Placed beside the control, again on resize, a scroll that moves it,
  // either box changing size and each look of the layer (a box above the
  // control grew); before paint, so it never shows in the wrong place. A
  // place that did not change is not set again, so a streaming terminal
  // scrolling elsewhere costs no render.
  useLayoutEffect(() => {
    const doc = target.ownerDocument;
    const view = doc.defaultView ?? window;
    const measure = () => {
      if (!target.isConnected) return;
      const ring = target.getBoundingClientRect();
      const own = ref.current?.getBoundingClientRect();
      const size = { width: own?.width || 300, height: own?.height || 160 };
      // The controls around it, and the Guide panel: a side that covers
      // none of them is taken first (TU-4 Mac walk).
      const avoid = nearbyControls(target, Math.max(size.width, size.height) + 24);
      // 1.171.0 (E2): and the card's Now box, whose words it must never
      // hide (walk 2026-10-27 #4g: it sat on Ready to ship).
      avoid.push(...nowBoxes(doc));
      const panel = doc.querySelector("[data-ply-tour-panel]")?.getBoundingClientRect();
      if (panel && panel.width > 0) avoid.push({ left: panel.left, top: panel.top, width: panel.width, height: panel.height });
      const at = placeCoach(
        ring,
        size,
        {
          width: doc.documentElement.clientWidth || view.innerWidth,
          height: doc.documentElement.clientHeight || view.innerHeight,
        },
        { avoid },
      );
      // In a narrow window the sidebar floats over the stage (z 60): a row
      // in it is pointed at from above that layer, not from under its scrim.
      const top = target.closest(".shell-sidebar-slot--overlay") != null;
      setPlace((cur) => (cur && samePlace(cur, ring, at, top) ? cur : { ring, at, top }));
      placed.current?.(ring);
    };
    measure();
    let frame: number | null = null;
    const soon = () => {
      if (frame != null) return;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    // Only a scroll of something that holds the control moves it: a
    // terminal or a list scrolling elsewhere does not.
    const onScroll = (e: Event) => {
      const at = e.target;
      if (at instanceof Node && at !== doc && !at.contains(target)) return;
      soon();
    };
    view.addEventListener("resize", soon);
    doc.addEventListener("scroll", onScroll, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(soon) : null;
    observer?.observe(target);
    if (ref.current) observer?.observe(ref.current);
    const unwatch = watch?.(soon);
    return () => {
      view.removeEventListener("resize", soon);
      doc.removeEventListener("scroll", onScroll, true);
      observer?.disconnect();
      unwatch?.();
      if (frame != null) view.cancelAnimationFrame(frame);
    };
  }, [target, watch]);

  // The control names the instruction as its description while shown. Only
  // this id is taken out again, so a description the control gained
  // meanwhile is kept.
  useEffect(() => {
    const ids = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    if (!ids.includes(bodyId)) target.setAttribute("aria-describedby", [...ids, bodyId].join(" "));
    return () => {
      const rest = (target.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((t) => t && t !== bodyId);
      if (rest.length > 0) target.setAttribute("aria-describedby", rest.join(" "));
      else target.removeAttribute("aria-describedby");
    };
  }, [target, bodyId]);

  // Once placed (never while hidden for measuring), so the keyboard lands
  // on a button that is where it is drawn.
  const placedOnce = place != null;
  // A page the mark just opened may take the keyboard itself a frame later
  // (a card's page focuses its headline when it first opens — Mac re-walk):
  // unless the member pressed or clicked something since, Next takes it
  // back once, two frames on.
  useEffect(() => {
    if (!focusNext || !placedOnce) return;
    nextRef.current?.focus({ preventScroll: true });
    const view = ref.current?.ownerDocument.defaultView ?? window;
    let touched = false;
    const touch = () => {
      touched = true;
    };
    view.addEventListener("keydown", touch, true);
    view.addEventListener("pointerdown", touch, true);
    let frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(() => {
        const active = view.document.activeElement;
        // Never from a modal that opened meanwhile (Search, a sheet).
        const inModal = active?.closest('[role="dialog"][aria-modal="true"]') != null;
        if (!touched && !inModal && ref.current && !ref.current.contains(active)) {
          nextRef.current?.focus({ preventScroll: true });
        }
      });
    });
    return () => {
      view.cancelAnimationFrame(frame);
      view.removeEventListener("keydown", touch, true);
      view.removeEventListener("pointerdown", touch, true);
    };
  }, [focusNext, placedOnce]);

  const ring = place?.ring;
  const at = place?.at;
  const arrowStyle =
    at == null ? undefined : at.side === "right" || at.side === "left" ? { top: at.arrow } : { left: at.arrow };
  const name = controlName(anchor, target.textContent);
  return (
    <>
      {ring && (
        <div
          className={place?.top ? "ux-tour-ring ux-tour-ring--top" : "ux-tour-ring"}
          aria-hidden="true"
          style={{
            left: ring.left - RING_OUTSET,
            top: ring.top - RING_OUTSET,
            width: ring.width + RING_OUTSET * 2,
            height: ring.height + RING_OUTSET * 2,
          }}
        />
      )}
      <div
        ref={ref}
        className={place?.top ? `${SIDE_CLASS[at?.side ?? "right"]} ux-tour-coach--top` : SIDE_CLASS[at?.side ?? "right"]}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-ply-tour-coach={anchor}
        style={at ? { left: at.left, top: at.top } : { visibility: "hidden" }}
      >
        <span className="ux-tour-coach-arrow" aria-hidden="true" style={arrowStyle} />
        <p className="ux-tour-coach-step">
          {number != null ? `Step ${number} of ${total} · ${name}` : name}
        </p>
        <p className="ux-tour-coach-title" id={titleId}>
          {machineWords(copy.title)}
        </p>
        <div className="ux-tour-coach-body" id={bodyId}>
          <p className="ux-tour-coach-text">{machineWords(copy.body)}</p>
          {copy.examples && copy.examples.length > 0 && (
            <ul className="ux-tour-examples">
              {copy.examples.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          )}
          {copy.notes?.map((note) => (
            <p key={note} className="ux-tour-step-note">
              {machineWords(note)}
            </p>
          ))}
        </div>
        {why && copy.why && <p className="ux-tour-why">{machineWords(copy.why)}</p>}
        <div className="ux-tour-coach-foot">
          {copy.why && (
            <CBtn tone="quiet" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
              Why?
            </CBtn>
          )}
          <span className="ux-tour-spacer" />
          {onSkip && (
            <CBtn tone="quiet" onClick={onSkip}>
              {skipLabel}
            </CBtn>
          )}
          {next && (
            <CBtn ref={nextRef} tone="accent" onClick={next.onClick}>
              {next.label}
            </CBtn>
          )}
        </div>
      </div>
    </>
  );
}
