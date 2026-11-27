// 1.175.0 F10 (owner I11): the card's "Fix failing checks by itself"
// switch, under Change… (it was in the Shipping section). Shown while the
// card's own pull request is open and it has a Builder; what a try is doing,
// and where it stopped, stay said in the Shipping section and under Now.
import { useState } from "react";
import { Toggle } from "./ux";
import { useKanban, type KanbanCard } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { forgetAutoFixWaitToast, forgetPrAutoFixStops } from "../store/prAutoFixStore";
import { AUTO_FIX_PICK_HINT, AUTO_FIX_SWITCH_LABEL, autoFixDefaultSince, autoFixOn } from "../lib/prAutoFix";
import { prOpen } from "../lib/prStatus";
import { pushErrorToast } from "../lib/errorToast";

/** The row is offered: the card's own open pull request, with a Builder. */
export function autoFixPickShown(card: KanbanCard): boolean {
  return prOpen(card) && Boolean(card.builder) && !card.prReview && !card.archived;
}

export function CardAutoFixPick({ card }: { card: KanbanCard }) {
  const since = useWorkspaces((s) => autoFixDefaultSince(s.workspaces.find((w) => w.id === card.workspaceId)));
  const [saving, setSaving] = useState(false);
  const on = autoFixOn(card, since);
  async function change(next: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      await useKanban.getState().setPrAutoFix(card.workspaceId, card.id, next);
      if (next) forgetPrAutoFixStops(card.id);
      else forgetAutoFixWaitToast(card.id);
    } catch (e) {
      pushErrorToast(`${AUTO_FIX_SWITCH_LABEL} wasn't changed`, e);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="ux-card-pickers-row" data-ply-pr-auto-fix={on ? "on" : "off"}>
      <span className="ux-card-field-label">{AUTO_FIX_SWITCH_LABEL}</span>
      <span className="ux-card-builder-pick">
        <Toggle checked={on} disabled={saving} onChange={(next) => void change(next)} label={AUTO_FIX_SWITCH_LABEL} />
        <span className="ux-card-muted-inline">{AUTO_FIX_PICK_HINT}</span>
      </span>
    </div>
  );
}
