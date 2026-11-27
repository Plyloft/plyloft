// 1.175.0 F2 (UX-3, I4): the solo/team deduction's read of GitHub
// (`setup_team_hint.rs`), asked once step 3 connected GitHub. Here, not in
// `ipc.ts`, which is at its size ceiling.
import { invoke } from "@tauri-apps/api/core";
import type { TeamHintFacts } from "./setupSteps";

export interface TeamHint extends TeamHintFacts {
  login: string;
  /** Why a read failed, in gh's words (Details only). */
  problem: string | null;
}

/** Read-only, bounded: the Plyloft teams listing the account and the
 *  repository invitations waiting for it. Never rejects for an offline
 *  computer: that answers `read: false`. */
export function setupTeamHint(account: string | null = null) {
  return invoke<TeamHint>("setup_team_hint", { account });
}

/** The hint Setup uses when GitHub's answer can't be asked for — the step
 *  was skipped, or nothing is signed in: nothing found, nothing read. */
export const UNREAD_HINT: TeamHint = { read: false, login: "", teams: [], invitations: 0, problem: null };

/** 1.176.4: Continue on "Your AI" waits at most this long for GitHub's answer. */
export const TEAM_WAIT_MS = 6000;
let waitOverride: number | null = null;
/** Tests shorten the wait. */
export function setTeamWaitForTests(ms: number | null) {
  waitOverride = ms;
}
export const teamWaitMs = () => waitOverride ?? TEAM_WAIT_MS;
/** The line Setup shows while it waits. */
export const TEAM_WAIT_LINE = "Looking for your teams…";

/**
 * 1.176.4: whether GitHub's answer about teams is still on its way. It is
 * asked once step 3 is behind and GitHub is connected; nothing is waited for
 * when it is already there, the mode is decided, nobody is signed in to
 * GitHub (or the GitHub command isn't there), or the step was asked for by
 * hand. A GitHub status not read yet, with the command there, counts as
 * pending (the same time limit ends it).
 */
export function teamAnswerPending(c: {
  hint: unknown;
  deduced: unknown;
  pastGithub: boolean;
  modeAsked: boolean;
  githubObserved: boolean | null;
  /** The GitHub command is there, so its status is still on its way when `githubObserved` is null. */
  ghFound?: boolean;
}): boolean {
  const github = c.githubObserved === true || (c.githubObserved === null && c.ghFound === true);
  return c.hint === null && c.deduced === null && c.pastGithub && !c.modeAsked && github;
}
