import { notificationAccess, type NotificationAccess } from "../ipc";

/**
 * QoL 1.168 (Challenger 3): the system's notification permission as Plyloft
 * last read it (`notification_access`). The plugin's own permission state and
 * `show()` always say yes on the desktop, so this is what decides whether a
 * notification can have reached the person — and so whether its click can
 * be waited for. Read at start, whenever the window comes to the front, and
 * by the notification row (Setup, Settings).
 */
let cached: NotificationAccess | null = null;

export function notificationsAllowed(): boolean {
  return cached === "allowed";
}

export function setNotificationAccessCache(access: NotificationAccess | null): void {
  cached = access;
}

export function refreshNotificationAccess(): Promise<NotificationAccess | null> {
  return notificationAccess()
    .then((a) => {
      cached = a;
      return a;
    })
    .catch(() => {
      cached = null;
      return null;
    });
}
