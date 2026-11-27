// 1.177.0 Compare: the open relay bar — the ask, the member's note, and the
// two ways to hand over. One filled primary: "Send to {B}". Its own file, so
// the bar at rest (whose one primary is "Pass to {B} →") and this are two
// views, never drawn together.
import { useEffect, type RefObject } from "react";
import { useCompare, type Composer } from "../store/compareStore";
import { closeComposer, deliver, refreshPreview } from "../store/compareActions";
import { questionReasonWords } from "../lib/compareView";
import {
  COMPARE_ASKS,
  COMPARE_ASK_LABEL,
  COMPARE_CANCEL,
  COMPARE_CUT_WORDS,
  COMPARE_HIDE,
  COMPARE_INCLUDE_QUESTION,
  COMPARE_NOTE_MAX,
  COMPARE_NOTE_PLACEHOLDER,
  COMPARE_PUT_IN_BOX,
  COMPARE_QUESTION_CUT,
  COMPARE_QUESTION_LEFT_OUT,
  COMPARE_SHOW,
  askHeading,
  charsWords,
  composerTitleWords,
  includeQuestionHint,
  questionLabelWords,
  sendWords,
} from "../lib/compareWords";
import { formatKeys, mod } from "../lib/platform";
import { CBtn } from "./ui/primitives";
import { Toggle } from "./ux/controls";
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
  // 1.179.0 "Include my question": null when the switch isn't offered (a
  // pass from the history that went without one).
  const question = composer.question ?? null;
  const questionOn = composer.includeQuestion === true && question?.state === "ok";
  const questionText = question?.state === "ok" ? question.text : null;
  // The preview comes from the backend, from the parts a press sends: asked
  // again (debounced) when they change, only with the switch on.
  useEffect(() => {
    refreshPreview(workspaceId);
  }, [workspaceId, composer.answer, composer.ask, composer.note, composer.includeQuestion, questionText]);
  const preview = questionOn ? (composer.preview ?? null) : null;
  // The question as it goes when the backend has said, else as it was read.
  const questionChars = preview?.question !== undefined ? [...preview.question].length : questionText !== null ? [...questionText].length : 0;
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
          {/* The question exactly as the backend prepared it, plain text. */}
          {preview?.question !== undefined && (
            <>
              <p className="ux-relay-muted">{questionLabelWords(composer.from)}</p>
              <p>{preview.question}</p>
            </>
          )}
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
      {question && !answerGone && (
        <div className="ux-relay-line">
          <span className="ux-relay-reason" title={includeQuestionHint(composer.from)}>
            <Toggle
              checked={questionOn}
              disabled={composer.busy || question.state !== "ok"}
              label={COMPARE_INCLUDE_QUESTION}
              onChange={(next) => store.patchComposer(workspaceId, { includeQuestion: next })}
            />
            <span>{COMPARE_INCLUDE_QUESTION}</span>
          </span>
          {questionOn ? (
            <>
              <span className="ux-relay-muted">{charsWords(questionChars)}</span>
              {preview?.questionLeftOut ? (
                <span className="ux-relay-muted">{COMPARE_QUESTION_LEFT_OUT}</span>
              ) : (
                preview?.questionCut && <span className="ux-relay-muted">{COMPARE_QUESTION_CUT}</span>
              )}
            </>
          ) : (
            question.state !== "ok" && <span className="ux-relay-muted">{questionReasonWords(composer.from, question)}</span>
          )}
        </div>
      )}
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
