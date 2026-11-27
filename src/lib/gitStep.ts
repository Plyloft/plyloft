// OB-6 — Setup's step 4, "Git and your name" (ONBOARDING_SPEC §5 step 4):
// the words and states, pure, so every case is tested under node:
//
//     node --experimental-strip-types src/lib/gitStep.test.ts
//
// The step's component is `components/setup/GitStep.tsx`.
import type { UxError } from "./uxError.ts";
import { causeWords } from "./aiTools.ts";
import type { SetupRunEvidence } from "./setupEvidence.ts";

/** What the Git row reads of a doctor report. */
export interface GitReportInput {
  tools: { id: string; found: boolean; path?: string | null; version?: string | null; installCmd?: string }[];
  gitIdentity?: { name?: string | null; email?: string | null; set?: boolean } | null;
}

/** The Git row's state. `no-bash`: Windows, git works but Git Bash wasn't
 *  found; `broken`: a git is there but doesn't answer. */
export type GitRowState = "unknown" | "ready" | "missing" | "no-bash" | "broken";

export interface GitRowView {
  state: GitRowState;
  /** "Git" on the Mac, "Git for Windows" on Windows. */
  label: string;
  hint: string;
  /** The install action's name, when one is offered. */
  install: string | null;
  /** The command the consent sheet names under Details. */
  command: string | null;
  /** 1.176.1 walk: missing while Program folders is set — "Open Program
   *  folders" is the way on, never an install. */
  programFolders?: boolean;
}

export const MAC_INSTALL_COMMAND = "xcode-select --install";
export const GIT_DOWNLOADS_URL = "https://git-scm.com/downloads";

/** "2.39.5" out of "git version 2.39.5 (Apple Git-154)" or "2.39.5". */
export function shortVersion(version: string | null | undefined): string | null {
  const m = version?.match(/\d+(?:\.\d+)+/);
  return m ? m[0] : null;
}

export function gitRow(report: GitReportInput | null, windows: boolean, programFoldersSet = false): GitRowView {
  const label = windows ? "Git for Windows" : "Git";
  if (!report) {
    return { state: "unknown", label, hint: "Looking…", install: null, command: null };
  }
  const git = report.tools.find((t) => t.id === "git");
  const bash = report.tools.find((t) => t.id === "git-bash");
  const installCmd = (t: typeof git) => t?.installCmd || null;
  if (git?.found) {
    if (windows && bash && !bash.found) {
      return {
        state: "no-bash",
        label,
        hint: "Git works, but Git Bash wasn't found. Plyloft needs it to run project checks.",
        install: "Install Git for Windows",
        command: installCmd(bash) ?? installCmd(git),
      };
    }
    const v = shortVersion(git.version);
    return {
      state: "ready",
      label,
      hint: windows ? "Installed, with Git Bash." : v ? `Installed (git ${v}).` : "Installed.",
      install: null,
      command: null,
    };
  }
  if (programFoldersSet) {
    return { state: "missing", label, hint: "Not in your Program folders.", install: null, command: null, programFolders: true };
  }
  const command = installCmd(git) ?? (windows ? null : MAC_INSTALL_COMMAND);
  const install = windows ? "Install Git for Windows" : "Install";
  // A git that resolved but never answered. On the Mac without the Command
  // Line Tools the shim is "there" but Git isn't: that is Not installed.
  if (git?.path && windows) {
    return { state: "broken", label, hint: "Git is there, but it doesn't start.", install, command };
  }
  return { state: "missing", label, hint: "Not installed.", install, command };
}

/** 1.176.4: under Install Git for Windows, before the press. */
export const INSTALL_GIT_WINDOWS_LINE =
  "Install Git for Windows runs its installer through winget, Windows' package installer. Windows may ask for an administrator's permission.";

/** The install consent sheet (§5 step 4 Actions). */
export function installSheet(windows: boolean): { title: string; lede: string; confirm: string } {
  return windows
    ? {
        title: "Install Git for Windows?",
        lede:
          "Plyloft runs the Git for Windows installer through winget, Windows' package installer. It includes Git Bash, which Plyloft needs to run project checks. Windows may ask you to allow it.",
        confirm: "Install",
      }
    : {
        title: "Install Apple's developer tools?",
        lede:
          "macOS installs Git with its Command Line Tools. A macOS window will ask you to confirm; it can take a few minutes.",
        confirm: "Install",
      };
}

// ── Name and email ─────────────────────────────────────────────────────

export const INVALID_EMAIL = "That doesn't look like an email address.";
export const EMPTY_NAME = "Enter the name to show on your commits.";

/** Only the `x@y` shape (§5 step 4); the same rule as Rust's. */
export function isValidEmail(email: string): boolean {
  const e = email.trim();
  const at = e.indexOf("@");
  if (at <= 0 || at === e.length - 1) return false;
  if (e.indexOf("@", at + 1) !== -1) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\s\x00-\x1f\x7f]/.test(e);
}

/** The errors a Save press shows inline, or null when both values are good. */
export function identityErrors(name: string, email: string): { name: string | null; email: string | null } | null {
  const n = name.trim() ? null : EMPTY_NAME;
  const e = isValidEmail(email) ? null : INVALID_EMAIL;
  return n || e ? { name: n, email: e } : null;
}

/** A value as a double-quoted shell word, for the Details line only — what
 *  runs is argv, never this string. */
export function quoted(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1").replace(/\n/g, "\\n")}"`;
}

/** The two commands the consent sheet names under Details. */
export function configCommands(name: string, email: string): string[] {
  return [
    `git config --global user.name ${quoted(name.trim())}`,
    `git config --global user.email ${quoted(email.trim())}`,
  ];
}

export function identityLine(name: string, email: string): string {
  return `Git knows you as ${name} <${email}>.`;
}

/** Which email the step saves: GitHub's private address when that choice
 *  is offered and taken, else what is in the field. */
export function chosenEmail(
  noreply: string | null,
  choice: "private" | "other",
  typed: string,
): string {
  return noreply && choice === "private" ? noreply : typed;
}

/** Step 8's sentence when Git can't commit yet (§5 step 4 Skip). */
export const IDENTITY_NEEDED =
  "Git needs your name and email before Plyloft can make the first commit.";

// ── An install that didn't end with Git ────────────────────────────────

/**
 * The error block after `install.git` ended without Git (§5 step 4
 * failures): the macOS installer closed (dismissed, or an administrator's
 * password refused — Plyloft can't tell which), the 30-minute wait, or
 * winget stopping with an error. Two ways out: `Install` again and `Do it
 * yourself` (Git's downloads page). Null for every other outcome.
 */
export function installFailure(
  outcome: string | null,
  windows: boolean,
  command: string | null,
  tail: readonly string[],
  evidence: SetupRunEvidence = {},
  programFoldersSet = false,
): UxError | null {
  // 1.176.1: a command the installer needed wasn't found.
  const notFound = evidence.cause === "command-not-found" ? causeWords("Git", false, evidence, tail, programFoldersSet) : null;
  const actions = [
    { id: "install", label: windows ? "Install Git for Windows" : "Install", primary: true },
    { id: "yourself", label: "Do it yourself" },
  ];
  const details = [command, ...tail].filter(Boolean).join("\n") || null;
  if (!windows && (outcome === "installer-closed" || outcome === "timed-out")) {
    return {
      title:
        outcome === "installer-closed"
          ? "The macOS installer was closed before Git was installed."
          : "The macOS installer didn't finish within 30 minutes.",
      happened: "The Command Line Tools, which bring Git, aren't on this Mac yet.",
      untouched: "Nothing else on this Mac was changed.",
      todo:
        "Install again and confirm in the macOS window. If it asked for an administrator's password you don't have, macOS needs an administrator to install the developer tools: ask one, or install Git yourself.",
      actions,
      details,
    };
  }
  // 1.176.0 R2: an install stopped at its time limit (Windows; the Mac's
  // is the macOS installer's, above) didn't end with an error.
  if (outcome === "timed-out") {
    return {
      title: "Git for Windows' installer took too long and was stopped.",
      happened: "winget ran for too long without finishing, so Plyloft stopped it.",
      untouched: "Part of it may have been installed.",
      todo: "Try again, or install Git for Windows yourself from its download page.",
      actions,
      details,
    };
  }
  if (outcome === "failed") {
    return {
      title: windows
        ? "Git for Windows' installer stopped with an error."
        : "Apple's installer stopped with an error.",
      happened:
        notFound?.happened ??
        (windows
          ? "winget ended before Git for Windows was installed. If Windows asked for an administrator and it was refused, the install stops here."
          : "xcode-select ended before the Command Line Tools were installed."),
      untouched: "Nothing else was changed.",
      todo: notFound && programFoldersSet ? notFound.todo : windows
        ? "Try again, or install Git for Windows yourself from its download page."
        : "Try again, or install Git yourself from its download page.",
      actions,
      details,
    };
  }
  return null;
}
