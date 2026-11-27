// Try it (TRY_IT_SPEC §3.3, §4.3, §5): the words for how a project's app
// starts — the Settings row "How to start your app", Setup step 9's line and,
// later, the sheet (TI-4). Pure, so node runs the test.
import type { TryCommandView, TryDetection } from "../ipc.ts";
import type { PendingLike } from "./repositoryPage.ts";
import { machineWords, type Platform, platform } from "./platform.ts";

/** The row's label, everywhere it is drawn and indexed. */
export const TRY_ROW_LABEL = "How to start your app";

/** What a detection suggests to run; null for a static site or nothing. */
export function detectedCommand(detection: TryDetection | null | undefined): string | null {
  if (!detection) return null;
  switch (detection.kind) {
    case "packageScript":
    case "django":
    case "rails":
      return detection.command;
    default:
      return null;
  }
}

/** Where a suggestion came from, in words: "Found in package.json: the
 *  "dev" script, run with npm." Null when nothing was found. */
export function foundWords(detection: TryDetection | null | undefined): string | null {
  if (!detection) return null;
  switch (detection.kind) {
    case "packageScript":
      return `Found in package.json: the "${detection.script}" script, run with ${detection.packageManager}.`;
    case "django":
      return "Found manage.py: this looks like a Django project.";
    case "rails":
      // `bundle exec rackup` is a Rack app (Sinatra, Hanami…), not Rails.
      return detection.command.includes("rackup")
        ? "Found a Gemfile: this looks like a Ruby web app."
        : "Found a Gemfile: this looks like a Rails app.";
    case "staticSite":
      return "This looks like a plain website.";
    default:
      return null;
  }
}

/** PRINCIPLES 1: where the start command lives. */
export function tryScopeLine(shared: boolean, p: Platform = platform()): string {
  return shared
    ? "Shared with everyone who opens the repository"
    : machineWords("Saved for this repository on this Mac", p);
}

/** The sentence that states the command: `Plyloft will start your app with "npm run dev".` */
export function willStartLine(command: string): string {
  return `Plyloft will start your app with "${command}".`;
}

/** What the row shows. */
export type TryRowState =
  | { kind: "saved"; command: string }
  | { kind: "suggested"; command: string; found: string | null }
  | { kind: "staticSite" }
  | { kind: "notSet" };

export function tryRowState(view: TryCommandView | null): TryRowState {
  if (!view) return { kind: "notSet" };
  const saved = view.command?.trim();
  if (saved) return { kind: "saved", command: saved };
  const suggested = detectedCommand(view.detection);
  if (suggested) return { kind: "suggested", command: suggested, found: foundWords(view.detection) };
  if (view.detection.kind === "staticSite") return { kind: "staticSite" };
  return { kind: "notSet" };
}

/** The row's hint: what it holds, then where it lives, then whether this
 *  machine still has to allow it. */
export function tryRowHint(view: TryCommandView | null, p: Platform = platform()): string {
  const state = tryRowState(view);
  const scope = `${tryScopeLine(!!view?.shared, p)}.`;
  switch (state.kind) {
    case "saved": {
      const ask =
        view && !view.approved
          ? machineWords(" It hasn't run on this Mac yet: Try it asks you once before it does.", p)
          : "";
      return `What Try it runs to show a card's result. ${scope}${ask}`;
    }
    case "suggested":
      return `${state.found ?? "Plyloft found how your app likely starts."} Nothing is saved until you choose Use this.`;
    case "staticSite":
      return "This looks like a plain website: Try it opens its index.html in your browser.";
    default:
      return "Plyloft couldn't tell how this app starts. Type the command you'd use in a terminal, for example \"npm run dev\".";
  }
}

/** The mark of a start command saved here and not in the repository yet
 *  (`cache.pending.tryCommand`): on its way, or waiting in a pull request.
 *  Null when nothing is waiting. */
export function tryPendingMark(
  pending: PendingLike | null | undefined,
): { state: "publishing" | "waiting"; hint: string } | null {
  if (!pending || !("tryCommand" in pending.fields)) return null;
  const pr = pending.pullRequests.tryCommand;
  return pr
    ? {
        state: "waiting",
        hint: `Changed here, waiting in pull request #${pr}. It works on this Mac already.`,
      }
    : { state: "publishing", hint: "Changed here, not published yet. It works on this Mac already." };
}

/** Why a typed command can't be saved, in words; null when it can. Mirrors
 *  `project_config::normalize_try_command`. */
export const MAX_TRY_COMMAND_CHARS = 2000;
export function tryCommandProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/[\r\n]/.test(t)) return "A start command is one line, as you'd type it in a terminal.";
  if ([...t].length > MAX_TRY_COMMAND_CHARS)
    return `A start command is at most ${MAX_TRY_COMMAND_CHARS} characters.`;
  return null;
}

// ── Setup step 9's line ────────────────────────────────────────────────

/** Step 9's one line. `typed` is what the person chose there: null =
 *  untouched, "" = no start command. `command` is what the line states. */
export function setupTryLine(
  view: TryCommandView | null,
  typed: string | null,
): { sentence: string; command: string | null } | null {
  if (!view) return null;
  if (typed !== null) {
    const chosen = typed.trim() || null;
    return chosen
      ? { sentence: willStartLine(chosen), command: chosen }
      : { sentence: "No start command: Try it will ask how your app starts.", command: null };
  }
  const saved = view.command?.trim() || null;
  if (saved) return { sentence: willStartLine(saved), command: saved };
  const suggested = detectedCommand(view.detection);
  if (suggested) return { sentence: willStartLine(suggested), command: suggested };
  if (view.detection.kind === "staticSite")
    return { sentence: "This looks like a plain website: Plyloft will open its index.html in your browser.", command: null };
  return { sentence: "Plyloft couldn't tell how your app starts. You can type it in yourself.", command: null };
}

/** What step 9's save writes for the start command: `{ command }` (null
 *  clears it), or null for nothing to write — the line states what is saved
 *  already, or the repository is read-only here. */
export function setupTryToSave(
  view: TryCommandView | null,
  typed: string | null,
): { command: string | null } | null {
  const line = setupTryLine(view, typed);
  if (!view || !line || view.readOnly) return null;
  const saved = view.command?.trim() || null;
  if (typed === null && !line.command) return null;
  return line.command === saved ? null : { command: line.command };
}
