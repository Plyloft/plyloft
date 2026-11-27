// F1 (1.172.1, owner 2026-10-28): the changes sheet — what is in the way of
// GitHub's updates in the project folder, instead of opening files in Code.
// "2 changes in your project folder — not saved in Git yet, so GitHub's
// updates can't come in." Each file with its lines added and removed, its
// changes drawn as the review draws them, Open per file; *Ask Claude to save
// them* opens Claude in the folder and asks it to save them (Claude does
// it in view — Plyloft writes nothing to Git itself); *Sync again*.
import { useEffect, useState } from "react";
import { CBtn, Details, Sheet, StatusLine } from "./ux";
import { DiffFiles } from "./CardReviewPanel";
import { useProjectFolder } from "../store/projectFolderStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useTiles } from "../store/tileStore";
import { openCenterMode, useUi } from "../store/uiStore";
import { projectFolderChangesDetail, type FolderChanges } from "../ipc";
import { openInEditor } from "../lib/openInEditor";
import { joinPath } from "../lib/paths";
import { hunkLineCounts } from "../lib/diffSummary";
import { saveChangesPrompt, SYNC_AGAIN } from "../lib/worktreeBase";

export const ASK_CLAUDE_TO_SAVE = "Ask Claude to save them";
/** The Claude tile's name. */
export const SAVE_CHANGES_TILE = "Save the changes";

/** "2 changes in your project folder". */
export function folderChangesTitle(n: number): string {
  return n === 1 ? "1 change in your project folder" : `${n} changes in your project folder`;
}

export const FOLDER_CHANGES_LEDE = "Not saved in Git yet, so GitHub's updates can't come in.";
/** TX5 round 1 (T30b): the same sheet, opened from a ship it stopped. */
export const FOLDER_CHANGES_SHIP_LEDE = "Plyloft won't ship into your project folder while these aren't saved in a commit.";
export const FOLDER_CHANGES_SHIP_EMPTY = "Nothing is in the way any more. Ship it again.";
const FOLDER_CHANGES_SYNC_EMPTY = "Nothing is in the way any more. Sync again to bring in GitHub's updates.";

export function FolderChangesSheet() {
  const workspaceId = useProjectFolder((s) => s.sheetFor);
  if (!workspaceId) return null;
  return <FolderChangesSheetView key={workspaceId} workspaceId={workspaceId} />;
}

function FolderChangesSheetView({ workspaceId }: { workspaceId: string }) {
  const close = useProjectFolder((s) => s.closeSheet);
  const fromShip = useProjectFolder((s) => s.sheetReason === "ship");
  const folder = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.cwd ?? null);
  const [changes, setChanges] = useState<FolderChanges | null>(null);
  const [state, setState] = useState<"reading" | "read" | "failed">("reading");

  useEffect(() => {
    let gone = false;
    projectFolderChangesDetail(workspaceId)
      .then((c) => {
        if (gone) return;
        setChanges(c);
        setState(c ? "read" : "failed");
      })
      .catch(() => {
        if (!gone) setState("failed");
      });
    return () => {
      gone = true;
    };
  }, [workspaceId]);

  const total = changes?.totalCount ?? 0;
  const files = changes?.files ?? [];

  const syncAgain = () => {
    close();
    void useKanban.getState().reconcileGithub(workspaceId, { manual: true }).catch(() => {});
  };

  const open = (rel: string) => {
    if (!folder) return;
    void openInEditor(workspaceId, joinPath(folder, rel), rel).then((ok) => {
      if (!ok) return;
      close();
      const ui = useUi.getState();
      if (ui.settingsOverlayOpen) ui.setSettingsOverlayOpen(false);
      openCenterMode(workspaceId, "code");
    });
  };

  const askClaude = () => {
    if (!folder) return;
    const paths = files.map((f) => f.path);
    const tile = useTiles
      .getState()
      .addClaudeTile(workspaceId, folder, { args: [saveChangesPrompt(paths, Math.max(0, total - paths.length))], label: SAVE_CHANGES_TILE });
    close();
    openCenterMode(workspaceId, "terminals");
    useTiles.getState().setExpanded(workspaceId, tile.id);
    const ui = useUi.getState();
    if (ui.settingsOverlayOpen) ui.setSettingsOverlayOpen(false);
  };

  // Challenger 4: a neutral title until the changes are read.
  const title =
    state !== "read"
      ? "Changes in your project folder"
      : total === 0
        ? "No changes in your project folder now"
        : folderChangesTitle(Math.max(total, files.length));

  return (
    <Sheet
      title={title}
      lede={
        state === "read" && total === 0
          ? fromShip
            ? FOLDER_CHANGES_SHIP_EMPTY
            : FOLDER_CHANGES_SYNC_EMPTY
          : fromShip
            ? FOLDER_CHANGES_SHIP_LEDE
            : FOLDER_CHANGES_LEDE
      }
      size="wide"
      onClose={close}
      actions={
        <>
          <CBtn onClick={close}>Close</CBtn>
          {!fromShip && <CBtn onClick={syncAgain}>{SYNC_AGAIN}</CBtn>}
          {total > 0 && (
            <CBtn tone="accent" onClick={askClaude} disabled={!folder}>
              {ASK_CLAUDE_TO_SAVE}
            </CBtn>
          )}
        </>
      }
    >
      <div data-ply-folder-changes="">
        {state === "reading" && <StatusLine state="running">Reading the changes…</StatusLine>}
        {state === "failed" && (
          <StatusLine state="aborted">Plyloft couldn't read the folder's changes. Open the project folder in Code to see them.</StatusLine>
        )}
        {files.map((file) => {
          const lines = hunkLineCounts(file);
          return (
            <div key={file.path} data-ply-folder-change={file.path}>
              <p className="folder-change-line">
                <code>{file.path}</code>
                <span className="folder-change-count">
                  +{lines.added} −{lines.removed}
                </span>
                <CBtn size="sm" onClick={() => open(file.path)} disabled={!folder || file.kind === "removed"}>
                  Open
                </CBtn>
              </p>
              <Details summary="The changes" open={files.length <= 3}>
                <DiffFiles cardId="project-folder" files={[file]} />
              </Details>
            </div>
          );
        })}
        {changes?.truncated && <p className="folder-change-line">And more files, not shown here.</p>}
      </div>
    </Sheet>
  );
}
