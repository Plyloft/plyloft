import { pushErrorToast } from "../lib/errorToast";
import { useEffect, useState } from "react";
import { isChecksHold } from "../lib/checksConsent";
import { useVerify } from "../store/verifyStore";
import {
  verifyRevealLog,
  type KanbanCard,
  type VerifyStepResult,
} from "../ipc";
// GH #102: the failure's summary in the error shape (BOARDS.md §5), and — for
// a run that is not a failure — the same step output and logs on their own.
import { VerifyFailureBlock } from "./errors/VerifyFailureBlock";
import { VerifyStepOutput } from "./errors/VerifyStepLogs";
import { NO_CHECKS_WORD, cardHasNoChecks, checkStepWords, entryHasNoChecks } from "../lib/checksWords";
import { CBtn, Details, StateWord, StatusLine, type RunState } from "./ux";
// Skills hub H5 (R12): the copies Plyloft aligned before these checks ran.
import { twinsAlignedNotes, twinsApartNotes } from "../lib/skillCards";
// QoL 1.168 (C2): the failing checks' output, sent to the card's Builder.
import { askBuilderToFixChecks } from "../store/askBuilderCard";
import { ASK_BUILDER_FIX_CHECKS_LABEL, askBuilderFixChecksTitle } from "../lib/checksFix";
import { fixRoundByItselfNow } from "../store/fixRoundStore";

type Props = {
  card: KanbanCard;
  /** Challenger block 5 (item 6): false while the card's Now box offers
   *  Fix with the Builder — one button, not two. */
  offerFix?: boolean;
};

const STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
};

/** GH #260: the card's checks as a state word, never the raw field. */
const STATUS_WORD: Record<string, { word: string; dot: RunState }> = {
  none: { word: "Not run yet", dot: "empty" },
  queued: { word: "Queued", dot: "running" },
  running: { word: "Running", dot: "running" },
  passed: { word: "Passed", dot: "done" },
  failed: { word: "Failed", dot: "aborted" },
  skipped: { word: "Skipped", dot: "empty" },
  legacy: { word: "Not recorded", dot: "empty" },
};

/**
 * v1.10.x (Phase B): inline verify pipeline view inside CardDetailPanel.
 *
 * Shows the live job state when there's an active verify for this card,
 * the most recent verifyHistory entry's per-step results otherwise.
 *
 * Phase D will extend this with the screenshot gallery + verify-intent.md
 * preview.
 */
export function VerifyPanel({ card, offerFix = true }: Props) {
  const status = useVerify(
    (s) => s.byKey[`${card.workspaceId}::${card.id}`] ?? null,
  );
  const refresh = useVerify((s) => s.refresh);
  const start = useVerify((s) => s.start);
  const bootstrapListeners = useVerify((s) => s.bootstrapListeners);
  const [asking, setAsking] = useState(false);

  // Subscribe to verify events once globally; refresh this card's row
  // on mount so a freshly-attached panel sees the latest cached status.
  useEffect(() => {
    void bootstrapListeners();
    void refresh(card.workspaceId, card.id);
  }, [card.workspaceId, card.id, bootstrapListeners, refresh]);

  const verifyStatus = card.verifyStatus ?? "none";
  const liveState = status?.state.kind ?? null;
  const isInFlight = liveState === "running" || liveState === "queued";

  async function onVerify() {
    try {
      await start({ workspaceId: card.workspaceId, cardId: card.id });
    } catch (e: unknown) {
      console.error("verify start failed", e);
      // 1.176.2 (E1): the press stopped spinning and said nothing.
      pushErrorToast("The checks didn't start", e);
    }
  }

  // Phase B disables Verify when the card is already in flight, was
  // shipped, or is legacy. Failed cards get a "Re-verify" affordance.
  const canStart =
    !isInFlight &&
    verifyStatus !== "queued" &&
    verifyStatus !== "running" &&
    verifyStatus !== "legacy" &&
    card.shipStatus !== "shipped";

  const lastEntry = card.verifyHistory?.[card.verifyHistory.length - 1] ?? null;
  // The live/recent run when the registry has one; after a relaunch, the
  // last recorded run, so a failure's reason and full log stay reachable.
  const runId = status?.verifyRunId ?? lastEntry?.verifyRunId ?? null;
  const steps: VerifyStepResult[] = status
    ? status.steps
    : lastEntry?.status === "failed"
      ? (lastEntry.steps ?? [])
      : [];
  // GH #102: the failure's summary is one block, whether the run that failed
  // is the live one or the last recorded one — so a relaunch still shows the
  // three parts and still reaches the full log.
  //
  // Review 1: gated on the run having **failed**, and never on a step that did
  // not pass. A capacity stall and a timeout both push a `passed: false` step
  // and then finish as something else (`verify.rs`), and a running step can be
  // marked before the run is over; saying `Verify failed.` and "fix what it
  // names" over any of those is a false statement with an instruction on it.
  const runReason =
    status?.state.kind === "failed" ? status.state.reason : (lastEntry?.summary ?? null);
  // 1.175.0 B2: a run held for this Mac's OK ran nothing: not a failure.
  const showFailure =
    (status?.state.kind === "failed" && !isChecksHold(status.state)) || (status == null && lastEntry?.status === "failed");
  // One opener for every surface that shows a log (review 2).
  const openLog = runId
    ? (stepKind: string) => verifyRevealLog(card.workspaceId, card.id, runId, stepKind)
    : null;

  // GH #333: a pass with no checks set up ran nothing — never "Passed".
  // The live run when there is one, the card's last recorded run otherwise.
  const noChecks =
    verifyStatus === "passed" &&
    (status?.state.kind === "passed" ? status.steps.length === 0 : cardHasNoChecks(card));
  const word = noChecks
    ? { word: NO_CHECKS_WORD, dot: "empty" as const }
    : (STATUS_WORD[verifyStatus] ?? { word: verifyStatus, dot: "empty" as const });
  // GH #260: on the one scale — a subheading with the checks' state in a
  // word and one quiet action; the steps as state words.
  return (
    <section className="ux-card-outcome-block" aria-label="Checks">
      <div className="ux-card-challenge-head">
        <h3 className="ux-card-subheading">Checks</h3>
        <StateWord state={word.dot} live={word.dot === "running"}>
          {word.word}
        </StateWord>
        {verifyStatus === "legacy" ? (
          <span className="ux-card-muted-inline">Shipped before Plyloft recorded checks.</span>
        ) : (
          <CBtn
            tone="quiet"
            onClick={onVerify}
            disabled={!canStart}
            title="Run the project's checks against this card's working tree"
            reason={card.shipStatus === "shipped" ? "This card shipped; its checks are done." : null}
          >
            {verifyStatus === "failed" ? "Run the checks again" : "Run the checks"}
          </CBtn>
        )}
        {offerFix && showFailure && card.builder && !card.archived && !card.prReview && card.shipStatus !== "shipped" && (
          <CBtn
            tone="quiet"
            data-ply-ask-builder-fix=""
            disabled={asking}
            title={askBuilderFixChecksTitle(fixRoundByItselfNow(card))}
            onClick={() => {
              setAsking(true);
              void askBuilderToFixChecks(card).finally(() => setAsking(false));
            }}
          >
            {asking ? "Sending…" : ASK_BUILDER_FIX_CHECKS_LABEL}
          </CBtn>
        )}
      </div>

      {/* Skills hub H5 (R12 AC): a skill whose one copy the Builder edited had
          the other brought in line before the checks ran on this tree. */}
      {twinsAlignedNotes(card).map((note) => (
        <StatusLine key={note} state="done">
          {note}
        </StatusLine>
      ))}
      {twinsApartNotes(card).map((note) => (
        <StatusLine key={note} state="empty">
          {note}
        </StatusLine>
      ))}

      {status && (status.state.kind === "queued" || status.state.kind === "running") && (
        <StatusLine state="running">
          {STATE_LABELS[status.state.kind]}
          {/* GH #333: an empty pipeline's step is "no-verify" — no check. */}
          {status.state.kind === "running" && status.state.step && status.state.step !== "no-verify"
            ? ` · ${status.state.step}`
            : null}
          {status.state.kind === "queued" && status.state.position > 0
            ? ` (number ${status.state.position} in line)`
            : null}
        </StatusLine>
      )}

      {/* GH #102 review 1: a timeout has its own words. The per-step reason box
          that used to carry them went with the block, so the run that did not
          finish says so here rather than showing a bare mark. */}
      {status?.state.kind === "timedOut" && (
        <>
          <StatusLine state="aborted">
            The checks timed out: {status.state.step} did not finish in its window. Nothing was
            shipped; run them again when the machine is quieter.
          </StatusLine>
          {/* Review 2: what the steps reported, and their logs, which the
              deleted per-step box used to carry. No error block and no "fix
              what it names": a timeout is not a test that said something. */}
          <VerifyStepOutput steps={steps} onOpenLog={openLog} />
        </>
      )}

      {/* GH #102 (BOARDS.md §5): the summary in the error shape — the title,
          the three parts, and the steps' own output under `Details`, where the
          logs sit. It replaces `Verify failed.` followed by a raw reason, which
          named the mechanism and left the three facts out. */}
      {showFailure && (
        <VerifyFailureBlock steps={steps} reason={runReason} onOpenLog={openLog} />
      )}

      {steps.length > 0 && (
        <ul className="ux-card-ships" aria-label="The checks">
          {steps.map((s, i) => (
            <li key={`${s.kind}-${i}`} className="ux-card-ship">
              <StateWord state={s.passed ? "done" : "aborted"}>
                {/* 1.172.0 D2 (CP-26): its name; the kind is its tooltip. */}
                <span title={s.kind} data-ply-check-kind={s.kind}>{checkStepWords(s.kind)}</span>
              </StateWord>
              <span className="ux-card-muted-inline">{s.passed ? "passed" : "failed"}</span>
              <span className="ux-card-ship-when">{Math.round(s.elapsedMs / 1000)}s</span>
              {/* GH #102: the failing step's own output and `Open full log`
                  moved into the block above, under `Details`. Repeating them
                  per step put two `Open full log` buttons on one card. */}
            </li>
          ))}
        </ul>
      )}

      {!status && lastEntry && steps.length === 0 && (
        <p className="ux-card-muted">
          {entryHasNoChecks(lastEntry)
            ? "No checks are set up for this project, so none ran."
            : `Last run: ${lastEntry.summary ?? lastEntry.status}`}
        </p>
      )}

      {/* v1.12.x (Phase D): Claude-as-QA capacity-stall surface. The
          underlying claude session hit a Max-plan cap; the user retries
          when capacity frees. No fix swarm is auto-spawned. */}
      {status?.state.kind === "capacityStall" && (
        <>
          <StatusLine state="aborted">
            Claude hit its capacity: {status.state.detail}. Run the checks again in a few minutes.
          </StatusLine>
          {/* Review 2: the steps that did run still reported something, and
              their logs are still there. */}
          <VerifyStepOutput steps={steps} onOpenLog={openLog} />
        </>
      )}

      {/* v1.12.x (Phase D): verify-intent is populated by the swarm
          builder before declaring complete. It documents what the
          claude-qa step should check. */}
      {card.verifyIntent && (
        <Details summary="What the checks look for">{card.verifyIntent}</Details>
      )}
    </section>
  );
}
