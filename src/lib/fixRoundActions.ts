import { invoke } from "@tauri-apps/api/core";
import type { KanbanCard } from "../ipc";

// 1.175.0 F5: the backend half of "Finish and check by itself" (`fix_round.rs`).

/** "After a fix round" on this card: true checks by itself, false waits,
 *  null follows Settings › Cards › AI and models. */
export function cardFixRoundCheckSet(workspaceId: string, cardId: string, check: boolean | null) {
  return invoke<KanbanCard>("card_fix_round_check_set", { workspaceId, cardId, check });
}

/** The checks Plyloft started by itself in a row on this card. */
export function cardFixRoundSelfChecksSet(workspaceId: string, cardId: string, count: number) {
  return invoke<number>("card_fix_round_self_checks_set", { workspaceId, cardId, count });
}

/** Whether the card's copy changed since its last snapshot; null when it
 *  can't be told. */
export function cardFixRoundChanged(workspaceId: string, cardId: string) {
  return invoke<boolean | null>("card_fix_round_changed", { workspaceId, cardId });
}
