import { create } from "zustand";
import { myLibraryFind, myLibraryStatus, onSkillsHubLibrary, type MyLibraryView } from "../ipc";

/**
 * Skills hub H10: My library on this computer — its view (`my_library_status`),
 * read once on first use and again whenever the backend says a library moved
 * (`skills-hub://library`), and what GitHub answered to "is there one already?"
 * on a computer that uses none (asked once per account per run).
 */
interface MyLibraryState {
  view: MyLibraryView | null;
  /** `owner/name` of a My library on GitHub for `foundFor`, or null. */
  found: string | null;
  foundFor: string | null;
  /** The create / use / gone sheet in All skills. */
  sheet: null | "create" | "use" | "point";
  refresh: () => Promise<void>;
  find: (account: string | null) => Promise<void>;
  set: (view: MyLibraryView) => void;
  setSheet: (sheet: MyLibraryState["sheet"]) => void;
}

export const useMyLibrary = create<MyLibraryState>((set, get) => ({
  view: null,
  found: null,
  foundFor: null,
  sheet: null,
  refresh: async () => {
    try {
      set({ view: await myLibraryStatus() });
    } catch (e) {
      console.warn("my library status failed:", e);
    }
  },
  find: async (account) => {
    const key = account ?? "";
    if (get().foundFor === key) return;
    set({ foundFor: key });
    try {
      set({ found: await myLibraryFind(account) });
    } catch {
      // Offline, or signed out: nothing to offer, nothing to say.
      set({ found: null });
    }
  },
  set: (view) => set({ view }),
  setSheet: (sheet) => set({ sheet }),
}));

let started = false;

/** Once, from All skills: keep the view current. */
export function startMyLibrarySubscriptions() {
  if (started) return;
  started = true;
  void onSkillsHubLibrary(() => void useMyLibrary.getState().refresh());
  void useMyLibrary.getState().refresh();
}
