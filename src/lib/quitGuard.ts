/**
 * QoL 1.168 S1-2: what a quit would lose, and the words of the sheet that asks.
 *
 * Every quit Plyloft starts itself (Plyloft › Quit and ⌘Q on the Mac, the
 * tray's Quit and Ctrl+Shift+Q on Windows, the close sheet's Quit) and the
 * updater's relaunch ask first — but only when something would be lost
 * (owner decision D8): files with unsaved changes, or work in flight (a
 * Claude or Codex turn mid-way, a Builder working, a run, a review, a build,
 * a ship). A session waiting at its prompt loses nothing — its conversation
 * is kept and Resume continues it — so it never makes the quit ask.
 *
 * Unsaved files are always asked about. Work in flight is asked about while
 * `behavior.confirmQuitWithWorkingSessions` is on; the sheet's "Don't ask
 * again" turns it off.
 *
 * Pure, so node runs it (`quitGuard.test.ts`).
 */

import { basename } from "./paths.ts";
import type { RunningCounts } from "./closeChoice.ts";

export interface UnsavedFile {
  workspaceId: string;
  path: string;
}

/** Why Plyloft is about to end: a quit, or the updater's relaunch. */
export type QuitReason = "quit" | "update";

/** What a quit would lose. `working` counts only work in flight: sessions
 *  mid-turn (never one waiting at its prompt), runs, reviews, swarms,
 *  builds and a ship. `terminals` is unused here (a shell at its prompt or
 *  serving a dev server is not asked about). */
export interface QuitLoss {
  files: UnsavedFile[];
  working: RunningCounts;
}

export function workingTotal(c: RunningCounts): number {
  return c.sessions + c.runs + c.reviews + c.swarms + c.builds + (c.shipping ? 1 : 0);
}

/** What keeps "Install when my work is done" waiting: the work in flight and
 *  the sessions waiting for an answer (Challenger: never a restart over a
 *  pending approval). */
export function busyForUpdate(c: RunningCounts): number {
  return workingTotal(c) + (c.waiting ?? 0);
}

export interface QuitAskOptions {
  /** `behavior.confirmQuitWithWorkingSessions`. */
  askWorking: boolean;
  /** The Windows close sheet already named what would stop: ask only about
   *  unsaved files. */
  workingAcknowledged: boolean;
}

/** Whether the quit asks at all. */
export function quitAsks(loss: QuitLoss, opts: QuitAskOptions): boolean {
  if (loss.files.length > 0) return true;
  return workingCounted(loss, opts);
}

/** Whether the sheet names the work in flight, or sessions waiting for an
 *  answer (1.169.0, owner: a quit asks for those too, as closing a tile does). */
export function workingCounted(loss: QuitLoss, opts: QuitAskOptions): boolean {
  return opts.askWorking && !opts.workingAcknowledged && workingTotal(loss.working) + (loss.working.waiting ?? 0) > 0;
}

/** `1 session asks you something`, `2 sessions ask you something` (1.171.0
 *  C2, CF8: the session word). */
export function waitingLine(c: RunningCounts): string | null {
  const n = c.waiting ?? 0;
  if (n <= 0) return null;
  return n === 1 ? "1 session asks you something" : `${n} sessions ask you something`;
}

function counted(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? one : many}`;
}

function listed(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** `2 files have unsaved changes`. */
export function unsavedLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 file has unsaved changes" : `${n} files have unsaved changes`;
}

/** `1 session is working`, `2 sessions and 1 build are working`,
 *  `a card is shipping`. */
export function workingLine(c: RunningCounts): string | null {
  const parts = [
    counted(c.sessions, "session", "sessions"),
    counted(c.runs, "agent run", "agent runs"),
    counted(c.reviews, "review", "reviews"),
    counted(c.swarms, "multi-AI run", "multi-AI runs"),
    counted(c.builds, "build", "builds"),
  ].filter((p): p is string => p !== null);
  const one = workingTotal(c) - (c.shipping ? 1 : 0) === 1;
  const working = parts.length > 0 ? `${listed(parts)} ${one ? "is" : "are"} working` : null;
  const shipping = c.shipping ? "a card is shipping" : null;
  if (working && shipping) return `${working}, and ${shipping}`;
  return working ?? shipping;
}

/** The file names the sheet lists, at most `max`, then "and N more". */
export function fileNames(files: UnsavedFile[], max = 5): string[] {
  const names = files.slice(0, max).map((f) => basename(f.path));
  if (files.length > max) names.push(`and ${files.length - max} more`);
  return names;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The update sheet's own sentence (`updateWords.updateConfirmBody`), for a
 *  quit sheet whose work ended while it was open. */
export const NOTHING_STOPS = "Nothing is running, so nothing stops.";

export interface QuitSheetWords {
  title: string;
  /** `2 files have unsaved changes · 1 session is working.` */
  lede: string;
  /** What happens to the work in flight, when it is named. */
  workingNote: string | null;
  /** Shown only with unsaved files. */
  saveAll: string | null;
  anyway: string;
  cancel: string;
  /** "Don't ask again" for the work in flight, when it is named. */
  dontAsk: string | null;
  dontAskHint: string | null;
}

export function quitSheetWords(
  loss: QuitLoss,
  reason: QuitReason,
  opts: QuitAskOptions,
): QuitSheetWords {
  const working = workingCounted(loss, opts);
  const inFlight = working && workingTotal(loss.working) > 0;
  // 1.177.1 (item 21): the open sheet follows what is going on; once nothing
  // would be lost any more it says so (the update sheet's approved sentence)
  // and waits for the press — it never ends Plyloft by itself.
  // Review M1: only when nothing works or waits at all — "Don't ask again",
  // or the Windows close sheet that already named the work, leave `working`
  // false while a turn runs.
  if (loss.files.length === 0 && !working && workingTotal(loss.working) + (loss.working.waiting ?? 0) === 0) {
    const update = reason === "update";
    return {
      title: update ? "Restart Plyloft to update?" : "Quit Plyloft?",
      lede: NOTHING_STOPS,
      workingNote: null,
      saveAll: null,
      anyway: update ? "Restart anyway" : "Quit Plyloft",
      cancel: "Cancel",
      dontAsk: null,
      dontAskHint: null,
    };
  }
  let lines = [
    unsavedLine(loss.files.length),
    inFlight ? workingLine(loss.working) : null,
    working ? waitingLine(loss.working) : null,
  ].filter((l): l is string => l !== null);
  // Review M1: the file the sheet opened for was saved meanwhile, and the work
  // in flight wasn't to be asked about: the sheet still says what is true.
  if (lines.length === 0) {
    lines = [workingLine(loss.working), waitingLine(loss.working)].filter((l): l is string => l !== null);
  }
  const update = reason === "update";
  return {
    title: update ? "Restart Plyloft to update?" : "Quit Plyloft?",
    lede: capitalized(`${lines.join(" · ")}.`),
    workingNote: inFlight
      ? `${update ? "Restarting" : "Quitting"} stops that work halfway. A Claude or Codex conversation can be resumed afterwards; the turn in progress is lost.`
      : working
        ? `${update ? "Restarting" : "Quitting"} leaves the question unanswered. A Claude or Codex conversation can be resumed afterwards; the turn that asked is lost.`
        : null,
    saveAll: loss.files.length > 0 ? (update ? "Save all and restart" : "Save all and quit") : null,
    anyway: update ? "Restart anyway" : "Quit anyway",
    cancel: "Cancel",
    dontAsk: working ? "Don't ask again about work in progress" : null,
    dontAskHint: working
      ? "Unsaved files are always asked about. You can turn this back on in Settings › Look and feel › Appearance."
      : null,
  };
}

/** What Save all reports when a file could not be written. */
export function saveFailedLine(failed: { path: string }[]): string {
  const names = listed(failed.map((f) => basename(f.path)));
  return failed.length === 1
    ? `${names} could not be saved, so Plyloft is still open. Save it from Code, or quit anyway.`
    : `${names} could not be saved, so Plyloft is still open. Save them from Code, or quit anyway.`;
}
