import { create } from "zustand";
import { licenseGet, type LicenseInfo } from "../ipc";

/**
 * v1.85.0 (team-tier roadmap cycle 2): the GLOBAL license store — flat,
 * not per-workspace. Launch G3: a stored `PLY1` key unlocks nothing; launch
 * A3 retired the Licence page, so this store only reports a key left on this
 * Mac (Diagnostics says so). The plan is the account store's
 * (`accountStore.ts`), shown in Settings › Account › Plan.
 */
type LicenseStore = {
  info: LicenseInfo | null;
  loaded: boolean;
  refresh: () => Promise<void>;
};

export const useLicense = create<LicenseStore>((set) => ({
  info: null,
  loaded: false,

  refresh: async () => {
    try {
      const info = await licenseGet();
      set({ info, loaded: true });
    } catch {
      // Backend unavailable (e.g. tests outside Tauri) → stay unlocked
      // UI-side is wrong; stay LOCKED-side: a null info reads as no
      // license, which is the safe default.
      set({ loaded: true });
    }
  },
}));
