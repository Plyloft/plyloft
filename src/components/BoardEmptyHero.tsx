// 1.176.3: the empty Board's hero ("What do you want to build?") in a file of
// its own. It holds the one filled button while the Board is empty (the
// header's New card is bordered then), which the one-primary guard
// (`lib/onePrimary.test.ts`) counts per component.
import { useEffect, useState } from "react";
import { NewCardAreaPick, useNewCardArea } from "./CardAreaLine";
import { CBtn } from "./ui/primitives";
import { TextField } from "./ux";
import { HERO_MAKE_THE_CARD, HERO_MAKE_THE_CARD_TITLE, NEW_CARD_HERO_HINT } from "../lib/boardCommands";
import { TEAM_BOARD_READ_ONLY_MESSAGE } from "../lib/teamGateCardWrites";
import { cardFromHeroText } from "../lib/boardHeroCard";
import { usePlanExchange } from "../store/planExchangeStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { focusNewCardBrief } from "./followUpFocus";

/** QoL 1.168 (C10): a new card that couldn't be made; its text is kept. */
export const NEW_CARD_FAILED = "The card wasn't added. Your text is still here — press Enter to try again.";
/** QoL 1.168 (C9): how long a card just made stays marked. */
export const ARRIVED_MS = 1600;

/**
 * v1.75.0 (STEP6 D4): empty-board hero — the spec's "What do you want
 * to build?" frame. One action: type an outcome, get a Todo card with
 * its lifecycle open at Intake.
 */
export function BoardEmptyHero({
  workspaceId,
  readOnly,
  focusRequest,
  onFocusShown,
}: {
  workspaceId: string;
  readOnly: boolean;
  focusRequest: number;
  /** The request this hero has taken, so a later mount does not take it again. */
  onFocusShown?: (request: number) => void;
}) {
  const addCard = useKanban((s) => s.addCard);
  const selectCard = useUi((s) => s.selectCard);
  // 1.174.0 (C3, §2f): on All areas, the new card's area, already chosen.
  const newArea = useNewCardArea(workspaceId);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  // 1.171.0 (E2; walk 2026-10-27 #2): New card on the empty Board is seen —
  // the field is marked for a moment, and what to do next is said.
  const [asked, setAsked] = useState(false);
  const [marked, setMarked] = useState(false);
  const inputId = `board-empty-input-${workspaceId}`;

  useEffect(() => {
    if (focusRequest <= 0 || readOnly) return;
    onFocusShown?.(focusRequest);
    setAsked(true);
    setMarked(true);
    requestAnimationFrame(() => {
      const input = document.getElementById(inputId);
      input?.scrollIntoView?.({ block: "nearest" });
      input?.focus();
    });
  }, [focusRequest, readOnly, inputId, onFocusShown]);
  useEffect(() => {
    if (!marked) return;
    const done = window.setTimeout(() => setMarked(false), ARRIVED_MS);
    return () => window.clearTimeout(done);
  }, [marked]);

  async function start() {
    if (readOnly) return;
    // F10 (team walk 2026-10-01): the first sentence names the card; a longer
    // text goes to What you want instead of becoming the title.
    const next = cardFromHeroText(draft);
    if (!next) return;
    // QoL 1.168 (C10): the text stays until the card is made; a creation
    // that fails leaves it in the field, with the error under it.
    setFailed(false);
    try {
      const card = await addCard(workspaceId, next.title, next.notes, "todo", newArea.area);
      newArea.remember();
      setDraft("");
      // "Create and plan with two AIs" (the palette): its page opens on the
      // Plan form.
      if (usePlanExchange.getState().takeNewCardPlan(workspaceId)) {
        usePlanExchange.getState().requestForm(workspaceId, card.id);
      } else {
        // 1.172.0 (C1; CP-12): its page opens on What you want.
        focusNewCardBrief(card.id);
      }
      selectCard(workspaceId, card.id);
    } catch {
      // addCard already toasts + rolls back; the text is still here.
      setFailed(true);
    }
  }

  // 1.176.3: while the Board is empty the hero holds the one filled button
  // (Make the card); the header's New card is bordered and stays the tour's
  // anchor. Enter in the field starts it too, on the one scale.
  return (
    <div className="board-empty" data-board-empty="">
      <h2 className="board-empty-title">What do you want to build?</h2>
      <p className="board-empty-sub">
        Write one sentence, then press Enter. Plyloft makes the card and opens it. You add details there.
      </p>
      <div
        className={marked ? "board-empty-field board-empty-field--asked" : "board-empty-field"}
        data-ply-board-focus-fallback={workspaceId}
      >
        <TextField
          id={inputId}
          wide
          label="What do you want to build?"
          value={draft}
          disabled={readOnly}
          title={readOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : undefined}
          placeholder="Add dark mode, fix the signup bug, export reports as CSV"
          onChange={setDraft}
          onEnter={() => void start()}
          onCancel={draft ? () => setDraft("") : undefined}
        />
        {/* 1.174.0 (A6, G16): the hero only makes the card. */}
        <CBtn
          tone="accent"
          disabled={readOnly || !draft.trim()}
          title={HERO_MAKE_THE_CARD_TITLE}
          reason={readOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : null}
          onClick={() => void start()}
        >
          {HERO_MAKE_THE_CARD}
        </CBtn>
      </div>
      <NewCardAreaPick pick={newArea} disabled={readOnly} />
      <p className="board-empty-asked" role="status" aria-live="polite">
        {asked ? NEW_CARD_HERO_HINT : ""}
      </p>
      {failed && (
        <p className="board-new-card-error" role="alert">
          {NEW_CARD_FAILED}
        </p>
      )}
    </div>
  );
}

