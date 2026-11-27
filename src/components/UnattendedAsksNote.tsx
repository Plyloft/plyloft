import { useState } from "react";
import type { KanbanCard } from "../ipc";
import { cardPermissionsChoice, unattendedAsksNote, USE_EDITS_COPY_LABEL } from "../lib/builderPermissions";
import { boundedStartApplies } from "../lib/firstCardGuide";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { CBtn } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/**
 * 1.172.0 (A2, owner): a card whose Builder asks before every change, where
 * a fix is meant to run without the person — "Fix failing checks by itself"
 * (`autoFix`, under its switch) or a fix round Plyloft sent (`round`, under
 * Now while it waits). It says the fix waits for the person's OK in the
 * session, and offers "Edits its copy without asking" for this card: saved
 * on the card for its next fresh start, never the open session. Nothing
 * changes by itself; Settings' default stays as it is.
 */
export function UnattendedAsksNote({ card, kind }: { card: KanbanCard; kind: "autoFix" | "round" }) {
  const settingsDefault = useSettings((s) => s.settings.behavior.builderPermissions);
  const tourMode = useSettings((s) => boundedStartApplies(s.settings.onboarding, card.workspaceId, card, false));
  const [saving, setSaving] = useState(false);
  const session = card.builder ?? null;
  if (!session) return null;
  const note = unattendedAsksNote({
    session,
    sessionOpen: Boolean(session.ptyId),
    nextChoice: cardPermissionsChoice(card, session.vendor, settingsDefault, tourMode),
    kind,
  });
  if (!note) return null;
  async function onUseEditsCopy() {
    if (saving) return;
    setSaving(true);
    try {
      await useKanban.getState().setBuilderPermissions(card.workspaceId, card.id, "editsCopy");
    } catch (e) {
      pushErrorToast("Couldn't save how the Builder asks you", e);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="ux-card-session-note" role="note" data-ply-unattended-asks={kind}>
      <span className="ux-card-muted-inline">{note.line}</span>
      {note.offer ? (
        <>
          <CBtn tone="quiet" size="sm" disabled={saving} onClick={() => void onUseEditsCopy()} data-ply-use-edits-copy="">
            {USE_EDITS_COPY_LABEL}
          </CBtn>
          <span className="ux-card-muted-inline">{note.offerTitle}</span>
        </>
      ) : (
        note.after && <span className="ux-card-muted-inline">{note.after}</span>
      )}
    </div>
  );
}
