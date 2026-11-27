/**
 * QoL 1.168 (F4, owner D6): what the notification row says — in Setup's Your
 * AI step and in Settings › Claude and Codex — for the system's answer
 * (`notification_access`). Pure.
 *
 * - Mac, not asked: one sentence why, and **Allow notifications** (macOS
 *   asks once). Skippable: nothing in Setup waits on it.
 * - Allowed (Windows: always, unless turned off): on, with **Send a test**.
 * - Turned off: the system's settings are the only way back.
 * - Unknown (a development build, or no answer): **Send a test**, whose first
 *   notification makes macOS ask the same question.
 */
import type { NotificationAccess } from "../ipc";

export type NotificationRowAction = "allow" | "settings" | "test";

export type NotificationRowWords = {
  label: string;
  hint: string;
  action: NotificationRowAction;
  actionLabel: string;
};

export const NOTIFICATIONS_WHY =
  "Plyloft tells you when a card is ready or needs a fix, and when Claude or Codex waits for you, while you're in another app.";

export function notificationRowWords(access: NotificationAccess | null, windows: boolean): NotificationRowWords {
  const system = windows ? "Windows Settings" : "System Settings";
  if (access === "allowed") {
    return {
      label: "Notifications are on",
      hint: windows ? `${NOTIFICATIONS_WHY} Windows needs no permission for it.` : NOTIFICATIONS_WHY,
      action: "test",
      actionLabel: "Send a test",
    };
  }
  if (access === "denied") {
    return {
      label: "Notifications are turned off",
      hint: windows
        ? "Plyloft can't tell you when something needs you. Turn them on for Plyloft in Windows Settings, under System › Notifications."
        : `Plyloft can't tell you when something needs you. Turn them on for Plyloft in ${system}.`,
      action: "settings",
      actionLabel: `Open ${system}`,
    };
  }
  if (access === "not-asked" && !windows) {
    return {
      label: "Allow notifications",
      hint: `${NOTIFICATIONS_WHY} macOS asks you once.`,
      action: "allow",
      actionLabel: "Allow notifications",
    };
  }
  return {
    label: "Notifications",
    hint: windows
      ? `${NOTIFICATIONS_WHY} Send a test to see one arrive.`
      : `${NOTIFICATIONS_WHY} The first test makes macOS ask for permission — accept it, or nothing else arrives.`,
    action: "test",
    actionLabel: "Send a test",
  };
}
