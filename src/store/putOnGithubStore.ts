// 1.175.0 F3: which "Put it on GitHub…" sheet is asked, and what this
// session put on GitHub (`PutOnGithubSheet.tsx`). Session-only.
import { create } from "zustand";

export interface PutOnGithubAsked {
  workspaceId: string;
  project: string;
  /** Called once the project is on GitHub. */
  onDone?: (repo: string) => void;
  /** Add a project's ticked copy: its own sheet was the consent, so this
   *  one starts at once with this account and name. */
  start?: { login: string; name: string };
}

export const usePutOnGithub = create<{
  asked: PutOnGithubAsked | null;
  /** The repository this session made, per workspace, until its next Ship
   *  it (`forgetJustPut`): the card says "This project is on GitHub now". */
  justPut: Record<string, string>;
  /** How many times a workspace was put on GitHub: the card's result reads
   *  again (`hasRemote`) when it moves. */
  puts: Record<string, number>;
}>(() => ({ asked: null, justPut: {}, puts: {} }));

/** Open the sheet for a workspace. */
export function openPutOnGithub(asked: PutOnGithubAsked) {
  usePutOnGithub.setState({ asked });
}

export function putDone(workspaceId: string, repo: string) {
  usePutOnGithub.setState((s) => ({
    justPut: { ...s.justPut, [workspaceId]: repo },
    puts: { ...s.puts, [workspaceId]: (s.puts[workspaceId] ?? 0) + 1 },
  }));
}

/** Ship it was pressed in the workspace: the "on GitHub now" line ends. */
export function forgetJustPut(workspaceId: string) {
  if (!usePutOnGithub.getState().justPut[workspaceId]) return;
  usePutOnGithub.setState((s) => {
    const { [workspaceId]: _gone, ...rest } = s.justPut;
    return { justPut: rest };
  });
}

/** The count `OutcomeScreen` reads its result again on. */
export function usePutOnGithubCount(workspaceId: string): number {
  return usePutOnGithub((s) => s.puts[workspaceId] ?? 0);
}

