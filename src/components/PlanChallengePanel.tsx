import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { discussionBlocker, singleInstalled, vendorReadiness } from "../lib/vendorReadiness";
import { useDoctor } from "../store/doctorStore";
import {
  cardBriefText,
  cardPlanChallengeClear,
  cardPlanChallengeSet,
  discussionList,
  onDiscussionChanged,
  type DiscussionView,
  type KanbanCard,
  type PlanDecision,
} from "../ipc";
import { deriveDiscussionPresentation, singleVendorLine } from "../lib/discussionPresentation";
import { useKanban } from "../store/kanbanStore";
import { pushToast } from "../store/toastStore";
import { discussionMetTrustQuestion } from "../lib/claudeReviewTrust";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { CBtn, Callout, Icon, StateWord, TextField, type RunState } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/**
 * v1.109.0 (Builder/Challenger D5/D10/D15): the Plan challenge on the
 * Intake step. Shows the latest Discussion linked to this card — the
 * synthesis, what both vendors agreed on, and the disagreement ledger —
 * and lets the human decide each disagreement. Saved decisions travel into
 * the Builder prompt; an edited brief marks the challenge stale.
 *
 * GH #258: on the one scale — a notice with one quiet action before the
 * build, a section with state words once a discussion exists; nothing at
 * all on a card past its build that never had one.
 */
export function PlanChallengePanel({
  card,
  offer,
  onChallenge,
  heldReason = null,
}: {
  card: KanbanCard;
  /** GH #258: the card has not been built yet (draft, ready, planning), so
   *  challenging its plan still applies. Otherwise the panel shows only a
   *  discussion that already exists. */
  offer: boolean;
  onChallenge: () => void;
  /** N19: why a discussion may not start now ("Say what should change
   *  first." on a follow-up whose ask is bare): its buttons are off and the
   *  reason is said beside them. */
  heldReason?: string | null;
}) {
  const ws = card.workspaceId;
  const [views, setViews] = useState<DiscussionView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await discussionList(ws);
      // A5F-07: a read for a card the panel has moved on from is dropped.
      if (currentCard.current !== card.id) return;
      setViews(all.filter((v) => v.record.cardId === card.id));
    } catch {
      if (currentCard.current !== card.id) return;
      setViews([]);
    }
  }, [ws, card.id]);
  const currentCard = useRef(card.id);
  currentCard.current = card.id;

  useEffect(() => {
    setViews([]);
    void load();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onDiscussionChanged(() => void load()).then((u) => {
      // A5F-07: the card changed before `listen` answered: let it go.
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [load]);

  const latest = useMemo(() => {
    const sorted = [...views].sort((a, b) => b.record.startedAt - a.record.startedAt);
    return sorted[0] ?? null;
  }, [views]);
  const presentation = useMemo(
    () => (latest ? deriveDiscussionPresentation(latest) : null),
    [latest],
  );

  // OB-14 (§13.4, D5): one vendor installed takes both roles.
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const only = singleInstalled(readiness);
  const blocker = discussionBlocker(readiness);

  const saved = card.planChallenge ?? null;
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const d of saved?.decisions ?? []) next[d.disagreementId] = d.decision;
    setDrafts(next);
  }, [saved]);

  const stale = Boolean(saved) && saved!.brief !== cardBriefText(card);
  const savedForLatest = Boolean(saved && latest && saved.discussionId === latest.record.id);

  if (!latest) {
    if (!offer) return null;
    return (
      <Callout
        kind="info"
        title="Challenge the plan before it is built"
        text={
          heldReason
            ? heldReason
            : blocker
            ? blocker
            : only
            ? `Two separate ${only === "codex" ? "Codex" : "Claude"} sessions, with different roles, each read the brief and review each other; you settle where they disagree, and the Builder starts with your decisions.`
            : "Claude and Codex each read the brief and review each other; you settle where they disagree, and the Builder starts with your decisions."
        }
        actions={
          <CBtn tone="quiet" disabled={Boolean(heldReason)} reason={heldReason ?? null} onClick={onChallenge}>
            Challenge the plan
          </CBtn>
        }
      />
    );
  }

  const status = latest.record.status;
  const synthesis = presentation?.synthesis ?? null;
  const disagreements = presentation?.disagreements ?? [];

  async function save() {
    if (!latest) return;
    const decisions: PlanDecision[] = disagreements
      .filter((d) => (drafts[d.entry.id] ?? "").trim().length > 0)
      .map((d) => ({
        disagreementId: d.entry.id,
        statement: d.entry.statement,
        decision: (drafts[d.entry.id] ?? "").trim(),
      }));
    setSaving(true);
    try {
      await cardPlanChallengeSet(ws, card.id, latest.record.id, decisions);
      await useKanban.getState().loadFromDisk(ws, true);
      pushToast({
        kind: "info",
        title: "Plan decisions saved",
        body: `${decisions.length} decision${decisions.length === 1 ? "" : "s"} will go to the Builder with the brief.`,
      });
    } catch (e) {
      pushErrorToast("The decisions couldn't be saved", e, { then: "The card's plan decisions are as they were. Try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ux-card-challenge" aria-label="Plan challenge">
      <div className="ux-card-challenge-head">
        <h3 className="ux-card-subheading">Plan challenge</h3>
        <StateWord state={statusDot(status)} live={statusDot(status) === "running"}>
          {presentation?.statusLabel ?? status}
        </StateWord>
        <CBtn
          tone="quiet"
          disabled={status === "completed" && Boolean(heldReason)}
          title={status === "completed" ? heldReason ?? undefined : undefined}
          onClick={onChallenge}
        >
          {status === "completed" ? "Challenge again" : "Open the discussion"}
        </CBtn>
      </div>
      {status === "completed" && heldReason && <p className="ux-card-muted">{heldReason}</p>}
      {stale ? (
        <p className="ux-card-muted" title="The brief was edited after the decisions were saved.">
          The brief changed after your decisions were saved.
        </p>
      ) : savedForLatest ? (
        <p className="ux-card-muted">Your decisions are saved and go to the Builder with the brief.</p>
      ) : null}
      {status !== "completed" && (
        <p className="ux-card-muted">
          The discussion is {presentation?.statusLabel?.toLowerCase() ?? status}. Open it to start,
          resume or watch it.
        </p>
      )}
      {status !== "completed" && discussionMetTrustQuestion(latest.record) && (
        <ClaudeReviewTrustStep refused workspaceId={ws} density="dense" />
      )}
      {synthesis && (
        <div className="ux-card-challenge-synthesis">
          {singleVendorLine(latest.record) && (
            <p className="ux-card-muted">{singleVendorLine(latest.record)}</p>
          )}
          <p className="ux-card-plain">{synthesis.answer}</p>
          {synthesis.agreements.length > 0 && (
            <ul className="ux-card-challenge-agreements" aria-label="What both agreed on">
              {synthesis.agreements.map((a, i) => (
                <li key={i}>
                  <Icon name="current" size="sm" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status === "completed" && (
        <div className="ux-card-challenge-ledger">
          <p className="ux-card-challenge-count">
            {disagreements.length === 0
              ? latest.record.singleVendor
                ? "No disagreement between the two sessions."
                : "The two AIs agree."
              : `Your call on ${disagreements.length} disagreement${disagreements.length === 1 ? "" : "s"}.`}
          </p>
          {disagreements.map((d) => (
            <div className="ux-card-challenge-item" key={d.entry.id}>
              <p className="ux-card-challenge-statement">
                <strong>{d.entry.statement}</strong>
                {d.entry.rationale && <span className="ux-card-muted-inline"> — {d.entry.rationale}</span>}
              </p>
              {!d.unresolved && d.resolutionRationale && (
                <p className="ux-card-muted">
                  The synthesis: {d.disposition} — {d.resolutionRationale}
                </p>
              )}
              <TextField
                wide
                label={d.unresolved ? "Your decision" : "Override the synthesis"}
                placeholder={d.unresolved ? "Your decision" : "Override the synthesis (optional)"}
                value={drafts[d.entry.id] ?? ""}
                onChange={(next) => setDrafts((prev) => ({ ...prev, [d.entry.id]: next }))}
              />
            </div>
          ))}
          <div className="ux-card-section-actions">
            <CBtn onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save decisions for the Builder"}
            </CBtn>
            {saved && (
              <CBtn
                tone="quiet"
                onClick={async () => {
                  await cardPlanChallengeClear(ws, card.id);
                  await useKanban.getState().loadFromDisk(ws, true);
                }}
              >
                Forget decisions
              </CBtn>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The discussion's state as a dot. */
function statusDot(status: string): RunState {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
    case "aborted":
      return "aborted";
    case "preparing":
    case "running":
      return "running";
    default:
      return "empty";
  }
}
