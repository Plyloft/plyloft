import { useEffect, useId, useRef, useState, type CSSProperties, type Ref } from "react";
import { CBtn } from "../ui/primitives";
import { Details } from "../ux/Page";
import { Icon } from "../ux/Icon";
import { MoreMenu } from "../ux/MoreMenu";
import { machineWords } from "../../lib/platform";
import {
  FINISH_SETUP_LABEL,
  MORE_CHAPTERS_HEADING,
  OPT,
  STEP,
  type ChapterId,
  type TutorialStep,
} from "../../lib/tutorial/manifest";
import type { PanelRow, PanelView } from "../../lib/tutorial/tourPanel";

/** What the panel can do; the layer wires each to the store. */
export interface GuideActions {
  pause: () => void;
  skip: (step: TutorialStep) => void;
  unskip: (step: TutorialStep) => void;
  complete: (step: TutorialStep) => void;
  /** Show me: the coach-mark again, focus on the control. */
  showMe: () => void;
  /** Take me there: the step's `navigate`. */
  takeMeThere: (step: TutorialStep) => void;
  /** Another workspace holds the step (§9): the tour's workspace. */
  goToTourWorkspace: () => void;
  skipChapter: () => void;
  startOver: () => void;
  end: () => void;
  /** §9, §11: Setup's step for what is missing (no AI, no project). */
  finishSetup: (step: "ai" | "project") => void;
  /** B3: this card is the tour's (Continue with, Use that card). */
  takeCard: (workspaceId: string, cardId: string) => void;
  /** B3: the safe example, the guided first card (§2). */
  safeExample: () => void;
  /** TU-7 (§3.1): show this chapter's steps. */
  chooseChapter: (chapter: ChapterId) => void;
  /** 1.175.0 F4: the permissions question's answer — "Use this" (true) or
   *  "Keep this". Absent: the question isn't offered. */
  answerPermissions?: (use: boolean) => void;
}

const ROW_CLASS: Record<PanelRow["status"], string> = {
  done: "ux-tour-step ux-tour-step--done",
  skipped: "ux-tour-step ux-tour-step--skipped",
  current: "ux-tour-step ux-tour-step--current",
  offered: "ux-tour-step",
  todo: "ux-tour-step",
};

const MARK_CLASS: Record<PanelRow["status"], string> = {
  done: "ux-tour-mark ux-tour-mark--done",
  skipped: "ux-tour-mark ux-tour-mark--skipped",
  current: "ux-tour-mark ux-tour-mark--current",
  offered: "ux-tour-mark",
  todo: "ux-tour-mark",
};

const WORD: Record<PanelRow["status"], string> = {
  done: "Done",
  skipped: "Skipped",
  current: "",
  offered: "",
  todo: "",
};

/**
 * Getting started TU-4 (TUTORIAL_SPEC §3.1, §9, §10): the persistent
 * checklist, docked at the bottom right of the centre. Not a dialog: a
 * labelled region with no focus trap, reached by Tab from the page's end and
 * by Help › Getting started. The page around it stays usable.
 */
export function GuidePanel({
  pv,
  /** The current step's control is on screen (Show me), or not (Take me there). */
  targetShown,
  headingRef,
  actions,
  nowhere = null,
  asideLeft = null,
  lift = false,
  cap = null,
}: {
  pv: PanelView;
  targetShown: boolean;
  /** 1.172.0 walk (E1): Take me there found nowhere to go for this step —
   *  its row says so in one line. */
  nowhere?: { stepId: string; text: string } | null;
  /** The layer moves focus here after an explicit open or Resume. */
  headingRef?: Ref<HTMLHeadingElement>;
  actions: GuideActions;
  /** The step's control is where the panel docks: docked at this left edge
   *  (the centre's bottom left) instead, so it never covers it (§3.1). */
  asideLeft?: number | null;
  /** Code's status bar is along the bottom: dock above it. */
  lift?: boolean;
  /** TU-5 Mac walk: the panel's greatest height, so it ends below a field
   *  it would cover (`panelCap`); null for none. */
  cap?: number | null;
}) {
  const chapterId = useId();
  // A short window keeps the panel compact, its list scrolling on its own
  // (ux.css): the current step is kept in view there as the tour moves.
  const body = useRef<HTMLDivElement>(null);
  const currentId = pv.rows.find((r) => r.status === "current")?.step.id ?? null;
  useEffect(() => {
    if (!currentId) return;
    const row = body.current?.querySelector<HTMLElement>(`[data-ply-tour-step="${currentId}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [currentId]);

  const cls = ["ux-tour", asideLeft != null && "ux-tour--aside", lift && "ux-tour--lift"].filter(Boolean).join(" ");
  const style: CSSProperties & Record<string, string | number> = {};
  if (asideLeft != null) style.left = asideLeft;
  if (cap != null) style["--ux-tour-cap"] = `${cap}px`;
  return (
    <section
      className={cls}
      style={asideLeft != null || cap != null ? style : undefined}
      role="region"
      aria-label="Getting started"
      data-ply-tour-panel=""
    >
      <div className="ux-tour-head">
        <h2 className="ux-tour-title" ref={headingRef} tabIndex={-1}>
          Getting started
        </h2>
        <span className="ux-tour-progress">{pv.progress}</span>
        <CBtn tone="quiet" onClick={actions.pause}>
          Pause
        </CBtn>
        <MoreMenu
          label="More for Getting started"
          items={[
            { label: "Skip chapter", onSelect: actions.skipChapter },
            { label: "Start over", onSelect: actions.startOver },
            { label: "End the tour", onSelect: actions.end },
          ]}
        />
      </div>
      <div className="ux-tour-body" ref={body}>
        <p className="ux-tour-chapter" id={chapterId}>
          {pv.chapter.title}
        </p>
        {pv.ask && (
          <div className="ux-tour-note ux-tour-note--ask">
            <p className="ux-tour-note-title">{machineWords(pv.ask.title)}</p>
            <p className="ux-tour-note-body">{machineWords(pv.ask.body)}</p>
          </div>
        )}
        {(pv.live || pv.whileBuilding) && (
          <div
            className={pv.live?.tone === "paused" ? "ux-tour-note ux-tour-note--paused" : "ux-tour-note ux-tour-note--live"}
            data-ply-tour-live={pv.live?.tone ?? "aside"}
          >
            {pv.live && (
              <p className="ux-tour-note-title">
                <span
                  className={pv.live.tone === "paused" ? "ux-tour-live-dot ux-tour-live-dot--paused" : "ux-tour-live-dot"}
                  aria-hidden="true"
                />
                {machineWords(pv.live.text)}
              </p>
            )}
            {pv.whileBuilding && (
              <p className={pv.live ? "ux-tour-note-body" : "ux-tour-note-title"}>
                {!pv.live && <span className="ux-tour-live-dot" aria-hidden="true" />}
                {machineWords(pv.whileBuilding)}
              </p>
            )}
          </div>
        )}
        <ol className="ux-tour-steps" aria-labelledby={chapterId}>
          {pv.rows.map((row) => (
            <StepRow
              key={row.step.id}
              row={row}
              pv={pv}
              targetShown={targetShown}
              actions={actions}
              nowhere={nowhere?.stepId === row.step.id ? nowhere.text : null}
            />
          ))}
        </ol>
        {pv.finished && (
          <div className="ux-tour-note">
            <p className="ux-tour-note-title">{machineWords(pv.finished.title)}</p>
            <p className="ux-tour-note-body">{machineWords(pv.finished.body)}</p>
          </div>
        )}
        {pv.permissions && actions.answerPermissions && (
          <PermissionsQuestion question={pv.permissions} answer={actions.answerPermissions} />
        )}
        {pv.permissionsAnswered && (
          <p className="ux-tour-note-body" data-ply-tour-permissions-answered="">
            {machineWords(pv.permissionsAnswered)}
          </p>
        )}
        {pv.checklist && <SecondCard checklist={pv.checklist} actions={actions} />}
        {pv.secondAi && (
          <div className="ux-tour-note" data-ply-tour-second-ai="">
            <p className="ux-tour-note-title">{machineWords(pv.secondAi.title)}</p>
            <p className="ux-tour-note-body">{machineWords(pv.secondAi.body)}</p>
            <div className="ux-tour-actions">
              <CBtn tone="strong" onClick={() => actions.finishSetup("ai")}>
                {pv.secondAi.title}
              </CBtn>
              {/* "Once": Not now skips G3, so the offer goes (Settings and
                  search lists it as Skipped, with Do it now). */}
              <CBtn tone="quiet" onClick={() => actions.skip(pv.secondAi!.step)}>
                Not now
              </CBtn>
            </div>
          </div>
        )}
        {pv.chapters.length > 0 && <ChapterList pv={pv} actions={actions} />}
      </div>
    </section>
  );
}

/**
 * TU-7 (§3.1): the other chapters, under *More, when you're ready* — each
 * with its length (*3 steps*), how far it has come (*1 of 3*) or *Done*.
 * Choosing one shows its steps in the panel; nothing else moves.
 */
function ChapterList({ pv, actions }: { pv: PanelView; actions: GuideActions }) {
  const headingId = useId();
  return (
    <div className="ux-tour-chapters" data-ply-tour-chapters="">
      <p className="ux-tour-chapter" id={headingId}>
        {MORE_CHAPTERS_HEADING}
      </p>
      <ul className="ux-tour-chapter-list" aria-labelledby={headingId}>
        {pv.chapters.map((c) => (
          <li key={c.id}>
            <CBtn
              tone="quiet"
              className={c.complete ? "ux-tour-chapter-row ux-tour-chapter-row--done" : "ux-tour-chapter-row"}
              data-ply-tour-chapter={c.id}
              onClick={() => actions.chooseChapter(c.id)}
            >
              <span className="ux-tour-step-label">{c.title}</span>
              <span className="ux-tour-step-word">{c.length}</span>
            </CBtn>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * B11 (D24): the second card on its own — no coach-marks, only this list,
 * ticking itself from the card's state, with a one-line hint on request.
 */
/** 1.175.0 F4 (`rounds-and-ship.html` §4): two rows, two bordered buttons
 *  of the same width — neither is the panel's filled one. */
function PermissionsQuestion({
  question,
  answer,
}: {
  question: NonNullable<PanelView["permissions"]>;
  answer: (use: boolean) => void;
}) {
  const titleId = useId();
  return (
    <div className="ux-tour-note" data-ply-tour-permissions="" role="group" aria-labelledby={titleId}>
      <p className="ux-tour-note-title" id={titleId}>
        {machineWords(question.title)}
      </p>
      <p className="ux-tour-note-body">{machineWords(question.lede)}</p>
      <ul className="ux-tour-choice-rows">
        {question.choices.map((c) => (
          <li key={c.button} className="ux-tour-choice">
            <div className="ux-tour-choice-text">
              <p className="ux-tour-choice-name">
                {machineWords(c.name)}
                {c.mark && <span className="ux-tour-choice-mark"> · {machineWords(c.mark)}</span>}
              </p>
              <p className="ux-tour-note-body">{machineWords(c.text)}</p>
            </div>
            <CBtn className="ux-tour-choice-button" onClick={() => answer(c.use)}>
              {c.button}
            </CBtn>
          </li>
        ))}
      </ul>
      <p className="ux-tour-note-body">{machineWords(question.footer)}</p>
    </div>
  );
}

function SecondCard({ checklist, actions }: { checklist: NonNullable<PanelView["checklist"]>; actions: GuideActions }) {
  const [hint, setHint] = useState<string | null>(null);
  const titleId = useId();
  return (
    <div className="ux-tour-checklist" data-ply-tour-step={checklist.step.id}>
      <p className="ux-tour-note-title" id={titleId}>
        {checklist.quiet ? machineWords(checklist.quiet) : machineWords(checklist.offer)}
      </p>
      {!checklist.quiet && (
        <>
          <ul className="ux-tour-checklist-rows" aria-labelledby={titleId}>
            {checklist.rows.map((row) => (
              <li
                key={row.item}
                className={row.done ? "ux-tour-check ux-tour-check--done" : "ux-tour-check"}
                data-ply-tour-check={row.item}
              >
                <div className="ux-tour-step-line">
                  <span className={row.done ? "ux-tour-mark ux-tour-mark--done" : "ux-tour-mark"} aria-hidden="true">
                    {row.done && <Icon name="current" size="sm" />}
                  </span>
                  <span className="ux-tour-step-label">{row.item}</span>
                  {row.done ? (
                    <span className="ux-tour-step-word">Done</span>
                  ) : (
                    <CBtn
                      tone="quiet"
                      aria-expanded={hint === row.item}
                      aria-label={`Hint: ${row.item}`}
                      onClick={() => setHint((h) => (h === row.item ? null : row.item))}
                    >
                      Hint
                    </CBtn>
                  )}
                </div>
                {hint === row.item && !row.done && <p className="ux-tour-why">{machineWords(row.hint)}</p>}
              </li>
            ))}
          </ul>
          <div className="ux-tour-actions">
            <CBtn tone="quiet" onClick={() => actions.skip(checklist.step)}>
              Skip this step
            </CBtn>
          </div>
        </>
      )}
    </div>
  );
}

function StepRow({
  row,
  pv,
  targetShown,
  actions,
  nowhere,
}: {
  row: PanelRow;
  pv: PanelView;
  targetShown: boolean;
  actions: GuideActions;
  nowhere: string | null;
}) {
  const [why, setWhy] = useState(false);
  const { step, status, copy } = row;
  const current = status === "current";
  const offered = status === "offered";
  const fallback = step.id === STEP.tryIt || step.id === OPT.codeTryProject ? pv.tryFallback : null;
  return (
    <li
      className={ROW_CLASS[status]}
      aria-current={current ? "step" : undefined}
      data-ply-tour-step={step.id}
    >
      <div className="ux-tour-step-line">
        <span className={MARK_CLASS[status]} aria-hidden="true">
          {status === "done" && <Icon name="current" size="sm" />}
        </span>
        <span className="ux-tour-step-label">{machineWords(copy.title)}</span>
        {WORD[status] && <span className="ux-tour-step-word">{WORD[status]}</span>}
        {status === "skipped" && (
          <CBtn tone="quiet" onClick={() => actions.unskip(step)}>
            Do it now
          </CBtn>
        )}
      </div>
      {fallback && !current && <TryFallback fallback={fallback} />}
      {(current || offered) && (
        <div className="ux-tour-step-detail">
          <p className="ux-tour-step-text">{machineWords(copy.body)}</p>
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
          {current && pv.waitLine && <p className="ux-tour-step-text">{machineWords(pv.waitLine)}</p>}
          {current && why && copy.why && <p className="ux-tour-why">{machineWords(copy.why)}</p>}
          {current && fallback && <TryFallback fallback={fallback} />}
          {current && pv.b3 && <B3Options b3={pv.b3} actions={actions} />}
          {nowhere && (
            <p className="ux-tour-step-note" role="status" data-ply-tour-nowhere="">
              {machineWords(nowhere)}
            </p>
          )}
          <div className="ux-tour-actions">
            {current ? (
              <CurrentActions row={row} pv={pv} targetShown={targetShown} actions={actions} />
            ) : (
              step.navigate && (
                <CBtn tone="strong" onClick={() => actions.takeMeThere(step)}>
                  Take me there
                </CBtn>
              )
            )}
            {current && copy.why && (
              <CBtn tone="quiet" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
                Why?
              </CBtn>
            )}
            {(current || offered) && step.kind !== "explain" && (
              <CBtn tone="quiet" onClick={() => actions.skip(step)}>
                Skip this step
              </CBtn>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** §6.3: how to try it when Try it can't start the app. */
function TryFallback({ fallback }: { fallback: NonNullable<PanelView["tryFallback"]> }) {
  return (
    <div className="ux-tour-fallback" data-ply-tour-fallback="">
      <p className="ux-tour-step-text">{machineWords(fallback.text)}</p>
      {fallback.details && (
        <Details>
          <p className="ux-tour-why">{machineWords(fallback.details)}</p>
        </Details>
      )}
    </div>
  );
}

/** B3's other ways (§6.2, §11): the safe example, the guided card under
 *  way. Each is the member's own press. */
function B3Options({ b3, actions }: { b3: NonNullable<PanelView["b3"]>; actions: GuideActions }) {
  if (!b3.safeExample && !b3.continueWith) return null;
  return (
    <div className="ux-tour-actions" data-ply-tour-b3="">
      {b3.continueWith && (
        <CBtn tone="quiet" onClick={() => actions.takeCard(b3.continueWith!.workspaceId, b3.continueWith!.cardId)}>
          {b3.continueWith.label}
        </CBtn>
      )}
      {b3.safeExample && (
        <CBtn tone="quiet" onClick={actions.safeExample}>
          {b3.safeExample}
        </CBtn>
      )}
    </div>
  );
}

function CurrentActions({
  row,
  pv,
  targetShown,
  actions,
}: {
  row: PanelRow;
  pv: PanelView;
  targetShown: boolean;
  actions: GuideActions;
}) {
  const { step } = row;
  if (step.kind === "explain") {
    // TU-7: an optional chapter's explain step also shows where it is —
    // Show me on screen, else Take me there — beside its Next.
    return (
      <>
        <CBtn tone="accent" onClick={() => actions.complete(step)}>
          {step.id === STEP.howItWorks ? "Start" : "Next"}
        </CBtn>
        {step.anchor && targetShown ? (
          <CBtn tone="quiet" onClick={actions.showMe}>
            Show me
          </CBtn>
        ) : (
          step.navigate && (
            <CBtn tone="quiet" onClick={() => actions.takeMeThere(step)}>
              Take me there
            </CBtn>
          )
        )}
      </>
    );
  }
  if (pv.view.wait === "other-workspace") {
    // A step on the card's page: to the card itself, not only its workspace
    // (TU-5 Mac walk). B6/B7 (a mode of the tour workspace) go to the
    // workspace: opening a mode does not switch to it.
    const toCard = step.navigate != null && "card" in step.navigate;
    return (
      <CBtn tone="strong" onClick={toCard ? () => actions.takeMeThere(step) : actions.goToTourWorkspace}>
        Take me there
      </CBtn>
    );
  }
  // §9, §11: what only Setup does — the AI, the project.
  if (pv.view.wait === "no-workspace" || pv.view.wait === "ai-not-ready") {
    const to = pv.view.wait === "no-workspace" ? "project" : "ai";
    return (
      <CBtn tone="strong" onClick={() => actions.finishSetup(to)}>
        {FINISH_SETUP_LABEL}
      </CBtn>
    );
  }
  // TU-5 Mac walk: a card step while its card's page is not on screen (the
  // sidebar's Resume on the Inbox): Take me there to the card, whatever the
  // step waits on there.
  if (pv.cardElsewhere) {
    return (
      <CBtn tone="strong" onClick={() => actions.takeMeThere(step)}>
        Take me there
      </CBtn>
    );
  }
  if (pv.view.wait) return null;
  if (step.anchor && targetShown) {
    return (
      <CBtn tone="strong" onClick={actions.showMe}>
        Show me
      </CBtn>
    );
  }
  if (step.navigate) {
    return (
      <CBtn tone="strong" onClick={() => actions.takeMeThere(step)}>
        Take me there
      </CBtn>
    );
  }
  return null;
}
