import { homeDir } from "@tauri-apps/api/path";
import { projectsFolderCreate, teamStatus } from "../ipc";
import { cloneRootToKeep, reportedCloneRoot, teamClonesFrom, type TeamClonesView } from "../lib/projectsFolder";
import { useSettings } from "./settingsStore";
import { useWorkMode } from "./workModeStore";

/**
 * The OB-1 review's safeguard, carried forward to OB-12: before the projects
 * folder changes, team workspaces already cloned where the clone root points
 * now keep resolving there — `team.cloneRoot` is written first
 * (`lib/projectsFolder.ts::cloneRootToKeep`). Settings › Account › Setup's
 * `Change…` (OB-15) and Setup's step 7 (OB-12) both call this, then write
 * `projects.folder` their own way.
 */
export async function keepCloneRootBefore(next: string): Promise<void> {
  const latest = useSettings.getState().settings;
  if (latest.team?.cloneRoot?.trim()) return;
  let team: TeamClonesView | null = null;
  let reportedRoot: string | null = null;
  try {
    const status = await teamStatus();
    team = teamClonesFrom(status);
    reportedRoot = reportedCloneRoot(status);
  } catch {
    team = null;
  }
  const keep = cloneRootToKeep({
    cloneRoot: latest.team?.cloneRoot,
    currentFolder: latest.projects?.folder,
    nextFolder: next,
    team,
    teamMode: useWorkMode.getState().mode === "team",
    reportedRoot,
    home: reportedRoot ? await homeDir().catch(() => null) : null,
  });
  if (!keep) return;
  await useSettings
    .getState()
    .update((cur) => (cur.team?.cloneRoot?.trim() ? cur : { ...cur, team: { ...cur.team, cloneRoot: keep } }));
}

/**
 * OB-12 (§5 step 7): `[Use this folder]` — the safeguard first, then the
 * folder made when it is missing (no sheet: an empty folder in the person's
 * home), then `settings.projects.folder` in tilde form. The safeguard may
 * already have pinned `team.cloneRoot` when the folder then can't be made;
 * that pin only keeps team workspaces where they already resolve, so it is
 * left as it is. Returns the expanded path.
 */
export async function chooseProjectsFolder(next: string): Promise<string> {
  await keepCloneRootBefore(next);
  const path = await projectsFolderCreate(next);
  await useSettings
    .getState()
    .update((cur) =>
      cur.projects?.folder === next ? cur : { ...cur, projects: { ...cur.projects, folder: next } },
    );
  return path;
}
