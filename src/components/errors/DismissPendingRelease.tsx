import { useState } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import { CBtn } from "../ui/primitives";
import { shipPendingReleaseDismiss } from "../../ipc";
import { refreshPendingRelease } from "../../store/errorBlockStore";
import { machineWords } from "../../lib/platform";
import { pushToast } from "../../store/toastStore";

/**
 * GH #222 review 2–3: the one Dismiss of a recorded, unpublished release —
 * confirm first, saying what stays on this Mac — shared by the card's Ship
 * step and the Ship / Ship batch dialogs, wherever the refusal is met. With
 * no `tag` it is the unreadable record: Dismiss removes the file.
 */
export function DismissPendingReleaseDialog({
  workspaceId,
  tag,
  cardCount,
  stage = "tagged",
  throughPr = false,
  prOpened = true,
  onClose,
  onDismissed,
  onFailed,
}: {
  workspaceId: string;
  tag: string | null;
  cardCount: number;
  /** Review 4: `committing` — the commit and tag may not exist, and a staged
   *  merge may be left, so the words don't promise either. */
  stage?: "committing" | "tagged";
  /** G8 fixes (1.170.0): a release through a pull request — nothing of it
   *  is on this computer's target; its pull request stays on GitHub. */
  throughPr?: boolean;
  /** G2 walk (Mac): no pull request of this release was opened (it stopped
   *  before, on an old one of the same branch, say): only its branch stays. */
  prOpened?: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  onFailed?: (reason: string) => void;
}) {
  const cardsStay = cardCount === 0 ? "" : ` ${cardCount === 1 ? "The card stays" : "Its cards stay"} unshipped.`;
  const body = tag && throughPr && !prOpened
    ? `Plyloft stops following ${tag}. Its release branch stays on GitHub; no pull request of this release was opened.${cardsStay}`
    : tag && throughPr
    ? `Plyloft stops following ${tag}. Its pull request and its branch stay on GitHub (close them ` +
      `there if you don't want them), and Plyloft turns off merging it when its checks pass, so it ` +
      `isn't merged by itself. ${cardCount === 1 ? "The card stays" : "Its cards stay"} unshipped.`
    : tag && stage === "committing"
    ? `Plyloft forgets the release it was making (${tag}). It stopped part way: the release commit ` +
      `and the tag ${tag} may not exist, and a staged merge may be left in your project folder. Check ` +
      `git status for a staged merge, and git log / git tag. Nothing on GitHub changes.`
    : tag
    ? `Plyloft stops offering to publish ${tag}. The release commit and the tag ${tag} stay on ` +
      `this Mac only, ${cardCount === 1 ? "the card stays" : "its cards stay"} unshipped, and ` +
      `nothing on GitHub changes.`
    : "Plyloft removes its record of an unpublished release, which it can't read. Any release " +
      "commit and tag stay on this Mac only, and nothing on GitHub changes.";
  return (
    <ConfirmDialog
      title={tag ? `Dismiss ${tag}?` : "Dismiss the unreadable release record?"}
      body={machineWords(body)}
      confirmLabel="Dismiss"
      destructive
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        shipPendingReleaseDismiss(workspaceId)
          .then((said) => {
            // G8 fixes: what was done on GitHub (auto-merge turned off).
            if (said) pushToast({ kind: "info", title: `${tag ?? "The release"} was dismissed`, body: machineWords(said) });
          })
          .then(() => refreshPendingRelease(workspaceId))
          .then(() => onDismissed?.())
          .catch((e: unknown) => onFailed?.(String(e)));
      }}
    />
  );
}

/** A `Dismiss…` button that opens the dialog above — for the Ship dialogs. */
export function DismissPendingReleaseButton(props: {
  workspaceId: string;
  tag: string | null;
  cardCount: number;
  stage?: "committing" | "tagged";
  throughPr?: boolean;
  prOpened?: boolean;
  onDismissed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <CBtn onClick={() => setOpen(true)}>
        {props.tag ? `Dismiss ${props.tag}…` : "Dismiss the record…"}
      </CBtn>
      {failed && <span className="ux-inline-alert"> Couldn&apos;t dismiss it: {failed}</span>}
      {open && (
        <DismissPendingReleaseDialog
          {...props}
          onClose={() => setOpen(false)}
          onFailed={setFailed}
        />
      )}
    </>
  );
}
