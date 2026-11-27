import { create } from "zustand";

/**
 * Try it TI-4 (spec §4.5): the words a card shows after Plyloft stopped its
 * Try session ("Plyloft stopped your app's preview to ship it."), by card
 * copy (`lib/tryPanel.ts::tryRunKey`). Set by the tile store's
 * `card://try-stopped` listener, read by the card's Try it panel, cleared by
 * its next start. In memory only. No imports beyond zustand, so the tile
 * store can feed it without a cycle.
 */
interface TryStoppedStore {
  words: Record<string, string | undefined>;
  note: (key: string, words: string) => void;
  clear: (key: string) => void;
}

export const useTryStopped = create<TryStoppedStore>((set) => ({
  words: {},
  note: (key, words) => set((s) => ({ words: { ...s.words, [key]: words } })),
  clear: (key) =>
    set((s) => {
      if (!(key in s.words)) return s;
      const words = { ...s.words };
      delete words[key];
      return { words };
    }),
}));
