import type {
  CardDeleteOutcome,
  CardWorktreeState,
  WorktreeChoice,
} from "../ipc";
import { worktreeTrashFolder } from "./worktreeBase.ts";

/**
 * GH #116: what the card-delete confirm sheet says and offers about the
 * card's Builder worktree. Pure — the sheet reads the worktree through
 * `kanban_card_worktree_state` and this turns that answer into copy and
 * a set of buttons.
 *
 * The rule the sheet exists for: nothing that exists only on this Mac is
 * ever removed without the second, explicit choice. A worktree the
 * backend calls `remove` holds nothing at risk (clean, and every commit
 * is on the base, the target branch or origin), so it goes with the card
 * under the plain Delete.
 */

/** The button set a delete offers, in the order the sheet renders them. */
export type DeleteChoiceButton = {
  label: string;
  choice: WorktreeChoice;
  destructive: boolean;
};

/** "2 commits, 3 changed files" — only the parts that apply. */
export function atStake(wt: CardWorktreeState): string {
  const parts: string[] = [];
  if (wt.unpushedCommits > 0) {
    parts.push(
      `${wt.unpushedCommits} commit${wt.unpushedCommits === 1 ? "" : "s"}`,
    );
  }
  if (wt.dirtyFiles > 0) {
    parts.push(`${wt.dirtyFiles} changed file${wt.dirtyFiles === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

/** True while the sheet must not offer any destructive button yet: the
 *  worktree read hasn't landed, so nobody knows what a delete would take. */
export function stillReading(wt: CardWorktreeState | null): boolean {
  return wt == null;
}

/** The sheet's warning, or `null` when the delete needs no warning. A
 *  folder Ply could not confirm as this card's own checkout — not a
 *  worktree, on another branch, detached, or unreadable — says so
 *  instead of naming counts that would be another branch's.
 *
 *  GH #276: words only — the folder's path is behind the sheet's Details
 *  (`deleteFolderLine`), never in the first layer. */
export function deleteWarning(wt: CardWorktreeState | null): string | null {
  if (!wt || wt.disposition !== "ask") return null;
  if (wt.unreadable) {
    return "Plyloft couldn't confirm this folder is this card's own, so it won't remove it on its own.";
  }
  // n16: the folder is the card's own; only its commits couldn't be
  // measured (no target branch, base or origin to measure against).
  if (wt.commitsUnmeasured) {
    const files =
      wt.dirtyFiles > 0
        ? ` It also has ${wt.dirtyFiles} changed file${wt.dirtyFiles === 1 ? "" : "s"} that exist${wt.dirtyFiles === 1 ? "s" : ""} only on this Mac.`
        : "";
    return `Plyloft couldn't tell which of this card's commits are elsewhere, so it won't remove them on its own.${files}`;
  }
  // n16: with no origin every commit is only on this Mac; what matters
  // is that they aren't on the branch the card's work lands on.
  const target = noOriginTarget(wt);
  if (target && wt.unpushedCommits > 0) {
    const commits = notOnTarget(wt.unpushedCommits, target);
    if (wt.dirtyFiles === 0) return `This card has ${commits}.`;
    const files = `${wt.dirtyFiles} changed file${wt.dirtyFiles === 1 ? "" : "s"}`;
    return `This card has ${commits} and ${files} that exist${wt.dirtyFiles === 1 ? "s" : ""} only on this Mac.`;
  }
  const parts: string[] = [];
  if (wt.unpushedCommits > 0) {
    parts.push(`${wt.unpushedCommits} commit${wt.unpushedCommits === 1 ? "" : "s"}`);
  }
  if (wt.dirtyFiles > 0) {
    parts.push(`${wt.dirtyFiles} changed file${wt.dirtyFiles === 1 ? "" : "s"}`);
  }
  const n = wt.unpushedCommits + wt.dirtyFiles;
  const stake = parts.length ? parts.join(" and ") : "work";
  return `This card has ${stake} that exist${n === 1 ? "s" : ""} only on this Mac.`;
}

/** n16: the target branch when the workspace has no `origin` (the commit
 *  line then says "isn't on <target>"), else `null`. */
function noOriginTarget(wt: CardWorktreeState): string | null {
  return wt.hasOrigin === false && wt.targetBranch ? wt.targetBranch : null;
}

/** "1 commit that isn't on main" / "3 commits that aren't on main". */
function notOnTarget(n: number, target: string): string {
  return `${n} commit${n === 1 ? " that isn't" : "s that aren't"} on ${target}`;
}

/** n16: the longest commit line Details shows; a longer one ends in "…". */
export const COMMIT_LINE_MAX = 100;

function capSubject(line: string): string {
  const chars = [...line];
  return chars.length > COMMIT_LINE_MAX ? `${chars.slice(0, COMMIT_LINE_MAX - 1).join("").trimEnd()}…` : line;
}

/** n16: the local-only commits for the sheet's Details — `<short sha>
 *  <subject>`, newest first, with "and N more" past the five listed — so a
 *  `build: snapshot` or a Builder's own commit is recognisable. Never their
 *  contents. Empty when there is nothing to list. */
export function deleteCommitLines(wt: CardWorktreeState | null): string[] {
  if (!wt || wt.disposition !== "ask") return [];
  const subjects = wt.localOnlySubjects ?? [];
  if (subjects.length === 0) return [];
  const total = wt.branch ? wt.unpushedCommits : (wt.cardBranchCommits ?? subjects.length);
  const lines = [`Its commit${total === 1 ? "" : "s"}:`, ...subjects.map(capSubject)];
  const more = total - subjects.length;
  if (more > 0) lines.push(`and ${more} more`);
  return lines;
}

/** GH #276: where the folder is, for the sheet's Details; `null` when the
 *  sheet has no Details to show it in. */
export function deleteFolderLine(wt: CardWorktreeState | null): string | null {
  if (!wt || wt.disposition !== "ask" || !wt.path) return null;
  return `The folder: ${wt.path}`;
}

/** What `Delete everything` really does, behind the sheet's Details (GH
 *  #276: mechanism is the second layer). Ply never deletes a checkout
 *  outright — it is staged in the `.trash/` of its worktree root
 *  (`.plyloft-worktrees/`, or `.atelier-worktrees/` for an older card),
 *  which is cleared after a week — so the destructive choice is
 *  recoverable, and says so. */
export function deleteRecoveryNote(wt: CardWorktreeState | null): string | null {
  // Not while the delete is refused: it describes a button that is not
  // on the sheet.
  if (
    wt?.disposition !== "ask" ||
    wt.busy?.kind === "verify" ||
    wt.busy?.kind === "setup" ||
    wt.busy?.kind === "terminal"
  )
    return null;
  return (
    `Delete everything moves the folder to ${worktreeTrashFolder(wt.path)} for 7 days — ` +
    "longer if anything writes into it meanwhile — and you can take it back from there."
  );
}

/** The quiet line for a worktree that goes with the card, or `null`.
 *
 *  It says what is true of a `remove` verdict — everything is committed
 *  and already on another ref, and nothing ignored is left but build
 *  output — rather than the sweeping "nothing in there exists only on
 *  this Mac", which was wrong about the build output the removal drops.
 *  `killRun`: the sheet's "Also kill the running agent" box. */
export function deleteNote(wt: CardWorktreeState | null, killRun = true): string | null {
  if (!wt || wt.disposition !== "remove") return null;
  // F8 (SL-4 walk): not while the delete is refused — nothing goes anywhere.
  if (deleteBlockedReason(wt, killRun)) return null;
  const branch = wt.branch ? ` and branch ${wt.branch}` : "";
  const session = wt.liveSession
    ? " Its open Builder session is ended first."
    : "";
  return `Its Builder folder${branch} go${wt.branch ? "" : "es"} with it. Nothing in it is unsaved or unpushed; its build output is not kept.${session}`;
}

/** 1.168.1 (A4, owner 2026-10-22): what a delete keeps — the card's runs
 *  and checks stay in History, marked "· card deleted". */
export const DELETE_KEEPS_HISTORY = "Its runs and checks stay in History.";

/** GH #116: what a delete would take that the folder itself cannot
 *  account for — the card's own branch, when the checkout proves none.
 *  `Delete everything` drops it, so the sheet names it and measures it
 *  rather than removing something it never mentioned. */
export function deleteBranchNote(wt: CardWorktreeState | null): string | null {
  if (!wt || wt.disposition !== "ask" || wt.branch || !wt.cardBranch) return null;
  const n = wt.cardBranchCommits;
  const commits =
    n == null
      ? "Plyloft couldn't measure"
      : n === 0
        ? "has no commits of its own"
        : noOriginTarget(wt)
          ? `has ${notOnTarget(n, noOriginTarget(wt)!)}`
          : `has ${n} commit${n === 1 ? "" : "s"} that exist${n === 1 ? "s" : ""} only on this Mac`;
  return `Deleting everything also drops this card's branch ${wt.cardBranch}, which ${commits}.`;
}

/** GH #116: the run the delete must stop before it starts, or `null`.
 *
 *  The user's tick is the authority, not the card's `lastRunStatus`:
 *  that field is a mirror the exit listener writes, and the sheet now
 *  also offers the kill for a run only the backend's read found, whose
 *  mirror can say anything. Gating the kill on the mirror was what made
 *  that offer unable to keep its word — the box was ticked, the kill was
 *  skipped, and the delete was refused for the run still standing.
 *  Stopping a run that has already finished is a no-op in the backend,
 *  so asking is always safe. */
export function runToKill(
  // `lastRunStatus` is named here to be visibly unused: it is the
  // mirror this deliberately does not consult.
  card: { linkedRunId?: string | null; lastRunStatus?: string | null },
  opts?: { alsoKillRun?: boolean },
): string | null {
  return opts?.alsoKillRun ? (card.linkedRunId ?? null) : null;
}

/** GH #116: whether the kill-the-run box should be ticked once the
 *  worktree read lands.
 *
 *  A run the card already advertised leaves the user's own state alone:
 *  the box was there from the start, defaulted on, and unticking it is
 *  a deliberate act the read must not undo. A run only the read found
 *  arrives with its box unticked and would block the sheet with nothing
 *  the user had a chance to choose, so it defaults on like any other. */
export function killRunDefault(
  previous: { killRun: boolean; hasRunningRun: boolean },
  wt: CardWorktreeState,
): boolean {
  if (previous.killRun) return true;
  return !previous.hasRunningRun && wt.busy?.kind === "run";
}

/** GH #116: the delete is refused while something works in the folder —
 *  unless it is the card's own agent run and the human has ticked the
 *  box that kills it, which the delete does before it starts. Ply will
 *  not pull the ground from under a Verify run, and will not end one on
 *  the user's behalf either. */
export function deleteBlockedReason(
  wt: CardWorktreeState | null,
  killRun: boolean,
): string | null {
  const busy = wt?.busy;
  if (!busy) return null;
  if (busy.kind === "run" && killRun) return null;
  const reason = `${busy.reason[0].toUpperCase()}${busy.reason.slice(1)}`;
  if (busy.kind === "setup") return `${reason}. Wait for it to finish, then delete the card.`;
  // #378 (P3-2): "Open a terminal in this worktree" — the person closes it.
  if (busy.kind === "terminal") return `${reason}. Close it, then delete the card.`;
  return busy.kind === "run"
    ? `${reason}. Tick "Also kill the running agent on this card", or stop it first.`
    : `${reason}. Stop it first, then delete the card.`;
}

/** The destructive buttons the sheet offers. A worktree holding work
 *  that exists nowhere else replaces the single Delete with the two
 *  explicit choices; everything else keeps the one plain Delete. */
export function deleteChoices(
  wt: CardWorktreeState | null,
  ghBacked: boolean,
  killRun: boolean,
): DeleteChoiceButton[] {
  // Nothing to press while something owns the folder and the sheet
  // cannot clear it — the backend refuses, so no button is offered that
  // cannot work. The card's own run is the exception: with the kill box
  // ticked the delete stops it first, which is the whole point of that
  // box, and the backend sees a run already ended.
  if (deleteBlockedReason(wt, killRun)) return [];
  if (wt?.disposition === "ask") {
    return [
      // GH #276: short, so the foot stays one row.
      { label: "Keep the folder", choice: "keep", destructive: false },
      { label: "Delete everything", choice: "everything", destructive: true },
    ];
  }
  return [
    {
      label: ghBacked ? "Close issue & delete" : "Delete",
      choice: "auto",
      destructive: true,
    },
  ];
}

/** The toast a finished delete owes the user, or `null` when the delete
 *  did exactly what was asked and there is nothing to add. */
export type DeleteOutcomeToast = {
  kind: "error" | "info";
  title: string;
  body: string;
};

/** GH #116: what to say about what the delete left behind.
 *
 *  A folder that stayed is always named — that is the whole point of the
 *  toast, and the backend's `problem` (`rename to trash: Permission
 *  denied`) does not name it. A folder the user chose to keep needs no
 *  toast: they pressed the button that says so. And a delete whose
 *  folder went while only its branch stayed must not claim the folder
 *  stayed. */
export function deleteOutcomeToast(
  outcome: CardDeleteOutcome,
  choice: WorktreeChoice | undefined,
): DeleteOutcomeToast | null {
  // GH #116: the folder went, but not to the week's queue — something
  // in it was never judged, so it waits in the trash for the human.
  // Said first: it is the one outcome that leaves work needing a
  // decision, and the Worktrees panel is where that decision is made.
  if (outcome.keptInTrash) {
    return {
      kind: "info",
      title: "Card deleted — its folder is kept, not queued for deletion",
      body: `${outcome.keptReason ?? "Plyloft could not judge what is in it"}. It is at ${outcome.keptInTrash}, and listed in Settings › Project › Cards' copies until you deal with it.`, // ux-allow: technical page name
    };
  }
  if (outcome.problem) {
    // The folder went; something smaller did not.
    if (outcome.worktreeRemoved && !outcome.keptPath) {
      return {
        kind: "error",
        title: "Card deleted — its branch stayed",
        body: outcome.problem,
      };
    }
    return {
      kind: "error",
      title: "Card deleted — its folder stayed",
      body: outcome.keptPath
        ? `${outcome.keptPath} — ${outcome.problem}`
        : outcome.problem,
    };
  }
  if (outcome.keptPath && choice !== "keep") {
    // Why it stayed is the backend's judgement (work only here, or a
    // folder it could not read), so the toast states the fact and points
    // at the one place that can finish the job.
    return {
      kind: "info",
      title: "Card deleted — its folder stayed",
      body: `${outcome.keptPath} is still on disk. Remove it from Settings › Project › Cards' copies when you no longer need it.`, // ux-allow: technical page name
    };
  }
  return null;
}
