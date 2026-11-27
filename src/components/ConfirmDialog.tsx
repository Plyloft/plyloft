import { useRef, useState } from "react";
import { CBtn, Details, DuplicateChip, Sheet } from "./ux";
import { CheckLine } from "./ux/CheckList";
import { openWebLink } from "../ipc";
import { machineWords } from "../lib/platform";
import { linkDidNotOpen } from "../lib/linkToast";
import { pushToast } from "../store/toastStore";

type Props = {
  title: string;
  body?: string;
  /** R2: a list under the body, one line each. */
  items?: string[];
  /** 1.171.0 A3 (DL-21): the list folded under this; the body comes first. */
  itemsLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Closed without an answer (Escape, the backdrop); `onCancel` when absent. */
  onDismiss?: () => void;
  destructive?: boolean;
  /** C3: Cancel takes focus and the accepting button is a plain one — the
   *  safe answer is the default without the action being destructive. */
  cautious?: boolean;
  /** Cancel takes focus; the accepting button keeps its tone. */
  focusCancel?: boolean;
  /** F21: a third, plain button beside the accepting one. */
  altLabel?: string;
  onAlt?: () => void;
  /** 1.173.0 (B3): the third button after the accepting one. */
  altAfter?: boolean;
  /** 1.173.0 (B3): a sentence under the list; with it, the body leads. */
  note?: string;
  /** 1.173.0 (C2): a quiet sentence in the body, under the lede. */
  hint?: string;
  /** 1.173.0 (C2): Cancel is the strong button (and has the focus). */
  strongCancel?: boolean;
  /** 1.176.1 walk: one column of buttons, same width, shared right edge. */
  stacked?: boolean;
  /** 1.173.0 (C2): the words are this platform's already; drawn as they are. */
  asIs?: boolean;
  /** 1.173.0 (B3): files as rows, the path in code style and an outline chip. */
  fileRows?: { path: string; tag: string }[];
  /** QoL 7.3: a fourth, plain button, before the third. */
  alt2Label?: string;
  onAlt2?: () => void;
  /** 1.169.0 (C8): a tick box with these words; the accepting button is
   *  pressable only once it is ticked. */
  agreement?: string;
  /** G1: a web page to read more, opened in the browser; answers nothing. */
  link?: { label: string; url: string };
};

/**
 * One yes/no question over the page. UX-10.1: a thin wrapper over
 * `Sheet size="confirm"`, so its callers keep this API. The confirming
 * button takes focus, unless it is destructive: then it is the one filled
 * `--danger` button on the surface and Cancel takes focus, so Enter never
 * destroys by accident (SHEET.md "ConfirmSheet"; owner decision 2026-09-30).
 */
export function ConfirmDialog({
  title,
  body,
  items,
  itemsLabel,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  onDismiss,
  destructive,
  cautious,
  focusCancel,
  altLabel,
  onAlt,
  altAfter,
  note,
  hint,
  strongCancel,
  stacked,
  asIs,
  fileRows,
  alt2Label,
  onAlt2,
  agreement,
  link,
}: Props) {
  const [agreed, setAgreed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const words = (text: string) => (asIs ? text : machineWords(text));
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // 1.176.1 walk 2: in one column (`stacked`) the safe answer, Cancel, is
  // the one filled primary, first; the accepting button is plain. One
  // element draws the primary either way, so a sheet has one.
  const cancelPrimary = !!stacked && !destructive;
  const primary = (
    <CBtn
      ref={cancelPrimary ? cancelRef : confirmRef}
      tone={destructive ? "danger" : cautious && !cancelPrimary ? undefined : "accent"}
      className={destructive ? "ux-danger-fill" : undefined}
      disabled={!cancelPrimary && !!agreement && !agreed}
      onClick={cancelPrimary ? onCancel : onConfirm}
    >
      {words(cancelPrimary ? cancelLabel : confirmLabel)}
    </CBtn>
  );
  const other = cancelPrimary ? (
    <CBtn ref={confirmRef} onClick={onConfirm}>
      {words(confirmLabel)}
    </CBtn>
  ) : (
    <CBtn ref={cancelRef} className={strongCancel ? "cbtn--strong" : undefined} onClick={onCancel}>
      {words(cancelLabel)}
    </CBtn>
  );
  const first = cancelPrimary ? primary : other;
  const second = cancelPrimary ? other : primary;
  return (
    <Sheet
      title={title}
      asIs={asIs}
      // R2: a list is read right under the title; the body follows it —
      // unless the list is folded (`itemsLabel`): then the body leads.
      lede={(items?.length || fileRows?.length) && !itemsLabel && !note ? undefined : body}
      size="confirm"
      onClose={onDismiss ?? onCancel}
      initialFocusRef={destructive || cautious || focusCancel || strongCancel || agreement ? cancelRef : confirmRef}
      actions={
        <div className={stacked ? "ux-confirm-stack" : "ux-confirm-row"}>
          {first}
          {alt2Label && onAlt2 && <CBtn onClick={onAlt2}>{machineWords(alt2Label)}</CBtn>}
          {altLabel && onAlt && !altAfter && <CBtn onClick={onAlt}>{words(altLabel)}</CBtn>}
          {second}
          {altLabel && onAlt && altAfter && <CBtn onClick={onAlt}>{machineWords(altLabel)}</CBtn>}
        </div>
      }
    >
      {fileRows?.length ? (
        <>
          <ul className="ux-confirm-items ux-confirm-files">
            {fileRows.map((row, i) => (
              <li key={i}>
                <code>{row.path}</code> <DuplicateChip>{machineWords(row.tag)}</DuplicateChip>
              </li>
            ))}
          </ul>
          {note ? <p className="ux-sheet-lede">{machineWords(note)}</p> : undefined}
        </>
      ) : items?.length && itemsLabel ? (
        <Details summary={itemsLabel}>
          <ul className="ux-confirm-items">
            {items.map((item, i) => (
              <li key={i}>{machineWords(item)}</li>
            ))}
          </ul>
        </Details>
      ) : items?.length ? (
        <>
          <ul className="ux-confirm-items">
            {items.map((item, i) => (
              <li key={i}>{machineWords(item)}</li>
            ))}
          </ul>
          {note ? (
            <p className="ux-sheet-lede">{machineWords(note)}</p>
          ) : body ? (
            <p className="ux-sheet-lede">{machineWords(body)}</p>
          ) : undefined}
        </>
      ) : hint ? (
        // 1.173.0 (C2): a quiet sentence in the body.
        <p className="ux-sheet-hint">{words(hint)}</p>
      ) : undefined}
      {agreement ? (
        <CheckLine checked={agreed} onChange={setAgreed}>
          {agreement}
        </CheckLine>
      ) : undefined}
      {link ? (
        <p className="ux-sheet-lede">
          <CBtn tone="quiet" onClick={() => void openWebLink(link.url).catch((e: unknown) => pushToast(linkDidNotOpen(link.url, e)))}>
            {link.label}
          </CBtn>
        </p>
      ) : undefined}
    </Sheet>
  );
}
