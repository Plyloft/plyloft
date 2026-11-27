// 1.175.0 B2 (SEC-4): the calls behind `checksConsent.ts` (`checks_consent.rs`).
// Here, not in `ipc.ts`, which is at its size ceiling.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ConsentView } from "./checksConsent";

/** What this computer allowed and what the repository has now. */
export function checksConsentView(workspaceId: string) {
  return invoke<ConsentView>("checks_consent_view", { workspaceId });
}

/** Allow and run on a card: the checks shown (`hash`) are allowed on this
 *  computer, then run on the card (and on any other card waiting for them). */
export function checksAllowAndRun(workspaceId: string, cardId: string, hash: string) {
  return invoke<void>("checks_allow_and_run", { workspaceId, cardId, hash });
}

/** Allow and run on the install step: the path shown is allowed, and the
 *  step runs for the release that was waiting. Resolves to what started. */
export function installAllowAndRun(workspaceId: string, path: string) {
  return invoke<string>("install_allow_and_run", { workspaceId, path });
}

/** An OK was given, or a local change allowed itself (payload: workspace id). */
export function onChecksConsentChanged(cb: (workspaceId: string) => void): Promise<UnlistenFn> {
  return listen<string>("checks-consent://changed", (e) => cb(e.payload));
}
