/**
 * QoL block 13.2 (owner decision D4, 2026-10-21): the Library's ways out of a
 * git step Plyloft doesn't take itself. Plyloft has no general git UI
 * (AGENTS.md, product boundaries) and gets no new exception for it: a row
 * that used to say "pull <branch>" offers **Ask the Builder** — a session of
 * the member's own Builder CLI in the project folder, started with the
 * request below, which the member watches and answers like any other — and a
 * row that used to say "Commit the change first" offers **Ship it with a
 * card** (13.1), which carries the folder's copy in a skill card.
 *
 * Pure: no React, no store, no IPC, so node runs it (`askBuilder.test.ts`).
 */

/** The one label every surface uses. */
export const ASK_BUILDER = "Ask the Builder";

/** The tile's name while the request is its first turn. */
export const ASK_BUILDER_TILE = "Builder · bring it here";

const FALLBACK = "the integration branch";

/** The row's words when the project folder lags behind `branch`. */
export function folderBehindLine(branch: string | null): string {
  return `Your project folder is behind ${branch ?? FALLBACK}.`;
}

/**
 * What Ask the Builder asks for when the project folder is behind `branch`:
 * bring it here, without touching the member's own changes, and ask before
 * anything that isn't a plain fast-forward.
 */
export function bringBranchPrompt(branch: string | null, about?: string): string {
  const where = branch ?? FALLBACK;
  const why = about ? ` I need it for ${about}.` : "";
  return (
    `My project folder is behind ${where}.${why} Please bring ${where}'s latest commits into this ` +
    `folder: if the folder is on ${where}, bring it up to date only if that needs no merge ` +
    `(git merge --ff-only). If it is on another branch, or it would need a merge, tell me what ` +
    `you'd do and wait for my answer. Don't discard, ` +
    `stash, reset or commit any of my changes; if one is in the way, stop and tell me which files.`
  );
}
