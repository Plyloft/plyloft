// 1.175.0 F8 (UX-12, owner I10): the card page's troubles, drawn the one
// way: the first in `cardErrorNow`'s order leads Now (`NowErrorView` for
// `CardStateHeader`), the others wait at the top of the card's Details
// (`ToLookAt`). The words are `lib/cardErrorNow.ts`'s; the presses stay
// the card page's (`CardDetailPanel`), handed in as `onAction`.
import { forwardRef, type ReactNode } from "react";
import { CBtn, Details } from "./ux";
import type { NowErrorView } from "./CardStateHeader";
import { errorForMachine, type UxError } from "../lib/uxError";
import {
  SHOW_WAYS_OUT_LABEL,
  TO_LOOK_AT_LABEL,
  detailsErrorLine,
  nowErrorLine,
  nowErrorTitle,
  nowErrorWays,
  type CardTroubleKind,
} from "../lib/cardErrorNow";
import { cardActionError as actionFailedError, mergeConflictPaths, startBranchMissingError, startNeedsSetUpError } from "../lib/cardPage";
import { CONFLICT_FIX_ACTION } from "../lib/shipConflict";
import { LocalBranchBlock } from "./errors/LocalBranchBlock";
import { UnpublishedReleaseBlock } from "./errors/UnpublishedReleaseBlock";

/** One open trouble: its error, and where its presses go. */
export type Trouble = { error: UxError; onAction: (id: string) => void };

/** The Builder store's error (`errorByCard`) in the error shape. */
export function builderErrorUx(
  e: { action: string; cause: string; setUp?: true; missingBranch?: string } | null | undefined,
  areaName: string | null,
): UxError | null {
  if (!e) return null;
  if (e.missingBranch) return startBranchMissingError(e.action, e.missingBranch, areaName, e.cause);
  if (e.setUp) return startNeedsSetUpError(e.action, e.cause);
  return actionFailedError(e.action, e.cause);
}

/** F8 (card-page.html §6): a ship stopped on a conflict offers the
 *  conflict's own press, Fix with the Builder, when the card has a Builder
 *  (`offered`). */
export function withConflictFix(error: UxError | null, cause: string | null, offered: boolean): UxError | null {
  if (!error || !cause || !offered || !mergeConflictPaths(cause)) return error;
  if (error.actions.some((a) => a.id === CONFLICT_FIX_ACTION.id)) return error;
  return { ...error, actions: [{ ...CONFLICT_FIX_ACTION, primary: true }, ...error.actions] };
}

/** The error that leads Now: its title without the full stop, one line,
 *  its one way on and Dismiss; the tool's output, the error's other ways
 *  and `extra` (the conflicting files) under its Details. */
export function nowErrorView(
  lead: Trouble,
  extra?: { before?: ReactNode; showFiles?: () => void; retryTitle?: string },
): NowErrorView {
  const e = errorForMachine(lead.error);
  const ways = nowErrorWays(e);
  const others = e.actions.filter((a) => a.id !== "dismiss" && a.id !== ways.primary?.id);
  // Challenger block 5 (item 5): with Ask the Builder to commit them as its
  // way on, Show the files sits beside the list.
  const after =
    extra?.showFiles && e.actions.some((a) => a.id === "ask-commit") && !others.some((a) => a.id === "show-files") ? (
      <CBtn tone="quiet" onClick={extra.showFiles}>
        Show the files
      </CBtn>
    ) : null;
  const hasMore = Boolean(e.todo.trim() || e.details || others.length > 0 || extra?.before || after);
  return {
    title: nowErrorTitle(e.title),
    name: e.title,
    line: nowErrorLine(e),
    primary: ways.primary
      ? { id: ways.primary.id, label: ways.primary.label, title: ways.primary.id === "retry" ? extra?.retryTitle : undefined }
      : null,
    onAction: lead.onAction,
    details: hasMore ? (
      <>
        {/* What to do, in today's words: Now's line says what happened. */}
        {e.todo.trim() && <p className="ux-error-sentence">{e.todo}</p>}
        {extra?.before}
        {e.details && <pre className="ux-error-output">{e.details}</pre>}
        {(others.length > 0 || after) && (
          <div className="ux-error-details-action">
            {others.map((a) => (
              <CBtn key={a.id} tone={a.danger ? "danger" : "quiet"} onClick={() => lead.onAction(a.id)}>
                {a.label}
              </CBtn>
            ))}
            {after}
          </div>
        )}
      </>
    ) : undefined,
  };
}

/** The refused ship's own blocks (`errorBlockStore`): each draws itself
 *  only for this card's refusal. */
export function ShipRefusalBlocks({ workspaceId, cardId, onPublish }: { workspaceId: string; cardId: string; onPublish: () => void }) {
  return (
    <>
      <LocalBranchBlock workspaceId={workspaceId} on="card-ship" cardId={cardId} />
      <UnpublishedReleaseBlock workspaceId={workspaceId} cardId={cardId} onPublish={onPublish} />
    </>
  );
}

/** The top of the card's Details while troubles wait there: each in one
 *  line with its way on (or Dismiss); a refused ship keeps its own block,
 *  behind Show the ways out. Takes focus from Now's Show. */
export const ToLookAt = forwardRef<
  HTMLElement,
  { kinds: readonly CardTroubleKind[]; troubleOf: (k: CardTroubleKind) => Trouble | null; refusal: ReactNode }
>(function ToLookAt({ kinds, troubleOf, refusal }, ref) {
  if (kinds.length === 0) return null;
  return (
    <section className="ux-card-more" aria-label={TO_LOOK_AT_LABEL} tabIndex={-1} ref={ref} data-ply-card-to-look-at="">
      <h3 className="ux-card-field-label">{TO_LOOK_AT_LABEL}</h3>
      {kinds.map((kind) => {
        if (kind === "ship-refused") {
          return (
            <Details key={kind} summary={SHOW_WAYS_OUT_LABEL}>
              {refusal}
            </Details>
          );
        }
        const t = troubleOf(kind);
        if (!t) return null;
        const e = errorForMachine(t.error);
        // F8 round 2: the same as it would be in Now — its way on, Dismiss,
        // and under its own Details what to do, the output and its other ways.
        const view = nowErrorView(t);
        return (
          <div key={kind} data-ply-to-look-at={kind}>
            <div className="ux-card-session-note">
              <span className="ux-card-muted-inline">{detailsErrorLine(e)}</span>
              {view.primary && (
                <CBtn tone="quiet" onClick={() => t.onAction(view.primary!.id)}>
                  {view.primary.label}
                </CBtn>
              )}
              <CBtn tone="quiet" onClick={() => t.onAction("dismiss")}>
                Dismiss
              </CBtn>
            </div>
            {view.details && <Details>{view.details}</Details>}
          </div>
        );
      })}
    </section>
  );
});
