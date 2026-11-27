/**
 * CL-6: the Challenger's findings on the review diff — where each one is
 * drawn and what it says. Pure (no Tauri, no React), unit-tested under node
 * (`findingAnchors.test.ts`).
 *
 * The backend (`review_anchors.rs`) has already mapped each finding's line
 * from the revision its review read to the branch as it is now. Here a
 * finding goes under the diff line with that number (an added or unchanged
 * line of the card's version); one whose line the diff does not show goes
 * under its file's name; one on a file the diff does not show goes in a
 * group of its own. Findings without a line are not anchors: they stay in
 * the findings list only.
 */
import type { FindingAnchor, ReviewRound } from "../ipc.ts";
import type { DiffRow } from "./lineComments.ts";
import { dismissalWords, ledgerLine, severityWord } from "./challengerReview.ts";
import { roundFindingIds } from "./cardPage.ts";

export interface FilePlacement {
  /** Anchors drawn under a line, by the line's `DiffRow.order`. */
  byRow: Map<number, FindingAnchor[]>;
  /** This file's anchors whose line the diff doesn't show. */
  onFile: FindingAnchor[];
}

export interface AnchorPlacement {
  files: Map<string, FilePlacement>;
  /** Anchors on files the diff doesn't show. */
  elsewhere: FindingAnchor[];
}

const rank = (a: FindingAnchor) =>
  (a.state === "closed" || a.dismissed ? 100 : 0) +
  (a.nonBlocking ? 10 : 0) +
  (a.severity === "P1" ? 0 : a.severity === "P2" ? 1 : a.severity == null ? 2 : 3);
const idNumber = (a: FindingAnchor) => Number.parseInt(a.id.replace(/\D/g, ""), 10) || 0;

/** Open before closed, blocking before not, P1 first, then by id. */
export function sortAnchors(anchors: FindingAnchor[]): FindingAnchor[] {
  return [...anchors].sort((a, b) => rank(a) - rank(b) || idNumber(a) - idNumber(b));
}

/** Place every anchor: under its line, under its file, or elsewhere. */
export function placeAnchors(
  anchors: FindingAnchor[] | null | undefined,
  files: { path: string; rows: DiffRow[] }[],
): AnchorPlacement {
  const placement: AnchorPlacement = { files: new Map(), elsewhere: [] };
  for (const file of files) placement.files.set(file.path, { byRow: new Map(), onFile: [] });
  for (const anchor of sortAnchors(anchors ?? [])) {
    const file = files.find((f) => f.path === anchor.path);
    const spot = placement.files.get(anchor.path);
    if (!file || !spot) {
      placement.elsewhere.push(anchor);
      continue;
    }
    const row =
      anchor.line == null || anchor.fate === "unknown" || anchor.fate === "file-removed"
        ? undefined
        : file.rows.find((r) => r.kind !== "del" && r.kind !== "meta" && r.newLine === anchor.line);
    if (!row) {
      spot.onFile.push(anchor);
      continue;
    }
    const under = spot.byRow.get(row.order) ?? [];
    under.push(anchor);
    spot.byRow.set(row.order, under);
  }
  return placement;
}

/** "F3 · P2 — Title" ("F3 · P2 — pre-existing — Title"), as the findings
 *  list names it. */
export function anchorTitle(anchor: FindingAnchor): string {
  return ledgerLine({ ...anchor, preExisting: anchor.preExisting ?? false });
}

export function anchorStateWord(anchor: FindingAnchor): string {
  // Tier 4 walk 2026-10-14: a dismissed finding is not "Open", whatever
  // the ledger's state says (a dismissal is kept apart from the state).
  if (anchor.dismissed) return "Dismissed";
  switch (anchor.state) {
    case "closed":
      return "Closed";
    case "still-open":
      return "Still open";
    default:
      return "Open";
  }
}

/** "Raised in round 1 · still open after round 2: why". */
export function anchorStateLine(anchor: FindingAnchor): string {
  const raised = `Raised in round ${anchor.round}`;
  const why = anchor.reason?.trim() ? `: ${anchor.reason.trim()}` : "";
  if (anchor.dismissed) return `${raised} · ${dismissalWords(anchor.dismissal ?? {})}`;
  switch (anchor.state) {
    case "closed":
      return `${raised} · closed in round ${anchor.updatedRound}${why}`;
    case "still-open":
      return `${raised} · still open after round ${anchor.updatedRound}${why}`;
    default:
      return anchor.nonBlocking ? `${raised} · non-blocking` : raised;
  }
}

/** Open findings that ask for changes show their text; P3s, other
 *  non-blocking findings (pre-existing ones, notes) and closed ones start
 *  collapsed to one line (owner's decision, 2026-10-01). */
export function anchorOpenByDefault(anchor: FindingAnchor): boolean {
  return anchor.state !== "closed" && !anchor.dismissed && !anchor.nonBlocking && anchor.severity !== "P3";
}

/** What happened to the line since the review, in words; null when it is
 *  the same line. */
export function anchorFateNote(anchor: FindingAnchor): string | null {
  const was = `It was line ${anchor.reviewedLine}.`;
  switch (anchor.fate) {
    case "same":
      return null;
    case "moved":
      return `Was line ${anchor.reviewedLine} at the review.`;
    case "changed":
      return `This line changed since the review. ${was}`;
    case "removed":
      return `This line was removed since the review. ${was}`;
    case "file-removed":
      return `This file was removed since the review. ${was}`;
    default:
      return `This line may have changed since the review. ${was}`;
  }
}

/** For an anchor under its file's name: where its line is, when known. */
export function anchorWhere(anchor: FindingAnchor): string | null {
  if (anchor.line == null || anchor.fate === "unknown" || anchor.fate === "file-removed") return null;
  return `Line ${anchor.line}, outside the lines this diff shows.`;
}

/** The anchor's accessible name. */
export function anchorLabel(anchor: FindingAnchor): string {
  const where = anchor.line != null && anchor.fate !== "unknown" ? `, line ${anchor.line}` : "";
  return `Reviewer finding ${anchor.id}, ${severityWord(anchor.severity).toLowerCase()}, ${anchorStateWord(anchor).toLowerCase()}${where}`;
}

/** SP-6: one choice of the round switch above the diff — a review round
 *  and the finding ids it stored (raised, closed or still open in it). */
export interface RoundChoice {
  round: number;
  ids: string[];
}

/** SP-6: the rounds the switch offers, oldest first: those whose findings
 *  the ledger still keeps (Activity's "See its findings" rule). */
export function roundChoices(rounds: readonly ReviewRound[] | null | undefined): RoundChoice[] {
  const list = rounds ?? [];
  let restart = -1;
  list.forEach((r, i) => {
    if (r.ledgerRestart) restart = i;
  });
  return list
    .map((r, i) => ({ round: r.round, ids: roundFindingIds(r, i < restart) }))
    .filter((c) => c.ids.length > 0);
}

/** SP-6: the anchors a round's view draws — its findings only; all of them
 *  when no round is chosen. */
export function anchorsOfRound(anchors: FindingAnchor[] | null | undefined, ids: readonly string[] | null): FindingAnchor[] {
  const all = anchors ?? [];
  if (!ids) return all;
  const keep = new Set(ids);
  return all.filter((anchor) => keep.has(anchor.id));
}

/** SP-6: the line above a round's view of the diff. */
export function roundViewWords(round: number, shown: number): string {
  const lead = `Findings raised or closed in round ${round}`;
  if (shown === 0) return `${lead}: none of them is in these changes.`;
  return shown === 1 ? `${lead}: 1 is under the line it names.` : `${lead}: ${shown} are under the lines they name.`;
}
