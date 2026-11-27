import { onCodexUpdateDone, onCodexUpdateState } from "./codexUpdateIpc";
import { codexUpdateToast } from "./codexUpdateNotice";
import { openRepair } from "./openRepair";
import { pushToast } from "../store/toastStore";
import { useDoctor } from "../store/doctorStore";

/**
 * 1.176.0 R5: the window's side of the automatic Codex update. It no longer
 * starts one: the backend runs it while Codex is idle (`codex_auto_update.rs`)
 * and keeps each attempt on disk. The window follows its two events — the
 * Terminals toolbar's "Codex (updating…)" and a tile's wait words read
 * `codexUpdating` — and shows the one notice the backend asks for.
 */

/** Before R5 the window kept the last attempt here; the backend now does
 *  (a missing record just means due), so the old key is dropped. */
const LEGACY_ATTEMPT_KEY = "atelier:codex-update:last-at";

let subscribed = false;

export function startCodexUpdateSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    localStorage.removeItem(LEGACY_ATTEMPT_KEY);
  } catch {
    // Storage blocked: nothing to forget.
  }
  onCodexUpdateState((running) => useDoctor.getState().setCodexUpdating(running)).catch((err) => {
    subscribed = false;
    console.error("codex update: state subscription failed:", err);
  });
  onCodexUpdateDone((done) => {
    useDoctor.getState().setCodexUpdating(false);
    const toast = codexUpdateToast(done);
    if (!toast) return;
    const { action, ...words } = toast;
    pushToast({
      ...words,
      action: action && {
        label: action.label,
        onClick: () => {
          if (action.opens === "repair") {
            void openRepair("codex");
          } else {
            void import("../store/uiStore").then(({ useUi }) => useUi.getState().openSettingsSection("diagnostics"));
          }
        },
      },
    });
  }).catch((err) => {
    console.error("codex update: done subscription failed:", err);
  });
}
