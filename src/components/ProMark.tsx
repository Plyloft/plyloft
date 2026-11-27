import { useAccount } from "../store/accountStore";
import { PlanMark } from "./ux/MoreMenu";

/**
 * Skills hub H3 walk: the small "Team" after a team-library control on a plan
 * without the team. The press still says why (the backend's Team refusal);
 * the mark says it before the press.
 */
export function TeamMark() {
  // Unknown (not read yet) reads as allowed: nothing is marked before the
  // answer, and the backend still refuses.
  const team = useAccount((s) => s.gates == null || s.gates.teamAllowed === true);
  if (team) return null;
  return <PlanMark text="Team" title="Part of Team" />;
}
