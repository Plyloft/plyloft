// Launch G3: the plan gates a rendered test runs under. The backend decides
// (`plan_gates_get`); a test puts its answer straight into the account store,
// as the licence store's `teamAllowed` used to be put.
import type { PlanGates } from "../ipc";
import { useAccount } from "../store/accountStore";

export const FREE_GATES: PlanGates = {
  plan: "free",
  entitlementValid: true,
  exp: null,
  team: { state: "no_team_plan" },
  teamAllowed: false,
  teamRefusal: "Team plan needed: team features run on the Team plan. Your Plyloft account isn't on it (or its plan lapsed). See Settings › Setup and account › Plan.",
};

export const PRO_GATES: PlanGates = {
  ...FREE_GATES,
  // An old entitlement or comp that still says `pro`: the same as Free.
  plan: "pro",
};

/** 1.178.0 (A3 D18): not signed in to Plyloft. */
export const SIGNED_OUT_GATES: PlanGates = {
  ...FREE_GATES,
  entitlementValid: false,
  team: { state: "signed_out" },
  teamRefusal:
    "Plyloft account needed: team features run on a Team plan, and you aren't signed in to Plyloft on this Mac. Sign in in Settings › Setup and account › Plan.",
};

/** 1.178.0 (A3 D19): the account's Team runs on another computer; this one
 *  is signed in on Free. */
export const TEAM_ELSEWHERE_GATES: PlanGates = {
  ...FREE_GATES,
  team: { state: "team_elsewhere" },
  teamRefusal:
    "Team is on another computer: team features run on one computer at a time. Use Team on this computer in Settings › Setup and account › Plan brings them here.",
};

/** The Team plan for this Mac's team, as the team's account. */
export const TEAM_GATES: PlanGates = {
  plan: "team",
  entitlementValid: true,
  exp: null,
  team: { state: "allowed" },
  teamAllowed: true,
  teamRefusal: null,
};

export function setPlanGates(gates: PlanGates | null): void {
  useAccount.setState({ gates });
}

/** The old `useLicense.setState({ info: { teamAllowed } })` of a test. */
export function setTeamAllowed(allowed: boolean): void {
  setPlanGates(allowed ? TEAM_GATES : FREE_GATES);
}
