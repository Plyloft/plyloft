import { createMutationQueue, type SettingsMutation } from "../lib/settingsQueue";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
// GH #103: the shape and the shipped defaults live in `lib/settingsShape.ts`
// so the pure field → page map can read them under node. Re-exported here:
// every caller that imported them from the store still does.
export {
  DEFAULT_SETTINGS,
  type AccentPreset,
  type PaneKind,
  type ReloadStrategy,
  type Settings,
  type SilencedDuplicate,
  type SurfaceSize,
  type SidebarLayout,
  type ThemePref,
  type RoleModels,
  type SetupLevel,
  type WorkMode,
  type FirstCardGuide,
  type TutorialProgress,
  type TutorialPath,
  type SetupStepId,
  SETUP_VERSION,
  SETUP_STEP_IDS,
  DEFAULT_PROJECTS_FOLDER,
} from "../lib/settingsShape";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settingsShape";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Change part of the settings, applied to the latest committed state
   *  when its turn comes; writes run one at a time (Challenger F1). A
   *  mutation that returns `latest` itself sends nothing (GH #178). */
  update: (mutation: SettingsMutation<Settings>) => Promise<Settings>;
  /** 1.176.3 (owner, 2026-11-23): a reset, on the same queue. `paths` go
   *  back to `mutation`'s values whatever wrote them — a value Plyloft wrote
   *  after this window's copy too — and the rest is merged as any save is.
   *  `before` is what was stored just before, read by the backend under its
   *  lock: what an Undo puts back. */
  reset: (mutation: SettingsMutation<Settings>, paths: string[]) => Promise<{ before: Settings; saved: Settings }>;
  applyExternal: (next: Settings) => void;
}

export const useSettings = create<SettingsState>((set, get) => {
  const mutate = createMutationQueue<Settings>({
    read: () => get().settings,
    // 1.176.2 R2: with the copy the change was based on, so the backend
    // merges only this window's own change onto what it holds.
    send: (next, base) => invoke<Settings>("settings_set", { settings: next, base }),
    commit: (saved) => set({ settings: saved }),
  });
  return {
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const s = await invoke<Settings>("settings_get");
    set({ settings: s, loaded: true });
  },
  update: (mutation) => mutate(mutation),
  reset: async (mutation, paths) => {
    let before: Settings | null = null;
    const saved = await mutate(mutation, (next, base) =>
      invoke<{ before: Settings; saved: Settings }>("settings_reset", { settings: next, base, paths }).then((r) => {
        before = r.before;
        return r.saved;
      }),
    );
    return { before: before ?? saved, saved };
  },
  // GH #103: there is no `resetToDefaults` any more. `Reset all settings on
  // this Mac` is `reset(resetAllOnThisMac, resetAllPaths())` — the preferences go back, the
  // records (first run, the git identity, the skills switched off, the
  // dismissals) stay. Writing `DEFAULT_SETTINGS` whole brought the welcome
  // screen back and switched every Ply skill on again (#93 sweep, P3).
  applyExternal: (next) => {
    set({ settings: next });
  },
  };
});

let unlisten: UnlistenFn | null = null;

export async function startSettingsSubscription() {
  if (unlisten) return;
  unlisten = await listen<Settings>("settings://changed", (e) => {
    useSettings.getState().applyExternal(e.payload);
  });
}

/**
 * GH #172 review 1: for the behavioural UI tests only. The guard above lives
 * for the module, and a test file replaces the Tauri stub before every test, so
 * without this a second test's `settings://changed` reached no listener. Called
 * by `src/test/setup.ts` after each test; the app never stops the subscription.
 */
export function stopSettingsSubscriptionForTests(): void {
  const off = unlisten;
  unlisten = null;
  void off?.();
}

