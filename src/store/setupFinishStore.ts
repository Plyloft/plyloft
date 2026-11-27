import { useEffect } from "react";
import { create } from "zustand";
import { hasPathOverride } from "../lib/diagnostics";
import { onWorkspaceDefinitionEdited, projectConfigList, type DoctorReport } from "../ipc";
import {
  deriveSteps,
  finishRow,
  missingRequired,
  requiredItems,
  setupFactsFrom,
  setupWorkspaceCount,
  type FinishRowView,
  type RequiredId,
  type RequiredItemView,
  type SetupFacts,
  type SetupStepView,
} from "../lib/setupSteps";
import { useDoctor } from "./doctorStore";
import { useSettings } from "./settingsStore";
import { useSetup } from "./setupStore";
import { useWorkMode } from "./workModeStore";
import { useWorkspaces } from "./workspaceStore";
import { useUi } from "./uiStore";
import { useProjectListTrouble } from "./projectListTrouble";

/**
 * OB-15 (onboarding §9): what Setup's required set looks like **outside**
 * Setup — for the sidebar's "Setup isn't finished · Finish" row, the header's
 * sidebar dot and Settings › Account › Setup.
 *
 * The facts are the stores as they are (the doctor report, the settings, the
 * workspaces, the mode) plus one read this store owns: which workspaces have
 * a project config (`project_config_list`). No sign-in process is run (§4:
 * outside Setup's AI step the credential files decide). The row goes by
 * itself when a fact changes — no relaunch: the config list is read again
 * when the workspaces change, when a shared definition is pulled, when a
 * repository's settings are saved (`refreshConfiguredProjects`) or Settings
 * closes, and — with the doctor — when Setup closes, where most fixes happen.
 */
interface SetupFinishState {
  /** Workspace ids with a saved project config; null until read (or when the
   *  read failed — unknown, never "none"). */
  configuredIds: string[] | null;
  refresh: () => Promise<void>;
}

let generation = 0;

export const useSetupFinish = create<SetupFinishState>((set) => ({
  configuredIds: null,
  refresh: async () => {
    const mine = ++generation;
    try {
      const list = await projectConfigList();
      if (mine !== generation) return;
      set({ configuredIds: Array.isArray(list) ? list.map(([id]) => id) : null });
    } catch (e) {
      if (mine === generation) set({ configuredIds: null });
      console.warn("setup: project configs not read", e);
    }
  },
}));

/** Read the config list again (a repository's settings were saved). */
export function refreshConfiguredProjects(): void {
  void useSetupFinish.getState().refresh();
}

let started = false;
let stops: (() => void)[] = [];

/** Follow what the required set is built from. Idempotent; App starts it, and
 *  the row starts it too so it never draws from a list nobody reads. */
export function startSetupFinishSubscription(): void {
  if (started) return;
  started = true;
  void useSetupFinish.getState().refresh();
  let ids = workspaceKey();
  let open = useSetup.getState().open;
  let settingsOpen = useUi.getState().settingsOverlayOpen;
  stops.push(
    useWorkspaces.subscribe(() => {
      const next = workspaceKey();
      if (next === ids) return;
      ids = next;
      void useSetupFinish.getState().refresh();
    }),
    useSetup.subscribe((s) => {
      const was = open;
      open = s.open;
      // Setup just closed: what it fixed is read again, so the row says
      // what is left (or goes).
      if (was && !s.open) {
        void useSetupFinish.getState().refresh();
        void useDoctor.getState().refresh();
      }
    }),
    useUi.subscribe((s) => {
      const was = settingsOpen;
      settingsOpen = s.settingsOverlayOpen;
      // Settings just closed: a repository's Re-detect or a removed config
      // is counted.
      if (was && !s.settingsOverlayOpen) void useSetupFinish.getState().refresh();
    }),
  );
  let live = true;
  onWorkspaceDefinitionEdited(() => void useSetupFinish.getState().refresh())
    .then((off) => {
      if (live) stops.push(off);
      else off();
    })
    .catch(() => {});
  stops.push(() => {
    live = false;
  });
}

/** Tests: forget the subscription and the list. */
export function stopSetupFinishForTests(): void {
  for (const stop of stops) stop();
  stops = [];
  started = false;
  generation += 1;
}

function workspaceKey(): string {
  return useWorkspaces
    .getState()
    .workspaces.map((w) => w.id)
    .join(",");
}

/** Whether Claude Code or Codex is installed at all (for "install" versus
 *  "sign in"). */
function aiInstalled(report: DoctorReport | null): boolean | null {
  if (!report) return null;
  return report.tools.some((t) => (t.id === "claude" || t.id === "codex") && t.found);
}

export interface SetupRequiredView {
  facts: SetupFacts;
  steps: SetupStepView[];
  missing: RequiredId[];
  items: RequiredItemView[];
  /** The Finish row, when it is drawn (null while Setup is open). */
  finish: FinishRowView | null;
}

/** The required set as the stores say it now. Pure over the stores; the
 *  reads are started by {@link useSetupFinishFeed}. */
export function useSetupRequired(): SetupRequiredView {
  const report = useDoctor((s) => s.report);
  const settings = useSettings((s) => s.settings);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const workspacesLoaded = useWorkspaces((s) => s.loaded);
  const followed = useWorkMode((s) => s.mode);
  const configuredIds = useSetupFinish((s) => s.configuredIds);
  const setupOpen = useSetup((s) => s.open);
  const listTrouble = useProjectListTrouble((s) => s.trouble);
  const ids = new Set(workspaces.map((w) => w.id));
  const facts = setupFactsFrom({
    report,
    userEmail: settings.identity?.userEmail ?? null,
    level: settings.onboarding?.level ?? null,
    chosenMode: settings.team?.workMode ?? null,
    followedMode: followed,
    teamJoined: Boolean(settings.team?.teamRepo),
    projectsFolder: settings.projects?.folder ?? null,
    // Y3: an empty list is "not known" while the project list is in trouble
    // this launch — never "Setup isn't finished".
    workspaceCount: setupWorkspaceCount(workspacesLoaded, workspaces.length, listTrouble),
    configuredWorkspaceCount: configuredIds === null ? null : configuredIds.filter((id) => ids.has(id)).length,
  });
  const skipped = settings.onboarding?.skipped;
  const words = { aiInstalled: aiInstalled(report), programFolders: hasPathOverride(settings.shell?.pathOverride) };
  return {
    facts,
    steps: deriveSteps(facts, skipped),
    missing: missingRequired(facts),
    items: requiredItems(facts, words),
    finish: finishRow(facts, skipped, setupOpen, words, settings.onboarding?.currentStep),
  };
}

/** Start the reads the required set needs: the subscription, and the doctor
 *  once if nobody has read it (never with sign-in, GH #173). */
export function useSetupFinishFeed(): void {
  const hasReport = useDoctor((s) => s.report !== null);
  useEffect(() => {
    startSetupFinishSubscription();
  }, []);
  useEffect(() => {
    if (!hasReport) void useDoctor.getState().refresh();
  }, [hasReport]);
}
