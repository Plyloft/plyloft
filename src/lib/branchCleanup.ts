/**
 * N18: card branches are cleaned up automatically — the words. The rule
 * itself is the backend's (`branch_cleanup.rs`): a shipped, landed or merged
 * card's branch is deleted at the tip recorded when it shipped, once its
 * worktree's trash entry has expired (7 days); an archived card's only after
 * the Inbox asked. This file says it: the card's Activity row, the Inbox
 * rows, the Worktrees page's kept branches and the GitHub suggestion.
 */
import type { BranchAskItem, BranchBacklogItem, BranchCleanup, KanbanCard } from "../ipc";

/** "abc1234": the short form git itself shows. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The card's Activity row for its branch: "Branch <name> deleted (was
 *  <short sha>)" once it went, "Branch kept: the card started again" when
 *  the card picked it up again. null for anything else. */
export function branchDeletedText(rec: BranchCleanup | null | undefined): string | null {
  if (!rec) return null;
  if (rec.outcome === "deleted") return `Branch ${rec.branch} deleted (was ${shortSha(rec.tip)})`;
  if (rec.outcome === "restarted") return "Branch kept: the card started again";
  return null;
}

/** What the Worktrees page says under a branch it kept. */
export const KEPT_AFTER_SHIP = "Has commits after it shipped — kept";
export const KEPT_AFTER_ARCHIVE = "Has commits after it was archived — kept";
export const KEPT_BEHIND = "Its pull request merged commits this Mac doesn't have — kept";

/** The words for a kept branch, by why it was kept; null when it wasn't. */
export function keptLabel(rec: BranchCleanup | null | undefined): string | null {
  if (rec?.outcome === "behind") return KEPT_BEHIND;
  if (rec?.outcome !== "movedOn") return null;
  return rec.reason === "archived" ? KEPT_AFTER_ARCHIVE : KEPT_AFTER_SHIP;
}

/** The cards whose branch the cleanup kept for good — not a card that uses
 *  a branch again (it records one, or is in progress). */
export function keptBranches(
  cards: readonly KanbanCard[],
): { cardId: string; title: string; branch: string; label: string }[] {
  return cards.flatMap((c) => {
    const label = keptLabel(c.branchCleanup);
    if (!label || c.branchName || c.columnId === "in_progress") return [];
    return [{ cardId: c.id, title: c.title, branch: c.branchCleanup!.branch, label }];
  });
}

const NAMES_SHOWN = 3;

/** "a, b and c" — or the first three "and 2 more". */
export function branchList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= NAMES_SHOWN) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${names.length - NAMES_SHOWN} more`;
}

function branches(n: number): string {
  return n === 1 ? "1 branch" : `${n} branches`;
}

/** The Inbox ask about archived cards' branches, worded from the cards'
 *  records: a card archived without ever shipping has all its work on the
 *  branch; one that shipped, started again and was archived has its last
 *  work there. Either way it is not on the main branch, and deleting the
 *  branch loses it. 1.171.0 A3 (BI-2): so Keep them is the row's press and
 *  Delete them… asks first (`deleteAsk`); the title says what is true, with
 *  no "due to be deleted". */
export function askWords(asks: readonly BranchAskItem[]): {
  title: string;
  detail: string;
  /** The row's press: keeps them. */
  keep: string;
  /** The other way, behind `deleteAsk`. */
  remove: string;
  deleteAsk: { title: string; body: string; confirmLabel: string; cancelLabel: string; destructive: true };
} {
  const n = asks.length;
  return {
    title:
      n === 1
        ? "An archived card's work is only on its branch"
        : `${n} archived cards' work is only on their branches`,
    detail: asks.some((a) => a.shipped)
      ? `${n === 1 ? "Its card was" : "Their cards were"} archived; ${n === 1 ? "its" : "their"} last work is only on ` +
        `${n === 1 ? "this branch" : "these branches"}, not on the main branch: ${branchList(asks.map((a) => a.branch))}`
      : `${n === 1 ? "Its card was" : "Their cards were"} archived without shipping, so the work is only on ` +
        `${n === 1 ? "this branch" : "these branches"}, not on the main branch: ${branchList(asks.map((a) => a.branch))}`,
    keep: "Keep them",
    remove: "Delete them…",
    deleteAsk: {
      title: n === 1 ? "Delete this branch?" : `Delete these ${n} branches?`,
      body: `The work on ${n === 1 ? "it" : "them"} is only there: ${branchList(asks.map((a) => a.branch))}. Once deleted, it's gone.`,
      confirmLabel: n === 1 ? "Delete it" : "Delete them",
      cancelLabel: "Keep them",
      destructive: true,
    },
  };
}

/** The one-time offer for branches of cards shipped before this update.
 *  When only archived cards' branches are listed, `yes` is "Ask about
 *  them": those go to the Inbox ask one by one and are never deleted from
 *  the offer itself. */
export function backlogWords(items: readonly BranchBacklogItem[]): {
  title: string;
  detail: string;
  yes: string;
  notNow: string;
  never: string;
} {
  const shipped = items.filter((i) => !i.archived);
  const archived = items.length - shipped.length;
  const parts: string[] = [];
  if (shipped.length > 0) parts.push(branchList(shipped.map((i) => i.branch)));
  if (archived > 0) {
    parts.push(
      archived === 1
        ? "1 archived card's branch will be asked about here"
        : `${archived} archived cards' branches will be asked about here`,
    );
  }
  return {
    title:
      shipped.length > 0
        ? `${branches(shipped.length)} of cards that already shipped can be deleted`
        : `${branches(archived)} of archived cards can be cleaned up`,
    detail: parts.join(" · "),
    yes: shipped.length > 0 ? `Delete ${branches(shipped.length)}` : "Ask about them",
    notNow: "Not now",
    never: "Never",
  };
}

/** What a toast says after an answer. */
export function answerToast(r: { deleted: number; kept: number; queued: number }): string {
  const parts: string[] = [];
  if (r.deleted > 0) parts.push(`${branches(r.deleted)} deleted`);
  if (r.kept > 0) parts.push(`${branches(r.kept)} kept (in use, or with commits after it shipped)`);
  if (r.queued > 0) parts.push(`${branches(r.queued)} of archived cards to ask about`);
  return parts.length > 0 ? `${parts.join(", ")}.` : "Nothing to delete.";
}

/** The repository whose GitHub settings to link: the board's own, else a
 *  local board's GitHub origin (`project_local_origin`). */
export function githubRepoOf(boardRepo: string | null | undefined, originRepo: string | null | undefined): string | null {
  return githubBranchSettingsUrl(boardRepo) ? boardRepo!.trim() : githubBranchSettingsUrl(originRepo) ? originRepo!.trim() : null;
}

/** The repository's GitHub settings page, where "Automatically delete head
 *  branches" is (General › Pull Requests). null without a known repository. */
export function githubBranchSettingsUrl(ownerRepo: string | null | undefined): string | null {
  const repo = ownerRepo?.trim() ?? "";
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `https://github.com/${repo}/settings`;
}
