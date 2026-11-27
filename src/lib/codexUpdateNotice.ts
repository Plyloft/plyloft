import { causeWords } from "./aiTools.ts";
import type { CodexUpdateDone } from "./codexUpdateIpc.ts";

// 1.176.0 R5: what the window says about the automatic Codex update. Pure,
// so each outcome's words are tested without a window (codexUpdateNotice.test.ts).
// The backend decides *whether* to say anything (`notice`: once per failing
// version and cause); this decides the words, R2's sentences reused.

export interface CodexUpdateToast {
  kind: "info" | "warn" | "error";
  title: string;
  body: string;
  details?: string;
  /** The press: Diagnostics' Update row, or Repair when Codex doesn't start. */
  action?: { label: string; opens: "diagnostics" | "repair" };
}

const NAME = "Codex";

/** The way on when nothing better is known: the next try, or the row now. */
const LATER = "Plyloft tries again tomorrow. To update it now, use Update in Diagnostics.";

function wayOn(done: CodexUpdateDone): string {
  switch (done.cause) {
    // R2's own words: trying again won't help a folder another account owns.
    case "permissions":
      return "That folder may belong to another account (an earlier install as an administrator can do that). Ask whoever manages this computer, or install it yourself.";
    case "disk-full":
      return "Free some space on the disk; Plyloft tries again tomorrow.";
    default:
      return LATER;
  }
}

function happened(done: CodexUpdateDone): string {
  const why = causeWords(NAME, true, done, done.tail);
  if (why) return why.happened;
  if (done.outcome === "older-version-now" || !done.starts) return `${NAME}'s update didn't finish.`;
  // It ran only because a newer Codex was known: a clean exit that left the
  // old version is R2's "said it finished" case.
  if (done.outcome === "still-on-old-version" && done.exitCode === 0) {
    return `${NAME}'s updater said it finished, but the old version still runs.`;
  }
  return `${NAME}'s updater stopped with an error.`;
}

function untouched(done: CodexUpdateDone): string {
  const { versionBefore: before, versionAfter: after } = done;
  if (done.outcome === "older-version-now") {
    return after && before
      ? `An older copy of ${NAME} answers now: version ${after}, where it was ${before}.`
      : `An older copy of ${NAME} answers now.`;
  }
  return before ? `${NAME} still works, on version ${before}.` : `${NAME} still works, on the version it had.`;
}

function detailsOf(done: CodexUpdateDone): string | undefined {
  const text = [done.command, ...done.tail].join("\n").trim();
  return text || undefined;
}

/** The toast for an update that ended, or null to stay quiet. */
export function codexUpdateToast(done: CodexUpdateDone): CodexUpdateToast | null {
  const details = detailsOf(done);
  const reason = done.tail.length > 0 ? " Details has the reason." : "";
  switch (done.notice) {
    case "updated":
      // As before R5: one quiet line when a newer Codex runs.
      return {
        kind: "info",
        title: "Codex is up to date",
        body: done.versionAfter ? `Detected ${done.versionAfter}.` : "Codex is ready.",
      };
    case "still-works":
      return {
        kind: "warn",
        title: "Codex wasn't updated",
        body: `${happened(done)} ${untouched(done)} ${wayOn(done)}${reason}`,
        details,
        action: { label: "Open Diagnostics", opens: "diagnostics" },
      };
    case "not-starting":
      return {
        kind: "error",
        title: "Codex wasn't updated, and it doesn't start now",
        body: `${happened(done)} Codex tiles won't start until it's repaired.${reason}`,
        details,
        action: { label: "Repair Codex", opens: "repair" },
      };
    default:
      return null;
  }
}

/** The words a Codex tile shows while its start waits for the update. The
 *  backend holds it two minutes, then goes ahead (Windows: once the stopped
 *  update has ended, a few seconds more) — "about", not "at most". */
export function codexStartWaitText(updating: boolean): string | null {
  return updating ? "Codex is updating. This tile starts as soon as it's done, or in about two minutes." : null;
}
