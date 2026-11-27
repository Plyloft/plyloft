import { create } from "zustand";
import type { MemberStates } from "../ipc";

/**
 * 1.174.3: the last Joined / Invited / No access GitHub gave, by team. Members
 * is unmounted when the page is left, and its first read lands seconds after
 * it opens, so every row blinked without its chip. In memory, never persisted;
 * a read that lands replaces it, and a failed read says so under the list.
 */
type TeamMemberStatesStore = {
  byTeam: Record<string, MemberStates | undefined>;
  remember: (teamRepo: string, next: (shown: MemberStates | null) => MemberStates | null) => void;
  /** 1.174.3: who a Remove left half-finished, by team: their access is gone and
   *  `team.json` still lists them. Nothing on GitHub tells that from any other
   *  No access, so only this Plyloft run knows it; in memory, never persisted. */
  unfinishedRemovals: Record<string, readonly string[] | undefined>;
  noteRemoval: (teamRepo: string, login: string, unfinished: boolean) => void;
};

/** A read that says they have access or an invitation, or doesn't list them,
 *  ends it. One GitHub didn't answer for says nothing either way. */
function stillUnfinished(logins: readonly string[], states: MemberStates): readonly string[] {
  return logins.filter((login) =>
    states.members.some((m) => m.login.toLowerCase() === login.toLowerCase() && m.state !== "joined" && m.state !== "invited"),
  );
}

export function teamStatesKey(teamRepo: string): string {
  return teamRepo.toLowerCase();
}

export const useTeamMemberStates = create<TeamMemberStatesStore>((set) => ({
  byTeam: {},
  remember: (teamRepo, next) =>
    set((s) => {
      const key = teamStatesKey(teamRepo);
      const states = next(s.byTeam[key] ?? null);
      return {
        byTeam: { ...s.byTeam, [key]: states ?? undefined },
        unfinishedRemovals: {
          ...s.unfinishedRemovals,
          [key]: states ? stillUnfinished(s.unfinishedRemovals[key] ?? [], states) : s.unfinishedRemovals[key],
        },
      };
    }),
  unfinishedRemovals: {},
  noteRemoval: (teamRepo, login, unfinished) =>
    set((s) => {
      const key = teamStatesKey(teamRepo);
      const others = (s.unfinishedRemovals[key] ?? []).filter((l) => l.toLowerCase() !== login.toLowerCase());
      return { unfinishedRemovals: { ...s.unfinishedRemovals, [key]: unfinished ? [...others, login] : others } };
    }),
}));
