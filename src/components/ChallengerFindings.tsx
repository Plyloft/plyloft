import { useEffect, useRef, useState } from "react";
import { reviewFindingDismiss, type BuilderReview, type KanbanCard, type LedgerFinding, type ReviewFinding } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { findingFocusLive, useUi } from "../store/uiStore";
import {
  findingCardDraft,
  findingLine,
  findingsBySeverity,
  findingsMarkdown,
  DISMISS_REASON_MAX_CHARS,
  ledgerFindingMark,
  ledgerLine,
  ledgerOfIds,
  ledgerSections,
  ledgerStateLine,
  reviewBaseWords,
  skillsFollowedOf,
  severityWord,
} from "../lib/challengerReview";
import { draftFromFinding, offersChecklistClass } from "../lib/reviewChecklist";
import { openP1Findings } from "../lib/attention";
import { pushToast } from "../store/toastStore";
import { Callout, CBtn, Details, Icon, TextField } from "./ux";
import { revealAncestors } from "./FindingAnchors";
import { InlineMd } from "./InlineMd";
import { GlossaryText } from "./GlossaryText";
import { smallNotesWords } from "../lib/deliveryWords";
import { pushErrorToast } from "../lib/errorToast";

/**
 * ADR 0006: the Challenger's findings under its verdict. The blocking ones
 * (P1, P2) are listed by severity; the risk checklist and the non-blocking
 * ones (P3, pre-existing) are collapsed. A pre-existing finding is in code
 * this card did not write: `Make a card` turns it into a card of its own.
 *
 * Once the card has a findings ledger (follow-up reviews), the ledger is
 * shown instead: open findings first with their ids and the round that
 * raised them, closed ones collapsed.
 *
 * GH #260: on the one scale — a count in words over each group, each
 * finding a disclosure with its body, the rest behind Details.
 */
export function ChallengerFindings({
  card,
  review,
}: {
  card: KanbanCard;
  review: BuilderReview;
}) {
  const findings = review.findings ?? [];
  const nonBlocking = review.nonBlocking ?? [];
  const checklist = review.checklist ?? [];
  const ledger = review.ledger ?? [];
  // Review integrity: the reviewed range's base wasn't checked against
  // origin's real tip, or a local ref ahead of origin was not used.
  // QoL 14.2 (G27): the findings, as Markdown, for a teammate. Nothing is
  // posted to GitHub.
  const hasAny = ledger.length > 0 || findings.length > 0 || nonBlocking.length > 0;
  const followed = (
    <>
      {hasAny && <CopyFindings title={card.title} review={review} />}
      {review.baseNote && (
        <div data-ply-review-base-note="">
          <p className="ux-card-muted">{reviewBaseWords(review.baseNote)}</p>
          <Details>{review.baseNote}</Details>
        </div>
      )}
      <FollowedSkills review={review} />
    </>
  );
  if (ledger.length > 0) {
    return (
      <>
        {followed}
        <LedgerView card={card} review={review} ledger={ledger} checklist={checklist} />
      </>
    );
  }
  if (findings.length === 0 && nonBlocking.length === 0 && checklist.length === 0) {
    return followed;
  }
  const groups = findingsBySeverity(findings);
  return (
    <div className="ux-card-outcome-block" data-ply-review-kind={review.kind ?? "review"}>
      {followed}
      {groups.map((group) => (
        <div key={group.severity} className="ux-card-outcome-block">
          <p className="ux-card-challenge-count">
            {severityWord(group.severity)} · {group.findings.length} finding{group.findings.length === 1 ? "" : "s"}
          </p>
          <ul className="ux-card-findings">
            {group.findings.map((finding, i) => (
              <FindingItem key={`${group.severity}-${i}`} finding={finding} />
            ))}
          </ul>
        </div>
      ))}
      {checklist.length > 0 && (
        <Details summary={`Risk checklist (${checklist.length} line${checklist.length === 1 ? "" : "s"})`}>
          <ul className="ux-card-checklist">
            {checklist.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Details>
      )}
      {nonBlocking.length > 0 && (
        <Details
          summary={`${smallNotesWords(nonBlocking.length)} · nothing to do — not sent to the Builder as changes`}
        >
          <ul className="ux-card-findings ux-card-outcome-body">
            {nonBlocking.map((finding, i) => (
              <FindingItem key={`nb-${i}`} finding={finding} card={card} review={review} />
            ))}
          </ul>
        </Details>
      )}
    </div>
  );
}

/** QoL 14.2 (G27): "Copy findings" puts the review's findings on the
 *  clipboard as Markdown (`findingsMarkdown`). */
function CopyFindings({ title, review }: { title: string; review: BuilderReview }) {
  return (
    <div className="ux-card-copy-findings">
      <CBtn
        size="sm"
        tone="quiet"
        data-ply-copy-findings=""
        title="Copy the findings as Markdown, to paste for a teammate. Nothing is posted to GitHub."
        onClick={() => {
          navigator.clipboard
            .writeText(findingsMarkdown(title, review))
            .then(() => pushToast({ kind: "info", title: "Findings copied", body: "Paste them where your team talks." }))
            .catch((e: unknown) => pushErrorToast("Couldn't copy the findings", e));
        }}
      >
        Copy findings
      </CBtn>
    </div>
  );
}

/**
 * CL-3: a review that asks for changes with a P1 open names the most serious
 * finding first, above the rest, as a "serious issue" (the P1 tag stays in
 * the findings list). Words and weight only: an info callout (no red, no
 * amber), and no notification.
 */
export function SeriousCatch({
  review,
  fromLastReview = false,
}: {
  review: BuilderReview;
  /** Commits came after the review: its open findings still stand, said as
   *  the last review's (the Inbox counts the same ones). */
  fromLastReview?: boolean;
}) {
  const serious = openP1Findings(review);
  if (serious.length === 0) return null;
  const [first] = serious;
  const more = serious.length - 1;
  const text = [
    first.location,
    more > 0 ? `${more} more serious issue${more === 1 ? "" : "s"} below` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = `${fromLastReview ? "From the last review · " : ""}Serious issue · ${first.title}`;
  return (
    <div data-ply-serious-catch="">
      <Callout kind="info" title={title} text={text || undefined} />
    </div>
  );
}

/**
 * CL-2: the skills the Challenger followed (GH #216), as neutral chips — a
 * fact about the review, never a run state. What each skill asked of the
 * review is behind Details.
 */
export function FollowedSkills({ review }: { review: BuilderReview }) {
  const skills = skillsFollowedOf(review);
  if (skills.length === 0) return null;
  const notes = skills.filter((entry) => entry.note.trim() !== "");
  return (
    <div className="ux-card-followed" data-ply-followed="">
      <p className="ux-card-followed-chips">
        <span className="ux-card-muted-inline">Followed</span>
        {skills.map((entry) => (
          <span key={entry.skill} className="cchip cchip--outline" title={entry.skill}>
            {entry.skill}
          </span>
        ))}
      </p>
      {notes.length > 0 && (
        <Details summary={notes.length === 1 ? "What the skill asked" : "What the skills asked"}>
          <dl className="ux-card-followed-notes">
            {notes.map((entry) => (
              <div key={entry.skill}>
                <dt>{entry.skill}</dt>
                <dd>{entry.note}</dd>
              </div>
            ))}
          </dl>
        </Details>
      )}
    </div>
  );
}

function LedgerView({
  card,
  review,
  ledger,
  checklist,
}: {
  card: KanbanCard;
  review: BuilderReview;
  ledger: LedgerFinding[];
  checklist: string[];
}) {
  // CL-5: a round's "See its findings" in Activity narrows the list to that
  // round, while this is still the review it was pressed on.
  const filter = useUi((s) => s.reviewRoundFilter[card.id] ?? null);
  const setReviewRoundFilter = useUi((s) => s.setReviewRoundFilter);
  const active = filter && filter.reviewId === (review.reviewId ?? null) ? filter : null;
  const round = active?.round ?? null;
  const { open, closed, dismissed } = ledgerSections(active ? ledgerOfIds(ledger, active.ids) : ledger);
  // CL-6: the review diff offers "Show in the findings list" while this
  // list is on screen; asked for a finding the round's view hides, the
  // whole list comes back so it can be shown.
  const countFindingList = useUi((s) => s.countFindingList);
  useEffect(() => {
    countFindingList(card.id, 1);
    return () => countFindingList(card.id, -1);
  }, [card.id, countFindingList]);
  const focus = useUi((s) => s.findingFocus);
  const listed = [...open, ...closed, ...dismissed].some((finding) => finding.id === focus?.findingId);
  const focusFinding = useUi((s) => s.focusFinding);
  const inLedger = ledger.some((finding) => finding.id === focus?.findingId);
  useEffect(() => {
    // Round 3: only a list whose ledger holds the finding answers the ask;
    // another list of the card leaves it to that one.
    if (!findingFocusLive(focus) || focus.to !== "list" || focus.cardId !== card.id || !inLedger) return;
    if (!listed && active) {
      setReviewRoundFilter(card.id, null);
      return;
    }
    // Round 2 (F6): an ask for one of its findings that nothing took after
    // one pass is dropped, so it can't steal the focus later.
    const timer = setTimeout(() => {
      if (useUi.getState().findingFocus === focus) focusFinding(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focus, listed, active, inLedger, card.id, setReviewRoundFilter, focusFinding]);
  return (
    <div className="ux-card-outcome-block" data-ply-review-kind={review.kind ?? "review"} data-ply-ledger="">
      {round != null && (
        <p className="ux-card-muted" data-ply-ledger-round={round}>
          <GlossaryText
            text={
              open.length + closed.length + dismissed.length === 0
                ? `No finding of round ${round} is kept any more. `
                : `Findings of round ${round}: raised, closed or still open in it. `
            }
            words={["round"]}
          />
          <CBtn tone="quiet" size="sm" onClick={() => setReviewRoundFilter(card.id, null)}>
            Show all findings
          </CBtn>
        </p>
      )}
      {review.followUpFallback && (
        <p className="ux-card-muted" data-ply-follow-up-fallback="">
          This review ran as a sweep, not a follow-up: {review.followUpFallback}
        </p>
      )}
      {review.ledgerNote && <p className="ux-card-muted">{review.ledgerNote}</p>}
      <div className="ux-card-outcome-block">
        <p className="ux-card-challenge-count">
          {open.length === 0
            ? "No finding is open"
            : `${open.length} open finding${open.length === 1 ? "" : "s"}`}
        </p>
        {open.length > 0 && (
          <ul className="ux-card-findings">
            {open.map((finding) => (
              <LedgerItem key={finding.id} finding={finding} card={card} review={review} />
            ))}
          </ul>
        )}
      </div>
      {dismissed.length > 0 && (
        <Details summary={`${dismissed.length} dismissed as not a real issue`}>
          <ul className="ux-card-findings ux-card-outcome-body">
            {dismissed.map((finding) => (
              <LedgerItem key={finding.id} finding={finding} card={card} />
            ))}
          </ul>
        </Details>
      )}
      {closed.length > 0 && (
        <Details summary={`${closed.length} closed finding${closed.length === 1 ? "" : "s"}`}>
          <ul className="ux-card-findings ux-card-outcome-body">
            {closed.map((finding) => (
              <LedgerItem key={finding.id} finding={finding} card={card} />
            ))}
          </ul>
        </Details>
      )}
      {checklist.length > 0 && (
        <Details
          summary={`Risk checklist of the last review (${checklist.length} line${checklist.length === 1 ? "" : "s"})`}
        >
          <ul className="ux-card-checklist">
            {checklist.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Details>
      )}
    </div>
  );
}

function LedgerItem({
  finding,
  card,
  review,
}: {
  finding: LedgerFinding;
  card?: KanbanCard;
  review?: BuilderReview;
}) {
  const mark = ledgerFindingMark(finding);
  // CL-6: to and from the same finding on the review diff.
  const cardId = card?.id ?? null;
  const onDiff = useUi((s) => (cardId ? (s.diffAnchorIds[cardId] ?? []).includes(finding.id) : false));
  const focus = useUi((s) => s.findingFocus);
  const focusFinding = useUi((s) => s.focusFinding);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!findingFocusLive(focus) || focus.to !== "list" || focus.cardId !== cardId || focus.findingId !== finding.id) return;
    focusFinding(null);
    const details = detailsRef.current;
    if (details) {
      details.open = true;
      revealAncestors(details);
      details.scrollIntoView?.({ block: "center" });
    }
    summaryRef.current?.focus();
  }, [focus, focusFinding, cardId, finding.id]);
  return (
    <li className="ux-card-finding" data-ply-finding-id={finding.id} data-ply-finding-state={finding.state}>
      <details className="ux-card-finding-details" ref={detailsRef}>
        <summary className="ux-card-finding-summary" ref={summaryRef}>
          <Icon name="expand" size="sm" />
          <span>
            <InlineMd text={ledgerLine(finding)} links={false} />
            {mark ? ` · ${mark}` : ""}
          </span>
        </summary>
        <p className="ux-card-muted">{ledgerStateLine(finding)}</p>
        <p className="ux-card-critique">
          <InlineMd text={finding.body} />
        </p>
      </details>
      {cardId && onDiff && (
        <CBtn
          tone="quiet"
          size="sm"
          aria-label={`Show ${finding.id} in the changes`}
          onClick={() => focusFinding({ cardId, findingId: finding.id, to: "diff" })}
        >
          Show in the changes
        </CBtn>
      )}
      {card && review && finding.state !== "closed" && !finding.dismissal && (
        <DismissFinding finding={finding} card={card} />
      )}
      {card && offersChecklistClass(finding) && (
        <AddChecklistClassButton finding={finding} card={card} />
      )}
      {finding.state !== "closed" && finding.preExisting && card && review && (
        <MakeCardButton
          finding={{
            severity: finding.severity,
            title: finding.title,
            body: finding.body,
            preExisting: true,
            pass: null,
            id: finding.id,
          }}
          card={card}
          review={review}
        />
      )}
    </li>
  );
}

/** Findings filter: "Not a real issue" on an open finding. The member may
 *  say why in one line; the finding stays on the card as dismissed, no
 *  longer blocks, and the next review is told so. */
function DismissFinding({ finding, card }: { finding: LedgerFinding; card: KanbanCard }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    setBusy(true);
    try {
      await reviewFindingDismiss(card.workspaceId, card.id, finding.id, reason.trim() || null);
      setAsking(false);
    } catch (e) {
      pushErrorToast(`Couldn't dismiss ${finding.id}`, e);
    } finally {
      setBusy(false);
    }
  };
  if (!asking) {
    return (
      <CBtn
        tone="quiet"
        size="sm"
        aria-label={`${finding.id} is not a real issue`}
        title="Dismiss this finding: it stays on the card as dismissed, no longer blocks approval, and the next review is told not to raise it again."
        onClick={() => setAsking(true)}
      >
        Not a real issue
      </CBtn>
    );
  }
  return (
    <span className="ux-card-finding-dismiss" data-ply-dismiss={finding.id}>
      <TextField
        value={reason}
        onChange={(next) => setReason(next.slice(0, DISMISS_REASON_MAX_CHARS))}
        onEnter={() => void dismiss()}
        onCancel={() => setAsking(false)}
        label={`Why ${finding.id} is not a real issue (optional)`}
        placeholder="Why it is not a real issue (optional)"
        disabled={busy}
        autoFocus
      />
      <CBtn tone="strong" size="sm" disabled={busy} onClick={() => void dismiss()}>
        {busy ? "Dismissing…" : `Dismiss ${finding.id}`}
      </CBtn>
      <CBtn tone="quiet" size="sm" disabled={busy} onClick={() => setAsking(false)}>
        Keep it
      </CBtn>
    </span>
  );
}

/** ADR 0006 (third card): a follow-up found this in code the sweep had
 *  read — the checklist may lack its class. Opens Settings › Build &
 *  release with a class drafted from the finding; nothing is added until
 *  the person presses Save there. */
function AddChecklistClassButton({ finding, card }: { finding: LedgerFinding; card: KanbanCard }) {
  const openChecklistDraft = useUi((s) => s.openChecklistDraft);
  return (
    <CBtn
      tone="quiet"
      title="The follow-up review found this in code the sweep had read. Open the repository's checklist with a class drafted from it; nothing is added until you press Save."
      onClick={() =>
        openChecklistDraft({
          workspaceId: card.workspaceId,
          findingId: finding.id,
          ...draftFromFinding(finding),
        })
      }
    >
      Add a checklist class
    </CBtn>
  );
}

function FindingItem({
  finding,
  card,
  review,
}: {
  finding: ReviewFinding;
  card?: KanbanCard;
  review?: BuilderReview;
}) {
  return (
    <li className="ux-card-finding">
      <details className="ux-card-finding-details">
        <summary className="ux-card-finding-summary">
          <Icon name="expand" size="sm" />
          <span>
            <InlineMd text={findingLine(finding)} links={false} />
          </span>
        </summary>
        <p className="ux-card-critique">
          <InlineMd text={finding.body} />
        </p>
      </details>
      {finding.preExisting && card && review && (
        <MakeCardButton finding={finding} card={card} review={review} />
      )}
    </li>
  );
}

function MakeCardButton({
  finding,
  card,
  review,
}: {
  finding: ReviewFinding;
  card: KanbanCard;
  review: BuilderReview;
}) {
  const addCard = useKanban((s) => s.addCard);
  const selectCard = useUi((s) => s.selectCard);
  const [busy, setBusy] = useState(false);
  return (
    <CBtn
      tone="quiet"
      disabled={busy}
      title="A new card with this finding as its brief. It opens so you can edit it before building."
      onClick={async () => {
        setBusy(true);
        try {
          const draft = findingCardDraft(finding, {
            cardTitle: card.title,
            snapshotN: review.snapshotN,
          });
          const created = await addCard(card.workspaceId, draft.title, draft.notes, "todo");
          selectCard(card.workspaceId, created.id);
        } catch {
          // addCard already toasts and rolls back.
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Making…" : "Make a card"}
    </CBtn>
  );
}
