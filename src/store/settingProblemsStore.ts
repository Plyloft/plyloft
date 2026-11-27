import { useEffect } from "react";
import { create } from "zustand";
import { settingCheck } from "../lib/settingCheck";
import { needsYouProblems, savedSettingProblems, type SavedSettingProblem } from "../lib/savedSettingChecks";
import { useSettings } from "./settingsStore";
import { useDoctor } from "./doctorStore";

/**
 * 1.176.1: this computer's saved free-text settings that certainly can't
 * work (the Tile shell, the team clone folder), for the sidebar's single
 * "needs you" row (built on another branch; wired at merge):
 *
 *     const problems = useSettingProblems();   // SavedSettingProblem[]
 *     // each: p.needsYou ("Tile shell can't start"), p.reason,
 *     // "Open the setting" → openSettingsSection(p.open.section, { row: p.open.row })
 *
 * Read again when either setting is saved and when the doctor's report is
 * read again — never per render. Command warnings are not here: they stay in
 * Diagnostics and next to their field.
 */
interface SettingProblemsState {
  problems: SavedSettingProblem[];
  refresh: () => Promise<void>;
}

let seq = 0;

export const settingProblemsStore = create<SettingProblemsState>((set) => ({
  problems: [],
  refresh: async () => {
    const my = ++seq;
    const s = useSettings.getState().settings;
    const list = await savedSettingProblems(
      { tileShell: s.shell?.tileShell ?? null, teamCloneRoot: s.team?.cloneRoot ?? null },
      settingCheck,
    ).catch(() => [] as SavedSettingProblem[]);
    if (my === seq) set({ problems: needsYouProblems(list) });
  },
}));

let watching: (() => void)[] | null = null;

/** Start reading (once): now, at each save of either setting, and at each
 *  new doctor report. */
export function watchSettingProblems(): void {
  if (watching) return;
  const refresh = () => void settingProblemsStore.getState().refresh();
  const key = () => {
    const s = useSettings.getState().settings;
    return `${s.shell?.tileShell ?? ""}\u0000${s.team?.cloneRoot ?? ""}`;
  };
  let last = key();
  watching = [
    useSettings.subscribe(() => {
      const now = key();
      if (now !== last) {
        last = now;
        refresh();
      }
    }),
    useDoctor.subscribe((next, prev) => {
      if (next.report !== prev.report) refresh();
    }),
  ];
  refresh();
}

/** The certain failures, for the sidebar. Starts the watch on first use. */
export function useSettingProblems(): SavedSettingProblem[] {
  useEffect(() => watchSettingProblems(), []);
  return settingProblemsStore((s) => s.problems);
}

/** Test seam: forget the watch. */
export function resetSettingProblemsForTests(): void {
  for (const stop of watching ?? []) stop();
  watching = null;
  seq++;
  settingProblemsStore.setState({ problems: [] });
}
