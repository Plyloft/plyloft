/**
 * Which warmed workspace makes room when another warms past the cap
 * (`App.tsx`'s WARMED_CAP, v1.17.0 Cycle E.5).
 *
 * Evicting a workspace unmounts its hosts, and unmounting a tile's Terminal
 * kills its PTY — so a workspace with a live session (a running tile, a
 * Claude or Codex session waiting for its person, a card's Builder) is never
 * the one picked. With seven or more workspaces at work and the sidebar's
 * stack making a switch to a cold one a single click, "least recently
 * active" alone would kill the session the person just went to look at.
 *
 * When every candidate is live, nothing is evicted and the warmed set grows
 * past the cap. The trade-off is memory (one more set of xterm and editor
 * hosts per live workspace) against killing someone's work; the work wins.
 * The set shrinks back on a later warm, once a workspace has gone idle.
 *
 * Pure, so `warmedEviction.test.ts` runs it under node.
 */
export function workspacesToEvict(input: {
  warmed: ReadonlySet<string>;
  /** The workspace being warmed now: never evicted. */
  activating: string;
  cap: number;
  lastActiveAt: Readonly<Record<string, number>>;
  /** A workspace with a live session. */
  isLive: (workspaceId: string) => boolean;
}): string[] {
  const { warmed, activating, cap, lastActiveAt, isLive } = input;
  const size = warmed.size + (warmed.has(activating) ? 0 : 1);
  const excess = size - cap;
  if (excess <= 0) return [];
  const candidates = [...warmed]
    .filter((id) => id !== activating && !isLive(id))
    .sort((a, b) => (lastActiveAt[a] ?? 0) - (lastActiveAt[b] ?? 0));
  return candidates.slice(0, excess);
}

/** The session kinds that keep a workspace warm: a tile whose process is
 *  alive (or about to be), and a card's Builder session. */
export function workspaceHasLiveSession(
  workspaceId: string,
  tilesByWorkspace: Record<string, { tiles: readonly { status: string }[] } | undefined>,
  builders: Record<string, { workspaceId: string }>,
): boolean {
  const tiles = tilesByWorkspace[workspaceId]?.tiles ?? [];
  if (tiles.some((t) => t.status === "running" || t.status === "pending")) return true;
  return Object.values(builders).some((b) => b.workspaceId === workspaceId);
}
