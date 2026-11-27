/**
 * QoL 1.168 G1: the update sheet's words, without jargon — what installing
 * stops, counted from the same detection the quit guard uses (block 1:
 * `quitGuardStore.workingNow` for the work in flight, `runningCounts` for
 * every live session and terminal), and a failure in the error shape
 * (`ErrorBlock`) instead of the updater's raw text, which goes under Details.
 *
 * Pure, so node runs it (`updateWords.test.ts`).
 */

import type { RunningCounts } from "./closeChoice.ts";
import { NOTHING_STOPS, waitingLine, workingLine, workingTotal } from "./quitGuard.ts";
import type { UxError } from "./uxError.ts";
import type { UpdatePhase } from "./updateFlow.ts";

/** Where a person downloads Plyloft by hand when the update can't install. */
export const DOWNLOAD_URL = "https://www.plyloft.com/download";

function counted(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? one : many}`;
}

function listed(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The sheet's body before Install: what restarting stops, every live session
 * and terminal counted, and the work in flight named apart — that is what is
 * lost halfway.
 *
 * `working`: work in flight now (`workingNow`). `open`: everything alive
 * (`runningCounts` over every tile and Builder session).
 */
export function updateConfirmBody(working: RunningCounts, open: RunningCounts): string {
  const parts = ["Installing quits Plyloft and opens the new version."];
  const busy = workingTotal(working) > 0 ? workingLine(working) : null;
  if (busy) {
    parts.push(`Right now ${busy}: that work stops halfway, and a turn in progress is lost.`);
  }
  const asking = waitingLine(working);
  if (asking) parts.push(`${asking.charAt(0).toUpperCase()}${asking.slice(1)}: the question is left unanswered.`);
  const closing = [
    counted(open.sessions, "open session", "open sessions"),
    counted(open.terminals, "terminal", "terminals"),
  ].filter((p): p is string => p !== null);
  if (closing.length > 0) {
    const one = open.sessions + open.terminals === 1;
    parts.push(`${capitalized(listed(closing))} ${one ? "closes" : "close"}.`);
  }
  if (open.sessions > 0 || working.sessions > 0) {
    parts.push("Claude and Codex keep their conversations, and each card offers Resume.");
  }
  if (!busy && closing.length === 0) parts.push(NOTHING_STOPS);
  return parts.join(" ");
}

/** The third choice of the sheet, and what it says under the buttons. */
export const WHEN_DONE_LABEL = "Install when my work is done";

export function whenDoneHint(installsAtQuit: boolean): string {
  return installsAtQuit
    ? "Install when my work is done waits until nothing is working, or until you quit Plyloft, then installs."
    : "Install when my work is done waits until nothing is working, then installs and restarts Plyloft.";
}

/** The sidebar row while a scheduled update waits. */
export function scheduledRowText(version: string): string {
  return `Plyloft ${version} installs when your work is done`;
}

/**
 * 1.176.4 (owner, 2026-11-23): why a scheduled update still waits, in one
 * line — the quit sheet's own words for the same states (`workingLine`,
 * `waitingLine`, joined as its lede joins them), so the two never disagree.
 * Null when no work in flight and no session waiting holds it.
 */
export function updateWaitLine(working: RunningCounts): string | null {
  const lines = [
    workingTotal(working) > 0 ? workingLine(working) : null,
    waitingLine(working),
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return `Waiting: ${lines.join(" · ")}.`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A failed update, in the error shape. Try again is the first way out;
 *  the download page the second. The updater's own text is the Details. */
export function updateFailedError(failure: {
  phase: UpdatePhase;
  stalled: boolean;
  reason: string;
  /** Null: a Check for updates by hand that found nothing yet. */
  version: string | null;
}): UxError {
  const version = failure.version ? `Plyloft ${failure.version}` : "the new version";
  const actions = [
    { id: "retry", label: "Try again", primary: true },
    { id: "download", label: "Download from plyloft.com" },
  ];
  const keeps = "This version of Plyloft keeps working, and nothing you have open was closed.";
  switch (failure.phase) {
    case "check":
      return {
        title: "Plyloft couldn't check for updates.",
        happened: "GitHub, where Plyloft's updates are published, didn't answer.",
        untouched: keeps,
        todo: "Try again in a few minutes. If it keeps happening, check that this computer is online.",
        actions: actions.slice(0, 1),
        details: failure.reason,
      };
    case "download":
      return {
        title: failure.stalled
          ? "The download stopped."
          : "Plyloft couldn't download the update.",
        happened: failure.stalled
          ? `Nothing more of ${version} arrived for a minute, so Plyloft stopped waiting.`
          : `${capitalized(version)} didn't finish downloading.`,
        untouched: keeps,
        todo: "Try again, or download it from plyloft.com and install it yourself.",
        actions,
        details: failure.reason,
      };
    case "install":
      return {
        title: "Plyloft couldn't install the update.",
        happened: `${capitalized(version)} was downloaded, but it couldn't be put in place.`,
        untouched: keeps,
        todo: "Try again, or download it from plyloft.com and install it yourself.",
        actions,
        details: failure.reason,
      };
    case "relaunch":
      return {
        title: "The update is installed, but Plyloft didn't restart.",
        happened: `${capitalized(version)} is in place. Plyloft couldn't open it by itself.`,
        untouched: "Everything you had open is as it was. The new version opens the next time Plyloft starts.",
        todo: "Quit Plyloft and open it again.",
        actions: [],
        details: failure.reason,
      };
  }
}
