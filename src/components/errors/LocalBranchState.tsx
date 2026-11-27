import { CBtn, Callout, Details } from "../ux";
import { useErrorBlocks } from "../../store/errorBlockStore";
import { localBranchAction } from "../../store/kanbanStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { useAnsweredAsk } from "../../store/projectFolderStore";
import {
  BRING_UP_TO_DATE,
  WORK_HERE_AGAIN,
  localBranchStateKey,
  localBranchSyncToast,
  projectFolderAsk,
  type LocalBranchPress,
} from "../../lib/worktreeBase";
import { machineWords } from "../../lib/platform";
import { folderSummary, type BoardNoteView } from "../../lib/boardNotices";

/**
 * E3 (owner, 2026-10-28): the local branch's lasting state, on the pages it
 * concerns — the Board, beside its Sync, and Settings › Board and worktrees. A Sync nobody pressed says it in
 * a toast once (`localBranchNoticeSay`); here it stays, in the toast's own
 * words and with the same press, for as long as the last Sync found it.
 * GH #102's refusal is not this: it has its own block (`LocalBranchBlock`).
 *
 * F1 (1.172.1): the project folder's ask ("Your project folder is from
 * 16 Sep") is one of these states. On the Board it goes once answered —
 * *I don't work here* (persisted), or *Bring it up to date* — while
 * Settings keeps it with the way back. The notice's icon is the toast's
 * kind (item 7), on the calm surface; the facts are under Details.
 */
export function LocalBranchState({
  workspaceId,
  on = "settings",
}: {
  workspaceId: string;
  /** The Board shows only what its Sync can help with (round 3): changes in
   *  the folder, open in another folder, couldn't update — both moved stays
   *  on Settings › Board and worktrees. */
  on?: "board" | "settings";
}) {
  const report = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.localState ?? null);
  const dontWorkHere = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.dontWorkHere ?? false);
  const board = useLocalBranchNotice(workspaceId);
  if (on === "board") return <>{board?.body ?? null}</>;
  const ask = report ? projectFolderAsk(report) : null;
  const said = report ? localBranchSyncToast(report) : null;
  const wayBack = dontWorkHere;
  if (!report || !said) return wayBack ? <DontWorkHereRow workspaceId={workspaceId} /> : null;
  // Settings' way back: "I don't work here" becomes "Tell me again".
  const presses = (said.presses ?? []).map((p) => {
    const kind: LocalBranchPress = wayBack && p.kind === "dont-work-here" ? "work-here" : p.kind;
    const label = kind === "work-here" ? WORK_HERE_AGAIN : p.label;
    return { ...localBranchAction(workspaceId, kind, label), primary: label === BRING_UP_TO_DATE };
  });
  return (
    <div data-ply-folder-state={ask ? "ask" : report.outcome.kind}>
      <Callout
        kind="info"
        iconTone={said.kind === "warn" ? "warn" : undefined}
        title={machineWords(said.title)}
        text={
          machineWords(said.body) +
          (ask && wayBack ? " You said you don't work here, so the Board doesn't ask." : "")
        }
        actions={
          presses.length > 0 ? (
            <>
              {presses.map((p) => (
                <CBtn key={p.label} tone={p.primary ? "accent" : "ghost"} onClick={p.onClick}>
                  {p.label}
                </CBtn>
              ))}
            </>
          ) : undefined
        }
      />
      {said.details && (
        <Details>
          <pre className="ux-output">{said.details}</pre>
        </Details>
      )}
    </div>
  );
}

/**
 * 1.174.0 (A4): the project folder's state as a note for the Board's one
 * slot (BoardNotices), or null — what the Board's Sync can help with: changes
 * in the folder, open in another folder, couldn't update, and the folder's
 * ask until it is answered. Both moved stays on Settings › Board and
 * worktrees. Its presses are bordered: the Board's one filled button is New
 * card (mockups/board.html §3: "Bring it up to date" was filled).
 */
export function useLocalBranchNotice(workspaceId: string): BoardNoteView | null {
  const report = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.localState ?? null);
  const dontWorkHere = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.dontWorkHere ?? false);
  const answered = useAnsweredAsk(workspaceId);
  const ask = report ? projectFolderAsk(report) : null;
  const said = report ? localBranchSyncToast(report) : null;
  if (!report || !said) return null;
  if (report.outcome.kind === "diverged") return null;
  if (ask && (dontWorkHere || answered === localBranchStateKey(report))) return null;
  const presses = (said.presses ?? []).map((p) => localBranchAction(workspaceId, p.kind, p.label));
  return {
    id: "folder",
    kind: "folder",
    summary: machineWords(folderSummary(!!ask, said.title)),
    body: (
      <div data-ply-folder-state={ask ? "ask" : report.outcome.kind}>
        <Callout
          kind="info"
          iconTone={said.kind === "warn" ? "warn" : undefined}
          title={machineWords(said.title)}
          text={machineWords(said.body)}
          actions={
            presses.length > 0 ? (
              <>
                {presses.map((p) => (
                  <CBtn key={p.label} onClick={p.onClick}>
                    {p.label}
                  </CBtn>
                ))}
              </>
            ) : undefined
          }
        />
        {said.details && (
          <Details>
            <pre className="ux-output">{said.details}</pre>
          </Details>
        )}
      </div>
    ),
  };
}

/** F1: Settings' state after *I don't work here* with nothing to ask now. */
function DontWorkHereRow({ workspaceId }: { workspaceId: string }) {
  const back = localBranchAction(workspaceId, "work-here", WORK_HERE_AGAIN);
  return (
    <div data-ply-folder-state="dont-work-here">
      <Callout
        kind="info"
        title="You don't work in the project folder"
        text="The Board doesn't say when it falls behind GitHub. Code and terminals opened there still say which version they show."
        actions={<CBtn onClick={back.onClick}>{back.label}</CBtn>}
      />
    </div>
  );
}
