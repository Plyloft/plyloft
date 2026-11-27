// 1.175.0 (D3; review TM-4, mockup two-people.html#d3): a card edited here
// while its issue changed on GitHub. Plyloft writes only the part the
// member touched; when GitHub's copy of that part changed since this
// computer last read it, nothing is written and the card asks which
// version to keep (`issue_edit.rs`). These are the words of that question,
// on the card page, the Board, the Inbox and the toasts.
import { agoWords } from "./copyWords.ts";

/** A part of a card's issue that has a question of its own. */
export type EditPart = "title" | "brief";

/** Mirrors `issue_edit::EditConflict`: GitHub's value of the part as the
 *  question shows it, and who changed it there, when GitHub says. */
export interface EditConflict {
  part: EditPart;
  theirs: string;
  who?: string | null;
  at?: number | null;
}

/** Mirrors `issue_edit::Resolved`. */
export type EditResolved = "kept_github" | "kept_mine" | "changed_again" | "gone";

type AskingCard = { editConflicts?: readonly EditConflict[] | null };

/** The card's open question on `part`, or null. */
export function editConflictOf(card: AskingCard, part: EditPart): EditConflict | null {
  return card.editConflicts?.find((c) => c.part === part) ?? null;
}

/** Whether the card asks which version of a part to keep. */
export function hasEditConflict(card: AskingCard): boolean {
  return (card.editConflicts?.length ?? 0) > 0;
}

function who(c: EditConflict): string | null {
  return c.who?.trim() || null;
}

/** "example-teammate changed the brief on GitHub 4 min ago"; "Someone else
 *  changed…" when GitHub doesn't say who. */
export function conflictTitle(c: EditConflict, now: number): string {
  const when = c.at != null ? ` ${agoWords(c.at, now)}` : "";
  return `${who(c) ?? "Someone else"} changed the ${c.part} on GitHub${when}`;
}

/** Under the title of the notice. */
export function conflictBody(part: EditPart, issueNumber: number | null | undefined): string {
  const first = "You changed it here too, before seeing that.";
  if (part === "brief" && issueNumber != null) {
    return `${first} Your version isn't on issue #${issueNumber} yet. Which should the card keep?`;
  }
  return `${first} Which should the card keep?`;
}

/** The two versions' headings. The brief's name who and where; the title's
 *  are the two words alone (its values sit on two rows). "this Mac" is
 *  drawn through `machineWords` where it is shown. */
export function versionHeadings(c: EditConflict): { theirs: string; mine: string } {
  if (c.part === "title") return { theirs: "On GitHub now", mine: "Yours" };
  const by = who(c);
  return { theirs: by ? `On GitHub now · ${by}` : "On GitHub now", mine: "Yours · this Mac" };
}

export const USE_GITHUBS_LABEL = "Use GitHub's";
export const KEEP_MINE_LABEL = "Keep mine";

/** Under the brief's field while its question is open. */
export const BRIEF_ASKED_LINE =
  "Start build sends the brief you see here. Your version stays on this Mac until you choose.";

/** A version's lines, each marked when the other version doesn't have it:
 *  the two are shown whole, side by side, with what differs in weight. */
export function markedLines(text: string, other: string): { line: string; differs: boolean }[] {
  const others = new Set(other.split("\n").map((l) => l.trim()));
  return text.split("\n").map((line) => ({ line, differs: line.trim() !== "" && !others.has(line.trim()) }));
}

/** The Board card's quiet line. */
export const EDIT_WAITS_LINE = "Changed on GitHub · your edit waits";

const INBOX_DETAIL: Record<EditPart, string> = {
  brief: "The brief changed on GitHub · choose which version the card keeps",
  title: "The title changed on GitHub · choose which version the card keeps",
};

/** The Inbox row's words (the brief's question first), as
 *  `issue_edit::inbox_detail` says them for a project that isn't open. */
export function editInboxDetail(card: AskingCard): string | null {
  if (editConflictOf(card, "brief")) return INBOX_DETAIL.brief;
  if (editConflictOf(card, "title")) return INBOX_DETAIL.title;
  return null;
}

/** Whether an Inbox row's detail is one of those. */
export function isEditInboxDetail(detail: string | null | undefined): boolean {
  return detail === INBOX_DETAIL.brief || detail === INBOX_DETAIL.title;
}

/** The Inbox row's press: the choice is made on the card. */
export const EDIT_CHOOSE_ACTION = "Choose";

type Notice = { kind: "info" | "warn" | "error"; title: string; body: string; details?: string };

/** After *Use GitHub's*: the toast offers what the member wrote back. */
export function droppedNotice(part: EditPart): Notice {
  return { kind: "info", title: `Your change to the ${part} was dropped`, body: "The card shows what is on GitHub." };
}
export const COPY_MINE_LABEL = "Copy what I wrote";

/** After *Keep mine*. */
export function keptMineNotice(c: EditConflict, issueNumber: number | null | undefined, now: number): Notice {
  const whose = who(c) ? `${who(c)}’s` : "someone else’s";
  const when = c.at != null ? ` from ${agoWords(c.at, now)}` : "";
  return {
    kind: "info",
    title: issueNumber != null ? `Saved to issue #${issueNumber}` : "Saved to the issue",
    body: `Your ${c.part} replaced ${whose} change${when}.`,
  };
}

/** GitHub's version changed again before the press: nothing was written. */
export function changedAgainNotice(part: EditPart): Notice {
  return {
    kind: "warn",
    title: `The ${part} changed on GitHub again`,
    body: "Nothing was written. Look at the two versions again, then choose.",
  };
}

/** The answer couldn't be carried out; the reason goes behind Details. */
export function notRecordedNotice(details: string): Notice {
  // The backend's sentence leads its own error; what follows it is the reason.
  const reason = details.replace(/^Plyloft couldn’t record your choice\. Try again in a moment\.\s*/, "").trim();
  return { kind: "error", title: "Plyloft couldn’t record your choice", body: "Try again in a moment.", ...(reason ? { details: reason } : {}) };
}
