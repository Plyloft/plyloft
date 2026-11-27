import { isUndecided } from "../lib/buildBoth";
import { builderNeverStarted } from "../lib/challengerReview";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KanbanCard, LineComment } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import { pushToast } from "../store/toastStore";
import { cardInWorkspace } from "../lib/cardClaim";
import { dayWords } from "../lib/cardPage";
import { rangeLabel, unsentComments } from "../lib/lineComments";
import { sendLineComments, waitUntil } from "../lib/lineCommentSend";
import { CBtn, Details } from "./ux";

/** `deliverWhenIdle`'s key: one line-comment message per card at a time. */
const LINE_COMMENTS_KEY = "line-comments";
/** How long Send to Builder waits for a resumed session's terminal. */
const SESSION_WAIT_MS = 20_000;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * SL-5: the comment box under a selection of the review diff. Esc or Cancel
 * drops it; Add comment saves it on the card.
 */
export function LineCommentComposer({
  label,
  busy,
  body,
  onBody,
  onAdd,
  onCancel,
  focusKey = 1,
}: {
  label: string;
  busy: boolean;
  /** The draft is the panel's: selecting other lines keeps what was typed. */
  body: string;
  onBody: (next: string) => void;
  onAdd: (body: string) => Promise<boolean>;
  onCancel: () => void;
  /** v1.154.1: bumped when the box should take the focus (a click on a
   *  line, Enter on a line); 0 when the keyboard stays on the lines. */
  focusKey?: number;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusKey > 0) input.current?.focus();
  }, [focusKey]);
  const add = async () => {
    if (body.trim()) await onAdd(body);
  };
  return (
    <div className="card-review-composer" data-ply-line-composer="">
      <p className="card-review-comment-where">{label}</p>
      <textarea
        className="card-review-comment-input"
        aria-label="Comment for the Builder"
        placeholder="What should the Builder change here?"
        value={body}
        ref={input}
        onChange={(e) => onBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void add();
          }
        }}
      />
      <div className="card-review-comment-actions">
        <CBtn tone="quiet" size="sm" onClick={onCancel}>
          Cancel
        </CBtn>
        <CBtn size="sm" disabled={busy || !body.trim()} onClick={() => void add()}>
          Add comment
        </CBtn>
      </div>
    </div>
  );
}

/**
 * SL-5: the card's line comments — the ones not sent yet (edit, remove,
 * Send to Builder) and, under Details, the ones sent, kept as history.
 * They stay in Plyloft; nothing here posts to GitHub.
 */
export function LineCommentList({
  workspaceId,
  card,
  shipBusy = false,
}: {
  workspaceId: string;
  card: KanbanCard;
  /** The card is being shipped (Outcome's Ship): Send waits. */
  shipBusy?: boolean;
}) {
  // Store state, not the panel's: a card page opened again while a send is
  // held shows it queued, and cannot send it a second time.
  const sendState = useBuilder((s) => s.lineCommentSend[card.id]);
  const sending = sendState != null;
  const shipBusyRef = useRef(shipBusy);
  shipBusyRef.current = shipBusy;
  const all = card.lineComments ?? [];
  const unsent = unsentComments(all);
  const sent = all.filter((c) => c.sentAt != null);
  // Challenger on a pull request: the member's own pull request's card has a
  // Builder record from the start (its reviews live there) though no session
  // ever ran — nothing to resume, so nothing to send to until Fix with the
  // Builder starts one.
  const hasBuilder = Boolean(card.builder) && !builderNeverStarted(card.builder);

  const onSend = useCallback(async () => {
    const cardNow = () =>
      cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, card.id) ?? undefined;
    const sessionOpen = () => {
      const pty = cardNow()?.builder?.ptyId;
      const rt = useBuilder.getState().byCard[card.id];
      return Boolean(pty && rt && rt.ptyId === pty);
    };
    await sendLineComments({
      claim: () => useBuilder.getState().claimLineCommentSend(card.id),
      queued: () => useBuilder.getState().markLineCommentSendQueued(card.id),
      release: () => useBuilder.getState().releaseLineCommentSend(card.id),
      shipping: () => shipBusyRef.current,
      comments: () => cardNow()?.lineComments ?? [],
      hasBuilder: () => Boolean(cardNow()?.builder) && !builderNeverStarted(cardNow()?.builder),
      sessionOpen,
      sessionRecorded: () => Boolean(cardNow()?.builder?.ptyId),
      resume: () => useBuilder.getState().resume(workspaceId, card.id),
      waitForSession: () =>
        waitUntil(sessionOpen, SESSION_WAIT_MS, (ms) => new Promise((r) => setTimeout(r, ms))),
      deliver: (text, onQueued) =>
        useBuilder.getState().deliverWhenIdle(card.id, text, onQueued, LINE_COMMENTS_KEY),
      markSent: (ids) => useKanban.getState().markLineCommentsSent(workspaceId, card.id, ids),
      notify: (kind, title, body, details) => pushToast({ kind, title, body, details }),
    });
  }, [workspaceId, card.id]);

  if (all.length === 0) return null;
  const n = unsent.length;
  return (
    <section className="card-review-comments" aria-label="Comments for the Builder">
      <h5 className="card-review-comments-title">Comments for the Builder</h5>
      {n === 0 ? (
        <p className="card-review-note">Every comment has been sent to the Builder.</p>
      ) : (
        <>
          <ul className="card-review-comment-list">
            {unsent.map((c) => (
              <LineCommentItem
                key={c.id}
                workspaceId={workspaceId}
                cardId={card.id}
                comment={c}
                locked={sending}
              />
            ))}
          </ul>
          <div className="card-review-comment-actions">
            <span className="card-review-note" data-ply-line-comments-state={sendState ?? ""}>
              {sendState === "queued"
                ? "Queued for the Builder: they go in when it is back at its prompt."
                : sendState === "sending"
                  ? "Sending to the Builder…"
                  : !hasBuilder
                    ? isUndecided(card)
                      ? "Claude and Codex are both building this card. Pick one of the two builds to send them."
                      : card.prReview
                        ? "The Builder hasn't started on this card. Fix with the Builder starts it; send them once it has."
                        : "This card has no Builder yet. Start a build to send them."
                    : shipBusy
                      ? "The card is being shipped. Send them once the ship is over."
                      : "They go to the Builder in one message. Nothing is posted to GitHub."}
            </span>
            <CBtn
              tone="accent"
              disabled={sending || !hasBuilder || shipBusy}
              onClick={() => void onSend()}
              title={
                card.builder?.ptyId
                  ? "Paste the comments into the Builder session."
                  : "Resume the Builder session in this card's copy, then paste the comments into it."
              }
              data-ply-send-line-comments=""
            >
              Send to Builder ({n})
            </CBtn>
          </div>
        </>
      )}
      {sent.length > 0 && (
        <Details summary={`Sent (${sent.length})`}>
          <ul className="card-review-comment-list">
            {sent.map((c) => (
              <li key={c.id} className="card-review-comment is-sent">
                <CommentHead comment={c} />
                <p className="card-review-comment-body">{c.body}</p>
                <p className="card-review-note">Sent {dayWords(c.sentAt as number, Date.now())}.</p>
              </li>
            ))}
          </ul>
        </Details>
      )}
    </section>
  );
}

function CommentHead({ comment }: { comment: LineComment }) {
  return (
    <>
      <p className="card-review-comment-where">
        <code>{comment.path}</code>, {rangeLabel(comment)}
      </p>
      {comment.quoted && <pre className="card-review-comment-quote">{comment.quoted}</pre>}
    </>
  );
}

function LineCommentItem({
  workspaceId,
  cardId,
  comment,
  locked,
}: {
  workspaceId: string;
  cardId: string;
  comment: LineComment;
  locked: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: string, write: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await write();
      return true;
    } catch (e) {
      pushToast({
        kind: "error",
        title: `The comment couldn't be ${action}`,
        body: "Nothing was changed. Try again.",
        details: reason(e),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (editing == null || !editing.trim()) return;
    const ok = await run("saved", () =>
      useKanban.getState().updateLineComment(workspaceId, cardId, comment.id, editing),
    );
    if (ok) setEditing(null);
  };
  return (
    <li className="card-review-comment" data-ply-line-comment={comment.id}>
      <CommentHead comment={comment} />
      {editing == null ? (
        <>
          <p className="card-review-comment-body">{comment.body}</p>
          <div className="card-review-comment-actions">
            <CBtn tone="quiet" size="sm" disabled={locked || busy} onClick={() => setEditing(comment.body)}>
              Edit
            </CBtn>
            <CBtn
              tone="quiet"
              size="sm"
              disabled={locked || busy}
              onClick={() =>
                void run("removed", () =>
                  useKanban.getState().removeLineComment(workspaceId, cardId, comment.id),
                )
              }
            >
              Remove
            </CBtn>
          </div>
        </>
      ) : (
        <>
          <textarea
            className="card-review-comment-input"
            aria-label="Edit the comment"
            value={editing}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(null);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="card-review-comment-actions">
            <CBtn tone="quiet" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </CBtn>
            <CBtn size="sm" disabled={locked || busy || !editing.trim()} onClick={() => void save()}>
              Save
            </CBtn>
          </div>
        </>
      )}
    </li>
  );
}
