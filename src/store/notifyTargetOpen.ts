import { getCurrentWindow } from "@tauri-apps/api/window";
import { onNotificationSent } from "../ipc";
import { armTarget, dropTarget, personAway, takeOnFocus, type NotifyTarget } from "../lib/notifyTarget";
import { nativeDialogOpen } from "../lib/nativeDialog";
import { useWorkspaces } from "./workspaceStore";
import { openCenterMode, useUi } from "./uiStore";
import { showTile } from "./tileActions";
import { useBuildBoth } from "./buildBothStore";
import { pushToast } from "./toastStore";
import { notificationsAllowed, refreshNotificationAccess } from "./notificationAccessCache";

/** QoL 1.168 (F5): open what a notification was about — as the Inbox row
 *  for it does (`InboxPanel`'s `openSession`, `inboxStore.open`). */
export function openNotifyTarget(t: NotifyTarget): void {
  const workspaces = useWorkspaces.getState();
  if (workspaces.activeId !== t.workspaceId) void workspaces.setActive(t.workspaceId);
  const ui = useUi.getState();
  if (t.kind === "inbox") {
    openCenterMode(t.workspaceId, "inbox");
    return;
  }
  if (t.kind === "tile") {
    // QoL 1.168 (A1, L1): the member clicked the notification — the tile,
    // with the keyboard in it.
    showTile(t.workspaceId, t.tileId);
    return;
  }
  ui.selectCard(t.workspaceId, t.cardId, true);
  if (t.kind === "session") {
    // C3 follow-up: an open Review stays beside the session.
    ui.openCardSession(t.cardId);
    if (t.lane) useBuildBoth.getState().showLane(t.workspaceId, t.cardId, t.lane);
  }
}

/** Plyloft came to the front: the click opens its target; a later return
 *  is offered it in a toast (`lib/notifyTarget.ts::decideOnFocus`). */
export function onWindowFront(now: number): void {
  const decision = takeOnFocus(now);
  if (!decision) return;
  if (decision.kind === "open") {
    openNotifyTarget(decision.target);
    return;
  }
  const t = decision.target;
  pushToast({
    kind: "info",
    title: t.kind === "inbox" ? "From the notification: the Inbox" : `From the notification: ${t.name ?? "a card"}`,
    action: { label: "Open", onClick: () => openNotifyTarget(t) },
  });
}

let started = false;

/**
 * Once, from App: the window coming to the front decides the newest
 * notification's target; Rust's notifications (a pull request on GitHub)
 * leave theirs; the person moving to another workspace or mode drops it.
 * Returns the cleanup.
 */
export function startNotifyTargets(): () => void {
  if (started) return () => {};
  started = true;
  void refreshNotificationAccess();
  const unlisten: (() => void)[] = [];
  let gone = false;
  const keep = (p: Promise<() => void>) =>
    void p
      .then((u) => {
        if (gone) u();
        else unlisten.push(u);
      })
      .catch(() => {});
  keep(
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      onWindowFront(Date.now());
      void refreshNotificationAccess();
    }),
  );
  keep(
    onNotificationSent((e) => {
      if (!notificationsAllowed()) return;
      if (!personAway(typeof document === "undefined" ? null : document, nativeDialogOpen())) return;
      armTarget({ kind: "card", workspaceId: e.workspaceId, cardId: e.cardId }, Date.now());
    }),
  );
  unlisten.push(
    useWorkspaces.subscribe((s, prev) => {
      if (s.activeId !== prev.activeId) dropTarget();
    }),
    useUi.subscribe((s, prev) => {
      if (s.centerMode !== prev.centerMode) dropTarget();
    }),
  );
  return () => {
    gone = true;
    started = false;
    for (const u of unlisten) u();
  };
}
