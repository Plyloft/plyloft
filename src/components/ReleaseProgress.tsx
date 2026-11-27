import { useRef, useState } from "react";
import { openWebLink, shipReleaseUpdate, type PendingReleaseView, type ReleaseKind, type ReleasePrRecord, type ShipResult } from "../ipc";
import {
  STOP_THE_RELEASE,
  progressNote,
  progressSteps,
  releasePageUrl,
  releasedWords,
  stopOffered,
  stoppedReleaseWords,
  type ProgressState,
} from "../lib/releaseSheet";
import { releasePrStopped } from "../lib/uxError";
import { linkDidNotOpen } from "../lib/linkToast";
import { machineWords } from "../lib/platform";
import { refreshPendingRelease } from "../store/errorBlockStore";
import { pushToast } from "../store/toastStore";
import { DismissPendingReleaseButton } from "./errors/DismissPendingRelease";
import { CBtn, Details, Icon, Sheet, StatusLine } from "./ux";

const UPDATE_FAILED = "Plyloft couldn't update the release. Try again in a moment.";

const STATE_DOT: Record<ProgressState, "done" | "running" | "empty" | "warn" | "aborted"> = {
  done: "done", // drawn as a tick, not a dot (G2 walk)
  running: "running",
  todo: "empty",
  warn: "warn",
  failed: "aborted",
};

/**
 * 1.174.0 (DR4, release.html states 6–9, 11): the Release sheet following
 * a release — on its way (a row per step, the dot only on the step under
 * way, Stop, Open on GitHub, Update the release), done (every step ticked,
 * Open the release page, Done), or stopped where only the person can move
 * it on (why, what stays, Dismiss). Close lets it go: the sidebar's row and
 * Release <Area>… reopen it.
 */
export function ReleaseFollow({
  workspaceId,
  tag,
  branch,
  kind,
  throughPr,
  pr,
  problem,
  making = false,
  readyCards = 0,
  stage,
  cardCount,
  lede,
  done,
  pressing,
  canStop,
  stopping,
  failure,
  onStop,
  onContinue,
  onClose,
  onReread,
  heldInstall = null,
}: {
  workspaceId: string;
  tag: string;
  branch: string;
  kind: ReleaseKind;
  throughPr: boolean;
  pr: ReleasePrRecord | null;
  problem: string | null;
  /** DR4 round 1: the press runs, no record yet. */
  making?: boolean;
  /** Cards of its own (they are still ready if it stopped). */
  readyCards?: number;
  stage: NonNullable<PendingReleaseView["stage"]>;
  cardCount: number;
  lede: string;
  done: { result: ShipResult; cards: number; others: number; tag: string } | null;
  pressing: boolean;
  canStop: boolean;
  stopping: boolean;
  failure: { line: string; details: string | null } | null;
  onStop: () => void;
  onContinue: () => void;
  onClose: () => void;
  onReread: () => void;
  /** 1.176.1: the install step waits for this Mac's OK; its toast's press is
   *  offered here too, where a toast over a sheet can't be reached by key. */
  heldInstall?: { label: string; onClick: () => void } | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [updating, setUpdating] = useState(false);
  const [updateFailed, setUpdateFailed] = useState<string | null>(null);
  const step = done ? "tagged" : (pr?.step ?? null);
  const stoppedHere = pr !== null && releasePrStopped(pr);
  const steps = progressSteps({ tag, branch, kind, throughPr, step, pr, stopped: stoppedHere, done: done !== null, making });
  const note = done || problem ? null : progressNote({ tag, branch, throughPr, step, pr });
  const prUrl = done?.result.releasePr?.url ?? pr?.url ?? null;
  // Re-walk (Mac): a record at Tagged is released, whatever told the sheet.
  const finished = done !== null || pr?.step === "tagged";
  const pageUrl = finished && kind === "github" ? releasePageUrl(prUrl, tag) : null;
  const open = (url: string) => void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
  const words = finished
    ? releasedWords({
        tag,
        cards: done?.cards ?? cardCount,
        otherChanges: done?.others ?? 0,
        prNumber: done?.result.releasePr?.number ?? pr?.number ?? null,
        page: pageUrl !== null,
        throughPr,
      })
    : problem
      ? stoppedReleaseWords(tag, problem, branch, readyCards)
      : { title: `Releasing ${tag}`, lede };
  const update = () => {
    setUpdating(true);
    setUpdateFailed(null);
    shipReleaseUpdate(workspaceId)
      .then((said) => pushToast({ kind: "info", title: `${tag} was updated`, body: machineWords(said) }))
      .catch((e: unknown) => setUpdateFailed(typeof e === "string" ? e : UPDATE_FAILED))
      .finally(() => {
        setUpdating(false);
        void refreshPendingRelease(workspaceId);
        onReread();
      });
  };
  const showStop = !done && !problem && canStop && stopOffered(step) && (pressing || pr !== null);
  const primary: { label: string; act: () => void; off: boolean } | null = finished
    ? { label: "Done", act: onClose, off: false }
    : pr?.outdated && !problem
      ? { label: updating ? "Updating the release…" : "Update the release", act: update, off: updating }
      : stoppedHere && !problem
        ? { label: `Continue ${tag}`, act: onContinue, off: pressing }
        : null;
  return (
    <Sheet
      title={words.title}
      lede={words.lede}
      onClose={onClose}
      initialFocusRef={closeRef}
      actions={
        <>
          {finished && (pageUrl ?? prUrl) && (
            <CBtn onClick={() => open((pageUrl ?? prUrl)!)}>{pageUrl ? "Open the release page" : "Open on GitHub"}</CBtn>
          )}
          {finished && heldInstall && <CBtn onClick={heldInstall.onClick}>{heldInstall.label}</CBtn>}
          {showStop && (
            <CBtn onClick={onStop} disabled={stopping}>
              {STOP_THE_RELEASE}
            </CBtn>
          )}
          {!finished && prUrl && <CBtn onClick={() => open(prUrl)}>Open on GitHub</CBtn>}
          {!finished && (
            <CBtn ref={closeRef} onClick={onClose}>
              Close
            </CBtn>
          )}
          {/* One filled button: Done, Update the release (it fell behind),
              or Continue (it stopped while it was being made). */}
          {primary && (
            <CBtn ref={finished ? closeRef : undefined} tone="accent" onClick={primary.act} disabled={primary.off}>
              {primary.label}
            </CBtn>
          )}
        </>
      }
    >
      <ul className="ux-release-list" data-ply-release-progress={step ?? "pressing"}>
        {steps.map((st) => (
          <li className="ux-release-row" key={st.key} data-ply-release-step={st.state}>
            {/* G2 walk (Mac, release.html state 6): a finished step has a
                quiet tick; only the step under way (or one that warns or
                failed) has a coloured dot; one to come has a ring. */}
            {st.state === "done" ? (
              <>
                <span className="ux-release-row-icon" role="img" aria-label="Done">
                  <Icon name="current" size="sm" />
                </span>
                <span className="ux-release-row-main">
                  {machineWords(st.label)}
                  {st.sub && <span className="ux-release-row-hint">{machineWords(st.sub)}</span>}
                </span>
              </>
            ) : (
              <span className="ux-release-row-main">
                <StatusLine state={STATE_DOT[st.state]}>{machineWords(st.label)}</StatusLine>
                {st.sub && <span className="ux-release-row-hint">{machineWords(st.sub)}</span>}
              </span>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="ux-sheet-hint">{machineWords(note)}</p>}
      {(failure || updateFailed) && (
        <div className="ux-sheet-alert" role="alert">
          <p>{machineWords(updateFailed ?? failure?.line ?? "")}</p>
          {failure?.details && !updateFailed && (
            <Details>
              <pre className="ux-output">{failure.details}</pre>
            </Details>
          )}
        </div>
      )}
      {problem && (
        <div>
          <DismissPendingReleaseButton
            workspaceId={workspaceId}
            tag={tag}
            cardCount={cardCount}
            stage={stage}
            throughPr
            prOpened={pr?.number != null}
            onDismissed={onReread}
          />
        </div>
      )}
    </Sheet>
  );
}
