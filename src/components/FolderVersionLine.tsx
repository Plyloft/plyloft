// F1 (1.172.1, owner 2026-10-28): after *I don't work here*, Code and the
// terminals opened in the project folder keep one quiet line — "This is the
// version from 16 Sep · Bring it up to date" — so the old version is never a
// surprise. Muted, no coloured edge; only while the last Sync found the
// folder behind GitHub's target.
import { CBtn } from "./ux";
import { useErrorBlocks } from "../store/errorBlockStore";
import { useWorkspaces } from "../store/workspaceStore";
import { bringFolderUpToDate } from "../store/kanbanStore";
import { BRING_UP_TO_DATE, folderVersionLine, projectFolderAsk } from "../lib/worktreeBase";

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function inside(path: string, folder: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const f = norm(folder);
  const p = norm(path);
  if (!(p === f || p.startsWith(`${f}/`))) return false;
  // A card's copy lives under the folder too; it is the card's version.
  const rest = p.slice(f.length);
  return !/^\/\.(plyloft|atelier)-worktrees\//.test(rest);
}

/** Whether `where` (a file's path, or a tile's folder) is the project folder
 *  of `workspaceId` itself — not a card's copy. */
export function inProjectFolder(where: string | null | undefined, folder: string | null | undefined, file: boolean): boolean {
  if (!where || !folder) return false;
  return file ? inside(where, folder) : samePath(where, folder);
}

export function FolderVersionLine({
  workspaceId,
  where,
  file = false,
}: {
  workspaceId: string;
  /** The open file's path (Code) or the tile's folder (a terminal). */
  where: string | null | undefined;
  file?: boolean;
}) {
  const report = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.localState ?? null);
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null);
  if (!ws?.dontWorkHere || !report || !inProjectFolder(where, ws.cwd, file)) return null;
  const ask = projectFolderAsk(report);
  if (!ask) return null;
  return (
    <div className="folder-version-line" role="status" data-ply-folder-version="">
      <span>{folderVersionLine(ask)}</span>
      <CBtn size="sm" onClick={() => void bringFolderUpToDate(workspaceId)}>
        {BRING_UP_TO_DATE}
      </CBtn>
    </div>
  );
}
