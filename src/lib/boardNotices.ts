// 1.174.0 (A4, P2 BCI-1 AR-2 VC-2 VC-3): one slot for the notes above the
// Board (mockups/board.html §1–3, §8). Only the first note present is shown
// whole; the others are one line, "2 more notes: … · Show", and Show opens
// them in the slot's order. When the first is answered, the next one rises.
//
// The order is fixed: something broken, a setup to decide, the project
// folder, areas found in the repository, then Next improvement — always
// last, so with any other note present it is only a name in the line.
// Pure: the components (BoardNotices.tsx) say which notes are present.
import type { ReactNode } from "react";

/** What a note is about, in the slot's order. */
export type BoardNoticeKind = "broken" | "setup" | "folder" | "areas" | "next-improvement";

export const BOARD_NOTICE_ORDER: readonly BoardNoticeKind[] = [
  "broken",
  "setup",
  "folder",
  "areas",
  "next-improvement",
];

/** A note present above the Board: who draws it, its kind, and the few
 *  words the "more notes" line names it by (lower case, mid-sentence). */
export type BoardNoticeEntry = {
  /** Stable per source ("adoption", "areas", "folder", "next-improvement"). */
  id: string;
  kind: BoardNoticeKind;
  summary: string;
};

/** A note as its component hands it to the slot: the entry and its body. */
export type BoardNoteView = BoardNoticeEntry & { body: ReactNode };

/** The notes in the slot's order; two of one kind keep the order given. */
export function orderNotices<T extends Pick<BoardNoticeEntry, "kind">>(notes: readonly (T | null | undefined)[]): T[] {
  const present = notes.filter((n): n is T => !!n);
  return present
    .map((n, i) => ({ n, i }))
    .sort((a, b) => BOARD_NOTICE_ORDER.indexOf(a.n.kind) - BOARD_NOTICE_ORDER.indexOf(b.n.kind) || a.i - b.i)
    .map(({ n }) => n);
}

/** "2 more notes: your project folder is behind GitHub · two products in
 *  this repository", or "1 more note: …"; null with nothing more. */
export function moreNotesLine(rest: readonly Pick<BoardNoticeEntry, "summary">[]): string | null {
  if (rest.length === 0) return null;
  const head = rest.length === 1 ? "1 more note" : `${rest.length} more notes`;
  return `${head}: ${rest.map((n) => n.summary).join(" · ")}`;
}

export const SHOW_MORE_NOTES = "Show";
export const SHOW_FEWER_NOTES = "Show fewer";
/** The slot's name for a screen reader (mockup: a region with a name). */
export const NOTES_REGION = "Notes about this project";

// ── The words each note is named by in the line ──────────────────────────

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** The adoption banner's states (`adoption.ts::BannerView`). */
export function adoptionSummary(view: {
  kind: "question" | "held" | "retry" | "offer" | "elsewhere" | "removed" | "declined" | "branchGone";
  title: string;
  uses?: readonly unknown[];
  move?: string;
}): string {
  switch (view.kind) {
    case "retry":
      return "the board didn't switch to GitHub Issues";
    case "question":
      return "sharing this project's setup";
    case "removed":
      return "the shared setup was removed";
    case "declined":
      return "the shared setup stays in its older file";
    case "branchGone":
      return lowerFirst(view.title);
    case "offer":
      return view.move === "Move them to GitHub Issues" ? "this Mac's local cards" : "the board on GitHub Issues";
    case "elsewhere":
      return (view.uses?.length ?? 0) > 1 ? "shared setups on GitHub" : "a shared setup on GitHub";
    case "held":
      return lowerFirst(view.title);
  }
}

/** The adoption banner's slot: a failed board switch is broken, the rest
 *  is a setup to decide. */
export function adoptionKind(
  kind: "question" | "held" | "retry" | "offer" | "elsewhere" | "removed" | "declined" | "branchGone",
): BoardNoticeKind {
  return kind === "retry" ? "broken" : "setup";
}

/** Areas that can't be used, or the products Plyloft found. */
export function areasSummary(problem: boolean, products = 2): string {
  if (problem) return "the areas can't be used";
  return `${COUNT[products] ?? String(products)} products in this repository`;
}

/** The project folder's state: the ask in the mockup's words, else its title. */
export function folderSummary(ask: boolean, title: string): string {
  return ask ? "your project folder is behind GitHub" : lowerFirst(title);
}

/** U31: the project's folder is gone. */
export const PROJECT_FOLDER_GONE_TITLE = "This project's folder isn't where Plyloft left it";
export const PROJECT_FOLDER_GONE_BODY =
  "The cards are what Plyloft read last, and none can start until the folder is back.";
export const PROJECT_FOLDER_GONE_SUMMARY = "this project's folder isn't where Plyloft left it";

export const NEXT_IMPROVEMENT_SUMMARY = "Next improvement";

function lowerFirst(s: string): string {
  const t = s.trim().replace(/[.?]$/, "");
  // A name at the start ("GitHub's main…", "main on this Mac…") keeps its case.
  if (/^[A-Z][a-z]+\b/.test(t) && !/^(GitHub|Plyloft|Claude|Codex)\b/.test(t)) {
    return t.charAt(0).toLowerCase() + t.slice(1);
  }
  return t;
}
