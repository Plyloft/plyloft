import { create } from "zustand";

/**
 * QoL 1.168 (owner D7): which finished turn of each Claude or Codex tile the
 * person has seen — by tile id, the turn's key (`needsYou.ts::tileTurnEpisode`).
 * A tile counts as "needs you" after a turn only until it is seen: on screen
 * (its workspace's Terminals in front, App's tick), opened from the Inbox or
 * the stack. The next turn has a new key, so it counts
 * again. In memory only, like the tiles' own attention state: a relaunch
 * starts new sessions.
 */
type TileSeenStore = {
  seen: Record<string, string>;
  markSeen: (entries: ReadonlyArray<{ tileId: string; episode: string }>) => void;
};

export const useTileSeen = create<TileSeenStore>((set) => ({
  seen: {},
  markSeen: (entries) =>
    set((s) => {
      let next: Record<string, string> | null = null;
      for (const { tileId, episode } of entries) {
        if (s.seen[tileId] === episode) continue;
        next ??= { ...s.seen };
        next[tileId] = episode;
      }
      return next ? { seen: next } : s;
    }),
}));
