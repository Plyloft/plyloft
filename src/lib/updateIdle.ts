/**
 * QoL 1.168 G1 (Challenger round 1): when "Install when my work is done" may
 * restart Plyloft. Pure — the facts are gathered by `UpdatePrompt.tsx`'s
 * `idleFactsNow` — so node runs every branch (`updateIdle.test.ts`).
 *
 * Prudent by design: anything that could be lost or interrupted, and anything
 * Plyloft cannot read, keeps the update waiting. A shell whose command state
 * is unknown counts as running.
 */

/** No key, click, wheel or scroll in Plyloft for this long. */
export const IDLE_FOR_MS = 2 * 60 * 1000;
/** How often the watcher looks. */
export const IDLE_POLL_MS = 15 * 1000;
/** Idle looks in a row before it installs (a session between two turns
 *  reads idle for a moment). */
export const IDLE_LOOKS = 2;

export interface IdleFacts {
  now: number;
  lastInputAt: number;
  /** Open files with changes, including ones a save was refused for. */
  dirtyFiles: number;
  /** Work in flight (`workingTotal(workingNow())`). */
  working: number;
  /** Each live shell tile's `ptyCommandRunning`: true, false or null. */
  shellCommands: readonly (boolean | null)[];
  /** Claude/Codex tiles whose input line holds an unsent draft. */
  drafts: number;
  /** The quit sheet is asking. */
  quitAsk: boolean;
  /** A sheet or a UX surface (Settings) is on screen. */
  modalOpen: boolean;
  settingsOpen: boolean;
  setupOpen: boolean;
  paletteOpen: boolean;
  /** The window is shown and in front. A restart opens the new version's
   *  window in front, so it never happens behind a hidden (hard rule 5) or
   *  backgrounded window: there the Mac installs at quit instead. */
  windowInFront: boolean;
}

export type IdleBlocker =
  | "input"
  | "files"
  | "working"
  | "shell"
  | "draft"
  | "quit-sheet"
  | "modal"
  | "settings"
  | "setup"
  | "palette"
  | "window";

/** What keeps the update waiting now, or null when it may install. */
export function idleBlocker(f: IdleFacts): IdleBlocker | null {
  if (f.now - f.lastInputAt < IDLE_FOR_MS) return "input";
  if (f.dirtyFiles > 0) return "files";
  if (f.working > 0) return "working";
  if (f.shellCommands.some((c) => c !== false)) return "shell";
  if (f.drafts > 0) return "draft";
  if (f.quitAsk) return "quit-sheet";
  if (f.settingsOpen) return "settings";
  if (f.setupOpen) return "setup";
  if (f.paletteOpen) return "palette";
  if (f.modalOpen) return "modal";
  if (!f.windowInFront) return "window";
  return null;
}

/** The count of idle looks in a row after one more look. */
export function nextIdleLooks(previous: number, idle: boolean): number {
  return idle ? previous + 1 : 0;
}

export function installDue(looks: number): boolean {
  return looks >= IDLE_LOOKS;
}

/** The input events that count as someone using Plyloft. */
export const ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel", "scroll"] as const;
