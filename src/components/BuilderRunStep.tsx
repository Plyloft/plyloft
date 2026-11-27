import { showBackendText } from "../lib/backendMarks";
import { useEffect, useId, useRef, useState } from "react";
import { isChecksHold } from "../lib/checksConsent";
import { reviewerWords } from "../lib/words";
import type { BuildLaneId, KanbanCard, WorktreeSetupRecord } from "../ipc";
import { shipTargetOf } from "../lib/deliveryStage";
import { builderResumedIdle, useBuilder } from "../store/builderStore";
import { useWorkspaces } from "../store/workspaceStore";
import { CARD_TRUST_TILE_LINE, isCardFolder } from "../lib/copyWords";
import { useVerify } from "../store/verifyStore";
import { useSettings } from "../store/settingsStore";
import { deriveTileAttention, SILENCE_MS } from "../lib/attention";
import { selfCheckNote } from "../lib/selfCheck";
import { earlyFinishSheet } from "../lib/finishAndCheck";
import { resumedWithoutTurn } from "../lib/sessionActor";
import { finishAndCheck } from "../store/finishAndCheck";
import { verifyPassedMessage } from "../lib/checksWords";
import { effectiveBuilderVendor, restartPermissionsChoosable, startFreshOffer } from "../lib/cardPage";
import {
  BUILDER_PERMISSIONS,
  builderPermissionsLabel,
  builderPermissionsHelper,
  cardPermissionsChoice,
  readBuilderPermissions,
  restartPermissionsNote,
  sessionPermissionsWords,
} from "../lib/builderPermissions";
import {
  GUIDED_PERMISSION_MODE,
  GUIDED_SESSION_WORDS,
  guidedSessionTitle,
  boundedStartApplies,
  guidedStartApplies,
  guidedStartSentence,
} from "../lib/firstCardGuide";
import {
  FINISH_BUSY_LABEL,
  FINISH_LABEL,
  FINISH_TITLE,
  liveBuilderSessionState,
  PUT_BACK_SESSION_WORDS,
  resumeFailedHelper,
} from "../lib/cardLifecycle";
import {
  failureReason,
  handedOverOwed,
  reviewAgainLabel,
  reviewCanRunAgain,
  reviewChipForTruth,
  reviewCoverage,
  reviewTruth,
  singleVendorReviewTip,
  type ReviewTone,
  type ReviewTruth,
  builderNeverStarted,
  notStartedOnPrWords,
  verdictOwed,
  verdictShownAsWork,
  waitingReviewText,
} from "../lib/challengerReview";
import {
  verdictNeedsAcknowledging,
  verdictNeedsSending,
  verdictSendsItself,
} from "../lib/verdictDelivery";
import { useReviewTip } from "./useReviewTip";
import { confirmSheet } from "../store/confirmStore";
import { BuilderSession } from "./BuilderSession";
import { ThemeRestartLine } from "./ThemeRestartLine";
import { RESTART_WHILE_WORKING } from "../lib/themeRestart";
import { OverlapWarnings } from "./OverlapWarnings";
import { CBtn, Callout, Details, Select, SplitButton, StateWord, type RunState } from "./ux";
import { cardWorktreeSetupRetry, cardWorktreeSetupSkip } from "../ipc";
import { copyProblems, setupFailureWords } from "../lib/worktreeSetup";
import { useKanban } from "../store/kanbanStore";
import { useBuildBoth } from "../store/buildBothStore";
import { useSettingUp } from "../lib/autoSetUp";
import { buildBothOffer } from "../lib/buildBoth";
import { pushToast } from "../store/toastStore";
import { useDoctor } from "../store/doctorStore";
import { useUi } from "../store/uiStore";
import { pickerNote, startRefusal, vendorOption, vendorReadiness, VENDOR_NAME } from "../lib/vendorReadiness";
import { SkillDriftLine } from "./SkillDriftNotice";
import { useCardPresenter } from "../hooks/useCardLive";
import { cardSessionWords, sessionSaysResumeFailed } from "../lib/cardPresentation";
import { isPausedHeadline } from "../lib/sessionBlock";
import { FINISH_WITHOUT_REVIEW_HINT, FINISH_WITHOUT_REVIEW_LABEL, LEAVE_LINE, SESSION_WORDS, selfCheckWhat } from "../lib/deliveryWords";
import { modelSentenceWords } from "../lib/roleModels";
import { openRepair } from "../lib/openRepair";
import { pushErrorToast } from "../lib/errorToast";

/**
 * v1.106.0 (Builder/Challenger): the Run step when a card is built by a
 * live Builder session. Three faces:
 *   - no session yet → Start build (+ 1.171.0 D1: how the Builder asks you);
 *   - live session → the terminal and Build done (D6); Close is in the ⋯;
 *   - session lost/closed → Resume (D13).
 * Verify results are injected back into the open session (D12).
 *
 * GH #259: on the one scale — who builds, on what and in what state is one
 * small line of state words; the actions are quiet buttons (the page's one
 * accent is the Now callout's); the snapshots are in Technical details.
 */
/** Windows walk 2026-10-20: a shipped card's closed session — its copy is
 *  gone (or going), so there is nothing to resume. */
export const SHIPPED_SESSION_CLOSED_WORDS = "The Builder session was closed. This card is shipped.";

/** 1.168.1 (#6, Windows): Restart from the theme line — asked first while
 *  the Builder works or waits (as Finish asks, `earlyFinishSheet`), then
 *  the session closed and resumed (the Builder's own Resume), so it starts
 *  in today's theme. A close that failed has said so; nothing resumes. */
export async function restartBuilderSession(workspaceId: string, cardId: string): Promise<boolean> {
  const rt = useBuilder.getState().byCard[cardId];
  if (earlyFinishSheet(rt, Date.now(), builderResumedIdle(cardId)) && !(await confirmSheet({ ...RESTART_WHILE_WORKING }))) return false;
  if (!(await useBuilder.getState().close(workspaceId, cardId))) return false;
  try {
    await useBuilder.getState().resume(workspaceId, cardId);
    return true;
  } catch {
    // Resume's own failure line says why.
    return false;
  }
}

/** 1.172.0 (A2, owner): a new start of a card whose Builder session closed
 *  (Start fresh) or that moved back to Ready to start (Start build again)
 *  runs in the choice the card shows (`cardPermissionsChoice`), and the
 *  card keeps it as its own — so what was shown is what runs, a closed
 *  session's posture included. The tour card's bounded mode, shown while
 *  the card has no choice of its own, is left to Rust's own test. `false`
 *  when the choice couldn't be saved: then nothing starts (it says so). */
export async function keepShownPermissions(card: KanbanCard, vendor: "claude" | "codex"): Promise<boolean> {
  if (readBuilderPermissions(card.builderPermissions) || !card.builder) return true;
  const settings = useSettings.getState().settings;
  const tourMode = boundedStartApplies(settings.onboarding, card.workspaceId, card, false);
  const shown = cardPermissionsChoice(card, vendor, settings.behavior.builderPermissions, tourMode);
  const fromSession = card.builder.vendor === vendor && (readBuilderPermissions(card.builder.permissions) != null || card.builder.bypass);
  if (tourMode && !fromSession) return true;
  try {
    await useKanban.getState().setBuilderPermissions(card.workspaceId, card.id, shown);
    return true;
  } catch (e) {
    pushErrorToast("Couldn't save how the Builder asks you, so it didn't start", e);
    return false;
  }
}

/** 1.174.0 C4 (G3a walk): what the card page holds every Start build
 *  with — a blocker, a follow-up's or a copy card's empty brief
 *  (`reason`, said beside it) — and what it does first (`before`: save the
 *  typed brief; false stops the start). */
export interface StartHold {
  reason: string | null;
  before?: () => Promise<boolean>;
}

/** 1.174.1 P1 (T1): under the card's Codex session while Codex asks to
 *  trust the card's folder (`trustAsking`, the card's own Builder, not its
 *  intake) — only when the session runs in a card's folder, never in the
 *  project folder itself (`isCardFolder`, through `pathKey`). Never answers
 *  it. */
export function CardSessionTrustLine({
  card,
  vendor,
}: {
  card: Pick<KanbanCard, "id" | "workspaceId" | "worktreePath">;
  vendor: string | undefined;
}) {
  const asking = useBuilder((s) => s.trustAsking[card.id]);
  const projectCwd = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.cwd ?? null);
  if (vendor !== "codex" || !asking || asking.intake || asking.vendor !== "codex") return null;
  if (!isCardFolder(card.worktreePath, [card.worktreePath], projectCwd)) return null;
  return (
    <p className="ux-card-muted" role="note" data-ply-card-trust="">
      {CARD_TRUST_TILE_LINE}
    </p>
  );
}

export function BuilderRunStep({
  card,
  resumeInNow = false,
  startHold,
}: {
  card: KanbanCard;
  /** GH #259: the card's Now callout already offers Resume and Start fresh;
   *  the section does not repeat them. */
  resumeInNow?: boolean;
  startHold?: StartHold;
}) {
  const ws = card.workspaceId;
  const builder = card.builder ?? null;
  const rt = useBuilder((s) => s.byCard[card.id]);
  // v1.154.1 (J5): when work last went into the session.
  const sentAt = useBuilder((s) => s.sentAt[card.id]);
  const submittedAt = useBuilder((s) => s.submittedAt[card.id]);
  const doneAt = useBuilder((s) => s.doneAt[card.id]);
  // "Working" is silence-derived: the session's last output decides it,
  // and nothing re-renders when the silence runs out — the card's slow
  // tick is 30 s. Re-render once, when it does.
  const [, setSilenceTick] = useState(0);
  const outputAt = rt ? (rt.lastOutputAt ?? rt.startedAt) : null;
  useEffect(() => {
    if (outputAt == null) return;
    const due = outputAt + SILENCE_MS - Date.now();
    if (due < 0) return;
    const id = window.setTimeout(() => setSilenceTick((n) => n + 1), due + 50);
    return () => window.clearTimeout(id);
  }, [outputAt]);
  const start = useBuilder((s) => s.start);
  const resume = useBuilder((s) => s.resume);
  const inject = useBuilder((s) => s.inject);
  const [busy, setBusy] = useState(false);

  // D12: when the verify job for this card reaches a terminal state while
  // the session is alive, send the result back into it. Only transitions
  // count — a card reopened with an old passed verify must not re-inject.
  const verify = useVerify((s) => s.byKey[`${ws}::${card.id}`]);
  const lastVerifyKind = useRef<string | null>(null);
  useEffect(() => {
    const kind = verify?.state.kind ?? null;
    const prev = lastVerifyKind.current;
    lastVerifyKind.current = kind;
    if (!kind || !rt || prev === null) return;
    if (prev !== "running" && prev !== "queued") return;
    // 1.175.0 B2: the checks wait for this Mac's OK — nothing ran, so there
    // is nothing for the Builder to fix.
    if (isChecksHold(verify?.state)) return;
    if (kind === "passed") {
      inject(card.id, verifyPassedMessage(verify?.steps.length ?? 0));
    } else if (kind === "failed" || kind === "timedOut") {
      const failed = verify?.steps.filter((s) => !s.passed) ?? [];
      const detail = failed
        // 1.176.0 seams: the Builder reads the sentence, never a typed mark.
        .map((s) => `- ${s.kind}: ${showBackendText(s.reason ?? "no reason recorded").slice(0, 1200)}`)
        .join("\n");
      const reason =
        verify?.state.kind === "failed"
          ? showBackendText(verify.state.reason)
          : verify?.state.kind === "timedOut"
            ? `timed out at ${verify.state.step}`
            : "";
      inject(
        card.id,
        `[Plyloft] Verification FAILED${reason ? ` — ${reason.slice(0, 300)}` : ""}.\n${detail}\nFix it in this folder, then stop: Plyloft checks your fix when you are done.`,
      );
    }
  }, [verify, rt, inject, card.id]);

  // D8: the Challenger's verdict goes back into the open session. GH #135:
  // it used to be injected on the running → settled transition, and only
  // while this component was mounted, so a review that settled with the
  // card closed was never sent. The card records the settled verdict as
  // unsent instead (`BuilderState.undeliveredVerdict`); it goes in as soon
  // as a session is live — this open, the next one, or by the press below
  // — and the backend clears the record, so it is never sent twice.
  const review = builder?.review ?? null;
  const sendVerdict = useBuilder((s) => s.sendVerdict);
  const ackVerdict = useBuilder((s) => s.ackVerdict);
  const owedVerdict = verdictOwed(builder, useBuilder((s) => s.verdictDelivery[card.id]), Boolean(card.prReview));
  // The session this card has, attached here — the only one a verdict is
  // written into (`live` below is the same fact, after the early return).
  const liveSession = Boolean(builder?.ptyId) && rt?.ptyId === builder?.ptyId;
  // Nothing is written into a Builder mid-turn: the verdict waits for the
  // prompt here rather than in the pending queue, so a review superseded
  // (or a pushback accepted) while it waited cannot still reach the
  // Builder — by then the card owes nothing and this does nothing.
  const promptIdle = rt?.promptBoxIdle === true;
  useEffect(() => {
    if (!liveSession || !owedVerdict) return;
    if (promptIdle && verdictSendsItself(owedVerdict)) {
      void sendVerdict(ws, card.id, owedVerdict, "auto");
      return;
    }
    // The Builder has it; only the card was not told. Never a second write.
    if (verdictNeedsAcknowledging(owedVerdict, Date.now())) void ackVerdict(ws, card.id, owedVerdict);
  }, [liveSession, promptIdle, owedVerdict, sendVerdict, ackVerdict, ws, card.id]);

  // GH #99 (review 3): the chip uses the live branch tip, like the header.
  const reviewTip = useReviewTip(card);
  // UX P-A Mac walk 4: what the card says, when it outranks the session —
  // the header says the sidebar row's words ("Asks to trust the folder",
  // "Ship stopped on a conflict"), with the card's dot.
  const presenter = useCardPresenter();
  const presented = presenter(card, reviewTip);
  const cardWords = cardSessionWords(presented, builder?.vendor);
  // (Challenger, P-F) A usage limit is no question: Finish and check waits
  // for the Builder to continue after the reset, and says so.
  const limited = presented.rule === "session-block" && isPausedHeadline(presented.headline);
  const truth = reviewTruth({
    builder,
    branchTip: reviewTip?.branchTip,
    commitsSinceReview: reviewTip?.commitsSinceReview,
  });

  const waitingText = waitingReviewText(builder);
  // GH #129: a request for changes a hand-over left unsent.
  const sendHandedOver = useBuilder((s) => s.sendHandedOver);
  const owed = handedOverOwed(builder, useBuilder((s) => s.handedOverDelivery[card.id]));

  // 1.171.0 C3 (CF18, CP-10): the old Skip review toggle is Finish and
  // check ▾ › Check without the Reviewer, one press.
  // ADR 0006 (third card): the self-check Build done is waiting on.
  const selfCheck = useBuilder((s) => s.selfCheck[card.id]);
  const skipSelfCheck = useBuilder((s) => s.skipSelfCheck);
  // GH #111 F6: the snapshot and Verify handoff after the self-check.
  const doneBusy = useBuilder((s) => Boolean(s.doneBusy[card.id]));
  // Tier 4 walk 2026-10-14: Start fresh uses Start build's vendor.
  const settingsVendor = useSettings((s) => s.settings.behavior.builderVendor);
  const vendorPick = useBuilder((s) => s.vendorPref[card.id]);
  const freshVendor = effectiveBuilderVendor(vendorPick, card, settingsVendor);

  // Walk of #386 (step 7): a pull request's card has a Builder record from
  // the start (its reviews live there) though no session ever ran — a start
  // the card's setup refused leaves it so. That is no closed session to
  // resume: a pull request's card says how its Builder starts; any other
  // card shows Start build, as with no record.
  if (builder && builderNeverStarted(builder) && card.prReview) {
    return (
      <div className="ux-card-session">
        <p className="ux-card-muted" data-ply-builder-not-started="">
          {notStartedOnPrWords(card.prReview.state)}
        </p>
      </div>
    );
  }
  if (!builder || builderNeverStarted(builder)) {
    return <BuilderStartPanel card={card} busy={busy} heldReason={startHold?.reason ?? null} before={startHold?.before} onStart={async () => {
      if (startHold?.reason) return;
      setBusy(true);
      try {
        if (startHold?.before && !(await startHold.before())) return;
        await start(ws, card.id);
      } catch {
        // toast already shown by the store
      } finally {
        setBusy(false);
      }
    }} />;
  }

  const live = liveSession;
  // N14 walk F18: put back in To do — no Resume or Start fresh here; the
  // Now box's Start build picks the card up again from its branch.
  const inTodo = card.columnId === "todo" && !builder.ptyId;
  // Windows walk 2026-10-20: a shipped card's copy is gone, or goes once
  // its session closes (`keptCopy`) — nothing to resume in, no "copy is safe".
  const shippedClosed =
    !builder.ptyId && (card.shipStatus === "shipped" || card.reviewStatus === "merged" || Boolean(card.keptCopy));
  const attention = rt
    ? deriveTileAttention(
        {
          kind: rt.vendor,
          status: "running",
          startedAt: rt.startedAt,
          lastOutputAt: rt.lastOutputAt,
          promptBoxIdle: rt.promptBoxIdle,
          questionInView: rt.questionInView,
        },
        Date.now(),
      )
    : null;
  // v1.154.1 (J5): a live session whose build is done says so.
  const liveState = builder.ptyId ? liveBuilderSessionState(card, attention, sentAt ?? null, doneAt ?? null, rt?.turnIdle === true) : null;
  // 1.174.3: as Now says it: a resumed session that received nothing isn't at work.
  const resumedIdle = liveState?.id === "working" && rt != null && resumedWithoutTurn(rt, sentAt ?? null, submittedAt ?? null);
  const stateLabel = cardWords && liveState
    ? cardWords.header
    : !liveState
    ? // 1.171.0 C2 (CF8): one session word, however it went; the line
      // under the header says why.
      SESSION_WORDS.closed
    : resumedIdle
    ? SESSION_WORDS.yourTurn
    : liveState.label;
  const stateDot: RunState = !liveState ? "empty" : cardWords ? cardWords.dot : resumedIdle ? "done" : liveState.dot;
  // Mac walk 4: no Build done while the session asks a question — the
  // folder-trust question, or one in view — there is nothing to save yet.
  const asking = Boolean(cardWords?.asks) || liveState?.id === "question";
  const who = builder.vendor === "claude" ? "Claude" : "Codex";
  // Walk 2026-10-23: "builds on gpt-6-astra with high effort".
  const sessionModel = modelSentenceWords(builder.model);

  const finishOff = busy || !live || Boolean(selfCheck) || doneBusy || asking;
  const finishTitle = limited
    ? `${who}'s usage limit is reached. After it resets, tell the Builder to continue; then Finish and check saves the work.`
    : asking
    ? "Answer the session's question first; then Finish and check saves the work."
    : FINISH_TITLE;

  async function onDone(withoutReview = false) {
    // P-B: pressed early it asks first (still working, or a question).
    const sheet = earlyFinishSheet(rt, Date.now(), builderResumedIdle(card.id));
    if (sheet && !(await confirmSheet(sheet))) return;
    setBusy(true);
    try {
      // The store toasts the snapshot, or the self-check it sent first.
      // 1.171.0 C3: the one press (`store/finishAndCheck.ts`) — a skip is
      // set for this press only, and cleared after it whatever happened.
      await finishAndCheck(ws, card.id, { withoutReview, asked: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ux-card-session">
      {/* F4: a Builder started without its setup keeps saying so. */}
      {card.worktreeSetup?.state === "skipped" && (
        <WorktreeSetupNote card={card} busy={busy} onStart={() => undefined} />
      )}
      <p className="ux-card-session-line">
        <StateWord state={stateDot} live={stateDot === "running"}>
          {stateLabel}
        </StateWord>
        {/* #74: the model this session was actually spawned on. Absent
            when the Builder row is blank — then the CLI chose. */}
        <span title={sessionModel ? `This session runs on ${sessionModel}.` : undefined}>
          {who} builds{sessionModel ? ` on ${sessionModel}` : ""}
        </span>
        {/* 1.171.0 (D1): the choice this session started in. */}
        {sessionPermissionsWords(builder.permissions, builder.vendor) ? (
          <span title={sessionPermissionsWords(builder.permissions, builder.vendor)!.title}>
            {sessionPermissionsWords(builder.permissions, builder.vendor)!.words}
          </span>
        ) : builder.bypass ? (
          <span title="Started without permission prompts">without asking</span>
        ) : null}
        {/* UX P-C: the guided first card's bounded mode. */}
        {!builder.bypass && builder.permissionMode === GUIDED_PERMISSION_MODE && (
          <span title={guidedSessionTitle(builder.vendor, false, shipTargetOf(card))}>{GUIDED_SESSION_WORDS}</span>
        )}
        {rt && rt.pending.length > 0 && (
          <span title="Delivered when the Builder is back at its prompt">
            {rt.pending.length} message{rt.pending.length === 1 ? "" : "s"} waiting for its prompt
          </span>
        )}
      </p>
      {(review || waitingText) && (
        <p className="ux-card-session-line">
          {review && <ReviewWord review={review} truth={truth} />}
          {/* GH #124: a Build done waiting for the running review. */}
          {waitingText && (
            <span title="One review per card at a time: the newest round is reviewed when the running review ends — as its follow-up when that review judged the change.">
              {waitingText}
            </span>
          )}
          {review && <ReviewAgainButton card={card} review={review} />}
        </p>
      )}
      <OverlapWarnings workspaceId={ws} cardId={card.id} />
      {/* GH #135: a settled verdict the Builder has not received. It goes
          in by itself while a session is live; the press is the way back
          when the write failed, or the session has to be resumed first.
          1.171.0 C2 (CF11, K3): only a request for changes still to send is
          shown here — an approval (or an incomplete or failed review) goes
          in at the Builder's next prompt and is noted under Technical
          details, and nothing is said once the write has begun. */}
      {owedVerdict && verdictShownAsWork(owedVerdict, review) && (
        <div className="ux-card-session-note" role="status" data-ply-owed-verdict={owedVerdict.snapshotN}>
          <StateWord state="aborted">{owedVerdict.line}</StateWord>
          <span className="ux-card-muted-inline" data-ply-owed-verdict-delivery={owedVerdict.delivery}>
            {owedVerdict.status}
          </span>
          {verdictNeedsSending(owedVerdict) && (
            <CBtn
              tone="quiet"
              disabled={!live}
              onClick={() => void sendVerdict(ws, card.id, owedVerdict, "press")}
              title={live ? "Send the Reviewer's verdict on this round into the Builder session." : undefined}
              reason={live ? null : "Resume the Builder session first."}
              data-ply-owed-verdict-send=""
            >
              {owedVerdict.sendLabel}
            </CBtn>
          )}
        </div>
      )}
      {owed && (
        <div className="ux-card-session-note" role="status" data-ply-handed-over={owed.snapshotN}>
          <StateWord state="aborted">{owed.line}</StateWord>
          <span className="ux-card-muted-inline" data-ply-handed-over-delivery={owed.delivery}>{owed.status}</span>
          {(owed.delivery === "unsent" || owed.delivery === "failed") && (
            <CBtn
              tone="quiet"
              disabled={!live}
              onClick={() => void sendHandedOver(card.id, owed)}
              title={live ? "Send the open findings into the Builder session, by id, as a follow-up would have." : undefined}
              reason={live ? null : "Resume the Builder session first."}
            >
              {owed.delivery === "failed" ? "Send again" : "Back to the Builder"}
            </CBtn>
          )}
        </div>
      )}
      <SelfCheckLine
        card={card}
        who={who}
        running={Boolean(selfCheck)}
        waiting={selfCheck?.deliveredAt == null}
        asking={attention === "asking-you" && rt?.turnIdle !== true}
        onSkip={() => void skipSelfCheck(card.id)}
      />
      {builder.ptyId ? <SkillDriftLine ptyId={builder.ptyId} /> : null}
      {builder.ptyId ? (
        <ThemeRestartLine
          ptyId={builder.ptyId}
          vendor={builder.vendor}
          onRestart={() => restartBuilderSession(ws, card.id)}
        />
      ) : null}
      {/* 1.174.1 P1 (T1, Windows walk): the card's own Codex session, the
          same line as a Codex tile in a card's folder. */}
      {builder.ptyId ? <CardSessionTrustLine card={card} vendor={builder.vendor} /> : null}
      {builder.ptyId ? (
        <BuilderSession
          workspaceId={ws}
          cardId={card.id}
          ptyId={builder.ptyId}
          vendor={builder.vendor}
        />
      ) : !inTodo && !shippedClosed && builder.resumeFailed && !sessionSaysResumeFailed(card, presented) ? null : (
        <p className="ux-card-muted">
          {inTodo
            ? PUT_BACK_SESSION_WORDS
            : shippedClosed
            ? SHIPPED_SESSION_CLOSED_WORDS
            : builder.resumeFailed
            ? resumeFailedHelper(builder.vendor)
            : builder.sessionLost
            ? "The Builder's session ended (Plyloft restarted, or it crashed). The card's copy is safe; Resume opens a new session that continues the same conversation."
            : "The Builder session was closed. The card's copy is safe; Resume opens a new session in it."}
        </p>
      )}
      {builder.ptyId ? (
        <div className="ux-card-section-actions">
          {presented.state === "changes-requested" ? (
            // 1.171.0 C3 (Challenger 1): no way without the review over a
            // request for changes — on an unchanged copy it would record an
            // override without saying so; the card's Agree / Ship without
            // these changes are the way there.
            <CBtn
              onClick={() => void onDone()}
              disabled={finishOff}
              title={finishTitle}
              data-ply-finish=""
            >
              {busy || doneBusy ? FINISH_BUSY_LABEL : FINISH_LABEL}
            </CBtn>
          ) : (
            <SplitButton
              label={busy || doneBusy ? FINISH_BUSY_LABEL : FINISH_LABEL}
              onClick={() => void onDone()}
              disabled={finishOff}
              menuLabel={`Other ways: ${FINISH_LABEL}`}
              tone="ghost"
              items={[
                {
                  label: FINISH_WITHOUT_REVIEW_LABEL,
                  hint: FINISH_WITHOUT_REVIEW_HINT,
                  onSelect: () => void onDone(true),
                },
              ]}
              mainProps={{ title: finishTitle, "data-ply-finish": "" }}
            />
          )}
        </div>
      ) : resumeInNow || inTodo || shippedClosed ? null : (
        <>
        {/* 1.172.0 (A2): how the Builder asks, chosen again for Start fresh. */}
        {restartPermissionsChoosable(card) && (
          <label className="ux-card-field" data-ply-restart-permissions="">
            <span className="ux-card-field-label">Permissions</span>
            <BuilderPermissionsPick card={card} vendor={freshVendor} restart />
          </label>
        )}
        <div className="ux-card-section-actions">
          <CBtn
            onClick={async () => {
              setBusy(true);
              try {
                await resume(ws, card.id);
              } catch {
                // toast already shown
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            title="New session in the card's copy, continuing the previous conversation"
          >
            Resume
          </CBtn>
          <CBtn
            tone="quiet"
            onClick={async () => {
              // v1.110.3: a session that died before doing anything (a bad
              // flag, a crash at launch) has nothing to resume — start
              // over with the same posture, brief re-sent. Tier 4 walk
              // 2026-10-14: with Start build's vendor (`startFreshOffer`).
              useBuilder.getState().setBypassPref(card.id, startFreshOffer(builder.vendor, freshVendor, builder.bypass).bypass);
              setBusy(true);
              try {
                // 1.172.0 (A2): in the choice shown above it.
                if (!(await keepShownPermissions(card, freshVendor))) return;
                await start(ws, card.id);
              } catch {
                // toast already shown
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            title={startFreshOffer(builder.vendor, freshVendor, builder.bypass).title}
          >
            {startFreshOffer(builder.vendor, freshVendor, builder.bypass).label}
          </CBtn>
        </div>
        </>
      )}
    </div>
  );
}

const REVIEW_DOT: Record<ReviewTone, RunState> = {
  ok: "done",
  flag: "aborted",
  running: "running",
  muted: "empty",
};

function ReviewWord({
  review,
  truth,
}: {
  review: NonNullable<KanbanCard["builder"]>["review"] & object;
  truth: ReviewTruth;
}) {
  const { text, tone } = reviewChipForTruth(review, truth);
  const coverage = reviewCoverage(review);
  // GH #99: a failed or retrying review says why in words, raw error after.
  const failure =
    truth.kind === "not-reviewed"
      ? [truth.reason, truth.commitsLine, truth.details].filter(Boolean).join("\n")
      : review.retryAt != null
        ? [failureReason(review), reviewerWords(review.error)].filter(Boolean).join("\n")
        : null;
  const title =
    review.note ??
    failure ??
    (review.singleVendor
      ? singleVendorReviewTip(review)
      : review.degraded
        ? "Same-AI review: the other AI wasn't available."
        : reviewerWords(review.error) ?? (coverage ? `${coverage}.` : undefined));
  return (
    <span title={title}>
      <StateWord state={REVIEW_DOT[tone]} live={tone === "running"}>
        {text}
        {review.degraded && !review.singleVendor ? " · same AI" : ""}
      </StateWord>
    </span>
  );
}

/** ADR 0006 (third card): while Build done waits on the Builder's
 *  self-check, the state and Skip; afterwards, the note a timed-out one
 *  leaves on the card. */
function SelfCheckLine({
  card,
  who,
  running,
  waiting,
  asking = false,
  onSkip,
}: {
  card: KanbanCard;
  /** The Builder's AI, by name. */
  who: string;
  running: boolean;
  /** The message waits for the Builder's current turn to end. */
  waiting: boolean;
  /** CL-11 (walk): its session asks you something — an approval or a
   *  question in its terminal. The self-check waits on your answer. */
  asking?: boolean;
  onSkip: () => void;
}) {
  if (running && asking) {
    return (
      <div className="ux-card-session-note" role="status" data-ply-self-check="asking">
        <StateWord state="aborted">{SESSION_WORDS.asks}</StateWord>
        <span className="ux-card-muted-inline">
          {waiting
            ? `${who} asks something in its session below. Answer it there; then it re-reads its own work.`
            : `${who} asks something in its session below while it re-reads its own work. Answer it there; then Plyloft runs your checks and the Reviewer reviews it.`}
        </span>
        <CBtn
          tone="quiet"
          onClick={onSkip}
          title="Stop waiting for the self-check: save the Builder's work as it is, run your checks and start the review now."
        >
          Skip
        </CBtn>
      </div>
    );
  }
  if (running) {
    return (
      <div className="ux-card-session-note" role="status" data-ply-self-check="running">
        <StateWord state="running" live>
          {selfCheckWhat(who, !waiting)}
        </StateWord>
        <span className="ux-card-muted-inline">
          {/* 1.171.0 C2 (CF3): Now's words, without "prompt". */}
          Then your checks run and the Reviewer reviews it. {LEAVE_LINE}
        </span>
        <CBtn
          tone="quiet"
          onClick={onSkip}
          title="Stop waiting for the self-check: save the Builder's work as it is, run your checks and start the review now."
        >
          Skip
        </CBtn>
      </div>
    );
  }
  const record = card.builder?.selfCheck;
  if (record?.outcome !== "timedOut") return null;
  return (
    <p className="ux-card-muted" data-ply-self-check="timed-out">
      {selfCheckNote(record)}
    </p>
  );
}

/** GH #58: re-run an incomplete (or failed) review of the current snapshot
 *  in smaller passes — the way out that is not accepting a pushback. Shown
 *  only for the latest snapshot's review; the backend checks the rest. */
export function ReviewAgainButton({
  card,
  review,
}: {
  card: KanbanCard;
  review: NonNullable<KanbanCard["builder"]>["review"] & object;
}) {
  const reviewAgain = useBuilder((s) => s.reviewAgain);
  const [busy, setBusy] = useState(false);
  const snapshots = card.builder?.snapshots ?? [];
  const latest = snapshots[snapshots.length - 1]?.n;
  if (!reviewCanRunAgain(review) || review.snapshotN !== latest) return null;
  return (
    <CBtn
      tone="quiet"
      disabled={busy}
      title="Run the Reviewer again on this build, reading all of the changes in smaller passes. Nothing is committed and the checks are not re-run."
      onClick={async () => {
        setBusy(true);
        try {
          await reviewAgain(card.workspaceId, card.id);
        } catch {
          // toast already shown by the store
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Starting…" : reviewAgainLabel(review)}
    </CBtn>
  );
}

/** The card's Builder property before any build: the vendor, chosen here —
 *  the same per-card choice as the Run step's Builder field, so Start build
 *  (from the Now callout or the Run step) opens the vendor shown. */
export function BuilderVendorPick({ card }: { card: KanbanCard }) {
  const defaultVendor = useSettings((s) => s.settings.behavior.builderVendor);
  const pick = useBuilder((s) => s.vendorPref[card.id]);
  const vendor = effectiveBuilderVendor(pick, card, defaultVendor);
  const setVendor = useBuilder((s) => s.setVendorPref);
  // OB-14 (§13.2): a vendor that can't run here is shown, disabled, with why.
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const refusal = startRefusal(vendor, readiness);
  const hintId = useId();
  return (
    <span className="ux-card-builder-pick">
      <Select
        label="Builder"
        aria-describedby={hintId}
        value={vendor}
        onChange={(next) => void setVendor(card.workspaceId, card.id, next as "claude" | "codex", true)}
        options={[vendorOption("claude", "Claude", readiness), vendorOption("codex", "Codex", readiness)]}
      />
      <span id={hintId} className="ux-card-muted-inline">
        {refusal ? `not started · ${readiness[vendor].reason}` : "not started"}
      </span>
    </span>
  );
}

/** 1.171.0 (D1; FR-3, CF6): how the card's Builder asks before it changes
 *  things — chosen on the card before Start build (the facts line and the
 *  Run step), saved with the card; Settings › Claude and Codex gives a new
 *  card its default. The line under it says what that AI really does in it
 *  (`builderPermissionsHelper`). */
export function BuilderPermissionsPick({
  card,
  vendor,
  helper = true,
  restart = false,
}: {
  card: KanbanCard;
  vendor: "claude" | "codex";
  /** The guided first card shows D2's own sentence instead. */
  helper?: boolean;
  /** 1.172.0 (A2): chosen again after a session closed — where Resume is
   *  offered too, the line says Resume isn't changed by it. */
  restart?: boolean;
}) {
  const settingsDefault = useSettings((s) => s.settings.behavior.builderPermissions);
  const tourMode = useSettings((s) => boundedStartApplies(s.settings.onboarding, card.workspaceId, card, false));
  // A2: after a session, the choice a new start would keep (Rust's
  // `card_choice`); before one, the same as before.
  const choice = cardPermissionsChoice(card, vendor, settingsDefault, tourMode);
  const resumable = restart && card.builder != null && card.columnId !== "todo";
  const helperId = useId();
  return (
    <span className="ux-card-builder-pick" data-ply-builder-permissions="">
      <Select
        label="How the Builder asks you"
        aria-describedby={helper ? helperId : undefined}
        value={choice}
        onChange={(next) => {
          // A choice made here replaces a closed session's kept posture.
          useBuilder.getState().setBypassPref(card.id, false);
          void useKanban
            .getState()
            .setBuilderPermissions(card.workspaceId, card.id, readBuilderPermissions(next))
            .catch((e) =>
              pushErrorToast("Couldn't save how the Builder asks you", e),
            );
        }}
        options={BUILDER_PERMISSIONS.map((p) => ({ value: p, label: builderPermissionsLabel(p, vendor) }))}
      />
      {helper && (
        <span id={helperId} className="ux-card-muted-inline">
          {builderPermissionsHelper(choice, vendor)}
          {resumable ? ` ${restartPermissionsNote(card.builder!)}` : ""}
        </span>
      )}
    </span>
  );
}

/** The Run step before any session exists. */
export function BuilderStartPanel({
  card,
  busy,
  onStart,
  heldReason = null,
  before,
}: {
  card: KanbanCard;
  busy: boolean;
  onStart: () => void | Promise<void>;
  /** C4: what a start does first (save the typed brief); false stops it. */
  before?: () => Promise<boolean>;
  /** C4 (G3a walk): why the card page holds Start build — off here too,
   *  with the same reason beside it. */
  heldReason?: string | null;
}) {
  const bypass = useBuilder((s) => s.bypassPref[card.id] ?? false);
  const defaultVendor = useSettings((s) => s.settings.behavior.builderVendor);
  const pick = useBuilder((s) => s.vendorPref[card.id]);
  const vendor = effectiveBuilderVendor(pick, card, defaultVendor);
  const setVendor = useBuilder((s) => s.setVendorPref);
  // UX P-C: on the unedited guided first card, D2's one sentence takes the
  // permissions helper's place — 1.171.0 (D1) until the card has a choice
  // of its own.
  const guided = useSettings(
    (s) => card.builderPermissions == null && boundedStartApplies(s.settings.onboarding, card.workspaceId, card, bypass),
  );
  // Owner 2026-11-10: the sentence is the README example's card's only; the
  // tour's card says its bounded start under What you want.
  const readmeGuided = useSettings(
    (s) => guided && guidedStartApplies(s.settings.onboarding?.firstCard ?? null, card.workspaceId, card, bypass),
  );
  // OB-14 (§13.2): a vendor that isn't ready is shown disabled with its
  // reason, and Start build on it is refused with two ways out.
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const refusal = startRefusal(vendor, readiness);
  const note = pickerNote(readiness);
  // SL-6: Build with both, beside Start build.
  const bothOffer = buildBothOffer(card, readiness);
  const startBoth = useBuildBoth((s) => s.start);
  const bothBusy = useBuildBoth((s) => Boolean(s.busy[card.id]));
  // Windows walk of 1.160.0: a first start that sets the repository up says so.
  const settingUp = useSettingUp((s) => Boolean(s.byCard[card.id]));
  // The store's own start state, whichever surface pressed it (the Now box
  // or this one): one press at a time, the same words on both.
  const starting = useBuilder((s) => Boolean(s.startBusy[card.id]));
  const startOff = busy || starting || settingUp;
  // SL-4: a worktree whose setup failed holds the Builder back until Retry
  // or Start anyway.
  const setupFailed = card.worktreeSetup?.state === "failed" || card.worktreeSetup?.state === "running";
  const blocked =
    card.archived || card.intakeStatus === "active" || refusal !== null || setupFailed || Boolean(heldReason);
  return (
    <div className="ux-card-session">
      {card.worktreeSetup && card.worktreeSetup.state !== "done" && (
        <WorktreeSetupNote card={card} busy={busy} onStart={onStart} />
      )}
      <p className="ux-card-plain">
        Start build opens a live {vendor === "codex" ? "Codex" : "Claude"} session in this card's own
        copy of the project, with the card as its brief. You can talk to it, it can ask you questions,
        and nothing is pushed until you ship.
      </p>
      <label className="ux-card-field">
        <span className="ux-card-field-label">Builder</span>
        <Select
          label="Builder"
          value={vendor}
          onChange={(next) => void setVendor(card.workspaceId, card.id, next as "claude" | "codex", true)}
          options={[
            vendorOption("claude", "Claude Code", readiness),
            vendorOption("codex", "Codex (stays in the card's copy)", readiness),
          ]}
        />
      </label>
      {note && !refusal && <p className="ux-card-muted-inline">{note}</p>}
      {refusal && (
        <Callout
          kind="warn"
          text={refusal.sentence}
          actions={
            <>
              {refusal.switchTo && (
                <CBtn onClick={() => void setVendor(card.workspaceId, card.id, refusal.switchTo!, true)}>
                  Choose {VENDOR_NAME[refusal.switchTo]}
                </CBtn>
              )}
              <CBtn
                tone="quiet"
                onClick={() =>
                  refusal.repairs
                    ? void openRepair(refusal.repairs)
                    : useUi.getState().openSettingsSection("diagnostics")
                }
              >
                {refusal.fixLabel}
              </CBtn>
            </>
          }
        />
      )}
      {/* 1.171.0 (D1): how the Builder asks, chosen before Start build. */}
      <label className="ux-card-field">
        <span className="ux-card-field-label">Permissions</span>
        <BuilderPermissionsPick card={card} vendor={vendor} helper={!guided} />
      </label>
      {readmeGuided && (
        <p className="ux-card-plain" data-ply-guided-start="">
          {guidedStartSentence(vendor, shipTargetOf(card))}
        </p>
      )}
      <div className="ux-card-section-actions">
        <CBtn
          onClick={() => void onStart()}
          disabled={startOff || bothBusy || blocked}
          title="Open the Builder session"
          reason={
            refusal
              ? refusal.sentence
              : heldReason
                ? heldReason
                : setupFailed
                  ? "The card's setup holds the Builder: wait for it, Retry it, or Start anyway."
                  : blocked
                    ? "Finish planning first."
                    : null
          }
        >
          {settingUp && !bothBusy ? "Setting up…" : busy || starting ? "Starting…" : "Start build"}
        </CBtn>
        {/* SL-6: offered only with both CLIs ready on a card not yet built;
            otherwise shown off, with the reason. */}
        {(bothOffer.offered || bothOffer.reason) && (
          <CBtn
            tone="quiet"
            onClick={() =>
              void (async () => {
                if (heldReason) return;
                if (before && !(await before())) return;
                await startBoth(card.workspaceId, card.id);
              })()
            }
            disabled={startOff || bothBusy || !bothOffer.offered || card.intakeStatus === "active" || Boolean(heldReason)}
            title={
              heldReason ??
              bothOffer.reason ??
              "Claude and Codex each build this card in their own copy of the repository; the Reviewer compares the two and you pick one."
            }
            data-ply-build-both-start=""
          >
            {bothBusy ? (settingUp ? "Setting up…" : "Starting both…") : "Build with both"}
          </CBtn>
        )}
      </div>
      {heldReason && (
        <p className="ux-card-muted-inline" data-ply-start-held-reason="">
          {heldReason}
        </p>
      )}
      {bothOffer.reason && !bothOffer.offered && (
        <p className="ux-card-muted-inline" data-ply-build-both-reason="">
          {bothOffer.reason}
        </p>
      )}
    </div>
  );
}

/** SL-4: Retry (`allow`: Allow and run) or Start anyway on a setup that
 *  holds the Builder, then `onStart` once it no longer does. Reports its
 *  own failures. The run's note and the card's Now box both use it. */
export async function settleWorktreeSetup(
  card: KanbanCard,
  kind: "retry" | "skip",
  allow: string | null,
  lane: BuildLaneId | undefined,
  onStart: () => void | Promise<void>,
): Promise<void> {
  try {
    const updated =
      kind === "retry"
        ? await cardWorktreeSetupRetry(card.workspaceId, card.id, allow, lane === "b" ? lane : null)
        : await cardWorktreeSetupSkip(card.workspaceId, card.id, lane === "b" ? lane : null);
    await useKanban.getState().loadFromDisk(card.workspaceId, true);
    const after = lane === "b" ? updated.buildBoth?.lanes.find((l) => l.lane === "b")?.worktreeSetup : updated.worktreeSetup;
    if (after?.state === "failed") {
      pushToast({
        kind: "error",
        title: after.approvalNeeded ? "The setup command still needs your OK" : "Setup failed again",
        body: after.approvalNeeded
          ? "The output is on the card. Allow and run, or Start anyway."
          : "The output is on the card. Fix the cause, then Retry, or Start anyway.",
      });
      return;
    }
    await onStart();
  } catch (e) {
    pushErrorToast(kind === "retry" ? "Couldn't run the setup again" : "Couldn't start anyway", e);
  }
}

/** SL-4: the card's worktree setup failed (or was started anyway): what
 *  happened, its output under Details, and — while it holds the Builder
 *  back — Retry and Start anyway. Both go on to Start build when the setup
 *  no longer holds it. SL-6: `lane` "b" is the Codex build's worktree of a
 *  card built by both, whose record is on its lane. */
export function WorktreeSetupNote({
  card,
  busy,
  onStart,
  lane,
  record: laneRecord,
}: {
  card: KanbanCard;
  busy: boolean;
  onStart: () => void | Promise<void>;
  lane?: BuildLaneId;
  record?: WorktreeSetupRecord;
}) {
  const record = laneRecord ?? card.worktreeSetup!;
  const [working, setWorking] = useState<"retry" | "skip" | null>(null);
  const words = setupFailureWords(record);
  const problems = copyProblems(record);
  const holding = record.state === "failed";
  const allow = holding && record.approvalNeeded ? (record.command ?? null) : null;

  async function settle(kind: "retry" | "skip") {
    setWorking(kind);
    try {
      await settleWorktreeSetup(card, kind, allow, lane, onStart);
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      <Callout
        kind={record.state === "running" ? "info" : "warn"}
        title={words.title}
        text={words.text}
        actions={
          holding ? (
            <>
              <CBtn disabled={busy || working !== null} onClick={() => void settle("retry")}>
                {working === "retry" ? "Setting up…" : allow ? "Allow and run" : "Retry"}
              </CBtn>
              <CBtn tone="quiet" disabled={busy || working !== null} onClick={() => void settle("skip")}>
                Start anyway
              </CBtn>
            </>
          ) : undefined
        }
      />
      {(record.log || problems.length > 0) && (
        <Details summary="Setup output">
          {record.command && <span className="ux-details-line ux-mono-fg">{record.command}</span>}
          {record.log && <pre className="ux-output">{record.log}</pre>}
          {problems.map((line) => (
            <span key={line} className="ux-details-line">
              {line}
            </span>
          ))}
        </Details>
      )}
    </>
  );
}
