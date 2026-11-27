// 1.173.0 A3: the words of a copy without a card — Terminals' "In a new
// copy…" sheet, the tile head, Terminals › Copies and the pull-request sheet.
// Mockup: ~/ply-build/next-1173/mockups/copies.html, scenes 2–4.
//
// Pure: no React, no store, no IPC. "this Mac" is said here as on a Mac; the
// surfaces draw it through `machineWords` (this PC on Windows).

import type { BaseSource } from "../ipc";
import type { CopyStartPoint, CopyView } from "./copies";
import { pathKey } from "./paths.ts";
import { isWindows } from "./platform.ts";

export const NEW_COPY_MENU = "In a new copy…";
export const NEW_COPY_MENU_HINT = "its own files";
export const NEW_COPY_TITLE = "New terminal in a copy";
export const NEW_COPY_LEDE =
  "For trying something from a terminal without touching the project folder or the other terminals. " +
  "To have it reviewed and shipped, make it a card later.";
export const NEW_COPY_OPEN = "Open the copy";
export const NEW_COPY_OPENING = "Making the copy…";
/** While it is being made: the fetch and the folder take a moment, and can't
 *  be stopped halfway without leaving half a copy behind. */
export function newCopyOpeningHint(fromGitHub: boolean): string {
  return fromGitHub
    ? "Plyloft reads the branch from GitHub and makes the folder. This takes a few seconds."
    : "Plyloft makes the folder from the branch on this Mac. This takes a few seconds.";
}

export const COPIES_TITLE = "Copies";
export const COPIES_LEDE = "Work started from a terminal, each in its own copy of the project.";
// G2 (1.173.0): this, PR_SHEET_REACH_TAIL and copies.rs COPY_PR_BODY name
// the Reviewer (once the Challenger).
export const COPIES_STATUS =
  "“Make it a card” gives the copy to a new card: the Reviewer and your checks then look at it like any card's work.";
export const COPIES_EMPTY = "No copies yet. New › In a new copy… opens a terminal in one.";

export const MAKE_IT_A_CARD = "Make it a card";
export const OPEN_A_PULL_REQUEST = "Open a pull request";
export const OPEN_A_TERMINAL = "Open a terminal";
/** 1.174.1 P4 (T4): the row's open press names what it opens — the AI the
 *  copy was made with (`copies.json` "open"), else a plain terminal. */
export function copyOpenLabel(kind: "claude" | "codex" | "shell"): string {
  return kind === "claude" ? "Open Claude" : kind === "codex" ? "Open Codex" : OPEN_A_TERMINAL;
}
export const THROW_AWAY = "Throw away";
export const BRING_IT_BACK = "Bring it back";
export const SHOW_THE_PULL_REQUEST = "Show the pull request";

/** "just now", "2 min ago", "1 h ago", "yesterday", "3 days ago". */
export function agoWords(at: number, now: number): string {
  const d = Math.max(0, now - at);
  const min = Math.floor(d / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The sheet's "Starts from": "main on GitHub · read 2 min ago", or "main on
 *  this Mac" when origin isn't GitHub (A2's local start) or this Mac's
 *  branch is strictly ahead of GitHub's (A2's LocalAhead: the copy starts
 *  from it). Null before the read, or for a workspace with no branch to
 *  start from. */
export function startsFromWords(start: CopyStartPoint | null | undefined, now: number): string | null {
  const target = start?.target?.trim();
  if (!target) return null;
  // WALKFIX-3 (re-run, item 5): never "on GitHub · read …" for a branch
  // GitHub no longer has — C5's own sentence.
  if (start?.gone) return start.gone;
  if (!start?.fromGitHub || start.startsLocal) return `${target} on this Mac`;
  return start.readAt ? `${target} on GitHub · read ${agoWords(start.readAt, now)}` : `${target} on GitHub`;
}

/** After the copy is made: said only when it didn't start from GitHub's tip
 *  although the project is on GitHub (A2's `baseSource`/`baseNote`). */
export function startedLocallyWords(
  source: BaseSource | null | undefined,
  branch: string,
  note?: string | null,
): string | null {
  switch (source) {
    case "localOffline":
      return `GitHub couldn't be reached, so the copy started from ${branch} on this Mac. It may be behind GitHub's.`;
    case "localAhead":
      return `The copy started from ${branch} on this Mac, which has changes GitHub doesn't have yet.`;
    case "origin":
      // Origin's tip over a diverged local branch: the changes left out.
      return note ? `The copy started from ${branch} on GitHub. ${branch} on this Mac has changes it doesn't include.` : null;
    default:
      return null;
  }
}

// ── 1.174.0 E2 (P19, D12 a, P20): the trust question and what stays out ──

type TrustAi = "claude" | "codex";

/** The quiet line under a copy tile's header while its AI asks to trust
 *  the copy's folder (the same read as the header's amber words). */
export function copyTrustTileLine(kind: TrustAi): string {
  return kind === "claude"
    ? "Claude asks this for every new copy: the folder is the copy Plyloft just made of your project. Choose “Yes, I trust this folder” in the terminal."
    : "Codex asks this for every new copy: the folder is the copy Plyloft just made of your project. Choose to trust it in the terminal.";
}

/** The line once the session ended on that question (answered No). */
export function copyTrustRefusedLine(kind: TrustAi): string {
  return `${kind === "claude" ? "Claude" : "Codex"} needs the copy's folder trusted to work in it. Start fresh asks again.`;
}

/** 1.174.1 P1 (T1): the same quiet line under a Codex tile in a card's
 *  folder while Codex asks to trust it. Codex only: Claude keeps its trust
 *  on the project folder, so a card's folder inside it isn't asked about. */
export const CARD_TRUST_TILE_LINE = "Codex asks to trust this repository, not only this card's folder: choose to trust it.";

/** A folder's key for comparing: `pathKey` (on Windows either separator
 *  and any case — Codex prints the root as "c:\\…"), with `/` and no
 *  trailing separator. */
function folderKey(path: string, win: boolean): string {
  const k = pathKey(path, win);
  return (win ? k.replace(/\\/g, "/") : k).replace(/\/+$/, "");
}

/** 1.174.1 P1: whether a tile's folder is a card's — a `card-…` folder
 *  under a worktree root (`.plyloft-worktrees/`, or the legacy
 *  `.atelier-worktrees/`), or at or under a worktree a card records —
 *  through `pathKey`, so on Windows a path in either case and with either
 *  separator matches. A copy's folder (`copy-…`) is not a card's, nor is the
 *  project folder itself: a card that records it (a card worked in place)
 *  doesn't make every tile there a card's (Challenger P1). */
export function isCardFolder(
  cwd: string | null | undefined,
  cardWorktrees: readonly (string | null | undefined)[] = [],
  workspaceCwd?: string | null,
  win: boolean = isWindows(),
): boolean {
  if (!cwd) return false;
  const at = folderKey(cwd, win);
  if (/(^|\/)\.(plyloft|atelier)-worktrees\/card-[^/]+(\/|$)/.test(at)) return true;
  const project = workspaceCwd ? folderKey(workspaceCwd, win) : null;
  return cardWorktrees.some((wt) => {
    if (!wt) return false;
    const root = folderKey(wt, win);
    if (root === "" || root === project) return false;
    return at === root || at.startsWith(`${root}/`);
  });
}

/** The sheet's line under Open, for an AI (none for a shell). Claude keeps
 *  its trust on the project's own folder and asks nothing in a copy inside
 *  it once that is trusted (walk G3b): its line only when Claude is known
 *  not to trust the project folder yet. */
export function copyTrustSheetHint(open: string, claudeTrusted?: boolean | null): string | null {
  if (open === "claude") {
    return claudeTrusted === false ? "Claude will ask once to trust the copy's folder: choose “Yes, I trust this folder”." : null;
  }
  if (open === "codex") return "Codex will ask once to trust the copy's folder: choose to trust it.";
  return null;
}

/** The sheet's "Not in the copy" row, before it is made: the project
 *  folder's changed files and, when the copy starts from GitHub's branch
 *  although this computer's has diverged from it, the steps this computer's
 *  has that GitHub's doesn't. Strictly ahead, the copy starts from this
 *  computer's branch and has them: no steps said. Null when there is
 *  nothing, or nothing could be read (never a made-up number). */
export function notInCopyWords(start: CopyStartPoint | null | undefined): string | null {
  if (!start) return null;
  const branch = start.target?.trim() || "main";
  const files = start.projectChanged ?? 0;
  const steps = start.fromGitHub && !start.startsLocal ? (start.localAhead ?? 0) : 0;
  const filesWords = `${files} changed ${files === 1 ? "file" : "files"} in your project folder`;
  const stepsWords = `${steps} saved ${steps === 1 ? "step" : "steps"} that ${branch} on this Mac has but GitHub doesn't`;
  if (files > 0 && steps > 0) return `${filesWords}, and ${stepsWords}. They stay where they are.`;
  if (files > 0) return `${filesWords} ${files === 1 ? "isn't" : "aren't"} in it. They stay where they are.`;
  if (steps > 0) return `${stepsWords} ${steps === 1 ? "isn't" : "aren't"} in it.`;
  return null;
}

export const NOT_IN_COPY_LABEL = "Not in the copy";

/** The tile head's mark for a terminal in a copy. */
export function copyTileMark(name: string): string {
  return `Copy · ${name}`;
}

/** A row's chip: where it started and when. */
export function copyStartChip(copy: Pick<CopyView, "baseBranch" | "createdAt">, now: number): string {
  return `from ${copy.baseBranch || "main"} · ${agoWords(copy.createdAt, now)}`;
}

/** What is open in it: "Claude open", "2 terminals open", "No terminal open". */
export function copyTerminalWords(kinds: string[], counted: number): string {
  const n = Math.max(kinds.length, counted);
  if (n === 0) return "No terminal open";
  if (n === 1) {
    const name = KIND_NAME[kinds[0] ?? ""] ?? "A terminal";
    return `${name} open`;
  }
  return `${n} terminals open`;
}

const KIND_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", "codex-chat": "Codex chat", shell: "A shell" };

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** "3 files changed: InboxPanel.tsx, inboxView.ts, inboxView.test.ts". */
export function copyChangedWords(changed: CopyView["changed"]): string {
  if (changed.unreadable) return "its changes can't be read now";
  if (changed.count === 0) return "nothing changed";
  const one = changed.count === 1;
  const named = changed.files.map(baseName).join(", ");
  const more = changed.count > changed.files.length ? ` and ${changed.count - changed.files.length} more` : "";
  return `${changed.count} ${one ? "file" : "files"} changed${named ? `: ${named}${more}` : ""}`;
}

/** The pull request a copy opened, in its row. */
export function copyPrWords(pr: NonNullable<CopyView["pr"]>): string {
  const n = pr.number ? `Pull request #${pr.number}` : "Its pull request";
  if (pr.state === "merged") return `${n} merged`;
  if (pr.state === "closed") return `${n} closed`;
  return `${n} open · nobody reviewed it here`;
}

/** The pull-request sheet (scene 4). */
export function prSheetTitle(name: string): string {
  return `Open a pull request for ${name}`;
}

export function prSheetLede(changedFiles: number, target: string): string {
  const files = changedFiles === 1 ? "the changed file" : changedFiles > 1 ? `the ${changedFiles} changed files` : "its changes";
  return `Plyloft saves ${files}, sends this copy to GitHub and opens a pull request for ${target || "main"}.`;
}

export const PR_SHEET_REACH_LEAD = "Nobody has reviewed this.";
// G2 (1.173.0): the Reviewer, see COPIES_STATUS.
export const PR_SHEET_REACH_TAIL = "instead to have the Reviewer and your checks look at it first.";
export const PR_SHEET_OPEN = "Open the pull request";
export const PR_SHEET_OPENING = "Opening the pull request…";

/** The Throw away confirmation, asked only when the copy holds saved
 *  changes that exist nowhere else; null when it goes at once (Undo in the
 *  toast). */
export function throwAwayAsk(saved: number): { title: string; body: string } | null {
  if (saved <= 0) return null;
  const what = saved === 1 ? "1 saved change" : `${saved} saved changes`;
  return {
    title: "Throw this copy away?",
    body: `${what} will be deleted with the copy after 7 days in the Trash. Until then, Bring it back restores it whole.`,
  };
}

export const THROWN_AWAY_TITLE = "Copy thrown away";
export function thrownAwayBody(name: string): string {
  return `${name} is in the Trash for 7 days.`;
}

/** What *Make it a card* says when it's done. Walk fix (b): the card waits
 *  in Not started, as the Board shows it — no session works on it yet.
 *  1.174.0 C4 (P17): its brief is empty, so the toast says to write it. */
export function madeCardWords(title: string, started: boolean, note?: string | null): { title: string; body: string } {
  const named = `\u201c${title}\u201d`;
  if (started) return { title: "Card made", body: `${named} is in Working, on its copy.` };
  return {
    title: "Card made",
    body: `${named} is in Not started, with the work from its copy. ${note ?? "Say what the Builder should do, then Start build."}`.trim(),
  };
}

/** C4: What you want's placeholder on a card made from a copy, before
 *  anything is written there. */
export function copyBriefPlaceholder(name: string): string {
  return `What should the Builder do with the work in \u201c${name}\u201d?`;
}

/** Walk fix (d): why Throw away waits while a terminal is open in the copy. */
export function throwAwayHeldWords(open: number): string | null {
  if (open <= 0) return null;
  return open === 1 ? "Close its terminal first." : "Close its terminals first.";
}

/** The engine's refusals and errors, said plainly; anything unknown keeps
 *  only its first line (the rest goes behind Details). */
export function plainCopyError(raw: unknown): { title: string; body: string; details?: string } {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const known: Array<[RegExp, string]> = [
    [/not a copy|isn't one of this project's copies/i, "That isn't one of this project's copies any more."],
    [/is not this copy's folder|card_worktree_location|not under/i, "The copy's folder isn't where Plyloft left it, so nothing was changed."],
    // Challenger 1: before the `fatal:` rule — a hook's or git's refusal to
    // commit (copies.rs SAVE_FAILED), the hook's words behind Details.
    [/Couldn't save the copy's changes/i, "The copy's changes couldn't be saved, so nothing was sent to GitHub. Details says why."],
    [/being sent to GitHub/i, "This copy is being sent to GitHub. Try again once that has finished."],
    [/couldn't push the branch/i, "The copy couldn't be sent to GitHub. Nothing was opened; try again in a moment."],
    [/opening the pull request failed/i, "The copy is on GitHub, but the pull request didn't open. Press Open the pull request again."],
    [/already exists; refusing to overwrite|was already there/i, "A folder with that copy's name is already there, so nothing was made."],
    [/is neither on origin nor in this repository/, "That branch isn't on GitHub or on this computer. Create it, or choose another one in Settings › Project › Areas. Nothing was changed."],
    [/worktree add|worktree prune|fatal:/i, "Git couldn't make the copy. Nothing was changed."],
  ];
  for (const [re, body] of known) {
    if (re.test(text)) return { title: "That didn't work", body, details: text };
  }
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "Something went wrong.";
  const rest = text.trim() === first ? undefined : text;
  return { title: "That didn't work", body: first, details: rest };
}
