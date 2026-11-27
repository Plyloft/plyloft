/**
 * Launch G3: the plan gates as the frontend sees them. Everything for one
 * person runs on every plan; only team features need the Team plan. The
 * backend decides (`license.rs::PlanGates`); this file only names its
 * refusals.
 *
 * The refusals are told apart by their leads, as the setup refusals are
 * (`worktreeSetup.ts`). `license.rs`'s `the_frontend_knows_every_lead` test
 * reads this file: a lead changed on one side alone fails there.
 */
import type { PlanGates } from "../ipc";

export const TEAM_PLAN_LEAD = "Team plan needed:";
export const TEAM_OTHER_REPO_LEAD = "Your Team plan is for another team:";
export const TEAM_OTHER_ACCOUNT_LEAD = "Signed in as another account:";
/** 1.178.0 (A3 D18): a team feature pressed while signed out of Plyloft. */
export const SIGNED_OUT_LEAD = "Plyloft account needed:";
/** 1.178.0 (A3 D19): the account's Team runs on another computer. */
export const TEAM_ELSEWHERE_LEAD = "Team is on another computer:";
/** Review fix: Team is ready on no computer yet; the person chooses one. */
export const TEAM_TO_CHOOSE_LEAD = "Choose a computer to use Team.";

/** The stable codes of the plan refusals. */
export type PlanRefusalCode =
  | "team_plan_required"
  | "team_other_repo"
  | "team_account_mismatch"
  | "sign_in_required"
  | "team_elsewhere"
  | "team_to_choose";

export interface PlanRefusal {
  code: PlanRefusalCode;
  /** The plan that lifts it (`team_account_mismatch`: none, an account
   *  switch; `team_elsewhere`, `team_to_choose`: none, Use Team on this computer). */
  requiredPlan: "team" | null;
  /** The backend's sentence, from its lead on. */
  message: string;
}

function textOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e ?? "");
}

const LEADS: Array<[string, PlanRefusalCode, PlanRefusal["requiredPlan"]]> = [
  [SIGNED_OUT_LEAD, "sign_in_required", "team"],
  [TEAM_ELSEWHERE_LEAD, "team_elsewhere", null],
  [TEAM_TO_CHOOSE_LEAD, "team_to_choose", null],
  [TEAM_PLAN_LEAD, "team_plan_required", "team"],
  [TEAM_OTHER_REPO_LEAD, "team_other_repo", "team"],
  [TEAM_OTHER_ACCOUNT_LEAD, "team_account_mismatch", null],
];

/** The plan refusal inside `e`, or null for any other error. The lead may sit
 *  after a wrapper's words ("ship worker failed: …"). */
export function planRefusal(e: unknown): PlanRefusal | null {
  const text = textOf(e);
  for (const [lead, code, requiredPlan] of LEADS) {
    const at = text.indexOf(lead);
    if (at >= 0) return { code, requiredPlan, message: text.slice(at) };
  }
  return null;
}

/** The team gate predicate: the backend's `teamAllowed`. Before the first
 *  read, locked (as the licence store was). */
export function teamAllowed(gates: PlanGates | null): boolean {
  return gates?.teamAllowed === true;
}
