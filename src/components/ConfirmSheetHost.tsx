import { useEffect } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { answerConfirm, answerConfirmWith, registerConfirmHost, useConfirmSheet } from "../store/confirmStore";

/**
 * GH #281: the one host of `confirmSheet` — the question at the head of the
 * queue, as the confirm Sheet. Mounted once, in the App, above the rest.
 */
export function ConfirmSheetHost() {
  const head = useConfirmSheet((s) => s.queue[0]);
  useEffect(() => registerConfirmHost(), []);
  if (!head) return null;
  return (
    <ConfirmDialog
      key={head.id}
      title={head.title}
      body={head.body}
      items={head.items}
      itemsLabel={head.itemsLabel}
      confirmLabel={head.confirmLabel}
      cancelLabel={head.cancelLabel}
      altLabel={head.altLabel}
      onAlt={head.altLabel ? () => answerConfirmWith(head.id, "alt") : undefined}
      altAfter={head.altAfter}
      note={head.note}
      hint={head.hint}
      strongCancel={head.strongCancel}
      stacked={head.stacked}
      asIs={head.asIs}
      fileRows={head.fileRows}
      alt2Label={head.alt2Label}
      onAlt2={head.alt2Label ? () => answerConfirmWith(head.id, "alt2") : undefined}
      destructive={head.destructive}
      cautious={head.cautious}
      focusCancel={head.focusCancel}
      agreement={head.agreement}
      link={head.link}
      onConfirm={() => answerConfirm(head.id, true)}
      onCancel={() => answerConfirm(head.id, false)}
      onDismiss={() => answerConfirm(head.id, false, true)}
    />
  );
}
