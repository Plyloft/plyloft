/**
 * 1.175.0 F3 (review UX-1; owner I5): "Put it on GitHub…" — the words and
 * states of the consent sheet, the card's line, Settings › Cards ›
 * Shipping's row, the toast, and Add a project's tick. Pure, so
 * `putOnGithub.test.ts` runs it under node. The work is
 * `put_on_github.rs`; the calls are in `putOnGithubIpc.ts`.
 *
 * Written for the Mac; `machineWords` renames the machine where drawn.
 */

/** Mirrors `put_on_github::Preview`. */
export interface Preview {
  branch: string;
  commits: number;
  unsavedFiles: number;
  name: string;
}

/** Mirrors `put_on_github::LargeFile`. */
export interface LargeFile {
  path: string;
  bytes: number;
}

/** Mirrors `put_on_github::Outcome`. */
export type Outcome =
  | { kind: "done"; repo: string; branch: string }
  | { kind: "nameTaken"; name: string }
  | { kind: "stopped"; repo: string; branch: string }
  | { kind: "notCreated"; words: string; large: LargeFile | null; signIn: boolean }
  | { kind: "notSent"; repo: string; branch: string; words: string; large: LargeFile | null };

/** Mirrors `put_on_github::Progress` (`put-on-github://progress`). */
export interface Progress {
  workspaceId: string;
  repo: string;
  branch: string;
  commits: number;
}

export const PUT_ON_GITHUB = "Put it on GitHub…";
export const CONNECT_GITHUB_FIRST = "Connect GitHub first";

/** The card's line under Ship it, and Shipping's "How Ship it ships", on a
 *  project only on this computer. */
export const ONLY_ON_THIS_MAC =
  "This project is only on this Mac, so Ship it merges the card here. Put it on GitHub to ship cards as pull requests.";

/** The card's line right after: the project is on GitHub now. Lives until
 *  its first Ship it (`justPutOnGithub`). */
export function onGithubNowLine(repo: string): string {
  return `This project is on GitHub now, at ${repo}. Ship it opens a pull request and merges it when the checks pass.`;
}

/** F3's case of the card's Now note (`nowNote.ts`, F8): which line and
 *  which button under Ship it on a card Ready to ship, or null when this
 *  case doesn't apply. F8's `nowNote.ts` calls this first for a card whose
 *  project has no remote (`outcome.hasRemote === false`, no `originHost`,
 *  no `originUnreadable`); until it lands, `OutcomeScreen` calls it. */
export function putOnGithubNote(input: {
  /** The project has no remote at all (not another host, not unreadable). */
  noRemote: boolean;
  /** GitHub is connected on this computer (an account signed in). */
  githubConnected: boolean;
  /** The repository this computer just made, when the project's first Ship
   *  it hasn't happened yet. */
  justPut?: string | null;
}): { text: string; action: typeof PUT_ON_GITHUB | typeof CONNECT_GITHUB_FIRST | null } | null {
  if (input.justPut) return { text: onGithubNowLine(input.justPut), action: null };
  if (!input.noRemote) return null;
  return { text: ONLY_ON_THIS_MAC, action: input.githubConnected ? PUT_ON_GITHUB : CONNECT_GITHUB_FIRST };
}

// ── The sheet ─────────────────────────────────────────────────────────

/** The sheet before the press: account, name, private, what is sent. */
export function sheetWords(project: string, login: string, name: string, preview: Preview) {
  const commits = `${preview.commits} ${preview.commits === 1 ? "commit" : "commits"}`;
  const unsaved =
    preview.unsavedFiles === 0
      ? ""
      : ` Changes not saved in Git stay on this Mac (${preview.unsavedFiles} ${preview.unsavedFiles === 1 ? "file" : "files"}).`;
  return {
    title: `Put “${project}” on GitHub?`,
    lede: "Plyloft creates a private repository in your GitHub account and sends it this project's saved history. From then on, Ship it opens a pull request for each card.",
    rows: [
      { id: "account", label: "GitHub account", value: login },
      { id: "name", label: "Name on GitHub", value: name, hint: `github.com/${login}/${name}` },
      { id: "private", label: "Who can see it", value: "Only you. It's private; you can change that on GitHub." },
      { id: "sent", label: "What is sent", value: `${preview.branch}, with its ${commits}.${unsaved}` },
    ],
    cancel: "Cancel",
    confirm: "Put it on GitHub",
  };
}

/** While it runs. */
export function runningWords(p: Progress) {
  return {
    created: `Created ${p.repo} on GitHub.`,
    sending: `Sending ${p.branch} to GitHub… ${p.commits} ${p.commits === 1 ? "commit" : "commits"}`,
    stop: "Stop",
  };
}

/** The reason Rust gave, its first line only (Git's or GitHub's own output
 *  follows it and stays off the sheet). */
function why(words: string): string[] {
  const first = words.split("\n")[0]?.trim() ?? "";
  return first ? [first.endsWith(":") ? first.slice(0, -1) + "." : first] : [];
}

function size(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** What the sheet says after the press (null: done, the sheet closes). */
export function outcomeWords(outcome: Outcome):
  | {
      title: string;
      lines: string[];
      /** "Send it again" (into the repository made), "Try again" (the
       *  sheet from the start), "Choose another name" — by id, its label. */
      again: { id: "send" | "retry" | "rename"; label: string } | null;
      signIn: boolean;
    }
  | null {
  switch (outcome.kind) {
    case "done":
      return null;
    case "nameTaken":
      return {
        title: "The project wasn't put on GitHub.",
        lines: [`You already have a repository called ${outcome.name} on GitHub. Nothing was sent. Choose another name.`],
        again: { id: "rename", label: "Choose another name" },
        signIn: false,
      };
    case "stopped":
      return {
        title: "You stopped it.",
        // F3 walk: `gh repo create --remote origin` already pointed the
        // folder at it; the title isn't said twice.
        lines: [`${outcome.repo} exists on GitHub but doesn't have your project yet, and this folder now points to it. Its branches and commits are as they were. Send it again finishes it.`],
        again: { id: "send", label: "Send it again" },
        signIn: false,
      };
    case "notSent":
      return {
        title: "The project wasn't sent to GitHub.",
        lines: outcome.large
          ? [
              `GitHub refuses files over 100 MB, and ${outcome.branch} has one: ${outcome.large.path} (${size(outcome.large.bytes)}).`,
              `${outcome.repo} was created on GitHub and is empty, and this folder now points to it. Its branches and commits are as they were.`,
              "Take that file out of Git, then send it again.",
            ]
          : [...why(outcome.words), `${outcome.repo} was created on GitHub and is empty, and this folder now points to it. Its branches and commits are as they were.`],
        again: { id: "send", label: "Send it again" },
        signIn: false,
      };
    case "notCreated":
      return {
        title: "The project wasn't put on GitHub.",
        lines: outcome.large
          ? [
              `GitHub refuses files over 100 MB, and this project has one: ${outcome.large.path} (${size(outcome.large.bytes)}).`,
              "Nothing was created, and nothing changed on this Mac.",
              "Take that file out of Git, then try again.",
            ]
          : [...why(outcome.words), "Nothing was created, and nothing changed on this Mac."],
        again: { id: "retry", label: "Try again" },
        signIn: outcome.signIn,
      };
  }
}

/** The toast once it is done. */
export function doneToast(project: string, repo: string) {
  return {
    title: `“${project}” is on GitHub`,
    body: `A private copy is at ${repo}. Ship it now opens a pull request.`,
    action: "Open on GitHub",
  };
}

// ── Settings › Cards › Shipping ───────────────────────────────────────

/** "Fix failing checks by itself" on a project not on GitHub. */
export const FIX_CHECKS_NOT_ON_GITHUB = "For projects on GitHub.";

// ── Add a project › A folder ──────────────────────────────────────────

/** The tick (owner I5: off by default), only for a project without a
 *  remote, with GitHub connected. Null: not offered. */
export function keepCopyTick(input: { hasRemote: boolean; githubConnected: boolean; login: string | null; name: string; branch: string }) {
  if (input.hasRemote || !input.githubConnected || !input.login) return null;
  return {
    label: "Also keep a private copy on GitHub",
    hint: `This project is only on this Mac. Creates the private repository ${input.login}/${input.name} and sends it ${input.branch}, so cards ship as pull requests.`,
    defaultOn: false,
  };
}

/** Add a project, GitHub not connected (no tick). */
export const ADD_NOT_CONNECTED =
  "This project is only on this Mac. To ship its cards as pull requests, connect GitHub in Settings › Setup and account › Setup, then put the project on GitHub from Settings › Cards › Shipping.";

/** Add a project's sheet when the tick is on. */
export function addSheetWords(project: string) {
  return {
    title: `Add “${project}” and put it on GitHub?`,
    lede: "Plyloft adds the project. Then it creates a private repository in your GitHub account and sends it this project's saved history.",
    cancel: "Cancel",
    confirm: "Add and put it on GitHub",
  };
}

/** Add a project: the project was added, the copy wasn't made. */
export function addCopyFailedToast(project: string) {
  return {
    title: `“${project}” was added`,
    body: "The copy on GitHub couldn't be made, so the project is only on this Mac. Settings › Cards › Shipping has Put it on GitHub… to try again.",
  };
}
