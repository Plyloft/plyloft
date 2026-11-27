/**
 * 1.172.0 (A1): "Asked later (n)" under What you want — what the person told
 * the Builder after the first result, each with its words and time. The
 * Challenger reads them with the brief. Removable until the card is done;
 * a done card's, and a read-only team board's, are read-only.
 */
import { useState } from "react";
import type { KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import {
  LATER_REQUESTS_INTRO,
  LATER_REQUEST_REMOVE_LABEL,
  LATER_REQUEST_REMOVE_TITLE,
  laterRequestMeta,
  laterRequestRemoveName,
  laterRequestsHeading,
} from "../lib/laterRequests";
import { CBtn } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

export function LaterRequests({
  card,
  readOnly,
}: {
  card: Pick<KanbanCard, "id" | "workspaceId" | "laterRequests">;
  /** Done, or a team board this Mac can't write: no Remove. */
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const list = card.laterRequests ?? [];
  if (list.length === 0) return null;
  const now = Date.now();
  const headingId = `card-later-${card.id}`;
  const remove = async (id: string) => {
    setBusy(id);
    try {
      await useKanban.getState().removeLaterRequest(card.workspaceId, card.id, id);
    } catch (e) {
      pushErrorToast("It wasn't removed", e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="ux-card-later" aria-labelledby={headingId} data-ply-card-later="">
      <h3 className="ux-card-subheading" id={headingId}>
        {laterRequestsHeading(list.length)}
      </h3>
      <p className="ux-card-muted">{LATER_REQUESTS_INTRO}</p>
      <ul className="ux-card-later-list">
        {list.map((r) => (
          <li key={r.id} className="ux-card-later-item">
            <p className="ux-card-plain">{r.text}</p>
            <div className="ux-card-later-meta">
              <span className="ux-card-muted" title={new Date(r.at).toLocaleString()}>
                {laterRequestMeta(r, now)}
              </span>
              {!readOnly && (
                <CBtn
                  tone="quiet"
                  size="sm"
                  disabled={busy !== null}
                  title={LATER_REQUEST_REMOVE_TITLE}
                  aria-label={laterRequestRemoveName(r.text)}
                  onClick={() => void remove(r.id)}
                >
                  {LATER_REQUEST_REMOVE_LABEL}
                </CBtn>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
