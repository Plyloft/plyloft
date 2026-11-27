import type { InboxFeed } from "../ipc";
import { useSettings } from "./settingsStore";
import { useWorkspaces } from "./workspaceStore";
import { useKanban } from "./kanbanStore";
import { cardsToNotify, collapseNotices, EMPTY_CARD_TRACKER, type CardTracker } from "../lib/cardNotify";
import type { OnScreen } from "../lib/seenOnScreen";
import { gatedNotify } from "./notifyGate";

/**
 * QoL 1.168 (F3): a system notification when a card needs its person
 * (`lib/cardNotify.ts` decides which). App calls the step from the dock
 * badge's tick with the reconciled feed — the tick runs while the window is
 * hidden too, which is when a notification is worth sending. Sent through
 * the shared gate (`store/notifyGate.ts`); a click on one opens the card.
 */
export function createCardNotifier(): (feed: InboxFeed | null, onScreen: OnScreen, now: number) => void {
  let tracker: CardTracker = EMPTY_CARD_TRACKER;
  return (feed, onScreen, now) => {
    const { workspaces, activeId } = useWorkspaces.getState();
    const nameOf = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";
    const boards = useKanban.getState().byWorkspace;
    const loaded = new Set(Object.keys(boards).filter((ws) => boards[ws]?.loaded === true));
    const { notify, next } = cardsToNotify(tracker, feed, onScreen, now, nameOf, loaded);
    tracker = next;
    if (notify.length === 0) return;
    if (!useSettings.getState().settings.behavior.notifyOnAgentDone) return;
    for (const n of collapseNotices(notify)) {
      const card = n.card;
      gatedNotify(
        {
          cardKey: card ? `${card.workspaceId}::${card.cardId}` : null,
          title: n.title,
          body: n.body,
          target: card
            ? { kind: "card", workspaceId: card.workspaceId, cardId: card.cardId, name: card.cardTitle }
            : activeId
              ? { kind: "inbox", workspaceId: activeId }
              : null,
        },
        now,
      );
    }
  };
}
