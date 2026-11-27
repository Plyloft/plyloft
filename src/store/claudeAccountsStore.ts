import { useEffect } from "react";
import { create } from "zustand";
import { aiAccountsList, type ClaudeAccountRow } from "../ipc";

/**
 * 1.179.0 (C2): the window's copy of the Claude accounts (`ai_accounts_list`,
 * Main first), for the surfaces that name the account a session runs on
 * (`lib/claudeAccountNames.ts`). Read once when the first of them is drawn;
 * Settings › AI and models › Claude accounts puts its own rows here after
 * every change it makes, so a name shows up, changes or goes with it. Until
 * the list is read (or when it can't be), nothing is named: as with Main alone.
 */
interface ClaudeAccountsState {
  rows: ClaudeAccountRow[] | null;
  /** The read was started (kept in the store so a test's reset clears it). */
  asked: boolean;
  /** Read the list (again). */
  load: () => Promise<void>;
  /** The rows Settings just read or got back from a change. */
  setRows: (rows: ClaudeAccountRow[]) => void;
}

export const useClaudeAccounts = create<ClaudeAccountsState>((set) => ({
  rows: null,
  asked: false,
  load: async () => {
    set({ asked: true });
    try {
      const list = await aiAccountsList();
      if (Array.isArray(list)) set({ rows: list });
    } catch {
      // Nothing named until a later read: never a guess.
    }
  },
  setRows: (rows) => set({ rows }),
}));

/** The accounts, read the first time a surface asks. */
export function useClaudeAccountRows(): ClaudeAccountRow[] | null {
  const rows = useClaudeAccounts((s) => s.rows);
  useEffect(() => {
    const s = useClaudeAccounts.getState();
    if (!s.asked) void s.load();
  }, []);
  return rows;
}
