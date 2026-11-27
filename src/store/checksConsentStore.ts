// 1.175.0 B2 (SEC-4): what this computer allowed of the repository's checks
// and install step, per workspace (`checks_consent.rs::view`). Read when a
// surface needs it and again whenever it can have changed: an OK, a local
// edit, a refresh of the shared setup.
import { create } from "zustand";
import { onWorkspaceDefinitionEdited, onWorkspaceDefinitionRefreshed } from "../ipc";
import type { ShipResult } from "../ipc";
import { INSTALL_REVIEW, installHeldFor, type ConsentView } from "../lib/checksConsent";
import { checksConsentView, onChecksConsentChanged } from "../lib/checksConsentIpc";

interface ChecksConsentShape {
  byWorkspace: Record<string, ConsentView>;
  /** The install sheet is open for this workspace. */
  installSheet: string | null;
  /** Why a card's Allow and run didn't go through, keyed `ws::card`. */
  checksErrors: Record<string, string>;
  setChecksError: (key: string, error: string | null) => void;
  load: (workspaceId: string) => Promise<ConsentView | null>;
  openInstallSheet: (workspaceId: string) => void;
  closeInstallSheet: () => void;
  bootstrapListeners: () => Promise<void>;
}

let bootstrapped = false;

export const useChecksConsent = create<ChecksConsentShape>((set, get) => ({
  byWorkspace: {},
  installSheet: null,
  checksErrors: {},
  setChecksError: (key, error) =>
    set((s) => {
      const next = { ...s.checksErrors };
      if (error) next[key] = error;
      else delete next[key];
      return { checksErrors: next };
    }),
  load: async (workspaceId) => {
    try {
      const view = await checksConsentView(workspaceId);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: view } }));
      return view;
    } catch (e) {
      console.warn(`checks consent of ${workspaceId} couldn't be read:`, e);
      return null;
    }
  },
  openInstallSheet: (workspaceId) => {
    set({ installSheet: workspaceId });
    void get().load(workspaceId);
  },
  closeInstallSheet: () => set({ installSheet: null }),
  bootstrapListeners: async () => {
    if (bootstrapped) return;
    bootstrapped = true;
    const reload = (workspaceId: string) => void get().load(workspaceId);
    await onChecksConsentChanged(reload);
    await onWorkspaceDefinitionEdited(reload);
    await onWorkspaceDefinitionRefreshed((report) => reload(report.workspaceId));
  },
}));

/** After a release or a ship: is its install step waiting for this
 *  computer's OK? Then the toast says so and its one button is Review, which
 *  opens the sheet. Reads the record fresh (the backend just wrote it). */
export async function installHeldAfter(
  workspaceId: string,
  result: Pick<ShipResult, "tag" | "installScript">,
): Promise<{ held: { who: string; firstTime?: boolean }; action: { label: string; onClick: () => void } } | null> {
  const view = await useChecksConsent.getState().load(workspaceId);
  const held = installHeldFor(result, view?.install);
  if (!held) return null;
  return {
    held,
    action: { label: INSTALL_REVIEW, onClick: () => useChecksConsent.getState().openInstallSheet(workspaceId) },
  };
}

/** Tests: nothing read, no sheet, and the listeners attach again. */
export function resetChecksConsentForTests() {
  bootstrapped = false;
  useChecksConsent.setState({ byWorkspace: {}, installSheet: null, checksErrors: {} });
}
