import { useEffect, useState } from "react";
import {
  cardPrPushUpdate,
  openWebLink,
  prReviewMergeHead,
  prReviewRefresh,
  prReviewStart,
  type KanbanCard,
} from "../ipc";
import { CBtn, Callout, Details, ErrorBlock, MoreMenu, type RunState } from "./ux";
import { plainError, prPushError, prReadError, prSessionStillOpenError } from "../lib/plainError";
import type { UxError } from "../lib/uxError";
import { ChallengerFindings } from "./ChallengerFindings";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { CardReviewPanel } from "./CardReviewPanel";
import { useBuilder } from "../store/builderStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { pushToast } from "../store/toastStore";
import { reviewMetTrustQuestion } from "../lib/claudeReviewTrust";
import { cardHasNoChecks } from "../lib/checksWords";
import { confirmSheet } from "../store/confirmStore";
import { showPlanRefusal } from "../store/planPrompts";
import { isWorktreeSetupFailure, setupHold } from "../lib/worktreeSetup";
import { SEND_FIXES_LABEL } from "../lib/deliveryWords";
import { WorktreeSetupNote } from "./BuilderRunStep";
import {
  challengerName,
  currentReview,
  fixOffered,
  mergeOffered,
  mergeConflictsAgain,
  mergedNotBuilt,
  prLine,
  sameVendorReview,
  prReviewLabel,
  pushOffered,
  reviewOffer,
  reviewPressLabel,
  reviewSentence,
  unpushedFix,
} from "../lib/prReview";
import { linkDidNotOpen } from "../lib/linkToast";
import { PUSH_STILL_RUNNING, pressOnce, prPushPressKey, sayStillRunning } from "../lib/pressOnce";
import { pushErrorToast } from "../lib/errorToast";

/** The fix's checks, in words, before Push the fixes. */
function checksWords(card: KanbanCard): string | null {
  switch (card.verifyStatus) {
    case "passed":
      // Walk 2 of #386: a pass with no steps ran nothing (GH #333).
      return cardHasNoChecks(card) ? "No checks are set up for this project, so none ran on the fix." : "The fix's checks passed.";
    case "skipped":
      return "The fix's checks were skipped.";
    case "failed":
      return "The fix's checks failed — the Builder fixes them, then Finish and check again.";
    case "queued":
    case "running":
      return "The fix's checks are running.";
    default:
      return null;
  }
}

/** Walk 2 of #386 (finding 1): why Send the fixes to GitHub waits while the Builder's
 *  session is open — the backend's own refusal (`PUSH_WHILE_BUILDING`). */
export const PUSH_WAITS_FOR_SESSION =
  "Send the fixes to GitHub waits while the Builder's session is open: it could still change the branch. Close the session (press Finish and check first if the Builder changed anything since), then send them.";

/** Walk 3 of #386 (finding 3): why Bring in the new commits waits while the
 *  Builder's session is open — the backend refuses it then too. */
export const MERGE_WAITS_FOR_SESSION =
  "Bring in the new commits waits while the Builder's session is open: it could still change the branch. Close the session (press Finish and check first if the Builder changed anything since), or ask the Builder to merge the pull request's new commits itself.";

/** Walk 3 of #386 (finding 6): the last Bring in the new commits conflicted
 *  and neither the head nor the fix changed — the Builder resolves it. */
export function mergeConflictWords(head: string): string {
  return `Bring in the new commits would conflict again. Resume the Builder and ask it to merge ${head.slice(0, 12)} and resolve the conflict, then press Finish and check.`;
}

/**
 * Challenger on a pull request: the card page's Now for a card that reviews
 * a pull request — which pull request, what the Challenger said of its
 * current head, its findings (with "Not a real issue" and, with the diff
 * open, "Show on the diff"), the read-only diff, and the presses: Review /
 * Review again, Check GitHub, and — on the member's own pull request only —
 * Fix with the Builder, Bring in the new commits and Push the fixes (with
 * the fix's diff and checks first). Nothing here posts to GitHub.
 */
export function PrReviewPanel(props: {
  card: KanbanCard;
  /** Shows the Builder's session (the card page's run section). */
  onOpenSession: () => void;
}) {
  // Walk 3 of #386 (finding 2): what the last press couldn't do, and the
  // press under way, are this card's — another card's page starts afresh.
  return <PrReviewPanelOf key={props.card.id} {...props} />;
}

function PrReviewPanelOf({
  card,
  onOpenSession,
}: {
  card: KanbanCard;
  onOpenSession: () => void;
}) {
  const pr = card.prReview;
  const ws = card.workspaceId;
  const [busy, setBusy] = useState<string | null>(null);
  // What the last press couldn't do, in the backend's own plain words.
  // QoL 1.168 block 8 (A5): the error shape — plain words, the raw text
  // behind Details.
  const [failure, setFailure] = useState<UxError | null>(null);
  const diffOpen = useUi((s) => s.cardDiffOpen[card.id] ?? false);
  const startBuilder = useBuilder((s) => s.start);
  const resumeBuilder = useBuilder((s) => s.resume);
  const reload = () => useKanban.getState().loadFromDisk(ws, true);

  // The card page's open reads the pull request again (the poller does
  // between visits). A failed read is kept on the card and shown below.
  const open = pr?.state === "open";
  useEffect(() => {
    if (!open) return;
    void prReviewRefresh(ws, card.id)
      .then(() => reload())
      .catch(() => reload());
    // Once per opened card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, card.id, open]);

  if (!pr) return null;
  const offer = reviewOffer(card);
  const press = reviewPressLabel(offer, card);
  const label = prReviewLabel(card) ?? "";
  const review = currentReview(card) ?? card.builder?.review ?? null;
  const live = Boolean(card.builder?.ptyId);
  const merge = mergeOffered(card);
  // Walk 2 of #386 (finding 1): with the Builder's session open the push
  // is shown, disabled, with why and the way to close the session.
  const push = pushOffered(card);
  const pushWaits = push && live;
  const fix = fixOffered(card);
  const notBuilt = mergedNotBuilt(card);
  const sessionBefore = (card.builder?.startedAt ?? 0) > 0;
  // Walk 3 of #386 (finding 3): with the session open, Bring in the new
  // commits says why it waits, on the page, as Push the fixes does.
  const mergeWaits = merge && live;
  // Finding 6: after a conflict the same merge would conflict again; the
  // Builder resolves it (Resume the Builder) until the head or the fix moves.
  const conflictAgain = merge && !live && mergeConflictsAgain(card);
  const resumeFirst = fix && sessionBefore && (notBuilt || conflictAgain);
  // Walk of #386 (step 7): the first Fix with the Builder runs the
  // workspace's setup; one that failed or waits for this Mac's OK holds the
  // Builder, and its Allow and run / Retry / Start anyway are here — the
  // card's Now — as a normal card's Now box has them.
  const hold = fix ? setupHold(card.worktreeSetup) : null;
  // Changes asked on the member's own pull request: fixing is the next step.
  const fixFirst = fix && !press && !push && !merge && review?.verdict === "changes_requested";
  const who = challengerName(card);
  const dot: RunState =
    offer === "running"
      ? "running"
      : offer === "closed"
        ? "done"
        : review?.verdict === "changes_requested" || review?.status === "failed"
          ? "aborted"
          : "empty";

  async function run(what: string, act: () => Promise<unknown>, failed: string) {
    setBusy(what);
    setFailure(null);
    try {
      await act();
      await reload();
    } catch (e) {
      setFailure(plainError(failed, e));
      await reload();
    } finally {
      setBusy(null);
    }
  }

  /** Fix with the Builder (and the setup note's start once it no longer
   *  holds): a start the card's setup refused is said by the note itself. */
  async function startFix() {
    setBusy("fix");
    setFailure(null);
    try {
      await startBuilder(ws, card.id);
      onOpenSession();
    } catch (e) {
      if (!isWorktreeSetupFailure(e)) setFailure(plainError("The Builder didn't start", e));
    } finally {
      await reload();
      setBusy(null);
    }
  }

  /** Resume the Builder: walk 4 of #386 (finding 2) — the backend asks the
   *  Free slot as Fix with the Builder does, and its refusal opens the same
   *  Free sheet; anything else is said here. */
  async function resumeFix() {
    setBusy("resume");
    setFailure(null);
    try {
      await resumeBuilder(ws, card.id);
      onOpenSession();
    } catch (e) {
      if (!showPlanRefusal(e)) setFailure(plainError("The Builder didn't resume", e));
    } finally {
      await reload();
      setBusy(null);
    }
  }

  async function closeSession() {
    const ok = await confirmSheet({
      title: "Close the Builder session?",
      body: `The card's copy of the repository and its commits stay. ${SEND_FIXES_LABEL} is offered once it is closed.`,
      confirmLabel: "Close session",
    });
    if (!ok) return;
    setBusy("close");
    try {
      await useBuilder.getState().close(ws, card.id);
    } finally {
      await reload();
      setBusy(null);
    }
  }

  // 1.176.2 F2: one push of the fix at a time, taken before the first await.
  function pushFixes() {
    return pressOnce(prPushPressKey(ws, card.id), pushFixesNow, sayStillRunning(PUSH_STILL_RUNNING));
  }
  async function pushFixesNow() {
    setBusy("push");
    setFailure(null);
    try {
      const result = await cardPrPushUpdate(ws, card.id);
      await reload();
      if (result.pushed) {
        pushToast({ kind: "info", title: `Pushed to pull request #${pr!.number}`, body: "Its branch on GitHub has the fix now." });
      } else {
        setFailure(prPushError(result.refused ?? null));
      }
    } catch (e) {
      setFailure(prPushError(null, e));
    } finally {
      setBusy(null);
    }
  }

  /** QoL 14.3 (C20): Close the session and push the fixes, in one press —
   *  one confirm, then the same scoped push (`card_pr_push_update`) with all
   *  its safeguards; a refusal is said as Push the fixes' is. */
  async function closeAndPush() {
    const ok = await confirmSheet({
      title: "Close the Builder session and push the fixes?",
      body: `The session closes; the card's copy and its commits stay. Then the checked, reviewed fix is pushed to ${pr!.headRef}, never forced. If the Builder changed anything since the last Finish and check, press Finish and check first.`,
      confirmLabel: "Close and push",
    });
    if (!ok) return;
    setBusy("push");
    setFailure(null);
    const notClosed = () => {
      setFailure(prSessionStillOpenError());
      setBusy(null);
    };
    try {
      await useBuilder.getState().close(ws, card.id);
      await reload();
    } catch (e) {
      pushErrorToast("The session didn't close", e);
      await reload();
      notClosed();
      return;
    }
    // Only a session that is really gone lets the push go (the backend
    // refuses it too, but in its own words).
    const now = useKanban.getState().byWorkspace[ws]?.cards.find((c) => c.id === card.id);
    if (now?.builder?.ptyId) {
      notClosed();
      return;
    }
    await pushFixes();
  }

  // QoL 14.3 (C20): every press this state offers, in the order they
  // matter. The first that is the way forward (and can be pressed now) is
  // the one button; the rest are under ⋯, with why a waiting one waits.
  type Press = {
    key: string;
    label: string;
    forward: boolean;
    /** Off for a reason of the state (not just another press under way):
     *  never the one button. */
    waits?: boolean;
    disabled?: boolean;
    title?: string;
    data?: string;
    act: () => void;
  };
  const presses: Press[] = [];
  if (resumeFirst) {
    presses.push({ key: "resume", label: "Resume the Builder", forward: true, disabled: busy !== null, act: () => void resumeFix() });
  }
  if (merge) {
    presses.push({
      key: "merge",
      label: busy === "merge" ? "Bringing them in…" : "Bring in the new commits",
      forward: !(mergeWaits || conflictAgain),
      waits: mergeWaits || conflictAgain,
      disabled: busy !== null || mergeWaits || conflictAgain,
      title: mergeWaits
        ? MERGE_WAITS_FOR_SESSION
        : conflictAgain
          ? mergeConflictWords(pr.headSha)
          : "Merge the pull request's new commits into the card's branch, under your fix.",
      data: "data-ply-pr-merge",
      // Built as Build done would; its Verify starts in the backend.
      act: () => void run("merge", () => prReviewMergeHead(ws, card.id), "The new commits weren't brought in"),
    });
  }
  if (press) {
    presses.push({
      key: "review",
      label: busy === "review" ? "Starting…" : press,
      forward: true,
      disabled: busy !== null,
      data: "data-ply-pr-review-press",
      act: () => void run("review", () => prReviewStart(ws, card.id), "The review didn't start"),
    });
  }
  if (push && pushWaits && !mergeWaits) {
    presses.push({
      key: "close-push",
      label: busy === "push" ? "Sending…" : busy === "close" ? "Closing…" : "Close the session and send the fixes to GitHub",
      forward: true,
      disabled: busy !== null,
      title: PUSH_WAITS_FOR_SESSION,
      data: "data-ply-pr-close-push",
      act: () => void closeAndPush(),
    });
  }
  if (push) {
    presses.push({
      key: "push",
      // 1.171.0 B3 (CP-17, DL-18): the same label on both card kinds; the
      // command is `card_pr_push_update`, as before.
      label: busy === "push" ? "Sending…" : SEND_FIXES_LABEL,
      forward: !(press || merge || pushWaits),
      waits: pushWaits,
      disabled: busy !== null || pushWaits,
      title: pushWaits ? PUSH_WAITS_FOR_SESSION : undefined,
      data: "data-ply-pr-push",
      act: () => void pushFixes(),
    });
  }
  if (pushWaits || mergeWaits) {
    presses.push({
      key: "close",
      label: busy === "close" ? "Closing…" : "Close the Builder session",
      forward: mergeWaits,
      disabled: busy !== null,
      act: () => void closeSession(),
    });
  }
  if (fix && !resumeFirst && hold === null) {
    presses.push({
      key: "fix",
      label: "Fix with the Builder",
      forward: fixFirst || notBuilt,
      waits: offer === "running",
      disabled: busy !== null || offer === "running",
      title: `The Builder fixes what the Reviewer found, on this card's copy of your branch; the Reviewer (${who}) reviews the fix. ${SEND_FIXES_LABEL} sends it to the pull request.`,
      act: () => void startFix(),
    });
  }
  if (live) presses.push({ key: "session", label: "Open the Builder's session", forward: false, act: onOpenSession });
  if (card.worktreePath) {
    presses.push({
      key: "diff",
      label: diffOpen ? "Hide the changes" : "See the changes",
      forward: false,
      act: () => (diffOpen ? useUi.getState().closeCardDiff(card.id) : useUi.getState().openCardDiff(card.id)),
    });
  }
  if (open) {
    presses.push({
      key: "check",
      label: busy === "check" ? "Checking…" : "Check GitHub",
      forward: false,
      disabled: busy !== null,
      act: () => void run("check", () => prReviewRefresh(ws, card.id), "Plyloft couldn't read the pull request"),
    });
  }
  presses.push({
    key: "github",
    label: "Open on GitHub",
    forward: false,
    act: () =>
      void openWebLink(pr.url).catch((e: unknown) =>
        pushToast(linkDidNotOpen(pr.url, e)),
      ),
  });
  // Another press under way keeps the one button where it is, disabled.
  // Walk of lane 2 (step 14): with nothing to do here (approved, merged,
  // closed), the way forward is the pull request on GitHub.
  const primary =
    presses.find((p) => p.forward && !p.waits) ??
    (presses.some((p) => p.forward) ? null : (presses.find((p) => p.key === "github") ?? null));
  const rest = presses.filter((p) => p !== primary);
  const actions = (
    <>
      {primary && (
        <CBtn
          tone="accent"
          title={primary.title}
          disabled={primary.disabled}
          onClick={primary.act}
          data-ply-pr-primary={primary.key}
          {...(primary.data ? { [primary.data]: "" } : {})}
        >
          {primary.label}
        </CBtn>
      )}
      <MoreMenu
        label="More for this review"
        items={rest.map((p) => ({
          label: p.label,
          onSelect: p.act,
          disabled: p.disabled,
          hint: p.disabled ? p.title : undefined,
        }))}
      />
    </>
  );

  const checks = pr.pushable && unpushedFix(card) ? checksWords(card) : null;

  return (
    <section className="ux-card-section ux-card-pr-review" aria-label="Pull request review" data-ply-pr-review={offer ?? ""}>
      <Callout kind="now" state={dot} live={offer === "running"} title={label} text={reviewSentence(card)} actions={actions} />
      <p className="ux-card-muted" data-ply-pr-review-line="">
        Pull request {prLine(pr)}
        {pr.title ? ` · ${pr.title}` : ""} · Reviewer: {who}
      </p>
      {!pr.pushable && pr.fixNote && <p className="ux-card-muted">{pr.fixNote}</p>}
      {pr.pushable && pr.state === "open" && (push || unpushedFix(card)) && (
        <p className="ux-card-muted" data-ply-pr-push-words="">
          This is your pull request: Fix with the Builder works on this card's copy of its branch, and {SEND_FIXES_LABEL}{" "}
          sends the checked, reviewed fix to {pr.headRef} — only while nobody has pushed to it on GitHub since the fix started. Never
          forced.
        </p>
      )}
      {/* Walk of lane 2 (step 14): nothing unpushed — no push words; the
          Fix sentence only beside its button (under ⋯ it has its title). */}
      {pr.pushable && pr.state === "open" && !(push || unpushedFix(card)) && primary?.key === "fix" && (
        <p className="ux-card-muted" data-ply-pr-fix-words="">
          This is your pull request: Fix with the Builder works on this card's copy of its branch.
        </p>
      )}
      {checks && <p className="ux-card-muted" data-ply-pr-fix-checks="">{checks}</p>}
      {pushWaits && (
        <p className="ux-card-muted" data-ply-pr-push-waits="">
          {PUSH_WAITS_FOR_SESSION}
        </p>
      )}
      {mergeWaits && (
        <p className="ux-card-muted" data-ply-pr-merge-waits="">
          {MERGE_WAITS_FOR_SESSION}
        </p>
      )}
      {conflictAgain && (
        <p className="ux-card-muted" data-ply-pr-merge-conflict="">
          {mergeConflictWords(pr.headSha)}
        </p>
      )}
      {sameVendorReview(card) && (
        <p className="ux-card-muted" data-ply-pr-same-vendor="">
          {`The Builder and the Reviewer are both ${who}: the fix's review isn't by the other AI.`}
        </p>
      )}
      {hold && card.worktreeSetup && (
        <div data-ply-pr-fix-setup={hold}>
          <WorktreeSetupNote card={card} busy={busy !== null} onStart={startFix} />
        </div>
      )}
      {failure && <ErrorBlock error={failure} density="dense" />}
      {pr.readError && (
        <ErrorBlock
          density="dense"
          error={prReadError(pr.readError)}
        />
      )}
      {reviewMetTrustQuestion(card.builder?.review) && (
        <ClaudeReviewTrustStep refused workspaceId={ws} density="dense" />
      )}
      {review?.status === "done" && <ChallengerFindings card={card} review={review} />}
      {review?.status === "done" && review.excerpt && (
        <Details summary="The Reviewer's words">
          <p className="ux-card-plain">{review.excerpt}</p>
        </Details>
      )}
      {diffOpen && card.worktreePath && (
        <div className="ux-card-outcome-body" data-ply-pr-review-diff="">
          <CardReviewPanel workspaceId={ws} card={card} openPrNumber={pr.number} />
        </div>
      )}
    </section>
  );
}
