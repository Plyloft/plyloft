import { forwardRef, useEffect, useState, type MouseEvent, type ReactNode } from "react";

import {
  nowAnnouncement,
  type CardPrimaryActionId,
  type CardState,
  type CardStateTone,
} from "../lib/cardLifecycle";
import { CBtn, Callout, Details, MenuButton, PlanMark, SplitButton, type MenuItem, type RunState } from "./ux";
import { MORE_SHOW_LABEL, moreLine } from "../lib/cardErrorNow";
import { PLAN_FIRST_MENU_LABEL } from "../lib/briefSetup";
import { machineWords } from "../lib/platform";
import { TRY_IT_TOUR } from "../lib/tryPanel";
import type { TourAnchor } from "../lib/tutorial/manifest";
import type { DeliveryPath } from "../lib/deliveryStage";
import { DeliveryPathLine } from "./DeliveryPathLine";
import { waitTitle } from "../lib/deliveryWords";
import type { WaitLine } from "../lib/waitLine";

type Props = {
  state: CardState;
  /** P-A (UX P1 point 2): the rule of `presentCard` the words came from,
   *  as `data-ply-rule` — the same on the Board card, the List row and the
   *  Inbox row of this card. */
  rule?: string;
  label: string;
  /** CL-7: who is working, shown in place of the label ("Claude · building
   *  · 4m"). The live region keeps announcing the label, so a ticking clock
   *  is never re-read. */
  title?: string;
  /** 1.171.0 C2 (CF3, CF16): after Finish and check, what is happening
   *  and for how long, in place of the label — it ticks every second, so
   *  the live region keeps announcing only the label (the state word). */
  wait?: WaitLine | null;
  actionId: CardPrimaryActionId;
  actionLabel: string;
  /** v1.154.1 round 3 (K3): the primary's stable name for the screen
   *  reader ("Start build"), when its label is a transient one
   *  ("Starting…") while it is off. Defaults to `actionLabel`. */
  actionName?: string;
  /** GH #253: what the primary does — its tooltip, not the helper. */
  actionTitle?: string;
  helper: ReactNode;
  tone: CardStateTone;
  /** The dot beside the words (the Board's `boardRunState`). */
  runState: RunState;
  live?: boolean;
  disabled?: boolean;
  /** C7: why the primary is disabled, said beside the helper — never only in
   *  a tooltip (PATTERNS §3). */
  disabledReason?: string | null;
  onAction: (event: MouseEvent<HTMLButtonElement>) => void;
  /** At most one quiet alternative ("Not right", "Agree with Claude, keep it
   *  as it is", "Conclude intake"). Never the primary: Cmd-Enter and the
   *  action trace stay on `onAction`. */
  secondary?: SecondaryAction;
  /** Try it TI-4 (D18): the card's Try it, beside the alternative once the
   *  card's copy has changes. The tour's anchor (`card-try-it`). */
  tryIt?: SecondaryAction;
  /** QoL 1.168 (C3, V-3): "See the changes" beside Ship it — the review of
   *  what would ship, where the decision is made. Quiet, first. */
  seeChanges?: SecondaryAction;
  /** 1.172.0 (C2; CP-3): Ready to ship's one quiet press beside Ship it ▾,
   *  "Read the review" — it opens the Review, where See the changes, Try it
   *  and Not right are. Never with `seeChanges` or `tryIt`. */
  checkFirst?: SecondaryAction;
  /** 1.172.0 (C2; CP-19): a line under the actions, beside Ship it — the
   *  overlap with other cards. */
  chip?: ReactNode;
  /** UX-6.6: the primary's other ways ("Ship as a PR"). When present the
   *  primary is a split button. */
  variants?: MenuItem[];
  /** 1.172.0 (C1; CP-11, CF B4): before the build, every way to plan the
   *  card in one quiet menu beside Start build — "Plan it first ▾". Never
   *  with a `secondary`: Now offers one primary and one menu. */
  planFirst?: { items: MenuItem[]; tour?: TourAnchor };
  /** A quiet line under the actions: why a way isn't offered (1.169.1 walk:
   *  no pull request where the project can't open one). 1.175.0 F8: or the
   *  note that draws its own line and presses (`CardNowNote`). */
  note?: string | ReactNode;
  /** 1.171.0 (B1): where the change is, under the title — a card that
   *  shipped or is shipping (`deliveryPath`). */
  path?: DeliveryPath | null;
  /** The path's Sign in to GitHub, when a read was refused for it. */
  onSignIn?: () => void;
  /** 1.175.0 F8 (UX-12, I10): the error that leads Now (`cardErrorNow`):
   *  its title and one line in place of the state's, its one action as the
   *  filled press (else the state's), Dismiss beside it, and its Details. */
  error?: NowErrorView | null;
  /** F8: the other troubles, waiting in the card's Details — "2 more
   *  things on this card need a look." · Show. */
  more?: { count: number; onShow: () => void } | null;
  /** F8: Details under Now's line when no error leads — a ship stopped on a
   *  conflict names its files there (`ShipConflictDetails`). */
  details?: ReactNode;
};

export type NowErrorView = {
  /** Without its full stop (`nowErrorTitle`). */
  title: string;
  /** The error's whole title, as its group's name (the error block's). */
  name: string;
  /** What happened and what was left untouched (`nowErrorLine`). */
  line: string;
  /** Its one way on; null keeps the state's primary. */
  primary: { id: string; label: string; title?: string } | null;
  onAction: (id: string) => void;
  /** The tool's output and the error's other way, under Details. */
  details?: ReactNode;
  /** The press under way: its button reads busy. */
  busy?: boolean;
};

export type SecondaryAction = {
  label: string;
  title?: string;
  disabled?: boolean;
  onAction: () => void;
  /** A small mark after the label (the plan mark, such as "Team"). */
  badge?: string;
  /** Its tour anchor (TUTORIAL_SPEC §4.3), when the tour points at it. */
  tour?: TourAnchor;
};

/**
 * C6 (UX-6.2, the Card board): the card page's `Now` callout — what is true
 * now (the state's label), one line about it, the one primary action and at
 * most one quiet alternative. Presentation only; every command stays with
 * `CardDetailEditor` and routes through the existing store choke points. The
 * label, action and helper come from `CARD_STATE_PRESENTATION`.
 */
export const CardStateHeader = forwardRef<HTMLParagraphElement, Props>(
  function CardStateHeader(
    {
      state,
      rule,
      label,
      title,
      wait,
      actionId,
      actionLabel,
      actionName,
      actionTitle,
      helper,
      tone,
      runState,
      live,
      disabled = false,
      disabledReason,
      onAction,
      secondary,
      tryIt,
      seeChanges,
      checkFirst,
      chip,
      note,
      variants,
      planFirst,
      path,
      onSignIn,
      error,
      more,
      details,
    },
    ref,
  ) {
    const moreWords = more ? moreLine(more.count) : null;
    /** F8: the error's own way on, when it has one: Now's one primary. */
    const lead = error?.primary ?? null;
    const primaryData = {
      "data-ply-primary-action-id": actionId,
      "data-ply-primary-action-tone": tone,
      // The tour's anchor on the one primary action (TUTORIAL_SPEC §4.3).
      "data-ply-tour": "card-primary" satisfies TourAnchor,
      // The machine as this platform names it (`this PC`): a tooltip and a
      // fragment are drawn raw, past the primitives that rename it.
      title: actionTitle && machineWords(actionTitle),
    };
    const primaryTone = tone === "accent" ? "accent" : "ghost";
    return (
      <section
        className="ux-card-now"
        aria-label="Now"
        data-ply-state-headline={state}
        data-ply-rule={rule}
        data-ply-card-background-focus=""
        tabIndex={-1}
        onPointerDown={(event) => {
          if (
            !(event.target as HTMLElement).closest(
              "button, input, textarea, select, a, [contenteditable]",
            )
          ) {
            event.currentTarget.focus({ preventScroll: true });
          }
        }}
      >
        <NowErrorGroup name={error ? machineWords(error.name) : null}>
        <Callout
          kind="now"
          state={runState}
          live={live}
          titleRef={ref}
          title={error ? error.title : wait ? <WaitTitle what={wait.what} since={wait.since} /> : (title ?? label)}
          path={path && !error ? <DeliveryPathLine path={path} onSignIn={onSignIn} /> : undefined}
          text={
            error ? (
              error.line
            ) : (
              <>
                {typeof helper === "string" ? machineWords(helper) : helper}
                {disabled && disabledReason ? ` ${machineWords(disabledReason)}` : null}
              </>
            )
          }
          actions={
            <>
              {error && (
                <CBtn tone="quiet" data-ply-now-error-dismiss="" onClick={() => error.onAction("dismiss")}>
                  Dismiss
                </CBtn>
              )}
              {!error && (
            <>
              {checkFirst && (
                <CBtn
                  tone="quiet"
                  data-ply-check-first=""
                  title={checkFirst.title}
                  disabled={checkFirst.disabled}
                  onClick={checkFirst.onAction}
                >
                  {checkFirst.label}
                </CBtn>
              )}
              {seeChanges && (
                <CBtn
                  tone="quiet"
                  data-ply-see-changes=""
                  title={seeChanges.title}
                  disabled={seeChanges.disabled}
                  onClick={seeChanges.onAction}
                >
                  {seeChanges.label}
                </CBtn>
              )}
              {tryIt && (
                <CBtn
                  tone="quiet"
                  data-ply-tour={TRY_IT_TOUR}
                  data-ply-try-it="now"
                  title={tryIt.title}
                  disabled={tryIt.disabled}
                  onClick={tryIt.onAction}
                >
                  {tryIt.label}
                </CBtn>
              )}
              {secondary && (
                <CBtn
                  tone="quiet"
                  data-ply-secondary-action=""
                  data-ply-tour={secondary.tour}
                  title={secondary.title}
                  disabled={secondary.disabled}
                  onClick={secondary.onAction}
                >
                  {secondary.label}
                  {secondary.badge && <PlanMark text={secondary.badge} />}
                </CBtn>
              )}
              {planFirst && !secondary && planFirst.items.length > 0 && (
                <span data-ply-plan-first="">
                  <MenuButton
                    label={PLAN_FIRST_MENU_LABEL}
                    menuLabel={PLAN_FIRST_MENU_LABEL}
                    items={planFirst.items}
                    tone="quiet"
                    tour={planFirst.tour}
                  />
                </span>
              )}
            </>
              )}
              {/* The one primary: with its variants a split button, without
                  them the button alone (1.174.0 A7, VC-2). F8: an error's own
                  way on takes its place while the error leads Now. */}
              <SplitButton
                label={lead ? lead.label : actionLabel}
                onClick={lead ? () => error!.onAction(lead.id) : onAction}
                items={lead ? [] : (variants ?? [])}
                menuLabel={`Other ways: ${lead ? lead.label : actionLabel}`}
                disabled={lead ? error!.busy : disabled}
                tone={lead ? "accent" : primaryTone}
                mainProps={
                  lead
                    ? { ...primaryData, title: lead.title && machineWords(lead.title), "data-ply-primary-action-id": lead.id, "data-ply-primary-action-tone": "accent" }
                    : primaryData
                }
              />
            </>
          }
        />
        {(error ? error.details : details) && (
          <div className="ux-error-details" data-ply-now-details="">
            <Details>{error ? error.details : details}</Details>
          </div>
        )}
        </NowErrorGroup>
        {moreWords && (
          <div className="ux-card-session-note" data-ply-now-more="">
            <span className="ux-card-muted-inline">{moreWords}</span>
            <CBtn tone="quiet" onClick={more!.onShow}>
              {MORE_SHOW_LABEL}
            </CBtn>
          </div>
        )}
        {!error && chip}
        {note && !error && (typeof note === "string" ? (
          <p className="ux-card-muted" data-ply-no-remote="now">
            {machineWords(note)}
          </p>
        ) : (
          note
        ))}
        <span className="ux-sr-only" aria-live="polite" aria-atomic="true">
          {/* 1.171.0 (B1): "Shipped · only on this Mac" is "this PC" on Windows. */}
          {/* U1: on a card a teammate holds the press is no primary, so it isn't
              announced as one. */}
          {error ? (
            machineWords(nowAnnouncement(error.title, error.primary?.label ?? actionLabel, false))
          ) : rule === "claimed" && !disabled ? (
            machineWords(`${label}. ${actionLabel} asks before you claim it too.`)
          ) : (
            <>{machineWords(nowAnnouncement(label, disabled ? (actionName ?? actionLabel) : actionLabel, disabled))}</>
          )}
        </span>
      </section>
    );
  },
);

/** F8: while an error leads Now, its callout and Details are one group
 *  named by the error's title (as its block was); otherwise nothing wraps
 *  them. */
function NowErrorGroup({ name, children }: { name: string | null; children: ReactNode }) {
  if (name === null) return <>{children}</>;
  return (
    <div className="ux-card-now-error" role="group" aria-label={name} data-ply-now-error="">
      {children}
    </div>
  );
}

/** 1.171.0 C2: the wait's line with its time, ticking each second. Not a
 *  live region: the Now callout announces the state word once. */
function WaitTitle({ what, since }: { what: string; since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  return <span data-ply-wait-line="">{waitTitle(what, since == null ? null : Math.max(0, now - since))}</span>;
}
