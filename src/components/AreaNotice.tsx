// 1.173.0 (B2): what the Board says about areas, where the shared-setup
// notice lives (mockup areas.html scene 1):
// - the repository's areas can't be used (B1's `problem`): held — no card
//   can start, ship or release — or kept, on the last good ones;
// - otherwise, once, "This repository seems to hold two products…" with
//   *Set up areas…* and *Don't ask again* (for good, on this Mac; C7, BCI-3)
//   — 1.174.0 (C10, D6): also where nothing is shared, saying where they stay.
// 1.174.0 (A4): a note in the Board's one slot (BoardNotices), bordered.
import { useEffect, useRef, useState } from "react";
import { CBtn, Sheet } from "./ux";
import { areasAnswerSetAside } from "../ipc";
import { areasSummary, type BoardNoteView } from "../lib/boardNotices";
import { machineWords } from "../lib/platform";
import {
  AREA_NOTICE_DONT_ASK,
  SET_UP_AREAS,
  areaProblemLine,
  discoveryLines,
  discoveryShown,
  discoveryTitleParts,
  discoveryWanted,
} from "../lib/areaPicker";
import {
  PUBLISH_MINE,
  USE_THE_REPOSITORY_S,
  areasChoiceBody,
  areasChoiceKind,
  areasChoiceLede,
  areasChoiceTitle,
  noticeKeptLine,
} from "../lib/areasPage";
import { openAreasSettings, useAreaDiscovery, useAreas, useAreasView } from "../store/areaStore";
import { useSetupShareable } from "./AdoptionBanner";
import { useWorkspaces } from "../store/workspaceStore";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { pushErrorToast } from "../lib/errorToast";

/**
 * The areas' note: broken (the repository's areas can't be used) or, once,
 * the products Plyloft sees. A4: every button bordered — the Board's one
 * filled button is New card (mockups/board.html §1, §3).
 */
export function useAreaNotice(workspaceId: string): BoardNoteView | null {
  const view = useAreasView(workspaceId);
  const dismissed = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.areaNoticeDismissed ?? false,
  );
  // Looked for only where it could be shown: no areas, none broken, not
  // answered, and only where Set up areas… can save them.
  const looks = discoveryWanted(view, dismissed);
  const discovery = useAreaDiscovery(workspaceId, looks);
  const [busy, setBusy] = useState(false);
  // 1.174.0 (C10, D6 §3): where nothing is shared, the notice says where the
  // areas will stay.
  const notShared = !!view && !view.shared;
  const { shareable, loading } = useSetupShareable(workspaceId, notShared && looks);

  const problem = areaProblemLine(view);
  if (problem) {
    return {
      id: "areas",
      kind: "broken",
      summary: areasSummary(true),
      body: (
        <div
          className={`adoption-banner adoption-banner--${problem.held ? "held" : "kept"}`}
          role="status"
          data-ply-area-problem={problem.held ? "held" : "kept"}
        >
          <div className="adoption-banner-text">
            <span>{machineWords(problem.text)}</span>
          </div>
          <div className="adoption-banner-actions">
            <CBtn onClick={() => openAreasSettings(workspaceId)}>Fix them</CBtn>
          </div>
        </div>
      ),
    };
  }

  if (!discovery || !discoveryShown(discovery, view, dismissed)) return null;
  // Round 1: held until it is known whether Share is offered.
  if (loading) return null;
  const [, body] = discoveryLines(discovery);
  return {
    id: "areas",
    kind: "areas",
    summary: areasSummary(false, discovery.products.length),
    body: (
      <div className="adoption-banner adoption-banner--areas" role="region" aria-label="Products in this repository">
        <div className="adoption-banner-text">
          <span className="adoption-banner-lead">
            {discoveryTitleParts(discovery).map((part, i) =>
              part.strong ? <strong key={i}>{part.text}</strong> : <span key={i}>{part.text}</span>,
            )}
          </span>
          <span>
            {body}
            {notShared && <> {machineWords(noticeKeptLine(shareable))}</>}
          </span>
        </div>
        <div className="adoption-banner-actions">
          <CBtn disabled={busy} onClick={() => openAreasSettings(workspaceId, discovery.suggestion)}>
            {SET_UP_AREAS}
          </CBtn>
          <CBtn
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void useWorkspaces
                .getState()
                .dismissAreaNotice(workspaceId)
                .catch((err) => {
                  setBusy(false);
                  // TX6 (E12): the title names the press, so it follows its label.
                  pushErrorToast(`“${AREA_NOTICE_DONT_ASK}” wasn't saved`, err, { then: "The note stays above the Board. Try again." });
                });
            }}
          >
            {AREA_NOTICE_DONT_ASK}
          </CBtn>
        </div>
      </div>
    ),
  };
}

/**
 * 1.174.0 (C10, D6; mockup areas.html §4b, owner's answer 12): the setup
 * came in from the repository with other areas than the ones kept on this
 * Mac, which were set aside. One sheet over the Board, its focus on the
 * safe answer: "Use the repository's" writes nothing to the repository (the
 * list stays set aside here, in its own file); "Publish mine" is one edit of
 * the shared areas. Esc leaves the question for the next time the Board
 * opens; the repository's areas apply meanwhile.
 */
export function AreasChoiceSheet({ workspaceId }: { workspaceId: string }) {
  const view = useAreasView(workspaceId);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<"theirs" | "mine" | null>(null);
  const safe = useRef<HTMLButtonElement>(null);
  // Only on the Board on screen: every warmed workspace keeps its Board
  // mounted, hidden, and a sheet there would take the focus.
  const shown = useWorkspaces((s) => s.activeId === workspaceId);
  const onBoard = useUi((s) => effectiveCenterMode(s.centerMode, workspaceId) === "board");
  // Nor under another surface (as the Board's own keys, KanbanBoard).
  const covered = useUi((s) => s.palette.open || s.settingsOverlayOpen || s.releaseSheet !== null);
  // Round 1: closed with Esc, it asks again the next time the Board is on
  // screen.
  const visible = shown && onBoard;
  useEffect(() => {
    if (!visible) setClosedFor(null);
  }, [visible]);
  const mine = view?.setAside;
  if (!view || !mine?.length || closedFor === workspaceId || !visible || covered) return null;
  const kind = areasChoiceKind(view);

  const answer = async (publishMine: boolean) => {
    setBusy(publishMine ? "mine" : "theirs");
    try {
      await areasAnswerSetAside(workspaceId, publishMine);
      await useAreas.getState().load(workspaceId);
    } catch (e) {
      pushErrorToast(`“${publishMine ? PUBLISH_MINE : USE_THE_REPOSITORY_S}” didn't go through`, e, { then: "The sheet asks again next time." });
      setClosedFor(workspaceId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      size="confirm"
      title={areasChoiceTitle(kind)}
      lede={machineWords(areasChoiceLede(view.areas, mine, kind))}
      onClose={() => setClosedFor(workspaceId)}
      canDismiss={busy === null}
      initialFocusRef={safe}
      actions={
        <>
          {!view.readOnly && (
            <CBtn disabled={busy !== null} onClick={() => void answer(true)} data-ply-areas-publish-mine="">
              {PUBLISH_MINE}
            </CBtn>
          )}
          <CBtn
            ref={safe}
            tone="accent"
            disabled={busy !== null}
            onClick={() => void answer(false)}
            data-ply-areas-use-theirs=""
          >
            {USE_THE_REPOSITORY_S}
          </CBtn>
        </>
      }
    >
      <p className="ux-sheet-text">{machineWords(areasChoiceBody(mine, !view.readOnly, kind))}</p>
    </Sheet>
  );
}
