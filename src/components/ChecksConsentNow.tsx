// 1.175.0 B2 (SEC-4): what Now says under "The checks need your OK" — who
// changed the repository's checks and when, what this computer allowed and
// what the repository has now, a step per line, and which step differs.
// The one press is Now's own button (Allow and run, `allowChecksAndRun`).
import { useEffect, useState } from "react";
import type { KanbanCard } from "../ipc";
import {
  CHECKS_OK_COVERS,
  changedSteps,
  checksListHeadings,
  checksOkSentence,
  othersWaitingLine,
  SEE_WHAT_CHANGED,
  stepChangeSentences,
  stepWords,
  type CheckStep,
} from "../lib/checksConsent";
import { checksAllowAndRun } from "../lib/checksConsentIpc";
import { plainFailure } from "../lib/plainError";
import { machineWords } from "../lib/platform";
import { useChecksConsent } from "../store/checksConsentStore";
import { useKanban } from "../store/kanbanStore";
import { usePrAutoFix } from "../store/prAutoFixStore";
import { CBtn } from "./ux";

const cardKey = (card: Pick<KanbanCard, "workspaceId" | "id">) => `${card.workspaceId}::${card.id}`;

/** Now's press. The OK is for the steps on screen: if the repository's
 *  checks changed since, nothing is allowed and the sentence says to look
 *  again (the lists are re-read). */
export async function allowChecksAndRun(card: Pick<KanbanCard, "workspaceId" | "id">): Promise<void> {
  const store = useChecksConsent.getState();
  const shown = store.byWorkspace[card.workspaceId] ?? (await store.load(card.workspaceId));
  if (!shown) return;
  store.setChecksError(cardKey(card), null);
  try {
    await checksAllowAndRun(card.workspaceId, card.id, shown.checks.hash);
    await useKanban.getState().loadFromDisk(card.workspaceId, true);
  } catch (e) {
    // The backend's own sentence: "The checks changed since you looked…" or
    // "Plyloft couldn’t record your choice…". Nothing ran.
    store.setChecksError(cardKey(card), plainFailure(e).sentence);
    await store.load(card.workspaceId);
  }
}

function StepLines({ steps, marked, was }: { steps: readonly CheckStep[]; marked?: Set<number>; was?: boolean }) {
  return (
    <ol className={was ? "ux-versions-value ux-versions-value--was" : "ux-versions-value"}>
      {steps.map((step, i) => {
        const line = `${i + 1}. ${stepWords(step)}`;
        return <li key={i}>{marked?.has(i + 1) ? <mark>{line}</mark> : line}</li>;
      })}
    </ol>
  );
}

export function ChecksConsentNow({ card }: { card: Pick<KanbanCard, "workspaceId" | "id"> }) {
  // "Fix failing checks by itself" waits on this OK: the lists start folded
  // behind "See what changed", and the sentence says the fix is saved.
  const fix = usePrAutoFix((s) => {
    const step = s.phases[card.id]?.step;
    return step === "checking" || step === "finishing";
  });
  const view = useChecksConsent((s) => s.byWorkspace[card.workspaceId]?.checks);
  const error = useChecksConsent((s) => s.checksErrors[cardKey(card)] ?? null);
  const load = useChecksConsent((s) => s.load);
  const [shown, setShown] = useState(false);
  const open = !fix || shown;
  useEffect(() => {
    void load(card.workspaceId);
  }, [card.workspaceId, card.id, load]);
  const others = useKanban(
    (s) => (s.byWorkspace[card.workspaceId]?.cards ?? []).filter((c) => c.checksHold != null && c.id !== card.id && !c.archived).length,
  );
  const othersLine = othersWaitingLine(others);
  if (!view) return null;
  const headings = checksListHeadings(view);
  const marked = changedSteps(view);
  return (
    <>
      {error && (
        <span className="ux-versions-note" role="alert">
          {error}
        </span>
      )}
      {machineWords(checksOkSentence(view, Date.now(), fix))}
      {fix && (
        <span className="ux-versions-note">
          <CBtn size="sm" tone="quiet" aria-expanded={open} onClick={() => setShown((o) => !o)}>
            {SEE_WHAT_CHANGED}
          </CBtn>
        </span>
      )}
      {open && (
        <span className="ux-versions" data-ply-checks-versions="">
          {headings.approved && (
            <div>
              <div className="ux-versions-key">{machineWords(headings.approved)}</div>
              <StepLines steps={view.approved} was />
            </div>
          )}
          <div>
            <div className="ux-versions-key">{headings.current}</div>
            <StepLines steps={view.current} marked={marked} />
          </div>
        </span>
      )}
      {open &&
        stepChangeSentences(view).map((sentence) => (
          <span key={sentence} className="ux-versions-note">
            {sentence}
          </span>
        ))}
      {/* Round 2 (G5): what the OK covers, and what else the press starts. */}
      {open && <span className="ux-versions-note">{CHECKS_OK_COVERS}</span>}
      {othersLine && <span className="ux-versions-note">{othersLine}</span>}
    </>
  );
}
