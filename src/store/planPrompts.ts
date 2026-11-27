/**
 * Launch G3: what the app shows when a plan gate refuses — only team features
 * have one. The decisions are the backend's (`license.rs`); this file only
 * words and routes them.
 */
import type { AccountInfo } from "../ipc";
import { planRefusal } from "../lib/planGates";
import { USE_TEAM_DONE, USE_TEAM_FAILED } from "../lib/planPage";
import { machineWords } from "../lib/platform";
import { pushErrorToast } from "../lib/errorToast";
import { useAccount } from "./accountStore";
import { pushToast } from "./toastStore";
import { useUi } from "./uiStore";

/** Settings › Account › Plan (launch A3): where every plan refusal leads. */
export const PLAN_SECTION = "plan";

export function openPlanSettings(): void {
  useUi.getState().openSettingsSection(PLAN_SECTION);
}

/** Show a plan refusal its own way. `true` when `e` was one — the caller then
 *  says nothing more about it. */
export function showPlanRefusal(e: unknown): boolean {
  const refusal = planRefusal(e);
  if (!refusal) return false;
  switch (refusal.code) {
    case "team_account_mismatch":
      pushToast({
        kind: "warn",
        title: refusal.message,
        action: { label: "Switch account", onClick: openPlanSettings },
      });
      break;
    // 1.178.0 (A3 c.4): signed out (`sign_in_required`) and Team on another
    // computer (`team_elsewhere`, `team_to_choose`) say it the Team refusal's way: Settings ›
    // Plan has Sign in with GitHub and Use Team on this computer.
    default:
      pushToast({
        kind: "warn",
        title: refusal.message,
        action: { label: "See your plan", onClick: openPlanSettings },
      });
  }
  return true;
}

/** 1.178.0 (A3): the press of **Use Team on this computer** — Settings ›
 *  Plan's callout and the sidebar's row — said in a toast either way (D17).
 *  The store's `useTeam` answers the account, or null with the backend's
 *  refusal in `error` (null and no error: a press already out). */
export async function moveTeamHere(): Promise<boolean> {
  let info: AccountInfo | null;
  try {
    info = await useAccount.getState().useTeam();
  } catch (e) {
    pushErrorToast(machineWords(USE_TEAM_FAILED), e);
    return false;
  }
  if (info) {
    pushToast({ kind: "info", title: machineWords(USE_TEAM_DONE) });
    return true;
  }
  const error = useAccount.getState().error;
  if (error) pushErrorToast(machineWords(USE_TEAM_FAILED), error.message);
  return false;
}
