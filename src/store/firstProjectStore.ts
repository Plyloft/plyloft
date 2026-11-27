import { create } from "zustand";
import { workspaceSetGithubAccount } from "../ipc";
import { useWorkspaces, type Workspace } from "./workspaceStore";
import { pushErrorToast } from "../lib/errorToast";

/**
 * OB-12 (§5 step 8a "Detached HEAD", 8b "Default branch has no commits but
 * others do"): the branch cards start from, chosen in step 8 for a workspace
 * whose HEAD isn't on a branch with a commit. Plyloft never switches the
 * folder's branch; step 9 (OB-13) writes the choice as the project config's
 * target branch. Session-only: nothing here is persisted.
 */
interface FirstProjectState {
  targetBranch: Record<string, string>;
  setTargetBranch: (workspaceId: string, branch: string) => void;
}

export const useFirstProject = create<FirstProjectState>((set) => ({
  targetBranch: {},
  setTargetBranch: (workspaceId, branch) =>
    set((s) => ({ targetBranch: { ...s.targetBranch, [workspaceId]: branch } })),
}));

/**
 * OB-12 (§5 step 8, every way's end): register the workspace with the
 * existing `workspace_create` — which also makes it the active workspace, so
 * Setup's active workspace becomes it — then store its GitHub account when
 * step 8 asked for one (`workspace_set_github_account`, OB-7b). A branch
 * chosen for a detached or unborn HEAD is kept for step 9.
 */
export async function registerProject(input: {
  path: string;
  name: string;
  account?: string | null;
  targetBranch?: string | null;
}): Promise<Workspace> {
  const ws = await useWorkspaces.getState().create(input.path, input.name);
  if (input.targetBranch) useFirstProject.getState().setTargetBranch(ws.id, input.targetBranch);
  if (input.account) {
    try {
      await workspaceSetGithubAccount(ws.id, input.account);
      await useWorkspaces.getState().refresh();
    } catch (e) {
      pushErrorToast(`Couldn't save which GitHub account “${ws.name}” uses`, e, { then: "Change it in Settings › Setup and account › Setup › Account for each project." });
    }
  }
  return ws;
}

/** "Open it": a folder already in Plyloft becomes Setup's active workspace. */
export async function openExistingProject(id: string): Promise<void> {
  await useWorkspaces.getState().setActive(id);
}
