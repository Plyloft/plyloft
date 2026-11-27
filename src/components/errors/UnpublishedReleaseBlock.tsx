import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CBtn, ErrorBlock, StatusLine } from "../ux";
import { DismissPendingReleaseDialog } from "./DismissPendingRelease";
import { PENDING_RELEASE_CHANGED } from "../../ipc";
import { recordUnreadableError, releasePrStateLabel, releasePrStopped, unpublishedReleaseError } from "../../lib/uxError";
import { dismissFailedError, undoReleaseFailedError } from "../../lib/cardPage";
import { ConfirmDialog } from "../ConfirmDialog";
import { openWebLink, shipPendingReleaseUndo } from "../../ipc";
import { pushToast } from "../../store/toastStore";
import { machineWords } from "../../lib/platform";
import { refreshPendingRelease, useErrorBlocks } from "../../store/errorBlockStore";
import { linkDidNotOpen } from "../../lib/linkToast";
import { SHOW_THE_RELEASE } from "../../lib/inboxView";

/**
 * GH #222: a release committed and tagged here and recorded, not yet
 * published, on the Ship step of its cards — the surface of the operation that
 * stopped (PATTERNS.md §4). `Publish vX` opens the release dialog, which offers
 * exactly that release. Review 2: it mirrors the backend's record — read on
 * mount and on every `ship-pending-release-changed` — so it goes however the
 * record is cleared; `Dismiss` clears it after a confirm that says what stays.
 * Review 3: a record that can't be read is drawn on every card's Ship step of
 * the workspace, with Dismiss (which removes the file).
 */
export function UnpublishedReleaseBlock({
  workspaceId,
  cardId,
  onPublish,
}: {
  workspaceId: string;
  cardId: string;
  onPublish: () => void;
}) {
  const release = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.unpublished ?? null);
  const unreadable = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.unreadableRecord ?? null);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoFailed, setUndoFailed] = useState<{ cause: unknown } | null>(null);

  useEffect(() => {
    void refreshPendingRelease(workspaceId);
    let stop: (() => void) | null = null;
    let gone = false;
    void listen<string>(PENDING_RELEASE_CHANGED, (event) => {
      if (event.payload === workspaceId) void refreshPendingRelease(workspaceId);
    }).then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [workspaceId]);

  const mine = release && release.cardIds.includes(cardId) ? release : null;
  if (!mine && unreadable === null) return null;
  const error = mine ? unpublishedReleaseError(mine) : recordUnreadableError(unreadable!);
  const onAction = (id: string) => {
    if (id === "publish") onPublish();
    if (id === "dismiss") setConfirming(true);
    if (id === "undo") setUndoing(true);
    // G8: the release pull request, on GitHub.
    if (id === "open-pr" && mine?.pr?.url) {
      const url = mine.pr.url;
      void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
    }
  };
  // G8 (1.170.0): a release through a pull request on its way is a state of
  // the card, not an error: what it waits for, and the ways on.
  const waiting = mine?.pr && !mine.problem ? mine.pr : null;
  return (
    <>
      {waiting && mine ? (
        // 1.174.0 (DR4): a card in a release on its way points to the
        // Release sheet, which follows it (its steps, Stop, Update the
        // release); the card has no release of its own.
        <section className="ux-card-section" aria-label="Release pull request" data-release-pr-step={waiting.step}>
          <StatusLine state={releasePrStopped(waiting) ? "aborted" : "running"}>{`${mine.tag}: ${releasePrStateLabel(waiting)}`}</StatusLine>
          <p className="ux-page-lede">{machineWords(`This card is in ${mine.tag}. The Release sheet follows it.`)}</p>
          <div className="ux-card-section-actions">
            <CBtn onClick={onPublish}>{SHOW_THE_RELEASE}</CBtn>
          </div>
        </section>
      ) : (
        <ErrorBlock
          error={error}
          density="dense"
          onAction={onAction}
        />
      )}
      {failed && <ErrorBlock error={dismissFailedError(failed)} density="dense" />}
      {undoFailed && <ErrorBlock error={undoReleaseFailedError(undoFailed.cause)} density="dense" />}
      {undoing && mine && (
        <ConfirmDialog
          title={`Undo ${mine.tag}?`}
          body={machineWords(
            `Plyloft puts ${mine.branch} back where it was before the release and deletes the tag ` +
            `${mine.tag} on this Mac. It first checks that GitHub has neither. ` +
            `${mine.cardIds.length === 1 ? "The card keeps its" : "The cards keep their"} own copy and ` +
            `${mine.cardIds.length === 1 ? "stays" : "stay"} unshipped, and nothing on GitHub changes.`,
          )}
          confirmLabel="Undo the local release"
          destructive
          onCancel={() => setUndoing(false)}
          onConfirm={() => {
            setUndoing(false);
            setUndoFailed(null);
            shipPendingReleaseUndo(workspaceId)
              .then((words) => {
                pushToast({ kind: "info", title: `${mine.tag} was undone`, body: machineWords(words) });
              })
              .then(() => refreshPendingRelease(workspaceId))
              .catch((cause: unknown) => setUndoFailed({ cause }));
          }}
        />
      )}
      {confirming && (
        <DismissPendingReleaseDialog
          workspaceId={workspaceId}
          tag={mine ? mine.tag : null}
          cardCount={mine ? mine.cardIds.length : 0}
          stage={mine?.stage ?? "tagged"}
          throughPr={mine?.pr != null}
          onClose={() => setConfirming(false)}
          onFailed={setFailed}
        />
      )}
    </>
  );
}
