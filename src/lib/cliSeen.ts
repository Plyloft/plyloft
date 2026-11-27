import { cliSeenTake, onCliSeenPending } from "./cliSeenIpc";
import { cliSeenToast } from "./cliSeenNotice";
import { pushToast } from "../store/toastStore";

/**
 * 1.176.1: the window's side of `cli_seen.rs`. A launch's look happens
 * before the window listens, so the notices wait in the backend: taken once
 * at start (after the listener is up, so none slips between) and again on
 * each `cli-seen://pending`. Each is given once, so nothing is said twice.
 */

let subscribed = false;

async function takeAndSay(): Promise<void> {
  let notices;
  try {
    notices = await cliSeenTake();
  } catch (err) {
    console.error("cli seen: take failed:", err);
    return;
  }
  for (const notice of notices) {
    const toast = cliSeenToast(notice);
    if (toast) pushToast(toast);
  }
}

export function startCliSeenSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  onCliSeenPending(() => void takeAndSay())
    .then(() => takeAndSay())
    .catch((err) => {
      subscribed = false;
      console.error("cli seen: subscription failed:", err);
    });
}
