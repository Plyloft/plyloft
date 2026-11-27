import type { AgentConfig, AgentRun, AgentRunDoneEvent } from "../ipc";
import { isWindows } from "./platform";

/**
 * Posts a native macOS notification for a finished agent run, subject to:
 *  - global `behavior.notifyOnAgentDone` settings flag
 *  - per-agent `notifyOnDone` flag
 *  - status filter (skip user-initiated `killed`)
 *  - focus suppression for `manual` triggers (in-app toast is enough when window is up)
 *
 * Returns silently if the user hasn't granted notification permission yet —
 * QoL 1.168 (D6): Setup's Your AI step asks for it, and Settings › Claude
 * and Codex shows it with Allow (`components/NotificationAccessRow.tsx`).
 */
export async function maybeNotifyRunDone(
  event: AgentRunDoneEvent,
  agent: AgentConfig | null,
  globallyEnabled: boolean,
  run: AgentRun | null,
): Promise<void> {
  if (!globallyEnabled) return;
  if (!agent || !agent.notifyOnDone) return;
  if (event.status === "killed") return;
  // v1.0 R6: swarm-spawned runs are silenced — the swarm fires its own
  // single completion notification per `SwarmRegistry::terminate`.
  if (event.swarmId) return;

  // For manual runs, suppress when the window is focused (toast is enough).
  // Other runs always notify. (GH #171: scheduled and event-triggered runs
  // are retired; only an old run record can still carry those triggers.)
  if (run && run.trigger === "manual") {
    if (typeof document !== "undefined" && document.hasFocus()) return;
  }

  const startedAt = run?.startedAt ?? null;
  const endedAt = event.endedAt ?? run?.endedAt ?? null;
  const duration =
    startedAt && endedAt
      ? `${Math.round((endedAt - startedAt) / 1000)}s`
      : null;

  const body = duration
    ? `${event.status} · ${duration}`
    : event.status;

  await sendNative(`Agent: ${agent.name}`, body);
}

// QoL 1.168 (Challenger 3, 4): sessions and cards notify through the one
// gate (`store/notifyGate.ts`), which calls `sendNative` below.

/**
 * Post one native notification, or nothing. Resolves to whether it was
 * handed to the system — which on the desktop says nothing about whether it
 * was shown (the plugin always says yes); `notification_access` says that. Lazy-loads the plugin so it
 * stays out of the App's initial module graph (earlier versions imported it
 * eagerly and the WKWebView failed to initialize on first launch), and
 * returns silently when permission has not been granted.
 */
export async function sendNative(title: string, body: string): Promise<boolean> {
  let plugin: typeof import("@tauri-apps/plugin-notification");
  try {
    plugin = await import("@tauri-apps/plugin-notification");
  } catch {
    return false;
  }
  let granted = false;
  try {
    granted = await notificationsPermitted(plugin);
  } catch {
    return false;
  }
  if (!granted) return false;
  try {
    plugin.sendNotification({ title, body });
    return true;
  } catch {
    // Plugin call can throw if permission was revoked between the check and
    // the send; swallow so it doesn't bubble up to the renderer.
    return false;
  }
}

/**
 * Whether Ply may post a native notification. Never prompts on the Mac
 * (Setup's Your AI step and Settings ask, `notificationRequestAccess`). Windows: the plugin's
 * page script marks the permission "denied" at start until it is asked for;
 * asking on the desktop grants it with no prompt (toasts are the system's to
 * mute). Without this, no Ply notification ever showed on Windows.
 */
export async function notificationsPermitted(
  plugin: Pick<typeof import("@tauri-apps/plugin-notification"), "isPermissionGranted" | "requestPermission">,
): Promise<boolean> {
  if (await plugin.isPermissionGranted()) return true;
  if (!isWindows()) return false;
  return (await plugin.requestPermission()) === "granted";
}
