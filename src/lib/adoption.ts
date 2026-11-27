/**
 * GH #81: adoption of the shared workspace definition — the one question on
 * the board, and what runs without one (a legacy conversion; a Local board on
 * this Mac switched to the GitHub Issues board the repository's definition
 * already names, with its local cards migrated). A definition that says Local
 * is never switched or offered (R14, 1.169.1): only Settings › Board moves it,
 * on a press. `workspace_adoption.rs` decides; this module holds the words and
 * the once-per-session guards. Pure, so `adoption.test.ts` runs it under node.
 */
import {
  declinedNotice,
  KEEP_ON_THIS_MAC,
  PROPOSE_AGAIN,
  removedNotice,
  SHARE_AGAIN,
  type SharedSetup,
  type SharingNote,
} from "./sharedSetup.ts";

/** Mirrors `workspace_adoption::AdoptionAction`. */
export type AdoptionAction =
  | { kind: "none" }
  | { kind: "ask" }
  | { kind: "convertLegacy" }
  | { kind: "switchBoard"; localCards: number }
  | { kind: "migrateCards"; localCards: number }
  | { kind: "boardHeld"; reason: string }
  /** OB-8 (ask first): a switch to the repository's GitHub Issues board, or a
   *  migration, offered rather than run, until "Move to GitHub Issues" (since
   *  launch G3 nothing is unlocked only by the free beta, so the backend no
   *  longer offers on that ground). Never for a definition that says Local
   *  (R14). `cardsOnly`: the board is GitHub Issues already and only local
   *  cards would move. */
  | { kind: "offerBoard"; localCards: number; cardsOnly: boolean }
  /** OB-8: the offer was answered "Keep it on this Mac" — not asked again on
   *  the board; Settings › Board keeps the press that moves it. */
  | { kind: "boardKeptLocal"; localCards: number; cardsOnly: boolean }
  /** 1.171.0 (X2): a shared setup kept on another branch, for that branch
   *  alone, was not used — this folder is set up on its own. Asked once. */
  | {
      kind: "setupElsewhere";
      here: string | null;
      branch: string;
      name: string;
      /** 1.172.0 (B1): further branches with a shared setup each naming
       *  itself — the person chooses which. Absent from older backends. */
      others?: string[];
    }
  /** 1.172.0 (B1): solo mode, and the repository's shared setup puts the
   *  board on GitHub Issues — it stays local here, and that is said. */
  | { kind: "soloBoardLocal" }
  /** 1.175.0 (C1, SC-2): the shared setup was on `branch` and is gone from
   *  it. Until "Keep it on this Mac" or "Share it again…" Plyloft writes
   *  nothing to GitHub for this project. `at`: seconds; `pending`: this
   *  computer's changes that were not published yet and stay here. */
  | { kind: "setupRemoved"; branch: string; who: string | null; at: number | null; pending: number }
  /** 1.175.0 (C2, SC-1): the pull request that proposed moving the setup out
   *  of its older file was closed without merging. Said once on the Board;
   *  nothing is proposed again without a press. */
  | { kind: "conversionDeclined"; pullRequest: number; who: string | null }
  /** 1.175.0 (C5, SC-5): the branch cards go to is gone from GitHub —
   *  renamed (`renamedTo`) or deleted. */
  | { kind: "branchGone"; branch: string; renamedTo: string | null; readOnly: boolean; author: string | null };

/** Mirrors `workspace_adoption::AdoptionStatus`. */
export interface AdoptionStatus {
  githubRepo: string | null;
  hasDefinition: boolean;
  /** The issue repository a switch and a migration use: the definition's
   *  `githubOwnerRepo`, else origin. */
  boardRepo: string | null;
  /** R14: the board the repository's definition names, for a GitHub repo
   *  with one (null otherwise, and for a Local board this account can't push
   *  to). Absent from older backends. */
  repoBoard?: "local" | "githubIssues" | null;
  action: AdoptionAction;
  /** X2: "Keep this folder's setup" was answered for this branch's
   *  shared setup; Settings › General keeps the press that uses it. */
  keptOwnSetup?: string | null;
  /** 1.172.0 (B1): the other branches that answer was given with. */
  keptOwnSetupOthers?: string[];
  /** 1.175.0 (C1): Settings › Project › General's "Shared setup" row —
   *  shared, removed, or kept here. Absent for a project that never shared
   *  its setup, and from older backends. */
  sharedSetup?: SharedSetup | null;
  /** Round 2: this read learned the member can't push and kept the removed
   *  setup here — said once, as a toast. Absent otherwise. */
  sharingNote?: SharingNote | null;
}

/** Mirrors `workspace_adoption::ShareOutcome`. */
export interface ShareOutcome {
  alreadyShared: boolean;
  board: "local" | "githubIssues";
  localCards: number;
  boardHeld: string | null;
}

export const SHARE_QUESTION =
  "Share this workspace's setup with everyone who opens the repository?";

export const BOARD_OFFER_TITLE = "Move this board to GitHub Issues?";
export const CARDS_OFFER_TITLE = "Move this Mac's local cards to GitHub Issues?";
/** Team walk 2026-10-02 (T1): the repository's shared definition already
 *  chose GitHub Issues, so this Mac joins that board rather than moving its
 *  own there. */
export const JOIN_BOARD_TITLE = "The team's board is on GitHub Issues";
export const JOIN_BOARD_MOVE = "Use it here";

/** 1.172.2 (D6): the banner's two presses, in plain words — the shared
 *  setup is named by what it was made for, never as a "branch". */
export const ELSEWHERE_KEEP = "Keep this folder's setup";
export const ELSEWHERE_USE = "Use the shared setup";

/** 1.172.0 (B1): what the board and Settings › Board say in solo mode when
 *  the repository's shared setup puts the board on GitHub Issues. */
export const SOLO_REPO_BOARD_TITLE = "This repository's board is on GitHub Issues";
export const SOLO_REPO_BOARD_BODY = "While you work alone it stays on this Mac.";
/** The same in one line, for Settings › Board's status. */
export const SOLO_REPO_BOARD = `${SOLO_REPO_BOARD_TITLE}; while you work alone it stays on this Mac.`;
/** U13/U35: Settings › Board's status when the repository's shared setup sets
 *  the board, so it never contradicts the row under it ("The cards live on
 *  this Mac. Nobody else sees them."). Null when it can't yet be said: the
 *  repository's answer or the plan gates not read. `team`: the gates' answer. */
export function boardSetByRepositoryLine(
  repoBoard: "local" | "githubIssues" | null | undefined,
  onGitHubHere: boolean,
  team: string | null | undefined,
): string | null {
  if (onGitHubHere) return "This repository sets its board, so it is the same for everyone who opens it.";
  if (repoBoard === "local") {
    return "This repository keeps its board on each computer: everyone who opens it has their own cards.";
  }
  if (repoBoard !== "githubIssues" || !team) return null;
  if (team === "allowed") return `${SOLO_REPO_BOARD_TITLE}; this Mac hasn't moved to it yet.`;
  if (team === "no_team_plan") return `${SOLO_REPO_BOARD_TITLE}; your plan keeps it on this Mac.`;
  // Another account, another team, no seat: true of the plan or not, it isn't this.
  return `${SOLO_REPO_BOARD_TITLE}; team features are off on this Mac, so it stays here.`;
}

/** The press beside it: Account › Setup's Work with a team. */
export const SOLO_REPO_BOARD_TEAM = "Work with a team";

/** One of the branches a shared setup was found on, and its button. */
export interface ElsewhereUse {
  /** Absent: the first one (the answer names no branch). */
  branch?: string;
  label: string;
}

/** "a", "a and b", "a, b and c". */
function andWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** B1: one button per shared setup when there are several; one else. */
function elsewhereUses(branch: string, others: readonly string[], one: string): ElsewhereUse[] {
  if (others.length === 0) return [{ label: one }];
  return [branch, ...others].map((b) => ({ branch: b, label: `Use the one for ${b}` }));
}

/** X2: Settings › General's way back after "Keep this folder's setup". */
export function keptOwnSetupRow(
  status: AdoptionStatus | null,
): { hint: string; uses: ElsewhereUse[] } | null {
  const branch = status?.keptOwnSetup;
  if (!branch) return null;
  const others = status?.keptOwnSetupOthers ?? [];
  const hint =
    others.length === 0
      ? `This folder keeps its own setup. The shared setup on GitHub was made for ${branch}; using it starts cards from ${branch} and renames this project to match.`
      : `This folder keeps its own setup. The shared setups on GitHub were made for ${andWords([branch, ...others])}; using one starts cards from the one you pick and renames this project to match.`;
  return { hint, uses: elsewhereUses(branch, others, `Use the shared setup for ${branch}`) };
}

export interface BannerView {
  /** `removed` (1.175.0, C1): the shared setup is gone from its branch —
   *  `keep` and `move` are its two answers. */
  kind: "question" | "held" | "retry" | "offer" | "elsewhere" | "removed" | "declined" | "branchGone";
  title: string;
  body: string;
  /** An offer's two answers. */
  move?: string;
  keep?: string;
  /** B1: "elsewhere" — the setups to choose from, one button each. */
  uses?: ElsewhereUse[];
  /** B1: "held" in solo mode — the press that opens Work with a team. */
  team?: string;
  /** C5: "branchGone" for a rename — the branch "Move to" moves to. */
  moveTo?: string;
}

function cardsBecomeIssues(n: number, repo: string): string {
  return n === 1
    ? `This Mac's local card becomes an issue in ${repo}`
    : `This Mac's ${n} local cards become issues in ${repo}`;
}

/** The banner the board shows, or null. The question adds, on a Mac whose
 *  licence gate refuses GitHub Issues, that its board will stay local. */
export function adoptionBanner(
  status: AdoptionStatus | null,
  githubBoardAllowed: boolean,
  switchError: string | null = null,
  /** T1: the board the repository's shared definition names, when read. */
  repoBoard: "local" | "githubIssues" | null = null,
  nowSecs: number = Date.now() / 1000,
): BannerView | null {
  if (!status) return null;
  switch (status.action.kind) {
    case "branchGone": {
      const { branch, renamedTo, readOnly, author } = status.action;
      const ask = `Ask ${author ?? "someone with write access"} to move the shared setup. This Mac keeps the values it read last.`;
      if (renamedTo) {
        return {
          kind: "branchGone",
          title: `${branch} is called ${renamedTo} on GitHub now`,
          body: readOnly
            ? `Cards went to ${branch}, and the shared setup still names it. ${ask}`
            : `Cards went to ${branch}, and the shared setup still names it. Move both to ${renamedTo}: one small commit there, and new cards start from ${renamedTo} on every computer.`,
          ...(readOnly ? {} : { move: `Move to ${renamedTo}`, moveTo: renamedTo }),
        };
      }
      return {
        kind: "branchGone",
        title: `${branch} isn't on GitHub any more`,
        body: readOnly
          ? `Cards went there, and the shared setup lived there. ${ask}`
          : "Cards went there, and the shared setup lived there. Choose where cards go now; Plyloft moves the shared setup to that branch. Until then no card can start.",
        ...(readOnly ? {} : { move: "Choose where cards go" }),
      };
    }
    case "conversionDeclined":
      return {
        kind: "declined",
        ...declinedNotice(status.action.pullRequest, status.action.who),
        move: PROPOSE_AGAIN,
      };
    case "setupRemoved":
      return {
        kind: "removed",
        ...removedNotice(status.action, nowSecs),
        keep: KEEP_ON_THIS_MAC,
        move: SHARE_AGAIN,
      };
    case "switchBoard":
      // The automatic switch failed: it isn't retried on its own (a failure
      // would loop on every refresh), so the banner offers it.
      return switchError
        ? {
            kind: "retry",
            title: "Couldn't switch the board to GitHub Issues",
            body: switchError,
          }
        : null;
    case "ask":
      return {
        kind: "question",
        title: SHARE_QUESTION,
        body:
          `Plyloft commits .atelier/workspace.json to ${status.githubRepo ?? "the repository"} ` +
          "with this Mac's name, colour and project settings, and the board " +
          "becomes GitHub Issues: your cards become issues." +
          (githubBoardAllowed
            ? ""
            : " Without a Plyloft Team plan the board stays local on this Mac."),
      };
    case "offerBoard": {
      const repo = status.boardRepo ?? status.githubRepo ?? "the repository";
      const n = status.action.localCards;
      if (status.action.cardsOnly) {
        return {
          kind: "offer",
          title: CARDS_OFFER_TITLE,
          body:
            `The board is GitHub Issues already. ${cardsBecomeIssues(n, repo)}, ` +
            "and your teammates see them there. Plyloft changes nothing until you choose.",
          move: "Move them to GitHub Issues",
          keep: "Keep them on this Mac",
        };
      }
      if (repoBoard === "githubIssues") {
        return {
          kind: "offer",
          title: JOIN_BOARD_TITLE,
          body:
            `Everyone who opens this repository works from the issues in ${repo}. ` +
            (n > 0 ? `${cardsBecomeIssues(n, repo)} when you use it. ` : "") +
            "Plyloft changes nothing until you choose.",
          move: JOIN_BOARD_MOVE,
          keep: "Keep a local board on this Mac",
        };
      }
      return {
        kind: "offer",
        title: BOARD_OFFER_TITLE,
        body:
          (n > 0 ? `${cardsBecomeIssues(n, repo)}, ` : `The board becomes the issues in ${repo}, `) +
          "and your teammates see them there. Plyloft changes nothing until you choose.",
        move: "Move to GitHub Issues",
        keep: "Keep it on this Mac",
      };
    }
    case "setupElsewhere": {
      // B1 (walk 2026-10-27): the setup is named by what it was made for —
      // what the person recognises — never by the project name it carries.
      // 1.172.2 (D6): plain words, no "branch" and no folder state; the
      // facts stay — it was made elsewhere, this folder uses its own, and
      // using it starts cards from there and renames the project.
      const { branch } = status.action;
      const others = status.action.others ?? [];
      const where = status.githubRepo ? " on GitHub" : "";
      if (others.length > 0) {
        return {
          kind: "elsewhere",
          title: `This project has shared setups${where}`,
          body:
            `They were made for ${andWords([branch, ...others])}. This folder uses its own setup until you choose. ` +
            "Using one starts cards from the one you pick and renames this project to match.",
          move: ELSEWHERE_USE,
          keep: ELSEWHERE_KEEP,
          uses: elsewhereUses(branch, others, ELSEWHERE_USE),
        };
      }
      return {
        kind: "elsewhere",
        title: `This project has a shared setup${where}`,
        body:
          `It was made for ${branch}. This folder uses its own setup until you choose. ` +
          `Using it starts cards from ${branch} and renames this project to match.`,
        move: ELSEWHERE_USE,
        keep: ELSEWHERE_KEEP,
        uses: elsewhereUses(branch, others, ELSEWHERE_USE),
      };
    }
    case "soloBoardLocal":
      return {
        kind: "held",
        title: SOLO_REPO_BOARD_TITLE,
        body: SOLO_REPO_BOARD_BODY,
        team: SOLO_REPO_BOARD_TEAM,
      };
    case "boardHeld":
      return {
        kind: "held",
        title: "The board stays local on this Mac",
        body: status.action.reason,
      };
    default:
      return null;
  }
}

export function issuesWord(n: number): string {
  return `${n} ${n === 1 ? "issue" : "issues"}`;
}

/** The progress toast while local cards become issues. */
export function creatingIssuesToast(n: number) {
  return { kind: "info" as const, title: `Creating ${issuesWord(n)}…` };
}

/** The toast when the migration returns. */
export function createdIssuesToast(
  repo: string | null,
  summary: { pushed: number; failed: number },
) {
  const where = repo ? ` on ${repo}` : "";
  if (summary.failed > 0) {
    return {
      kind: "warn" as const,
      title: `Created ${issuesWord(summary.pushed)}${where}; ${summary.failed} failed`,
      body: "The cards that failed stay pending; Sync retries them.",
    };
  }
  return {
    kind: "info" as const,
    title: `Created ${issuesWord(summary.pushed)}${where}`,
    body: "The board is GitHub Issues now.",
  };
}

/** Kanban backing is set by the repository's definition for a GitHub repo:
 *  the setting disappears there. It stays for repos without a remote, and on
 *  a GitHub-backed board whose licence lapsed (switching to Local is the
 *  escape; it isn't published). */
export function showKanbanBacking(
  status: AdoptionStatus | null,
  githubBoardAllowed: boolean,
  githubBacked: boolean,
): boolean {
  if (!status || !status.githubRepo || !status.hasDefinition) return true;
  // Not switched yet (or the switch failed): the board is still Local here.
  if (status.action.kind === "switchBoard") return true;
  // OB-8: offered or kept on this Mac — the board is still Local here, and
  // Board keeps the press that moves it. Only cards waiting: the board is
  // already the repository's.
  if (status.action.kind === "offerBoard" || status.action.kind === "boardKeptLocal") {
    return !status.action.cardsOnly;
  }
  return githubBacked && !githubBoardAllowed;
}

/** R14: the question Settings › Board asks before it moves a board the
 *  repository's definition says is Local — the move is published for
 *  everyone. */
export const MOVE_REPO_BOARD_CONFIRM = {
  title: "Move this repository's board to GitHub Issues?",
  body: "Moving the board to GitHub Issues changes it for everyone who opens this repository.",
  confirmLabel: "Move to GitHub Issues",
};

export interface KeptLocalRow {
  label: string;
  hint: string;
  move: string;
  repo: string;
  cardsOnly: boolean;
  /** Asked before the move runs (R14), or absent. */
  confirm?: typeof MOVE_REPO_BOARD_CONFIRM;
}

/** What Settings › Board says, with the one press that moves the board, when
 *  the board banner offers nothing to move: the offer was answered "Keep it
 *  on this Mac" (OB-8 review 2), or the repository's definition says Local
 *  (R14 — the banner never offers that move; `licensed`: this Mac may run
 *  GitHub Issues). Null otherwise. */
export function keptLocalRow(
  status: AdoptionStatus | null,
  licensed = true,
): KeptLocalRow | null {
  if (!status) return null;
  const repo = status.boardRepo ?? status.githubRepo;
  if (!repo) return null;
  const action = status.action;
  const kept = action.kind === "boardKeptLocal";
  if (
    status.repoBoard === "local" &&
    status.hasDefinition &&
    licensed &&
    (action.kind === "none" || (kept && !action.cardsOnly))
  ) {
    return {
      label: "Local board",
      hint: `This repository's board is Local. Moving it to GitHub Issues turns the cards into issues in ${repo}.`,
      move: "Move to GitHub Issues",
      repo,
      cardsOnly: false,
      confirm: MOVE_REPO_BOARD_CONFIRM,
    };
  }
  if (!kept) return null;
  const { cardsOnly } = action;
  return {
    label: "Kept on this Mac",
    hint: cardsOnly
      ? `The board is GitHub Issues in ${repo}; this Mac's local cards were kept here. Moving them turns them into issues your teammates see.`
      : `The team's board is GitHub Issues in ${repo}; this Mac keeps its board here. Moving it turns the local cards into issues your teammates see.`,
    move: cardsOnly ? "Move them to GitHub Issues" : "Move to GitHub Issues",
    repo,
    cardsOnly,
  };
}

/** Statuses as they were read, by the workspace each was read for. */
export type StatusBook = Readonly<Record<string, AdoptionStatus>>;

/** The book with `workspaceId`'s status recorded; other workspaces' stay. */
export function recordStatus(
  book: StatusBook,
  workspaceId: string,
  status: AdoptionStatus,
): StatusBook {
  return { ...book, [workspaceId]: status };
}

/** The status read for `workspaceId`, or null while none is — the board
 *  component is reused across workspaces, and an automatic step must never
 *  pair one workspace's id with another's status. */
export function statusFor(
  book: StatusBook,
  workspaceId: string | null,
): AdoptionStatus | null {
  return workspaceId ? (book[workspaceId] ?? null) : null;
}

/** Numbers status requests per workspace so only each workspace's newest
 *  answer is kept: an operation finishing in workspace A and reloading A's
 *  status never supersedes a request for B. */
export class LatestOnly {
  #seq = new Map<string, number>();

  begin(key: string): number {
    const next = (this.#seq.get(key) ?? 0) + 1;
    this.#seq.set(key, next);
    return next;
  }

  isLatest(key: string, ticket: number): boolean {
    return this.#seq.get(key) === ticket;
  }
}

/** Nothing to say when a migration found nothing left to create. */
export function migrationToastNeeded(summary: {
  pushed: number;
  failed: number;
}): boolean {
  return summary.pushed > 0 || summary.failed > 0;
}

/** Keeps an automatic step (a migration, a board switch) from running twice
 *  at once for a workspace, without stopping a later adoption cycle — a
 *  board switched back to Local and to GitHub Issues again in the same
 *  session migrates the cards made meanwhile. */
export class InFlight {
  #running = new Set<string>();

  start(key: string): boolean {
    if (this.#running.has(key)) return false;
    this.#running.add(key);
    return true;
  }

  finish(key: string): void {
    this.#running.delete(key);
  }

  has(key: string): boolean {
    return this.#running.has(key);
  }
}

/** Runs an automatic step (conversion, board switch) at most once per
 *  workspace per session, so a failing one doesn't loop on every status. */
export class OncePerSession {
  #done = new Set<string>();

  claim(key: string): boolean {
    if (this.#done.has(key)) return false;
    this.#done.add(key);
    return true;
  }
}
