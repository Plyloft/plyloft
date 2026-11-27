import { create } from "zustand";
import {
  onSkillsHubLibrary,
  onSkillsHubPulled,
  skillsHubLibraryStatus,
  type LibraryPullView,
  type SkillsHubPulled,
} from "../ipc";
import { pulledToastText } from "../lib/skillsHub";
import { pushToast } from "./toastStore";
import { openLibraryPage } from "./uiStore";
import { useWorkspaces } from "./workspaceStore";
import { useSettings } from "./settingsStore";

/**
 * Skills hub H2: the team library's pull record on this Mac, read once at
 * start and again whenever the backend says it moved (`skills-hub://library`)
 * or the settings change (joining or leaving a team). Settings › Team and the
 * Library's team section read it from here.
 */
interface SkillsHubState {
  team: LibraryPullView | null;
  /** H4 Windows re-walk: how many team reads finished (Settings › Team ›
   *  Read it again). The open Library reads its rows again on each — the
   *  pull record alone stays the same when an earlier pull already moved. */
  teamReads: number;
  noteTeamRead: () => void;
  refresh: () => Promise<void>;
  set: (view: LibraryPullView | null) => void;
}

export const useSkillsHub = create<SkillsHubState>((set) => ({
  team: null,
  teamReads: 0,
  // The pull record itself arrives with `skills-hub://library` when it moved.
  noteTeamRead: () => set((s) => ({ teamReads: s.teamReads + 1 })),
  refresh: async () => {
    try {
      set({ team: await skillsHubLibraryStatus() });
    } catch (e) {
      console.warn("skills hub status failed:", e);
    }
  },
  set: (view) => set({ team: view }),
}));

/** R1 / R14: the one toast a pull with changes by someone else raises. */
export function showPulledToast(pulled: SkillsHubPulled) {
  const title = pulledToastText(pulled);
  if (!title) return;
  const activeId = useWorkspaces.getState().activeId;
  pushToast({
    kind: "info",
    title,
    // The Library's team section lists them (All skills arrives with H7).
    ...(activeId
      ? { action: { label: "Show", onClick: () => openLibraryPage(activeId, "skills", "team") } }
      : {}),
  });
}

let started = false;

export function startSkillsHubSubscriptions() {
  if (started) return;
  started = true;
  const refresh = () => void useSkillsHub.getState().refresh();
  void onSkillsHubLibrary(refresh);
  // Joining or leaving a team.
  useSettings.subscribe((next, prev) => {
    if (next.settings.team?.teamRepo !== prev.settings.team?.teamRepo) refresh();
  });
  void onSkillsHubPulled(showPulledToast);
  refresh();
}
