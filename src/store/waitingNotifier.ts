import { useWorkspaces } from "./workspaceStore";
import { useSettings } from "./settingsStore";
import { useTiles } from "./tileStore";
import { useBuilder } from "./builderStore";
import { useKanban } from "./kanbanStore";
import {
  EMPTY_TRACKER,
  sessionsToNotify,
  turnsEnded,
  waitingNotification,
  type WaitingTracker,
} from "../lib/waitingNotify";
import { sessionTarget } from "../lib/notifyTarget";
import { cardIdOfSessionKey } from "../lib/buildBoth";
import { gatedNotify } from "./notifyGate";

/** The workspace in front of the person: the active one while Ply is
 *  focused and visible, none while it is in the background or hidden. */
function workspaceOnScreen(activeId: string | null): string | null {
  if (typeof document === "undefined") return activeId;
  return document.hasFocus() && !document.hidden ? activeId : null;
}

/**
 * A system notification when a Claude or Codex session ends a turn and waits
 * for its person somewhere the person is not looking (`lib/waitingNotify.ts`
 * decides which). App calls the step from the dock badge's tick, which is
 * never paused while the window is hidden — exactly when a notification is
 * worth sending.
 */
export function createWaitingNotifier(): (now: number) => void {
  let tracker: WaitingTracker = EMPTY_TRACKER;
  return (now) => {
    const kanban = useKanban.getState().byWorkspace;
    const ended = turnsEnded({
      tilesByWorkspace: useTiles.getState().byWorkspace,
      builders: useBuilder.getState().byCard,
      cardTitle: (ws, id) => kanban[ws]?.cards.find((c) => c.id === id)?.title ?? null,
      now,
    });
    const { workspaces, activeId } = useWorkspaces.getState();
    const { notify, next } = sessionsToNotify(tracker, ended, workspaceOnScreen(activeId), now);
    tracker = next;
    if (notify.length === 0) return;
    const enabled = useSettings.getState().settings.behavior.notifyOnSessionWaiting;
    if (!enabled) return;
    const builders = useBuilder.getState();
    for (const s of notify) {
      const key = s.id.startsWith("builder:") ? s.id.slice("builder:".length) : null;
      // QoL 1.168 (Challenger 4): a Builder in its Finish and check (its
      // self-check, or the press itself) is not waiting for the person; the
      // card says so, and its result is the card notifier's.
      if (key && (builders.selfCheck[key] || builders.doneBusy[key])) continue;
      const name = workspaces.find((w) => w.id === s.workspaceId)?.name ?? "Another workspace";
      gatedNotify({
        // One card, once a minute, whichever notifier tells it.
        cardKey: key ? `${s.workspaceId}::${cardIdOfSessionKey(key)}` : null,
        ...waitingNotification(s, name),
        target: sessionTarget(s.id, s.workspaceId, s.where),
      });
    }
  };
}
