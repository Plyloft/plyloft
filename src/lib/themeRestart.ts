/**
 * 1.168.1 (#6, Windows; fallback B, owner 2026-10-22): on Windows a Claude
 * session can't follow a light/dark switch live. ConPTY drops the background
 * question Claude asks after a color-scheme report (OSC 11), so Claude keeps
 * the colors it started with. Its tile, an agent REPL run's tile, or the
 * Builder on the card page then says so, with Restart where there is one: a
 * tile resumes the same conversation (`--resume <id>`), the Builder takes its
 * Resume. Never on the Mac (Claude follows live there), never for Codex or a
 * shell, and never for a session Plyloft gave no theme (its light/dark is
 * unknown: `pty_session_lightness` says null).
 *
 * 1.169.0 (B2): Plyloft for Windows ships Microsoft's own ConPTY, which
 * passes OSC 11 both ways: there Claude follows a switch live, as on the
 * Mac, and the line never shows. It stays for a run on the system ConPTY
 * (the bundled one missing or failing to start: `conpty_host.rs`,
 * `pty_console_host`).
 *
 * The light/dark a session started in comes from the backend, recorded at
 * spawn (`claude_theme::register`). A dismissal is kept per session (its PTY
 * id) for as long as the app runs, so leaving the card and coming back
 * doesn't ask again; it goes when the session does.
 */

export const THEME_RESTART_WORDS =
  "Claude keeps the colors it started with on Windows. Restart it to use the new theme.";

/** The same, where the session has no Restart (no conversation id yet, or
 *  an agent run). */
export const THEME_REOPEN_WORDS =
  "Claude keeps the colors it started with on Windows. Close it and start a new one to use the new theme.";

/** Asked before a Restart stops a session that is working or waiting. */
export const RESTART_WHILE_WORKING = {
  title: "Claude is still working. Restart now?",
  body: "It stops what it is doing and comes back in the same conversation, in the new theme.",
  confirmLabel: "Restart now",
  cancelLabel: "Not now",
  cautious: true,
} as const;

const dismissed = new Map<string, boolean>();

/** The light/dark this session's line was dismissed for, if it was. */
export function dismissedFor(key: string): boolean | null {
  return dismissed.get(key) ?? null;
}

export function dismissFor(key: string, dark: boolean): void {
  dismissed.set(key, dark);
}

/** Back to the session's own light/dark (a later flip asks again), or the
 *  session ended. */
export function forgetDismissal(key: string): void {
  dismissed.delete(key);
}

/** For tests. */
export function resetThemeRestartForTests(): void {
  dismissed.clear();
}

/** Whether the line shows: on Windows on the system ConPTY, for Claude,
 *  for a session whose start light/dark is known and differs from the
 *  app's now, unless dismissed for this very light/dark. `consoleHost`
 *  null (not known yet): no line. */
export function offersThemeRestart(input: {
  windows: boolean;
  consoleHost: "bundled" | "system" | null;
  vendor: string | null | undefined;
  startedDark: boolean | null;
  nowDark: boolean;
  dismissedFor: boolean | null;
}): boolean {
  if (!input.windows || input.vendor !== "claude") return false;
  if (input.consoleHost !== "system") return false;
  if (input.startedDark === null || input.startedDark === input.nowDark) return false;
  return input.dismissedFor !== input.nowDark;
}
