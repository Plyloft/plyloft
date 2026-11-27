// 1.175.0 F6 (UX-6; owner I8): one line in the Review about the pull
// request's title and description written during the review — ready (Read
// it), still being written, out of date, or written by Plyloft itself.
import { useState } from "react";
import type { KanbanCard } from "../ipc";
import { READ_IT_LABEL, draftRow } from "../lib/prDraft";
import { usePrDraftEarly } from "../store/prDraftEarlyStore";
import { PrEditSheet } from "./PrEditSheet";
import { CBtn } from "./ux";

export function PrDraftRow({ card }: { card: KanbanCard }) {
  const entry = usePrDraftEarly((s) => s.byCard[card.id]);
  const [reading, setReading] = useState(false);
  if (card.prReview || card.prUrl) return null;
  const snaps = card.builder?.snapshots ?? [];
  const tip = snaps[snaps.length - 1]?.sha ?? null;
  const ai = card.builder?.vendor === "codex" ? "Codex" : "Claude";
  const row = draftRow(entry, tip, ai);
  if (!row) return null;
  return (
    <div className="ux-card-section-actions" data-ply-pr-draft-row={row.kind}>
      <span className="ux-card-muted">{row.line}</span>
      {row.kind === "ready" && (
        <CBtn tone="quiet" onClick={() => setReading(true)}>
          {READ_IT_LABEL}
        </CBtn>
      )}
      {reading && <PrEditSheet workspaceId={card.workspaceId} cardId={card.id} prNumber={0} draftBy={ai} onClose={() => setReading(false)} />}
    </div>
  );
}
