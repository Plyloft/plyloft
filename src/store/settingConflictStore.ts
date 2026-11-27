import { create } from "zustand";
import {
  workspaceDefinitionGet,
  workspaceDefinitionResolveConflict,
  type DefinitionRefreshReport,
  type SettingConflict,
} from "../ipc";
import { conflictKey, droppedToast, opensByItself, shownOf } from "../lib/settingConflict";
import { isDirectionField } from "../lib/nextImprovement";
import { pushToast } from "./toastStore";
import { useWorkspaces } from "./workspaceStore";

/**
 * 1.173.0 (C3): the question a shared setting both sides changed asks. One
 * sheet at a time, drawn by `SettingConflictHost`. It opens by itself after
 * a refresh held a field, only while the person is on that workspace with
 * Plyloft in front; otherwise the Inbox row (`shared_setting_conflict`)
 * waits and opens it. Closing it decides nothing: the row stays.
 */
interface Open {
  workspaceId: string;
  conflict: SettingConflict;
}

interface SettingConflictState {
  open: Open | null;
  busy: boolean;
  error: string | null;
  /** Questions already put this session (`conflictKey`). */
  asked: Set<string>;
  /** Read the workspace's questions and show the one for `field` (the
   *  first when absent). False: nothing to ask any more. */
  show: (workspaceId: string, field?: string | null) => Promise<boolean>;
  close: () => void;
  answer: (choice: "theirs" | "mine") => Promise<void>;
}

export const useSettingConflict = create<SettingConflictState>((set, get) => ({
  open: null,
  busy: false,
  error: null,
  asked: new Set(),
  show: async (workspaceId, field) => {
    const view = await workspaceDefinitionGet(workspaceId).catch(() => null);
    const conflicts = view?.conflicts ?? [];
    const conflict = (field ? conflicts.find((c) => c.field === field) : null) ?? conflicts[0];
    if (!conflict) return false;
    const asked = new Set(get().asked);
    asked.add(conflictKey(workspaceId, conflict));
    set({ open: { workspaceId, conflict }, asked, error: null, busy: false });
    return true;
  },
  close: () => {
    if (!get().busy) set({ open: null, error: null });
  },
  answer: async (choice) => {
    const open = get().open;
    if (!open || get().busy) return;
    set({ busy: true, error: null });
    try {
      const answered = await workspaceDefinitionResolveConflict(
        open.workspaceId,
        open.conflict.field,
        choice,
        shownOf(open.conflict),
      );
      set({ open: null, busy: false });
      if (!answered) {
        // C3 Challenger 1: the other side changed it again since it was
        // shown (or it was answered elsewhere): show what stands now.
        void get().show(open.workspaceId, open.conflict.field);
        return;
      }
      if (choice === "theirs") pushToast({ kind: "info", ...droppedToast(open.conflict) });
      // The next question of the same workspace, if any.
      void get().show(open.workspaceId);
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },
}));

/** After a refresh: open the question by itself when the person is there. */
export function onRefreshForConflicts(report: DefinitionRefreshReport): void {
  const held = report.publish?.conflicts ?? [];
  if (held.length === 0) return;
  openFirstHere(report.workspaceId, () => true);
}

/**
 * 1.173.0 (E3, from E1's review): a Next improvement direction changed state
 * here (`ni://direction`, after a refresh's drain or a press). The refresh
 * report carries only the definition's own fields, so a direction field the
 * drain held is looked for among the workspace's `ni-<area>-<field>` questions,
 * and opens by itself under the same rule.
 */
export function onDirectionForConflicts(workspaceId: string, area: string): void {
  // Challenger 14: the exact field names, so area "site" never takes the
  // questions of an area "site-app".
  openFirstHere(workspaceId, (field) => isDirectionField(field, area));
}

function openFirstHere(workspaceId: string, wanted: (field: string) => boolean): void {
  if (useSettingConflict.getState().open) return;
  const visible = typeof document === "undefined" || !document.hidden;
  const focused = typeof document === "undefined" || document.hasFocus();
  const activeWorkspaceId = useWorkspaces.getState().activeId;
  void workspaceDefinitionGet(workspaceId)
    .then((view) => {
      const asked = useSettingConflict.getState().asked;
      const first = (view?.conflicts ?? []).find(
        (c) =>
          wanted(c.field) &&
          opensByItself({
            visible,
            focused,
            activeWorkspaceId,
            workspaceId,
            key: conflictKey(workspaceId, c),
            asked,
          }),
      );
      if (first && !useSettingConflict.getState().open) {
        void useSettingConflict.getState().show(workspaceId, first.field);
      }
    })
    .catch(() => {});
}
