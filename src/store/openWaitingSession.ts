import type { WaitingSession } from "../lib/needsYou";
import { usePlanExchange } from "./planExchangeStore";
import { useTileSeen } from "./tileSeenStore";
import { useWorkspaces } from "./workspaceStore";
import { useUi } from "./uiStore";
import { showTile } from "./tileActions";
import { useBuildBoth } from "./buildBothStore";

/** The Inbox's press on a card's waiting Builder, and the update's line. */
export const OPEN_THE_BUILDER = "Open the Builder";
/** The Inbox's press on a waiting tile, and the update's line. */
export const OPEN_SESSION = "Open session";

/** What opening a waiting session needs to know. */
export type WaitingSessionPlace = Pick<WaitingSession, "workspaceId" | "target" | "question" | "intake" | "episode">;

/**
 * Open a waiting session: its tile, expanded in Terminals, or its card.
 * The Inbox's row press (moved here from `InboxPanel.tsx` in 1.176.4, so the
 * update's "Waiting: …" line opens a session the same way).
 */
export function openWaitingSession(s: WaitingSessionPlace): void {
  const workspaces = useWorkspaces.getState();
  if (workspaces.activeId !== s.workspaceId) void workspaces.setActive(s.workspaceId);
  if (s.target.kind === "card") {
    useUi.getState().selectCard(s.workspaceId, s.target.cardId, true);
    // N14 walk F14: a stopped intake opens its card, where Now offers Plan
    // again and Cancel intake.
    if (s.question === "intake-stopped") return;
    // Plan with two AIs: the card's Plan view, with its decision bar.
    if (s.question === "plan") {
      usePlanExchange.getState().requestForm(s.workspaceId, s.target.cardId);
      return;
    }
    // C6 (UX-6.3): the card's Builder is behind "Open the Builder"; this is it.
    // N14 walk F15: an intake that asks shows its conversation, not the
    // Builder's empty session.
    // C3 follow-up: the Builder's session keeps an open Review beside it.
    if (s.intake) useUi.getState().setCardStep(s.target.cardId, "intake");
    else useUi.getState().openCardSession(s.target.cardId);
    // Round 3: a card built by both shows the build the row is about.
    if (s.target.lane) useBuildBoth.getState().showLane(s.workspaceId, s.target.cardId, s.target.lane);
  } else {
    // QoL 1.168 (D7): opening the tile is seeing its turn.
    if (s.episode != null) useTileSeen.getState().markSeen([{ tileId: s.target.tileId, episode: s.episode }]);
    // QoL 1.168 (A1): on Terminals, with the keyboard in it.
    showTile(s.workspaceId, s.target.tileId);
  }
}
