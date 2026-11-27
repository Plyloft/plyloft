// 1.175.0 F5 (owner I7): the card's "After a fix round" in Change… —
// Checks by itself / Waits for me; its default is Settings › Cards › AI and
// models. Never shown on a card that reviews somebody else's pull request.
import { useId } from "react";
import type { KanbanCard } from "../ipc";
import { Select } from "./ux";
import {
  AFTER_FIX_ROUND_BY_ITSELF,
  AFTER_FIX_ROUND_HINT,
  AFTER_FIX_ROUND_LABEL,
  AFTER_FIX_ROUND_WAITS,
  fixRoundCheckOn,
} from "../lib/fixRoundCheck";
import { cardFixRoundCheckSet } from "../lib/fixRoundActions";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { pushErrorToast } from "../lib/errorToast";

export function FixRoundPick({ card }: { card: KanbanCard }) {
  const setting = useSettings((s) => s.settings.behavior.checkFixRoundsByItself !== false);
  const hintId = useId();
  if (card.prReview) return null;
  const on = fixRoundCheckOn(card, setting);
  return (
    <span className="ux-card-builder-pick" data-ply-fix-round-pick="">
      <Select
        label={AFTER_FIX_ROUND_LABEL}
        aria-describedby={hintId}
        value={on ? "self" : "wait"}
        onChange={(next) => {
          void cardFixRoundCheckSet(card.workspaceId, card.id, next === "self")
            .then(() => useKanban.getState().loadFromDisk(card.workspaceId, true))
            .catch((e) =>
              pushErrorToast("Couldn't save After a fix round", e, { then: "The card keeps its choice. Try again in a moment." }),
            );
        }}
        options={[
          { value: "self", label: AFTER_FIX_ROUND_BY_ITSELF },
          { value: "wait", label: AFTER_FIX_ROUND_WAITS },
        ]}
      />
      <span id={hintId} className="ux-card-muted-inline">
        {AFTER_FIX_ROUND_HINT}
      </span>
    </span>
  );
}
