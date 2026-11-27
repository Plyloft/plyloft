// OB-3 — the guided terminal's words (onboarding spec §7). The step line is
// Plyloft's words, driven by the action's watcher in Rust (`setup_run.rs`),
// never by parsing the output. The one thing read from the output is a
// one-time code (gh's `XXXX-XXXX`, Codex's device code), only to show it big.
//
// Pure, so every (action, phase, outcome) sentence is tested:
//
//     node --experimental-strip-types src/lib/setupRun.test.ts

import type {
  SetupGuidedActionId,
  SetupOutcome,
  SetupPhase,
} from "../ipc.ts";
import { isRepairAction, REPAIR_ENDED_LINE, REPAIR_RUNNING_LINE } from "./repairAction.ts";

/** The run-state dot a `StatusLine` draws. */
export type SetupRunState = "running" | "done" | "aborted" | "empty";

type Kind = "install" | "update" | "login" | "logout" | "setupgit" | "refresh" | "clone" | "trust";

function kindOf(id: SetupGuidedActionId): Kind {
  if (id === "project.clone") return "clone";
  if (id === "trust.claude") return "trust";
  // 1.179.0 (C1): a Claude account's sign-out (Remove's first half).
  if (id === "logout-account.claude") return "logout";
  if (id.startsWith("install.")) return "install";
  if (id.startsWith("update.")) return "update";
  if (id === "setupgit.gh") return "setupgit";
  if (id === "refresh.gh") return "refresh";
  return "login";
}

const TOOL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gh: "The GitHub command",
  git: "Git",
  node: "Node.js",
};

function toolOf(id: SetupGuidedActionId): string {
  return TOOL[id.slice(id.indexOf(".") + 1)] ?? "It";
}

/** Lower-case a tool name mid-sentence ("the GitHub CLI"), keep proper names. */
function mid(tool: string): string {
  return tool.startsWith("The ") ? "t" + tool.slice(1) : tool;
}

/** Whether the guided terminal stays drawn once the run has ended: for
 *  reading, except Claude opened on the review folder (`trust.claude`),
 *  whose screen Plyloft closes — its line says how it ended. */
export function keepsTerminalAfter(id: SetupGuidedActionId): boolean {
  return id !== "trust.claude";
}

/** A login whose screen shows a one-time code to type in the browser. */
export function showsCode(id: SetupGuidedActionId): boolean {
  return id === "login.gh" || id === "add-account.gh" || id === "login-device.codex";
}

/**
 * The step line. `platform` picks Windows' words where more than the
 * machine word changes (the Command Line Tools are a Mac thing); "this Mac"
 * itself is turned into "this PC" by `StatusLine`.
 */
export function setupLine(
  id: SetupGuidedActionId,
  phase: SetupPhase,
  outcome: SetupOutcome | null,
  platform: "mac" | "windows" = "mac",
): string {
  // 1.176.0 R4: a Repair's run has its own sheet; here it is only named.
  if (isRepairAction(id)) return phase === "done" ? REPAIR_ENDED_LINE : REPAIR_RUNNING_LINE;
  const kind = kindOf(id);
  const tool = toolOf(id);
  const clt = id === "install.git" && platform === "mac";
  const gitForWindows = id === "install.git" && platform === "windows";
  const name = gitForWindows ? "Git for Windows" : tool;

  // OB-12: step 8's clone (`project.clone`). Its end in detail — empty on
  // GitHub, which account, why it stopped — is the step's, from the final
  // event's `clone`; this line only says where the download is.
  if (kind === "clone") return cloneLine(phase, outcome);
  if (kind === "trust") return trustLine(phase, outcome);
  if (kind === "logout") return logoutLine(phase, outcome);
  if (phase === "waiting-long") return "Still waiting for you to sign in.";
  // 1.176.0 R2: before an install or update, its version is read.
  if (phase === "preparing") return `Checking which version of ${mid(name)} is there…`;
  if (phase === "checking") {
    return kind === "login" ? "Checking that you're signed in…" : `Checking that ${mid(name)} works…`;
  }
  if (phase === "running") {
    if (clt) return "Waiting for the macOS installer to finish…";
    switch (kind) {
      case "install":
        return `Installing ${mid(name)}… this takes about a minute.`;
      case "update":
        return `Updating ${mid(name)}…`;
      case "setupgit":
        return "Letting Git use your GitHub sign-in…";
      case "refresh":
        return "Finish in your browser: GitHub asks to let the GitHub command see your private repositories.";
      case "login":
        return showsCode(id)
          ? "Enter the code shown below in your browser. Plyloft notices when you're done."
          : "Finish signing in in your browser. Plyloft notices when you're done.";
    }
  }
  switch (outcome) {
    case "succeeded":
      switch (kind) {
        case "install":
          return `${name} is installed.`;
        case "update":
          return `${name} is updated.`;
        case "setupgit":
          return "Git uses your GitHub sign-in.";
        case "refresh":
          return "Your GitHub sign-in can see private repositories.";
        case "login":
          return "Signed in.";
      }
      break;
    case "not-observed":
      switch (kind) {
        case "install":
        case "update":
          return "Installed, but Plyloft can't find it yet. Quit and reopen Plyloft.";
        case "setupgit":
          return "Git doesn't use your GitHub sign-in yet.";
        case "refresh":
          return "Your GitHub sign-in still can't see private repositories.";
        case "login":
          return "Not signed in yet.";
      }
      break;
    case "could-not-tell":
      return kind === "login"
        ? "Plyloft couldn't tell whether you're signed in."
        : "Plyloft couldn't tell whether it worked. Look again in a moment.";
    case "failed":
      if (kind === "install") return `${name}'s installer stopped with an error. Nothing else was changed.`;
      if (kind === "update") return `${name}'s updater stopped with an error. Nothing else was changed.`;
      // 1.179.0 (C1): a Claude account's sign-in is Claude Code's, not gh's.
      if (id === "login-account.claude") return `${name} stopped with an error. Nothing was changed.`;
      return "The GitHub command stopped with an error. Nothing was changed.";
    case "timed-out":
      if (clt) return "The macOS installer didn't finish within 30 minutes.";
      // 1.176.0 R2: an install or update stopped at its time limit.
      return kind === "update"
        ? `${name}'s updater took too long and was stopped.`
        : `${name}'s installer took too long and was stopped.`;
    case "still-on-old-version":
      return `${name} wasn't updated. It still works, on the version it had.`;
    case "nothing-newer":
      return `${name}'s updater found nothing newer. It still works, on the version it had.`;
    case "older-version-now":
      return `${name} wasn't updated, and an older copy of it answers now.`;
    case "installer-closed":
      return "The macOS installer was closed before Git was installed.";
    case "cancelled":
      return kind === "install" || kind === "update"
        ? "Stopped. Part of it may have been installed; Plyloft checks again."
        : "Stopped.";
    case null:
      break;
    default:
      return unhandled(outcome);
  }
  return "";
}

/** A compile error when an outcome is added and not handled (R2). */
export function unhandled(outcome: never): string {
  return String(outcome);
}

/** Claude's TUI in Plyloft's review folder (`trust.claude`): the member
 *  answers, Plyloft only watches Claude's own state and closes it. */
function trustLine(phase: SetupPhase, outcome: SetupOutcome | null): string {
  if (phase === "running" || phase === "waiting-long") {
    return "Choose “Yes, I trust this folder” below. Plyloft notices and closes Claude.";
  }
  if (phase === "checking") return "Checking whether Claude trusts the folder…";
  switch (outcome) {
    case "succeeded":
      return "Claude trusts Plyloft's review folder.";
    case "cancelled":
      return "Stopped. Claude doesn't trust the folder yet.";
    case "could-not-tell":
      return "Plyloft couldn't tell whether Claude trusts the folder.";
    default:
      return "Claude doesn't trust Plyloft's review folder yet.";
  }
}

/** 1.179.0 (C1): `claude auth logout` on one Claude account's folder,
 *  judged by its exit code alone; the account is removed after it,
 *  whatever the end. */
function logoutLine(phase: SetupPhase, outcome: SetupOutcome | null): string {
  if (phase !== "done") return "Signing out of Claude Code…";
  switch (outcome) {
    case "succeeded":
      return "Signed out.";
    case "cancelled":
      return "Stopped.";
    case "failed":
      return "Claude Code's sign-out stopped with an error.";
    default:
      return "Claude Code's sign-out didn't finish.";
  }
}

function cloneLine(phase: SetupPhase, outcome: SetupOutcome | null): string {
  if (phase === "running" || phase === "waiting-long") return "Downloading from GitHub… You can cancel at any time.";
  if (phase === "checking") return "Checking the download…";
  switch (outcome) {
    case "succeeded":
      return "Downloaded.";
    case "cancelled":
      return "Stopped. Nothing was added to Plyloft.";
    case "failed":
    case "timed-out":
      return "The download stopped. Nothing was added to Plyloft.";
    default:
      return "The download didn't finish. Nothing was added to Plyloft.";
  }
}

/** The guided terminal's stop button: a clone is cancelled (its partial
 *  folder goes), everything else is stopped. */
export function stopLabel(id: SetupGuidedActionId): "Cancel" | "Stop" {
  return id === "project.clone" ? "Cancel" : "Stop";
}

/** The dot beside the line. */
export function setupRunState(phase: SetupPhase | null, outcome: SetupOutcome | null): SetupRunState {
  if (phase === null) return "empty";
  if (phase !== "done") return "running";
  if (outcome === "succeeded") return "done";
  if (
    outcome === "failed" ||
    outcome === "timed-out" ||
    outcome === "installer-closed" ||
    outcome === "still-on-old-version" ||
    outcome === "older-version-now"
  )
    return "aborted";
  return "empty";
}

// ── The one-time code ──────────────────────────────────────────────────

// CSI / OSC escapes, so a coloured code still matches.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** gh `XXXX-XXXX`; Codex `XXXX-XXXXX` (MEASUREMENTS §5). */
const CODE = /(?:^|[^A-Z0-9-])([A-Z0-9]{4}-[A-Z0-9]{4,5})(?![A-Z0-9-])/g;

/**
 * The last one-time code in `text` (the terminal's recent output), or null.
 * A code has at least one letter: `2026-0927` is a date, not a code.
 */
export function oneTimeCode(text: string): string | null {
  const plain = text.replace(ESCAPES, "");
  let found: string | null = null;
  for (const m of plain.matchAll(CODE)) {
    if (/[A-Z]/.test(m[1])) found = m[1];
  }
  return found;
}

/**
 * N14 walk F17 (Challenger P1): gh is at its "Press Enter to open
 * github.com/login/device" prompt in `text` (the terminal's recent output).
 * Only an Enter typed from then on is the one gh waits for; an earlier one
 * answered another question ("Authenticate Git with your GitHub
 * credentials? (Y/n)").
 */
export function waitsForEnter(text: string): boolean {
  return /Press Enter to open/i.test(text.replace(ESCAPES, ""));
}

// ── How a GitHub sign-in ended (1.175.0 F1) ────────────────────────────

/**
 * F1: a GitHub sign-in that ended without one — because its code expired,
 * or because the person stopped it (Stop here, or "Cancel" on GitHub's
 * page). Read from how the run ended and from the GitHub command's last
 * lines: GitHub's device flow names the two ends `expired_token` and
 * `access_denied`, and the command prints them. `null`: it succeeded, it
 * isn't a sign-in, or it ended some other way (the run's own line says it).
 */
export function signInEnd(
  id: SetupGuidedActionId,
  outcome: SetupOutcome | null,
  tail: readonly string[],
): "expired" | "stopped" | null {
  if (id !== "login.gh" && id !== "add-account.gh") return null;
  if (outcome === null || outcome === "succeeded") return null;
  if (outcome === "cancelled") return "stopped";
  const text = tail.join("\n").replace(ESCAPES, "");
  if (/expired_token|device[_ ]code[^\n]{0,40}expired|code (has )?expired/i.test(text)) return "expired";
  if (/access_denied|authorization request was denied/i.test(text)) return "stopped";
  return null;
}
