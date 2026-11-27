// 1.177.0 Compare: the open relay bar — the ask, the member's note, and the
// two ways to hand over. One filled primary: "Send to {B}". Its own file, so
// the bar at rest (whose one primary is "Pass to {B} →") and this are two
// views, never drawn together.
import type { RefObject } from "react";
import { useCompare, type Composer } from "../store/compareStore";
import { closeComposer, deliver } from "../store/compareActions";
import {
  COMPARE_ASKS,
  COMPARE_ASK_LABEL,
  COMPARE_CANCEL,
  COMPARE_CUT_WORDS,
  COMPARE_HIDE,
  COMPARE_NOTE_MAX,
  COMPARE_NOTE_PLACEHOLDER,
  COMPARE_PUT_IN_BOX,
  COMPARE_SHOW,
  askHeading,
  charsWords,
  composerTitleWords,
  sendWords,
} from "../lib/compareWords";
import { formatKeys, mod } from "../lib/platform";
import { CBtn } from "./ui/primitives";
import { MarkdownText } from "./MarkdownText";
import { RelayWho } from "./RelayWho";

export function CompareComposer({
  workspaceId,
  composer,
  sendReason,
  putReason,
  answerGone = false,
  noteRef,
}: {
  workspaceId: string;
  composer: Composer;
  sendReason: string | null;
  putReason: string | null;
  /** The source's answer is no longer on offer (a Codex tile that started a
   *  new conversation): its text and length aren't shown as if it were. */
  answerGone?: boolean;
  noteRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const store = useCompare.getState();
  // F2: why a button is off, as soon as it is — Send's, else Put's (only Put
  // off: its own reason, under it) — never while a press is under way (its
  // own paste makes the box read typed for a moment).
  const shownReason = composer.busy ? null : (sendReason ?? putReason);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeComposer(workspaceId);
      return;
    }
    if (e.key === "Enter" && mod(e.nativeEvent)) {
      e.preventDefault();
      // A held key repeats: only the press sends, and the keyboard goes back
      // to the tile after the key is released (the repeat never reaches it).
      if (e.repeat) return;
      void deliver(workspaceId, "send", true);
    }
  };

  return (
    <div className="ux-relay ux-relay--open" role="region" aria-label="Compare" data-compare-ws={workspaceId} onKeyDown={onKeyDown}>
      <div className="ux-relay-line">
        <RelayWho vendor={composer.from}>
          <b>{composerTitleWords(composer.from, composer.to, composer.answerKind)}</b>
        </RelayWho>
        {!answerGone && (
          <>
            <span className="ux-relay-muted">{charsWords(composer.chars)}</span>
            <CBtn size="sm" tone="quiet" disabled={composer.busy} onClick={() => store.patchComposer(workspaceId, { expanded: !composer.expanded })}>
              {composer.expanded ? COMPARE_HIDE : COMPARE_SHOW}
            </CBtn>
            {composer.cut && <span className="ux-relay-muted">{COMPARE_CUT_WORDS}</span>}
          </>
        )}
        <span className="ux-relay-spacer" />
        <CBtn size="sm" tone="quiet" onClick={() => closeComposer(workspaceId)}>
          {COMPARE_CANCEL}
          <kbd>esc</kbd>
        </CBtn>
      </div>
      {composer.expanded && !answerGone && (
        <div className="ux-relay-answer">
          <MarkdownText text={composer.answer} />
        </div>
      )}
      <div className="ux-relay-line">
        <span className="ux-relay-muted">{askHeading(composer.to)}</span>
        <span className="ux-relay-chips" role="radiogroup" aria-label={askHeading(composer.to)}>
          {COMPARE_ASKS.map((a, i) => (
            <CBtn
              key={a}
              size="sm"
              role="radio"
              aria-checked={composer.ask === a}
              tabIndex={composer.ask === a ? 0 : -1}
              active={composer.ask === a}
              disabled={composer.busy}
              onClick={() => store.patchComposer(workspaceId, { ask: a })}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = COMPARE_ASKS[(i + step + COMPARE_ASKS.length) % COMPARE_ASKS.length];
                store.patchComposer(workspaceId, { ask: next });
                (e.currentTarget.parentElement?.querySelector(`[data-ask="${next}"]`) as HTMLElement | null)?.focus();
              }}
              data-ask={a}
            >
              {COMPARE_ASK_LABEL[a]}
            </CBtn>
          ))}
        </span>
      </div>
      <div className="ux-relay-line ux-relay-line--note">
        <textarea
          ref={noteRef}
          className="ux-chat-input ux-relay-note"
          aria-label={COMPARE_NOTE_PLACEHOLDER}
          placeholder={COMPARE_NOTE_PLACEHOLDER}
          maxLength={COMPARE_NOTE_MAX}
          rows={2}
          disabled={composer.busy}
          value={composer.note}
          onChange={(e) => store.patchComposer(workspaceId, { note: e.target.value })}
        />
        <div className="ux-relay-buttons">
          <CBtn
            tone="accent"
            disabled={composer.busy || sendReason !== null}
            reason={sendReason}
            onClick={() => void deliver(workspaceId, "send")}
          >
            {sendWords(composer.to)}
            <kbd>{formatKeys("⌘↩")}</kbd>
          </CBtn>
          <CBtn
            disabled={composer.busy || putReason !== null}
            reason={putReason}
            onClick={() => void deliver(workspaceId, "put")}
          >
            {COMPARE_PUT_IN_BOX}
          </CBtn>
        </div>
      </div>
      {/* F2 / review H1, L1: one line, always there, so the bar's height —
          and the tiles' rows — never change as a reason comes and goes. A
          refusal after a press is announced (alert); a standing reason is the
          disabled button's own description (`CBtn reason`), shown here and
          not read a second time. */}
      <p className="ux-relay-error ux-relay-reason-slot">
        {composer.error ? (
          <span role="alert">{composer.error}</span>
        ) : (
          shownReason && <span aria-hidden="true">{shownReason}</span>
        )}
      </p>
    </div>
  );
}
