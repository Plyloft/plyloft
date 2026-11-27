import { useEffect, useRef, useState } from "react";
import { cardPrEdit, cardPrText } from "../ipc";
import { rawError } from "../lib/cardPage";
import { PR_EDIT_CHANGED, PR_EDIT_SAVE, PR_EDIT_TITLE, prEditSaveable } from "../lib/prEdit";
import { DRAFT_SHEET_TITLE, draftSheetSentence } from "../lib/prDraft";
import { cardPrDraftRead, cardPrDraftSave } from "../lib/prDraftIpc";
import { noteEarlyDraftSaved } from "../store/prDraftEarlyStore";
import { pushToast } from "../store/toastStore";
import { CBtn, Details, Sheet } from "./ux";

/**
 * 1.170.0 G4: **Edit title and description** of the card's open pull
 * request — prefilled from GitHub's current title and body; Save runs `gh
 * pr edit` (title and body) as the workspace's GitHub account. Nothing is
 * sent until Save; Cancel changes nothing.
 */
export function PrEditSheet({
  workspaceId,
  cardId,
  prNumber,
  onClose,
  draftBy,
}: {
  workspaceId: string;
  cardId: string;
  prNumber: number;
  onClose: () => void;
  /** 1.175.0 F6 (Read it): before the pull request exists — the Builder's
   *  draft in the card's copy, by its AI's name; Save keeps it there, and
   *  nothing goes to GitHub until Ship it. */
  draftBy?: string;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<{ title: string; body: string } | null>(null);
  const [loadErrorDetails, setLoadErrorDetails] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErrorDetails, setSaveErrorDetails] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = draftBy
      ? cardPrDraftRead(workspaceId, cardId).then((r) => {
          if (r.state !== "ready") throw new Error(r.state === "unusable" ? r.reason : "The draft isn't there any more.");
          return { title: r.title, body: r.body };
        })
      : cardPrText(workspaceId, cardId);
    load.then(
      (text) => {
        if (cancelled) return;
        setLoaded(text);
        setTitle(text.title);
        setBody(text.body);
      },
      (e) => {
        if (!cancelled) setLoadErrorDetails(rawError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, cardId, draftBy]);

  async function onSave() {
    if (!loaded || !prEditSaveable(loaded, title, body) || saving) return;
    setSaving(true);
    setSaveErrorDetails(null);
    try {
      if (draftBy) {
        // Local only: the draft in the card's copy, which Ship reads.
        await cardPrDraftSave(workspaceId, cardId, title, body);
        noteEarlyDraftSaved(cardId);
        onClose();
        return;
      }
      await cardPrEdit(workspaceId, cardId, title, body, loaded);
      pushToast({ kind: "info", title: "Pull request updated", body: `Pull request #${prNumber} has the new title and description.` });
      onClose();
    } catch (e) {
      setSaveErrorDetails(rawError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      title={draftBy ? DRAFT_SHEET_TITLE : PR_EDIT_TITLE}
      lede={draftBy ? draftSheetSentence(draftBy) : `Pull request #${prNumber} on GitHub, as it is now. Save changes it there.`}
      onClose={onClose}
      canDismiss={!saving}
      initialFocusRef={titleRef}
      actions={
        <>
          <CBtn tone="quiet" onClick={onClose} disabled={saving}>
            {draftBy ? "Close" : "Cancel"}
          </CBtn>
          <CBtn onClick={() => void onSave()} disabled={saving || !prEditSaveable(loaded, title, body)}>
            {saving ? "Saving…" : draftBy ? "Save" : PR_EDIT_SAVE}
          </CBtn>
        </>
      }
    >
      <div className="ux-sheet-form" data-ply-pr-edit="">
        {!loaded && !loadErrorDetails && <p className="ux-card-muted">{draftBy ? "Reading the draft…" : "Reading the pull request from GitHub…"}</p>}
        {loadErrorDetails && (
          <>
            <p className="ux-inline-alert">{draftBy ? "Couldn't read the draft. Close this and try again." : "Couldn't read the pull request from GitHub. Close this and try again."}</p>
            <Details summary={draftBy ? "Details" : "GitHub's answer"}>
              <p className="ux-card-critique">{loadErrorDetails}</p>
            </Details>
          </>
        )}
        {loaded && (
          <>
            <label className="ux-sheet-field">
              Title
              <input
                ref={titleRef}
                className="ux-sheet-textarea ux-sheet-textarea--prose"
                value={title}
                disabled={saving}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="ux-sheet-field">
              Description
              <textarea
                className="ux-sheet-textarea"
                rows={14}
                value={body}
                disabled={saving}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
          </>
        )}
        {saveErrorDetails === PR_EDIT_CHANGED && <p className="ux-inline-alert">{PR_EDIT_CHANGED}</p>}
        {saveErrorDetails && saveErrorDetails !== PR_EDIT_CHANGED && (
          <>
            <p className="ux-inline-alert">{draftBy ? "Not saved: the draft is as it was." : "Not saved: GitHub didn't take the change. The pull request is as it was."}</p>
            <Details summary={draftBy ? "Details" : "GitHub's answer"}>
              <p className="ux-card-critique">{saveErrorDetails}</p>
            </Details>
          </>
        )}
      </div>
    </Sheet>
  );
}
