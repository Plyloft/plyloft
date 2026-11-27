// 1.174.0 (C11, P15; mockup next-improvement.html §5): at the first save or
// publish of two or more areas, when a direction was written for the whole
// project before it had areas, one sheet asks whether each area takes a
// copy. Focus is on *Use it for both*: it only copies (the old direction
// stays until every area has its own), and the "Not to propose again" list
// comes along. *Start fresh* writes nothing: each area's first time then
// offers *Use it for <area>* (NextImprovementSection).
import { useEffect, useRef, useState } from "react";
import { niDirectionAdoptProject, niDirectionProject, type NiBeforeAreas } from "../../ipc";
import { ADOPT_DIRECTION_HINT, START_FRESH, adoptDirectionLede, adoptDirectionTitle, useItForAreas } from "../../lib/areasPage";
import { areaName } from "../../lib/areaPicker";
import { failure, type Failure } from "../../lib/failure";
import { rawError } from "../../lib/cardPage";
import { niProblemWords } from "../../lib/nextImprovement";
import { niKey, useNextImprovement } from "../../store/nextImprovementStore";
import { useAreasView } from "../../store/areaStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { CBtn, FailureText, Sheet } from "../ux";

/** After the first save of two or more areas: read the question and, when
 *  there is one, ask it through the store, so the sheet is seen even when
 *  the save left the Areas page (the leave guard's Save). */
export async function askAboutDirection(workspaceId: string): Promise<void> {
  let ask: NiBeforeAreas | null = null;
  try {
    ask = (await niDirectionProject(workspaceId)) ?? null;
  } catch {
    // Nothing to ask is no failure of the save: each area's first time
    // still offers it.
  }
  if (ask && ask.areas.length > 0) useNextImprovement.setState({ adoptAsk: { workspaceId, ask } });
}

/** Mounted once beside the direction sheet's host (App.tsx). Shown only
 *  while its workspace is the active one (the ask waits until then); a
 *  workspace that is removed takes its ask with it. */
export function AdoptDirectionSheetHost() {
  const asked = useNextImprovement((s) => s.adoptAsk);
  const activeId = useWorkspaces((s) => s.activeId);
  const gone = useWorkspaces((s) => !!asked && s.workspaces.length > 0 && !s.workspaces.some((w) => w.id === asked.workspaceId));
  useEffect(() => {
    if (gone) useNextImprovement.setState({ adoptAsk: null });
  }, [gone]);
  if (!asked || gone || asked.workspaceId !== activeId) return null;
  return (
    <AdoptDirectionSheet
      key={asked.workspaceId}
      workspaceId={asked.workspaceId}
      ask={asked.ask}
      onClose={() => useNextImprovement.setState({ adoptAsk: null })}
    />
  );
}

export function AdoptDirectionSheet({
  workspaceId,
  ask,
  onClose,
}: {
  workspaceId: string;
  ask: NiBeforeAreas;
  onClose: () => void;
}) {
  const view = useAreasView(workspaceId);
  const names = ask.areas.map((id) => {
    const found = view?.areas.find((a) => a.id === id);
    return found ? areaName(found) : id;
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Failure | null>(null);
  const useIt = useRef<HTMLButtonElement>(null);

  const adopt = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const took = await niDirectionAdoptProject(workspaceId, ask.areas);
      const store = useNextImprovement.getState();
      for (const id of took ?? []) store.dropDirection(niKey(workspaceId, id));
      onClose();
    } catch (e) {
      setProblem(failure(niProblemWords(rawError(e), "Plyloft couldn't copy the direction."), e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      size="confirm"
      asIs
      title={adoptDirectionTitle(names)}
      lede={adoptDirectionLede(ask.direction)}
      onClose={onClose}
      canDismiss={!busy}
      initialFocusRef={useIt}
      actions={
        <>
          <CBtn disabled={busy} onClick={onClose} data-ply-adopt-direction-fresh="">
            {START_FRESH}
          </CBtn>
          <CBtn ref={useIt} tone="accent" disabled={busy} onClick={() => void adopt()} data-ply-adopt-direction="">
            {busy ? "Copying…" : useItForAreas(names)}
          </CBtn>
        </>
      }
    >
      <p className="ux-sheet-hint">{ADOPT_DIRECTION_HINT}</p>
      {problem && (
        <div role="alert">
          <FailureText failure={problem} />
        </div>
      )}
    </Sheet>
  );
}
