// N19 (owner decision 2026-10-06): `Follow up` on a shipped card. A shipped
// card is history — its branch was merged or squash-merged and is cleaned up
// later (`branchCleanup`) — so more work on it is a new card in To do, linked
// both ways (`followsUp` / `followedUpBy`), that starts like any card: a new
// branch from the current target. Pure — node runs it
// (`src/lib/followUp.test.ts`).
import { cardDelivery, cardLanded } from "./cardLifecycle.ts";
import { machineWords } from "./platform.ts";
import { ownShipEntry } from "./shipVersion.ts";
import { nowFacts } from "./cardPage.ts";
import type { CardPresentationState, CardFollowLink, KanbanCard } from "../ipc.ts";

/** The press, on the Now callout (beside View the shipped result) and in the ⋯. */
export const FOLLOW_UP_LABEL = "Follow up";
/** Its tooltip: what the press does. */
export const FOLLOW_UP_TITLE =
  "Makes a new card, ready to start, that links back to this one, with what shipped as context. It starts on a new branch, from your main branch as it is now.";

/** Titles stay as short as the follow-up cards of Ship with follow-up. */
const TITLE_MAX = 120;
/** How much of the shipped card's brief the new brief quotes. */
const BRIEF_QUOTE_MAX = 1500;

/** The line the person replaces with what should change now. */
export const FOLLOW_UP_ASK = "What should change now: ";
/** The marked context block's heading. */
export function followUpContextHeading(title: string): string {
  return `Context — what shipped on “${title}” (from that card; edit or remove it before you start):`;
}

/** 1.171.0 (E2; walk 2026-10-27 #6): the card is done — it landed (its
 *  pull request merged, or shipped on this Mac), or its GitHub issue is
 *  closed (Complete on a GitHub Issues board, as `followUpOffered` reads
 *  it). Its brief is history then, and nothing blocks it any more: more work
 *  is a Follow up. 1.174.0 A2 (P7): a card whose pull request is still open
 *  (or closed without merging) is sent, not done — its brief can change. A
 *  card finished by hand without an issue stays editable. */
export function cardIsDone(
  card: Pick<KanbanCard, "shipStatus" | "reviewStatus"> & Partial<Pick<KanbanCard, "ghIssueNumber" | "pr" | "prUrl">>,
  state: CardPresentationState,
): boolean {
  return cardLanded(card) || (state === "closed" && Boolean(card.ghIssueNumber));
}

/** The line under a done card's What you want, which can't be edited;
 *  Follow up named only where the card offers it. 1.174.0 A2: a landed card
 *  says how it landed — its pull request merged (#N), or shipped on this
 *  Mac. A card done another way (its issue closed) keeps the plain line. */
export function doneBriefLine(
  card: Pick<KanbanCard, "shipStatus" | "reviewStatus"> & Partial<Pick<KanbanCard, "pr" | "prUrl" | "shipHistory" | "commitSha">>,
  followUpOffered: boolean,
): string {
  const more = followUpOffered ? " For more changes, use Follow up." : "";
  const merged = card.prUrl && card.pr?.state === "merged" ? card.pr.number : null;
  if (cardLanded(card) && merged != null) return `This card is done: pull request #${merged} merged.${more}`;
  // Round 1: "on this Mac" only when its last ship landed here.
  // A pull request Plyloft never read back (a link, no read) stays plain:
  // its merge is recorded as a local entry too. 1.174.0 (DR2 round 2): the
  // card's own ship, not a release that carried it later.
  const local =
    card.shipStatus === "shipped" &&
    ownShipEntry(card)?.releaseKind === "local" &&
    card.pr?.state !== "merged" &&
    !(card.prUrl && !card.pr);
  if (local) return machineWords(`This card is done: it shipped on this Mac.${more}`);
  // Its issue closed, or a pull request Plyloft never read back.
  return `This card is done, so what it asked for stays as it was.${more}`;
}

/** 1.174.0 A2 (P7): the line under What you want while the card is sent,
 *  not landed — its pull request is open, so the brief can still change
 *  (Fix with the Builder takes it: Now's for what GitHub said, else the ⋯'s
 *  for the brief), or it was closed without merging. Null for any other card. */
export function sentBriefLine(
  card: Pick<KanbanCard, "shipStatus" | "reviewStatus"> & Partial<Pick<KanbanCard, "pr" | "prUrl">>,
): string | null {
  if (cardDelivery(card) !== "sent" || !card.pr) return null;
  if (card.pr.state === "closed") return "The card isn't done: change what you want, then ship it again.";
  return `Pull request #${card.pr.number} is still open, so this card can still change. Edit this, then Fix with the Builder; Send the fixes to GitHub adds the new build to the pull request.`;
}

/** Whether the card offers Follow up: it has landed (its pull request
 *  merged, or shipped on this Mac — never while the pull request is open,
 *  1.174.0 A2), shown as shipped or archived — or, on a GitHub Issues
 *  board, its issue is done (Complete; a teammate shipped it and this Mac
 *  never did), shown as closed or archived. Never where the person can't
 *  create cards (`readOnly`: a GitHub board without Team). The backend's
 *  `kanban::follow_up_allowed`. */
export function followUpOffered(
  card: Pick<KanbanCard, "shipStatus" | "reviewStatus"> & Partial<Pick<KanbanCard, "ghIssueNumber" | "columnId" | "pr" | "prUrl">>,
  state: CardPresentationState,
  readOnly: boolean,
): boolean {
  if (readOnly) return false;
  if (cardLanded(card)) return state === "shipped" || state === "archived";
  // 1.174.0 A2 round 1: never while its own pull request is open.
  if (card.prUrl && card.pr?.state === "open") return false;
  return Boolean(card.ghIssueNumber) && card.columnId === "complete" && (state === "closed" || state === "archived");
}

/** `Intl.Segmenter`, as far as `cutText` uses it (not in this TS lib). */
type GraphemeSegmenter = new (
  locale: undefined,
  options: { granularity: "grapheme" },
) => { segment(text: string): Iterable<{ segment: string }> };

/** Cut `text` to at most `max` characters as a person sees them (grapheme
 *  clusters: an emoji or an accented letter is never split), the last one
 *  an ellipsis. Code points where `Intl.Segmenter` is missing. */
export function cutText(text: string, max: number): string {
  const Seg = (Intl as unknown as { Segmenter?: GraphemeSegmenter }).Segmenter;
  const parts = Seg
    ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment)
    : [...text];
  return parts.length > max ? `${parts.slice(0, max - 1).join("")}…` : text;
}

/** The original's title without the "Follow-up: " it may carry already, so a
 *  follow-up of a follow-up is never "Follow-up: Follow-up: …". */
export function followUpBaseTitle(title: string): string {
  return title.trim().replace(/^(?:Follow-up:\s*)+/i, "").trim() || title.trim();
}

type DraftCard = Pick<
  KanbanCard,
  "title" | "notes" | "dispatchPrompt" | "shipHistory" | "prUrl" | "reviewStatus" | "shipStatus" | "verifyStatus" | "verifyHistory" | "builder" | "archivedAt" | "autoArchived" | "lastRunStatus"
> &
  Partial<Pick<KanbanCard, "pr" | "columnId" | "ghIssueNumber">>;

/** The new card's title and brief ("What you want"). The brief opens with
 *  the line the person fills in, then the shipped card's facts and its brief
 *  quoted, under a heading that marks them as context. On a GitHub board it
 *  names the issue ("Follows up #21"), which GitHub links. */
export function followUpDraft(card: DraftCard, now: number): { title: string; notes: string } {
  const original = followUpBaseTitle(card.title);
  const title = cutText(`Follow-up: ${original}`, TITLE_MAX);
  const issue = card.ghIssueNumber ? `Follows up #${card.ghIssueNumber}.` : null;
  const shipped =
    nowFacts("shipped", card, { filesChanged: null, now }) ??
    (cardLanded(card) ? "Shipped." : card.ghIssueNumber ? `Issue #${card.ghIssueNumber} is closed.` : "Shipped.");
  const brief = (card.notes?.trim() || card.dispatchPrompt?.trim() || "").trim();
  const quoted = brief
    ? cutText(brief, BRIEF_QUOTE_MAX)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n")
    : null;
  const context = [
    followUpContextHeading(card.title.trim()),
    ...(issue ? [issue] : []),
    shipped,
    ...(quoted ? ["Its brief:", quoted] : []),
  ];
  return { title, notes: [FOLLOW_UP_ASK, "", "---", ...context].join("\n") };
}

/** 1.171.0 (E2; walk 2026-10-27 #6): Follow up first offers its card — the
 *  suggested title (`followUpDraft`'s, from this card) and "What should
 *  change now" — so the press says what it makes before it makes it. The
 *  person's words go after the ask's line; a title left empty keeps the
 *  suggestion; nothing written leaves the ask for later. */
export function followUpChosen(
  draft: { title: string; notes: string },
  title: string,
  ask: string,
): { title: string; notes: string } {
  const named = title.trim() ? cutText(title.trim(), TITLE_MAX) : draft.title;
  const said = ask.trim();
  if (!said || !draft.notes.startsWith(FOLLOW_UP_ASK)) return { title: named, notes: draft.notes };
  return { title: named, notes: `${FOLLOW_UP_ASK}${said}${draft.notes.slice(FOLLOW_UP_ASK.length)}` };
}

/** The brief still opens with the bare ask: the person said nothing yet. */
export function followUpAskLeft(notes: string): boolean {
  return notes.split("\n", 1)[0].trimEnd() === FOLLOW_UP_ASK.trimEnd();
}

/** The sheet's words. */
export const FOLLOW_UP_SHEET_TITLE = "Follow up with a new card";
export function followUpSheetLede(title: string): string {
  return `A new card, linked to “${title}”, with what shipped as its context. This card stays as it is.`;
}
export const FOLLOW_UP_ASK_LABEL = "What should change now";
export const FOLLOW_UP_ASK_PLACEHOLDER = "Optional: you can write it on the new card instead.";
export const FOLLOW_UP_MAKE_LABEL = "Make the card";

/** The words beside a follow-up card's Start build while nothing is written
 *  after "What should change now:". */
export const FOLLOW_UP_ASK_EMPTY = "Say what should change first.";

/** A follow-up card in To do whose brief still opens with the ask and
 *  nothing after it: Start build, Build with both and Plan stay off until
 *  the person says what should change (`brief`: the brief as typed). */
export function followUpAskEmpty(
  card: Pick<KanbanCard, "followsUp" | "archived" | "columnId">,
  brief: string,
): boolean {
  if (!card.followsUp || card.archived || card.columnId !== "todo") return false;
  const first = brief.split("\n", 1)[0];
  return first.trimEnd() === FOLLOW_UP_ASK.trimEnd();
}

/** The card's follow-up still waiting to start — made by Follow up or by
 *  Ship with follow-up, in To do, not archived, not landed — which Follow up
 *  opens instead of making another. Null when every follow-up has started or
 *  finished (or there is none): Follow up makes a new one. */
export function openFollowUp(
  card: Pick<KanbanCard, "followedUpBy" | "builder">,
  cards: readonly KanbanCard[],
): KanbanCard | null {
  const ids = [...(card.followedUpBy ?? []).map((f) => f.cardId), card.builder?.followUp?.cardId].filter(
    (id): id is string => Boolean(id),
  );
  for (const id of ids) {
    const c = cards.find((x) => x.id === id);
    if (c && !c.archived && !cardLanded(c) && c.columnId === "todo") return c;
  }
  return null;
}

/** The toast when Follow up opens the existing one. */
export function existingFollowUpWords(title: string): string {
  return `This card already has a follow-up: ${title}`;
}

/** "Follows up “Search”": the follow-up card's property, its original named
 *  by its title now when it still exists, else the title the link kept. */
export function followLinkTitle(link: CardFollowLink, cards: readonly Pick<KanbanCard, "id" | "title">[]): {
  title: string;
  exists: boolean;
} {
  const live = cards.find((c) => c.id === link.cardId);
  return { title: live?.title ?? link.title, exists: Boolean(live) };
}
