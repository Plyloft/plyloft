import { invoke } from "@tauri-apps/api/core";
import type { ShipMode } from "./shipVia";

// The pull request draft's backend calls (`card_pr_commands.rs`,
// `pr_draft.rs`), moved out of `ipc.ts` unchanged (1.175.0 F6, to make room
// under its cap), with F6's own beside them.

/** G4: the message for the card's Builder to write its pull request's title
 *  and description, and the session it is for — or why none is asked
 *  (`pr_draft.rs::DraftAsk`). */
export interface PrDraftAsk {
  message?: string;
  /** G4 Challenger 1: this press's request, handed back to `card_ship`. */
  requestId?: string;
  ptyId?: string;
  skip?: string;
}

/** G4: the Builder's draft as it is in the card's copy now. */
export type PrDraftRead =
  | { state: "ready"; title: string; body: string }
  | { state: "missing" }
  | { state: "unusable"; reason: string };

export function cardPrDraftPrepare(workspaceId: string, cardId: string, mode: ShipMode) {
  return invoke<PrDraftAsk>("card_pr_draft_prepare", { workspaceId, cardId, mode });
}

export function cardPrDraftRead(workspaceId: string, cardId: string) {
  return invoke<PrDraftRead>("card_pr_draft_read", { workspaceId, cardId });
}

/** G4 Challenger 1: the wait ended without a draft — drop the request. */
export function cardPrDraftForget(workspaceId: string, cardId: string, requestId: string) {
  return invoke<void>("card_pr_draft_forget", { workspaceId, cardId, requestId });
}

/** 1.175.0 F6 (UX-6): the draft asked while the Reviewer reviews — the same
 *  message, for the card's last build, kept on the card for Ship. */
export function cardPrDraftPrepareEarly(workspaceId: string, cardId: string, mode: ShipMode) {
  return invoke<PrDraftAsk>("card_pr_draft_prepare", { workspaceId, cardId, mode, duringReview: true });
}

/** 1.175.0 F6 (Read it): the person's title and description over the
 *  Builder's draft, before the pull request exists. Local only. */
export function cardPrDraftSave(workspaceId: string, cardId: string, title: string, body: string) {
  return invoke<PrDraftRead>("card_pr_draft_save", { workspaceId, cardId, title, body });
}
