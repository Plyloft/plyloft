// 1.175.0 F7 (owner I9): the "Turn on" offer under Now's primary, on a card
// whose pull request's checks failed (Fix with the Builder). It is the
// `autoFixOffer` note of F8's `nowNote.ts` (`CardNowNote.tsx` picks it).
import { useState } from "react";
import { create } from "zustand";
import type { KanbanCard } from "../ipc";
import { NOT_NOW_LABEL, TURN_ON_LABEL, UNDO_LABEL, autoFixOffered, offerLine, turnedOnLine, turnedOnShown, type TurnedOn } from "../lib/prAutoFixOffer";
import { useUi } from "../store/uiStore";
import { cardPermissionsChoice, unattendedAsksNote } from "../lib/builderPermissions";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { useWorkspaces } from "../store/workspaceStore";
import { forgetAutoFixWaitToast } from "../store/prAutoFixStore";
import { CBtn } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/** Cards where Turn on was just pressed: the line after it, with Undo,
 *  stays until the try ends (`turnedOnShown`) or the card is left. */
export const useAutoFixTurnedOn = create<{ cards: Record<string, TurnedOn | undefined> }>(() => ({ cards: {} }));

let leaving: (() => void) | null = null;
/** Walk 7: leaving the card forgets its line (not back on return). */
function forgetOnLeave() {
  if (leaving) return;
  leaving = useUi.subscribe((ui, prev) => {
    if (ui.selectedCardId === prev.selectedCardId) return;
    const cards = useAutoFixTurnedOn.getState().cards;
    const gone = Object.entries(cards).filter(([id, on]) => on && ui.selectedCardId[on.workspaceId] !== id);
    if (gone.length === 0) return;
    const next = { ...cards };
    for (const [id] of gone) delete next[id];
    useAutoFixTurnedOn.setState({ cards: next });
  });
}

function setTurnedOn(card: KanbanCard, on: boolean) {
  forgetOnLeave();
  useAutoFixTurnedOn.setState((s) => {
    const cards = { ...s.cards };
    if (on) cards[card.id] = { workspaceId: card.workspaceId, head: card.pr?.headSha ?? null, at: Date.now() };
    else delete cards[card.id];
    return { cards };
  });
}

/** The line after Turn on is showing on this card. */
export function useTurnedOnShown(card: KanbanCard): boolean {
  const on = useAutoFixTurnedOn((s) => s.cards[card.id]);
  return turnedOnShown(on, card);
}

export function AutoFixOffer({ card }: { card: KanbanCard }) {
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId));
  const settingsDefault = useSettings((s) => s.settings.behavior.builderPermissions);
  const turnedOn = useTurnedOnShown(card);
  const [busy, setBusy] = useState(false);
  const offered = autoFixOffered(card, ws);
  if (!offered && !turnedOn) return null;
  const vendor = card.builder?.vendor === "codex" ? "codex" : "claude";
  const asks = card.builder
    ? unattendedAsksNote({
        session: card.builder as never,
        sessionOpen: Boolean(card.builder.ptyId),
        nextChoice: cardPermissionsChoice(card, vendor, settingsDefault, false),
        kind: "autoFix",
      })
    : null;
  const both = async (on: boolean) => {
    setBusy(true);
    const before = card.prAutoFix ?? null;
    let cardSet = false;
    try {
      await useKanban.getState().setPrAutoFix(card.workspaceId, card.id, on);
      cardSet = true;
      await useWorkspaces.getState().setFixFailingChecks(card.workspaceId, on);
      if (on) await useWorkspaces.getState().markFixFailingChecksOffered(card.workspaceId);
      setTurnedOn(card, on);
      // Walk 7: Undo — a toast saying the fix starts later isn't true now.
      if (!on) forgetAutoFixWaitToast(card.id);
    } catch (e) {
      // F7 round 2: the card's switch went, the project's didn't — put the
      // card's back, so "Nothing was changed" is true.
      if (cardSet && before !== on) {
        await useKanban.getState().setPrAutoFix(card.workspaceId, card.id, before === true).catch(() => {});
      }
      pushErrorToast("Couldn't change Fix failing checks by itself", e, { then: "Nothing was changed. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span className="ux-now-ask" data-ply-auto-fix-offer={turnedOn ? "on" : "offered"}>
        <span className="ux-card-muted-inline">{turnedOn ? turnedOnLine(Boolean(card.builder?.ptyId)) : offerLine(asks?.line)}</span>
        {turnedOn ? (
          <CBtn tone="quiet" disabled={busy} onClick={() => void both(false)}>
            {UNDO_LABEL}
          </CBtn>
        ) : (
          <>
            <CBtn disabled={busy} onClick={() => void both(true)}>
              {TURN_ON_LABEL}
            </CBtn>
            <CBtn tone="quiet" disabled={busy} onClick={() => void useWorkspaces.getState().markFixFailingChecksOffered(card.workspaceId)}>
              {NOT_NOW_LABEL}
            </CBtn>
          </>
        )}
      </span>
    </>
  );
}
