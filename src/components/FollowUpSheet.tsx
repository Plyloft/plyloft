import { useRef, useState } from "react";
import {
  FOLLOW_UP_ASK_LABEL,
  FOLLOW_UP_ASK_PLACEHOLDER,
  FOLLOW_UP_MAKE_LABEL,
  FOLLOW_UP_SHEET_TITLE,
  followUpChosen,
  followUpSheetLede,
} from "../lib/followUp";
import { CBtn, Sheet, TextField } from "./ux";

/**
 * 1.171.0 (E2; walk 2026-10-27 #6: "Follow up" was unexplained): Follow up
 * first shows the card it would make — the title it suggests from this card
 * and an optional "What should change now" — and makes it on Make the card.
 * The card is made exactly as before (`followUpDraft`, the store's
 * `followUp`); only the person's title and words go in.
 */
export function FollowUpSheet({
  cardTitle,
  draft,
  busy,
  onMake,
  onClose,
}: {
  cardTitle: string;
  /** `followUpDraft(card)`: the suggestion. */
  draft: { title: string; notes: string };
  busy: boolean;
  onMake: (chosen: { title: string; notes: string }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [ask, setAsk] = useState("");
  const askRef = useRef<HTMLTextAreaElement>(null);
  const make = () => {
    if (busy) return;
    onMake(followUpChosen(draft, title, ask));
  };
  return (
    <Sheet
      title={FOLLOW_UP_SHEET_TITLE}
      lede={followUpSheetLede(cardTitle)}
      size="confirm"
      onClose={onClose}
      canDismiss={!busy}
      initialFocusRef={askRef}
      actions={
        <>
          <CBtn tone="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </CBtn>
          <CBtn tone="accent" disabled={busy} onClick={make}>
            {busy ? "Making the card…" : FOLLOW_UP_MAKE_LABEL}
          </CBtn>
        </>
      }
    >
      <div className="ux-card-field" data-ply-follow-up-sheet="">
        <span className="ux-card-field-label">Title</span>
        <TextField label="Title" wide value={title} onChange={setTitle} onEnter={make} />
      </div>
      <label className="ux-card-field">
        <span className="ux-card-field-label">{FOLLOW_UP_ASK_LABEL}</span>
        <textarea
          ref={askRef}
          className="ux-card-textarea"
          rows={4}
          value={ask}
          placeholder={FOLLOW_UP_ASK_PLACEHOLDER}
          onChange={(e) => setAsk(e.target.value)}
        />
      </label>
    </Sheet>
  );
}
