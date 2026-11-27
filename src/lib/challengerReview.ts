import { showBackendText } from "./backendMarks.ts";
import { codexScreenHelp, codexScreenNeedsPress } from "./builderInject.ts";
import type {
  BlockingThreshold,
  BuilderReview,
  CardPresentationState,
  FindingDismissal,
  KanbanCard,
  LedgerFinding,
  ReviewFinding,
  SkillFollowed,
} from "../ipc.ts";
import type { CardStatePresentation } from "./cardLifecycle.ts";
import { verdictNeedsSending } from "./verdictDelivery.ts";
import { modelSentenceWords } from "./roleModels.ts";
import { deliveryFor, type HandedOverDelivery } from "./handedOverDelivery.ts";
import { reviewerWords } from "./words.ts";
import { APPROVED_WORD, SHIP_ANYWAY_LABEL, SHIP_WITH_FOLLOW_UP_LABEL, OVERRIDDEN_WORD, SMALL_NOTE_MARK, smallNotesWords } from "./deliveryWords.ts";
import {
  VERDICT_ACK_ATTEMPTS,
  verdictDeliveryFor,
  type VerdictDelivery,
} from "./verdictDelivery.ts";

/**
 * GH #58: how a Challenger review of a build snapshot is presented. Pure,
 * so the Run head chip, Outcome and the Builder injection agree.
 *
 * `incomplete` — the reviewer could not see enough of the change to judge
 * it — is its own outcome, never "changes requested": it does not keep the
 * card on Run and does not block Ship, and "Review again in passes" re-runs
 * it in smaller passes (the way out that is not #41's override).
 */

export type ReviewTone = "ok" | "flag" | "running" | "muted";

export function reviewerName(review: Pick<BuilderReview, "provider">): string {
  return review.provider === "codex" ? "Codex" : "Claude";
}

/** OB-14 (§13.2): the review property's tooltip when only one vendor is
 *  installed — a separate session of the same vendor reviewed the build. */
export function singleVendorReviewTip(review: Pick<BuilderReview, "provider">): string {
  const who = reviewerName(review);
  const other = review.provider === "codex" ? "Claude Code" : "Codex";
  return `Reviewed by a separate ${who} session. With ${other} too, reviews come from an independent AI.`;
}

/** The review is done and incomplete. */
export function reviewIncomplete(review: BuilderReview | null | undefined): boolean {
  return review?.status === "done" && review.verdict === "incomplete";
}

/** Same rule as builder.rs::review_can_run_again. */
export function reviewCanRunAgain(review: BuilderReview | null | undefined): boolean {
  if (!review) return false;
  return (
    review.status === "failed" ||
    (review.status === "done" &&
      (review.verdict == null || review.verdict === "incomplete")) ||
    // GH #99 (review 9): an override with a failed pass left files unread.
    (review.status === "skipped" && Boolean(review.note) && (review.failedPasses ?? 0) > 0)
  );
}

/** "Review again in passes" for an incomplete or verdict-less review,
 *  "Review again" for a failed one. */
export function reviewAgainLabel(review: BuilderReview): string {
  return review.status === "failed" || (review.failedPasses ?? 0) > 0
    ? "Review again"
    : "Review again in passes";
}

/** "29 files, reviewed in 3 passes", or null before passes existed. #74:
 *  names the model when the Challenger row set one ("… by sonnet"), the
 *  same sentence `review_passes.rs::coverage_line` writes. */
export function reviewCoverage(
  review: Pick<BuilderReview, "passCount" | "fileCount" | "model" | "synthesisPass">,
): string | null {
  const passes = review.passCount;
  const files = review.fileCount;
  if (passes == null || files == null) return null;
  const words = modelSentenceWords(review.model);
  const model = words ? ` by ${words}` : "";
  const synthesis = review.synthesisPass ? " and a synthesis pass" : "";
  return `${files} file${files === 1 ? "" : "s"}, reviewed in ${passes} pass${passes === 1 ? "" : "es"}${synthesis}${model}`;
}

// ── ADR 0006: the sweep ──────────────────────────────────────────────────
//
// The first review of a card is a sweep: it reads the brief, the rules and
// the Verify result, walks the risk checklist and may take 15 minutes, so
// the Run step says so and a long wait is not read as a hang. Findings carry
// a severity: P1 and P2 are what the verdict is about; P3 and pre-existing
// ones never block and never start a round.

/** Every pass of a sweep (and its synthesis pass) may take 15 minutes. */
export const SWEEPING_TEXT = "Reviewer sweeping — first review, up to 15 min per pass";

export function isSweep(review: Pick<BuilderReview, "kind"> | null | undefined): boolean {
  return review?.kind === "sweep";
}

/** QoL 1.168 block 8 (A4): a finding's severity in words — never the code
 *  ("P1 · 2 findings"). The codes stay in what the agents read. */
export function severityWord(severity: string | null | undefined): string {
  switch (severity) {
    case "P1":
      return "Serious";
    case "P2":
      return "Should fix";
    case "P3":
      return "Minor";
    case null:
    case undefined:
    case "Unrated":
      return "Unrated";
    default:
      return severity;
  }
}

/** "F3 · Serious — pre-existing — Title (pass 2 of 3)", one line; the id
 *  once the card's ledger gave it one. */
export function findingLine(finding: ReviewFinding): string {
  const id = finding.id ? `${finding.id} · ` : "";
  const severity = severityWord(finding.severity);
  const mark = finding.preExisting ? " — pre-existing" : "";
  const pass = finding.pass ? ` (${finding.pass})` : "";
  return `${id}${severity}${mark} — ${finding.title}${pass}`;
}

// ── ADR 0006: follow-up reviews and the findings ledger ──────────────────
//
// Every review after the sweep is a follow-up: it re-checks the open
// findings by id and reads only the fixes. The card shows the ledger —
// open findings first, closed ones collapsed, each with the round that
// raised it — and the Builder gets only what is still open and what is new.

/** Same rule as review_ledger.rs::LedgerFinding::blocks: by default P1 and
 *  P2 in code the change wrote; the workspace's threshold where the last
 *  review read it differently (`blocking`); never once dismissed. */
export function ledgerFindingBlocks(finding: LedgerFinding): boolean {
  if (finding.dismissal) return false;
  return finding.blocking ?? (!finding.preExisting && !finding.note && finding.severity !== "P3");
}

/** Findings filter: the member dismissed it as not a real issue. */
export function ledgerFindingDismissed(finding: LedgerFinding): boolean {
  return Boolean(finding.dismissal);
}

/** Findings filter: the mark after an open finding's line — "Small note ·
 *  nothing to do" below the workspace's threshold (or a P3, a note, a
 *  pre-existing one; 1.171.0 C3: it needs nothing done to ship),
 *  "Dismissed" once the member dismissed it, nothing while it blocks or
 *  after a review closed it. */
export function ledgerFindingMark(finding: LedgerFinding): string | null {
  if (finding.dismissal) return "Dismissed";
  if (finding.state === "closed") return null;
  return ledgerFindingBlocks(finding) ? null : SMALL_NOTE_MARK;
}

/** Findings filter: `Findings that block approval`, as Settings offers it. */
export const BLOCKING_CHOICES: { value: BlockingThreshold; label: string }[] = [
  { value: "p1", label: "Serious only" },
  { value: "p1-p2", label: "Serious and Should fix" },
  { value: "all", label: "All findings" },
];

/** Findings filter: the row's line under each choice. */
export function blockingFindingsHint(threshold: BlockingThreshold): string {
  const what =
    threshold === "p1"
      ? "Only serious findings keep a card in changes requested; Should fix and Minor ones stay on the card as small notes, with nothing to do."
      : threshold === "all"
        ? "Every finding in code the card wrote keeps it in changes requested, Minor ones included."
        : "Serious and Should fix findings keep a card in changes requested; Minor ones stay on the card as small notes, with nothing to do.";
  return `${what} Pre-existing findings never block. Applies from the next review, on this Mac.`;
}

/** A one-line dismissal reason as the backend keeps it (300 characters). */
export const DISMISS_REASON_MAX_CHARS = 300;

/** Same rule as review_ledger.rs::LedgerFinding::is_open. */
export function ledgerFindingOpen(finding: LedgerFinding): boolean {
  return finding.state !== "closed" && !finding.dismissal;
}

/** 1.171.0 C1 (CF1): how many findings a request for changes asks the
 *  Builder to fix — the ledger's open ones that block, or (a review from
 *  before the ledger) its findings in code the change wrote. 0: none known. */
export function findingsToFixCount(review: Pick<BuilderReview, "ledger" | "findings"> | null | undefined): number {
  if (!review) return 0;
  const ledger = review.ledger ?? [];
  if (ledger.length > 0) return ledger.filter((f) => ledgerFindingOpen(f) && ledgerFindingBlocks(f)).length;
  return (review.findings ?? []).filter((f) => !f.preExisting).length;
}

/** 1.171.0 C3 (CF25): a review's small notes — the findings open that
 *  don't block (the ledger's), or before the ledger its non-blocking list.
 *  `approvedWord` counts them: "Approved (2 small notes)". */
export function smallNotesCount(review: Pick<BuilderReview, "ledger" | "nonBlocking"> | null | undefined): number {
  if (!review) return 0;
  const ledger = review.ledger ?? [];
  if (ledger.length > 0) return ledger.filter((f) => ledgerFindingOpen(f) && !ledgerFindingBlocks(f)).length;
  return (review.nonBlocking ?? []).length;
}

/** 1.172.0 walk (E1): a review's small notes, said with where they come
 *  from when an earlier round raised them. A note is never re-asked by a
 *  follow-up (only blocking findings are, `review_ledger::open_blocking`),
 *  so a round-1 note stays open — truthfully counted, but named as round
 *  1's: "1 small note from round 1", "3 small notes, 1 from round 1",
 *  "2 small notes from earlier rounds". Null without notes. */
export function smallNotesPhrase(
  review: Pick<BuilderReview, "ledger" | "nonBlocking" | "round"> | null | undefined,
): string | null {
  const all = smallNotesCount(review);
  if (!review || all === 0) return null;
  const latest = review.round?.round ?? 0;
  const ledger = review.ledger ?? [];
  if (latest <= 1 || ledger.length === 0) return smallNotesWords(all);
  const earlier = ledger.filter(
    (f) => ledgerFindingOpen(f) && !ledgerFindingBlocks(f) && f.round < latest && (f.updatedRound ?? f.round) < latest,
  );
  if (earlier.length === 0) return smallNotesWords(all);
  const rounds = [...new Set(earlier.map((f) => f.round))];
  const from = rounds.length === 1 ? `round ${rounds[0]}` : "earlier rounds";
  return earlier.length === all ? `${smallNotesWords(all)} from ${from}` : `${smallNotesWords(all)}, ${earlier.length} from ${from}`;
}

/** "Approved", "Approved (1 small note)", "Approved (1 small note from
 *  round 1)": the one approval word for a review (`smallNotesPhrase`). */
export function reviewApprovedWord(
  review: Pick<BuilderReview, "ledger" | "nonBlocking" | "round"> | null | undefined,
): string {
  const notes = smallNotesPhrase(review);
  return notes ? `${APPROVED_WORD} (${notes})` : APPROVED_WORD;
}

/** The ledger as the card shows it: open findings first (blocking before
 *  non-blocking, P1 first, then by id), closed and dismissed ones apart. */
export function ledgerSections(ledger: LedgerFinding[] | null | undefined): {
  open: LedgerFinding[];
  closed: LedgerFinding[];
  dismissed: LedgerFinding[];
} {
  const rank = (f: LedgerFinding) =>
    (ledgerFindingBlocks(f) ? 0 : 10) + (f.severity === "P1" ? 0 : f.severity === "P2" ? 1 : f.severity == null ? 2 : 3);
  const number = (f: LedgerFinding) => Number.parseInt(f.id.replace(/\D/g, ""), 10) || 0;
  const all = [...(ledger ?? [])];
  return {
    open: all
      .filter(ledgerFindingOpen)
      .sort((a, b) => rank(a) - rank(b) || number(a) - number(b)),
    closed: all
      .filter((f) => f.state === "closed" && !ledgerFindingDismissed(f))
      .sort((a, b) => number(a) - number(b)),
    dismissed: all.filter(ledgerFindingDismissed).sort((a, b) => number(a) - number(b)),
  };
}

/** CL-5: the findings a review round touched, by the ids the round stored
 *  when the ledger folded it — raised in it, closed by it, or still open
 *  after it. Findings the ledger has since pruned are gone. */
export function ledgerOfIds(ledger: LedgerFinding[] | null | undefined, ids: readonly string[]): LedgerFinding[] {
  const wanted = new Set(ids);
  return (ledger ?? []).filter((f) => wanted.has(f.id));
}

/** "F3 · P2 — Title", one line. */
export function ledgerLine(finding: Pick<LedgerFinding, "id" | "severity" | "preExisting" | "title">): string {
  const mark = finding.preExisting ? " — pre-existing" : "";
  return `${finding.id} · ${severityWord(finding.severity)}${mark} — ${finding.title}`;
}

/** Tier 4 walk 2026-10-14: "dismissed by ana@example.com as not a real
 *  issue: why" — who dismissed it, when the board recorded them
 *  (`Dismissal.by`), and their reason. The diff's anchors say the same. */
export function dismissalWords(dismissal: Pick<FindingDismissal, "by" | "reason">): string {
  const by = dismissal.by?.trim();
  const reason = dismissal.reason?.trim();
  return `dismissed${by ? ` by ${by}` : ""} as not a real issue${reason ? `: ${reason}` : ""}`;
}

/** "Raised in round 1 · still open: why", "Raised in round 1 · closed in
 *  round 3: why". */
export function ledgerStateLine(finding: LedgerFinding): string {
  // ADR 0006 (third card): the follow-up says the sweep had read this code.
  const raised = `Raised in round ${finding.round}${finding.sweepSaw ? " (in code the sweep read)" : ""}`;
  const why = finding.reason?.trim() ? `: ${finding.reason.trim()}` : "";
  if (finding.dismissal) return `${raised} · ${dismissalWords(finding.dismissal)}`;
  switch (finding.state) {
    case "closed":
      return `${raised} · closed in round ${finding.updatedRound}${why}`;
    case "still-open":
      return `${raised} · still open after round ${finding.updatedRound}${why}`;
    default:
      return raised;
  }
}

export function isFollowUp(review: Pick<BuilderReview, "kind"> | null | undefined): boolean {
  return review?.kind === "follow-up";
}

/** A follow-up keeps the review's 10-minute limit. */
/** GH #124: while a Build done waits for the running review of the same
 *  card — "Challenger reviewing snapshot 1 — snapshot 2 is reviewed next".
 *  null when nothing waits. */
export function waitingReviewText(builder: KanbanCard["builder"] | null | undefined): string | null {
  const waiting = builder?.waitingReview;
  if (!waiting) return null;
  const review = builder?.review;
  return review?.status === "running" && review.snapshotN !== waiting.snapshotN
    ? // 1.171.0 C2 (CF10): no round numbers on the card.
      "The Reviewer is reviewing an earlier version; this one is reviewed next."
    : "This version is reviewed next. Finish and check starts its review.";
}

export function followingUpText(review: BuilderReview): string {
  const open = (review.ledger ?? []).filter((f) => ledgerFindingOpen(f) && ledgerFindingBlocks(f)).length;
  return open > 0
    ? `Reviewer following up — re-checking ${open} open finding${open === 1 ? "" : "s"} and the fixes`
    : "Reviewer following up — checking the fixes";
}

/** Same as review_ledger.rs::SHIP_WITH_FOLLOW_UP_FROM. */
export const SHIP_WITH_FOLLOW_UP_FROM = 4;
/** 1.171.0 B3 (CP-14): beside the findings, "Ship now, fix these in a new
 *  card" (`deliveryWords.ts`). It ships as Ship it would, never merging by
 *  itself. */
export { SHIP_WITH_FOLLOW_UP_LABEL };
/** The pull request route of the same offer, on a project kept on this Mac
 *  that can take one: the pull request's body names the new card. */
export const SHIP_PR_WITH_FOLLOW_UP_LABEL = "Open the pull request now, fix these in a new card";

/** ADR 0006: whether the Ship step offers `Ship with follow-up` — the same
 *  rule as commands.rs::follow_up_refusal: the Challenger requests changes
 *  on the last snapshot, for the fourth time or more, with findings open
 *  and no P1 among them. `openCount` is what the new card would carry. */
export function shipWithFollowUpOffer(builder: KanbanCard["builder"] | null | undefined): {
  offered: boolean;
  openCount: number;
  openP1: string[];
} {
  const review = builder?.review;
  const last = builder?.snapshots[builder.snapshots.length - 1];
  const ledger = review?.ledger ?? [];
  const open = ledger.filter((f) => ledgerFindingOpen(f) && !f.preExisting);
  const openP1 = open.filter((f) => f.severity === "P1").map((f) => f.id);
  const requesting =
    review?.status === "done" &&
    review.verdict === "changes_requested" &&
    last != null &&
    review.snapshotN === last.n;
  const offered =
    requesting &&
    (builder?.changesRequestedCount ?? 0) >= SHIP_WITH_FOLLOW_UP_FROM &&
    open.some(ledgerFindingBlocks) &&
    openP1.length === 0;
  return { offered, openCount: open.length, openP1 };
}

/** The Ship step's helper beside the offer, in the §6 voice. */
export function shipWithFollowUpHelper(builder: KanbanCard["builder"] | null | undefined): string | null {
  const offer = shipWithFollowUpOffer(builder);
  const rounds = builder?.changesRequestedCount ?? 0;
  if (offer.offered) {
    return `After ${rounds} rounds with the Reviewer, ${offer.openCount} finding${offer.openCount === 1 ? " is" : "s are"} still open. “${SHIP_WITH_FOLLOW_UP_LABEL}”, beside the findings, ships this card and makes them one new card.`;
  }
  if (rounds >= SHIP_WITH_FOLLOW_UP_FROM && offer.openP1.length > 0) {
    return `${offer.openP1.join(", ")} ${offer.openP1.length === 1 ? "is serious" : "are serious"}: this card can't ship with ${offer.openP1.length === 1 ? "it" : "them"} open.`;
  }
  return null;
}

/** "Shipped with 2 open findings: #140" — the PR body line. */
export function followUpShippedLine(followUp: { cardRef: string; findingIds: string[] }): string {
  const n = followUp.findingIds.length;
  return `Shipped with ${n} open finding${n === 1 ? "" : "s"}: ${followUp.cardRef}`;
}

/** The blocking findings grouped by severity, P1 first, for the card. */
export function findingsBySeverity(
  findings: ReviewFinding[] | null | undefined,
): Array<{ severity: string; findings: ReviewFinding[] }> {
  const order = ["P1", "P2", "Unrated"];
  const groups = new Map<string, ReviewFinding[]>();
  for (const finding of findings ?? []) {
    const key = finding.severity === "P1" || finding.severity === "P2" ? finding.severity : "Unrated";
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return order
    .filter((severity) => groups.has(severity))
    .map((severity) => ({ severity, findings: groups.get(severity)! }));
}

/** What `Make a card` fills in for a pre-existing finding: its title, and
 *  the finding as the brief. */
export function findingCardDraft(
  finding: ReviewFinding,
  source: { cardTitle: string; snapshotN: number },
): { title: string; notes: string } {
  const title = finding.title.trim() || "Pre-existing defect found by the Reviewer";
  const notes = [
    `The Reviewer found this in code that "${source.cardTitle}" did not write (sweep of round ${source.snapshotN}). It was not a blocker for that card.`,
    "",
    finding.body.trim(),
  ].join("\n");
  return { title: title.length > 120 ? `${title.slice(0, 119)}…` : title, notes };
}

function findingsBlock(findings: ReviewFinding[]): string {
  return findings.map((finding) => `- ${finding.body.trim().replace(/\n/g, "\n  ")}`).join("\n\n");
}

/** The non-blocking findings as the Builder gets them: optional. */
function nonBlockingBlock(review: BuilderReview): string {
  const notes = review.nonBlocking ?? [];
  if (notes.length === 0) return "";
  return `\n\nNon-blocking (optional, do not start a round for these; pre-existing ones are in code this change did not write):\n\n${findingsBlock(notes)}`;
}

/** P-D2 (Challenger): the reason of an incomplete review in the person's
 *  words. Rust records "diff too large" (`review_passes.rs`, `builder.rs`)
 *  and the agent-facing `[Plyloft]` message keeps it; what a person reads
 *  says "the changes". Other reasons ("X failed", "no verdict in X") are
 *  shown as they are. */
export function incompleteReasonWords(reason: string | null | undefined): string {
  if (!reason || reason === "diff too large") return "the changes were too large";
  // G2: a reason saved before 1.173.0 names the Reviewer by its old name.
  return reviewerWords(reason);
}

export function reviewChip(review: BuilderReview): { text: string; tone: ReviewTone } {
  const who = reviewerName(review);
  if (review.status === "running" && review.retryAt != null) {
    return { text: RETRYING_TEXT, tone: "muted" };
  }
  if (review.status === "running" && isSweep(review)) {
    return { text: SWEEPING_TEXT, tone: "running" };
  }
  if (review.status === "running" && isFollowUp(review)) {
    return { text: followingUpText(review), tone: "running" };
  }
  if (review.status === "running") {
    return {
      text: review.retried ? `Reviewer ${who} reviewing again…` : `Reviewer ${who} reviewing…`,
      tone: "running",
    };
  }
  if (review.status === "skipped") {
    return { text: review.note ? OVERRIDDEN_WORD : "Review skipped", tone: "muted" };
  }
  if (review.status === "failed") {
    return { text: NOT_REVIEWED_HEADLINE, tone: "flag" };
  }
  switch (review.verdict) {
    case "approve":
      return { text: `Reviewer ${who}: ${reviewApprovedWord(review)}`, tone: "ok" };
    case "changes_requested":
      return { text: `Reviewer ${who}: changes requested`, tone: "flag" };
    case "incomplete":
      return {
        text: `Review incomplete (${incompleteReasonWords(review.incompleteReason)})`,
        tone: "flag",
      };
    default:
      return { text: `Reviewer ${who}: no verdict`, tone: "muted" };
  }
}

/** GH #99 (review 3): the Run chip tells the same truth as the header and
 *  Outcome — a stale approval is not shown as the card's verdict. */
export function reviewChipForTruth(
  review: BuilderReview,
  truth: ReviewTruth,
): { text: string; tone: ReviewTone } {
  if (truth.kind === "not-reviewed") return { text: truth.headline, tone: "flag" };
  return reviewChip(review);
}

/** The message sent into the open Builder session when a review settles.
 *  null when nothing is sent (still running, skipped). */
export function reviewSettledMessage(
  review: BuilderReview,
  /** GH #129: the snapshot whose request for changes a hand-over left
   *  unsent — then something is still needed from the Builder. */
  owedSnapshotN?: number | null,
): string | null {
  const owedNote =
    owedSnapshotN != null
      ? ` The changes the Reviewer requested on snapshot ${owedSnapshotN} are still open and have not been sent to you yet; the human sends them with Back to the Builder.`
      : "";
  const who = reviewerName(review);
  // OB-14 (§13.2): one AI installed is a normal setup, not a fault.
  const degraded = review.singleVendor
    ? ` (a separate ${who} session)`
    : review.degraded
      ? " (same-AI review: the other AI wasn't available)"
      : "";
  const n = review.snapshotN;
  if (review.status === "done" && review.verdict === "changes_requested") {
    // ADR 0006: the blocking findings are the changes requested; the
    // non-blocking ones travel as optional. A review Ply could not read
    // findings from still sends the reviewer's own words.
    // When a pass wrote findings Ply could not read into the list, the
    // reviewer's own words travel with it, so no defect is left behind.
    // The backend's handoff carries every blocking finding complete, past
    // the card's display caps; the rest is for reviews recorded before it.
    const blocking = review.findings ?? [];
    const excerpt = (review.excerpt ?? "").trim();
    const handoff = review.builderHandoff?.trim();
    const requested = handoff
      ? handoff
      : blocking.length === 0
        ? excerpt
        : review.findingsUnread && excerpt
          ? `${findingsBlock(blocking)}\n\nPly could not read every finding into the list above. The review in the Reviewer's own words:\n\n${excerpt}`
          : findingsBlock(blocking);
    const notes = !handoff && blocking.length > 0 ? nonBlockingBlock(review) : "";
    const kind = isSweep(review) ? "swept" : isFollowUp(review) ? "followed up on" : "reviewed";
    const fellBack = review.followUpFallback
      ? ` It ran as a sweep instead of a follow-up: ${review.followUpFallback}`
      : "";
    const byId = (review.ledger?.length ?? 0) > 0 ? " Each finding carries its id; answer by id." : "";
    return `[Plyloft] The Reviewer (${who}${degraded}) ${kind} snapshot ${n} read-only and requests changes.${fellBack}${byId}\n\n${requested}${notes}\n\nAddress what is valid, push back in one line on what is not, then stop: Plyloft checks your fixes when you are done.`;
  }
  if (review.status === "done" && review.verdict === "incomplete") {
    return `[Plyloft] The Reviewer (${who}${degraded}) could not review all of snapshot ${n} (${review.incompleteReason ?? "diff too large"}), so it neither approved nor requested changes.${owedNote ? `${owedNote} The` : " Nothing is needed from you; the"} human can run the review again in passes. Please do not edit files meanwhile.`;
  }
  if (review.status === "done" && review.verdict === "approve" && review.ledgerNote?.startsWith("Plyloft reads this review as APPROVE")) {
    // Findings filter: the approval is Plyloft's reading (the workspace's
    // threshold, or a finding the member dismissed), not the reviewer's word.
    return `[Plyloft] The Reviewer (${who}${degraded}) reviewed snapshot ${n}. ${review.ledgerNote} Nothing else is needed from you unless verification failed; leave the code as it is for those findings.${nonBlockingBlock(review)}`;
  }
  if (review.status === "done") {
    return `[Plyloft] The Reviewer (${who}${degraded}) reviewed snapshot ${n} and ${review.verdict === "approve" ? "approved it" : "returned no parseable verdict"}. Nothing else is needed from you unless verification failed.${nonBlockingBlock(review)}`;
  }
  if (review.status === "failed") {
    const tried = review.retried ? " Plyloft already tried once more." : "";
    return `[Plyloft] The Reviewer could not review snapshot ${n}: ${failureReason(review)}${tried} The last commit was not reviewed; the human can review again or ship anyway.${owedNote || " Nothing is needed from you."}`;
  }
  return null;
}

// ── GH #99: the last commit was not reviewed ─────────────────────────────
//
// Card #91 shipped as PR #97 with its last commit never reviewed: the second
// review died on "Selected model is at capacity" and nothing on the way said
// so. A verdict belongs to the revision it read; when the branch tip is newer
// than the last completed review, or the last review failed, the card says
// so wherever it shows a verdict, and never blocks Ship.

/** Seconds before the one automatic retry (review_failure.rs). */
export const RETRY_DELAY_SECS = 30;
export const RETRYING_TEXT = `Reviewer unavailable — trying again in ${RETRY_DELAY_SECS} s`;
export const NOT_REVIEWED_HEADLINE = "The last commit was not reviewed";

/** "1 of 3 review passes failed (the synthesis pass)." — the count includes
 *  a sweep's synthesis pass, and names the passes when the record does. */
export function failedPassesLine(
  review: Pick<BuilderReview, "passCount" | "synthesisPass" | "failedPassNames">,
  failedPasses: number,
): string {
  const total = (review.passCount ?? failedPasses) + (review.synthesisPass ? 1 : 0);
  const names = review.failedPassNames ?? [];
  return `${failedPasses} of ${Math.max(total, failedPasses)} review passes failed${
    names.length > 0 ? ` (${names.join(", ")})` : ""
  }.`;
}

/** A failed review's reason in words; reviews before GH #99 carry none. */
export function failureReason(review: Pick<BuilderReview, "failureReason">): string {
  // G2: a reason saved before 1.173.0 names the Reviewer by its old name.
  return reviewerWords(review.failureReason?.trim()) || "The Reviewer could not finish the review.";
}

export function commitsSinceLine(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"} since the last review`;
}

export type ReviewTruth =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "retrying"; text: string; reason: string }
  | { kind: "skipped" }
  /** The card's verdict stands for its tip. */
  | { kind: "reviewed" }
  | {
      kind: "not-reviewed";
      /** `failed`: the last review failed. `moved`: commits were made after
       *  the review that stands. */
      cause: "failed" | "moved";
      headline: string;
      reason: string;
      /** "N commits since the last review", when a completed review exists
       *  and the count is known. */
      commitsLine: string | null;
      /** The raw error, for Details. */
      details: string | null;
      /** How "Review again" gets there: re-run the review of the last build
       *  snapshot, or — when the tip moved past it — Build done, which
       *  snapshots the new commits and reviews them. */
      action: "review-again" | "build-done";
    };

export interface ReviewTruthInput {
  builder: KanbanCard["builder"] | null | undefined;
  /** The branch tip as Outcome read it live; absent → the last snapshot. */
  branchTip?: string | null;
  /** Commits since the last completed review, read live; absent → the
   *  failed review's recorded count. */
  commitsSinceReview?: number | null;
}

/** Pure: whether the card's tip was reviewed, from the last review record's
 *  status, the revision it read and the branch tip. */
export function reviewTruth(input: ReviewTruthInput): ReviewTruth {
  const builder = input.builder;
  const review = builder?.review;
  if (!builder || !review) return { kind: "none" };
  if (review.status === "running") {
    return review.retryAt != null
      ? { kind: "retrying", text: RETRYING_TEXT, reason: failureReason(review) }
      : { kind: "running" };
  }
  // Review 8: an override accepts the pushback on the findings, not the
  // files a failed pass never read; a plain skip keeps its meaning.
  const overriddenWithFailedPasses =
    review.status === "skipped" && Boolean(review.note) && (review.failedPasses ?? 0) > 0;
  if (review.status === "skipped" && !overriddenWithFailedPasses) return { kind: "skipped" };

  const snapshots = builder.snapshots;
  const last = snapshots[snapshots.length - 1] ?? null;
  const tip = input.branchTip ?? last?.sha ?? null;
  const action: "review-again" | "build-done" =
    input.branchTip != null && last != null && input.branchTip !== last.sha
      ? "build-done"
      : "review-again";
  const liveCount = input.commitsSinceReview;
  const everCompleted = Boolean(builder.lastReviewedRevision);

  if (review.status === "failed") {
    const n = liveCount ?? review.commitsSinceReview ?? null;
    return {
      kind: "not-reviewed",
      cause: "failed",
      headline: NOT_REVIEWED_HEADLINE,
      reason: failureReason(review),
      commitsLine: everCompleted && n != null && n > 0 ? commitsSinceLine(n) : null,
      details: showBackendText(review.error)?.trim() || null,
      action,
    };
  }

  // Done, but some passes failed after their retry: those files were not
  // reviewed. A standing request for changes still leads (the card is on
  // Run); the PR body line covers it at Ship.
  const failedPasses = review.failedPasses ?? 0;
  if (
    failedPasses > 0 &&
    (overriddenWithFailedPasses || review.verdict !== "changes_requested")
  ) {
    const n = liveCount ?? review.commitsSinceReview ?? null;
    return {
      kind: "not-reviewed",
      cause: "failed",
      headline: NOT_REVIEWED_HEADLINE,
      reason: `${failedPassesLine(review, failedPasses)} ${failureReason(review)}`,
      commitsLine: everCompleted && n != null && n > 0 ? commitsSinceLine(n) : null,
      details: showBackendText(review.error)?.trim() || null,
      action,
    };
  }

  // Done: the verdict belongs to the revision the review read.
  const read =
    review.reviewedRevision ??
    snapshots.filter((s) => s.n === review.snapshotN).pop()?.sha ??
    null;
  const sameSnapshot = last == null || last.n === review.snapshotN;
  const moved = (read != null && tip != null && read !== tip) || !sameSnapshot;
  if (!moved) return { kind: "reviewed" };
  const n = liveCount ?? null;
  return {
    kind: "not-reviewed",
    cause: "moved",
    headline: n != null && n > 0 ? commitsSinceLine(n) : NOT_REVIEWED_HEADLINE,
    reason: "Commits were made after the Reviewer's last review.",
    commitsLine: null,
    details: null,
    action,
  };
}

/** GH #99: the card-state header and the Board chip tell the same truth.
 *  Returns the presentation to use instead of `base` for a Builder card
 *  whose review is waiting to retry, or whose tip was not reviewed; null
 *  keeps `base`. Ship stays the primary action — it is never blocked. */
export function reviewTruthPresentation(
  state: CardPresentationState,
  base: CardStatePresentation,
  truth: ReviewTruth,
  /** QoL 1.168 (C5): the failed review can run again on the last build
   *  (`reviewCanRunAgain`, on the latest snapshot) — its press's label
   *  (`reviewAgainLabel`): then it is the primary and Ship anyway the
   *  alternative. Null: Ship anyway stays the primary. */
  reviewAgain: string | null = null,
): CardStatePresentation | null {
  if (truth.kind === "retrying" && state === "challenger-reviewing") {
    return {
      ...base,
      label: truth.text,
      helper: `${truth.reason} Plyloft tries the same review once more by itself. Ship is not blocked.`,
    };
  }
  if (truth.kind !== "not-reviewed") return null;
  if (state === "ready-to-ship" && truth.action === "build-done") {
    // Commits past the last Build done cannot ship until snapshotted.
    return {
      label: truth.headline,
      actionLabel: "Back to the Builder",
      helper: `${truth.reason} Finish and check in the session saves, checks and reviews them.`,
      tone: "accent",
      actionId: "inspect-run",
    };
  }
  if (state === "ready-to-ship" && truth.cause === "failed" && reviewAgain) {
    // QoL 1.168 (C5): a review that failed is run again first; shipping
    // unreviewed work is the second choice, never the nudge.
    return {
      label: truth.headline,
      actionLabel: reviewAgain,
      helper: truth.commitsLine ? `${truth.reason} ${truth.commitsLine}.` : truth.reason,
      actionTitle: "Run the Reviewer again on the last build. Nothing is committed and the checks are not re-run.",
      tone: "accent",
      actionId: "review-again",
    };
  }
  if (state === "ready-to-ship") {
    return {
      label: truth.headline,
      actionLabel: "Ship anyway",
      helper: truth.commitsLine ? `${truth.reason} ${truth.commitsLine}.` : truth.reason,
      tone: "accent",
      actionId: "ship",
    };
  }
  if (state === "result-ready") {
    return {
      ...base,
      label: truth.headline,
      helper: truth.reason,
      tone: "accent",
    };
  }
  return null;
}


// ── GH #129: a request for changes a hand-over left unsent ──────────────
//
// When a review asking for changes ends while the next snapshot waits, the
// card goes straight to that snapshot's follow-up (GH #124) and the verdict
// is never sent: the follow-up quotes the open findings and its verdict
// carries them. When the follow-up gives no verdict (failed, interrupted,
// incomplete), the Builder never saw them: the card names what is owed,
// `Back to the Builder` sends it, and Ship says it without being blocked.

export interface HandedOverOwed {
  /** "Review of snapshot 7 failed — snapshot 5's review asked for
   *  changes: F3, F4 still open". */
  line: string;
  /** What `Back to the Builder` sends into the session. */
  message: string;
  findingIds: string[];
  snapshotN: number;
  /** `HandedOverRequest.at`: which hand-over a delivery was of. */
  handedOverAt: number;
  /** How `Back to the Builder` went in the current session: `unsent`
   *  until it reached the PTY. Sent findings stay open (and on Ship's
   *  line) until a review re-checks them. */
  delivery: "unsent" | "queued" | "sent" | "failed";
  /** Why the last delivery failed. */
  deliveryError: string | null;
  /** The Run banner's second sentence. */
  status: string;
}

/** How the last review ended, as the hand-over's line says it. */
const LAST_REVIEW_ENDED: Record<string, string> = {
  "did not run": "didn't run",
  failed: "didn't finish",
  "was incomplete": "didn't finish",
  "was skipped": "was skipped",
  "gave no verdict": "gave no verdict",
};

/** How the review after the hand-over ended, in words; null while it
 *  runs (its verdict will carry the findings). */
function endedWithoutVerdict(review: BuilderReview | null | undefined): string | null {
  if (!review) return "did not run";
  if (review.status === "running") return null;
  if (review.status === "failed") return "failed";
  if (review.status === "skipped") return "was skipped";
  if (review.verdict === "incomplete") return "was incomplete";
  if (review.verdict === "approve" || review.verdict === "changes_requested") return null;
  return "gave no verdict";
}

/** The request the card still owes the Builder, or null. Same record as
 *  builder.rs::handed_over_ship_summary. */
export function handedOverOwed(
  builder: KanbanCard["builder"] | null | undefined,
  lastDelivery?: HandedOverDelivery | null,
): HandedOverOwed | null {
  const owed = builder?.handedOver;
  if (!owed) return null;
  const review = builder?.review ?? null;
  const ended = endedWithoutVerdict(review);
  if (!ended) return null;
  const ids = owed.findingIds ?? [];
  // 1.171.0 C2 (CF10): no round numbers in the line (Activity keeps them).
  const open =
    ids.length > 0
      ? `${ids.length} finding${ids.length === 1 ? "" : "s"} still open`
      : "The changes asked for are still open";
  const line = review ? `${open} · the last review ${LAST_REVIEW_ENDED[ended] ?? ended}` : open;
  const which = review
    ? `The review of snapshot ${review.snapshotN} ${ended}, so nothing sent you`
    : "Nothing sent you";
  const byId = ids.length > 0 ? " Each finding carries its id; answer by id." : "";
  const message = `[Plyloft] ${which} the changes the Reviewer requested on snapshot ${owed.snapshotN}. They are still open.${byId}\n\n${owed.handoff.trim()}\n\nAddress what is valid, push back in one line on what is not, then stop: Plyloft checks your fixes when you are done.`;
  const current = deliveryFor(lastDelivery, owed.at, builder?.ptyId);
  const delivery = current?.state ?? "unsent";
  const status =
    delivery === "sent"
      ? "Sent to the Builder — still open until a review re-checks them."
      : delivery === "queued"
        ? "Queued — they go in when the Builder is back at its prompt."
        : delivery === "failed"
          ? `They did not reach the Builder: ${current?.error ?? "the delivery failed"}`
          : "The Builder has not received these findings.";
  return {
    line,
    message,
    findingIds: ids,
    snapshotN: owed.snapshotN,
    handedOverAt: owed.at,
    delivery,
    deliveryError: delivery === "failed" ? current?.error ?? null : null,
    status,
  };
}

/** "Shipped with 2 open findings from snapshot 5's review, not re-checked:
 *  F3, F4." — the same line as builder.rs::handed_over_ship_summary. */
export function handedOverShipLine(owed: Pick<HandedOverOwed, "findingIds" | "snapshotN">): string {
  const n = owed.findingIds.length;
  if (n === 0) return `Shipped with the changes round ${owed.snapshotN}'s review requested, not re-checked.`;
  return `Shipped with ${n} open finding${n === 1 ? "" : "s"} from round ${owed.snapshotN}'s review, not re-checked: ${owed.findingIds.join(", ")}.`;
}

/** The card-state header for a card that owes the Builder a request: the
 *  line, and `Back to the Builder` as the primary. Ship is not blocked
 *  (the header offers it beside). null keeps the header as it was. */
export function handedOverPresentation(
  state: CardPresentationState,
  owed: HandedOverOwed | null,
): CardStatePresentation | null {
  if (!owed || (state !== "ready-to-ship" && state !== "result-ready")) return null;
  const shipNote = "Ship is not blocked; it says they were not re-checked.";
  if (owed.delivery === "sent" || owed.delivery === "queued") {
    return {
      label: owed.line,
      actionLabel: "Back to the Builder",
      helper: `${owed.status} Finish and check, once the Builder has addressed them, starts the next review. ${shipNote}`,
      tone: "accent",
      actionId: "inspect-run",
    };
  }
  return {
    label: owed.line,
    actionLabel: "Back to the Builder",
    helper:
      owed.delivery === "failed"
        ? `${owed.status} Back to the Builder sends them again. ${shipNote}`
        : `The Builder has not received these findings: the review that was to re-check them gave no verdict. Back to the Builder sends them into its session. ${shipNote}`,
    tone: "accent",
    actionId: "send-handed-over",
  };
}

// ── GH #135: a verdict the Builder has not received ─────────────────────
//
// The verdict used to be injected by the Run step, and only on a running →
// settled transition while it was mounted. With the card closed when the
// review settled, the next mount started from nothing and the message was
// never sent: the Builder sat idle and the loop looked stuck. The card now
// records the settled review whose verdict is unsent
// (`BuilderState.undeliveredVerdict`); the Run step and the card header say
// so, and it is sent once — the delivery is marked per session (`ptyId`),
// as `handedOverDelivery.ts` already does for GH #129's owed findings.

export interface VerdictOwed {
  /** "Claude doesn't have the findings yet" — no round number (1.171.0 C2,
   *  CF10/CF11). Shown only for a request for changes still to send. */
  line: string;
  /** What the send writes into the Builder's session. */
  message: string;
  /** The press: a request for changes (1.171.0 C2), or — 1.172.0 E2 — any
   *  verdict Codex's search or message box kept ("Send it again"). */
  sendLabel: string;
  /** 1.171.0 C2 (CF11): a request for changes — the person's to send when
   *  it didn't go in. Anything else Plyloft delivers by itself. */
  findings: boolean;
  snapshotN: number;
  /** `BuilderReview.at` — which verdict a delivery was of. */
  at: number;
  /** The card has a Builder session (`ptyId`) to send it into. */
  sessionOpen: boolean;
  /** The session a delivery of this verdict went into, as the card
   *  matched it; null when none has. */
  deliveredPtyId: string | null;
  /** How the send went in the current session. `unsent` until it reached
   *  the PTY; `sending` while the write is under way (1.171.0 C2, K3: the
   *  Builder is getting it); `unrecorded` once it did but the card could not
   *  be told, which is never a reason to write into the Builder again. */
  delivery: "unsent" | "sending" | "sent" | "unrecorded" | "failed";
  /** Why the last send failed. */
  deliveryError: string | null;
  /** How many times Ply has tried to record a delivered verdict, and
   *  when it last tried. */
  ackAttempts: number;
  ackAttemptAt: number | null;
  /** The human asked for a failed write to be tried again, and it is
   *  waiting for the Builder's prompt. */
  retryRequested: boolean;
  /** The second sentence, beside the line. */
  status: string;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `text` as a sentence, so a reason that ends however it ends does not
 *  run into the sentence after it. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** What the owed verdict is about, for the line — and whether the Builder
 *  has it, because a line that says it hasn't reached the Builder beside a
 *  status that says it was sent is one of them lying. 1.171.0 C2 (CF10,
 *  CF11, K3): by the AI's name, never a round number; a request for
 *  changes is "the findings", anything else "the review". */
function verdictWhat(review: BuilderReview, ai: string, had: "no" | "going" | "yes"): string {
  const findings = review.status !== "failed" && review.verdict === "changes_requested";
  const what = findings ? "the findings" : "the review";
  // 1.172 A3 (Windows walk 2026-10-27-211141): while the write is under way
  // the line says it is going in — "has" beside "Going to the Builder now"
  // read as a line left over from before.
  return had === "yes" ? `${ai} has ${what}` : had === "going" ? `${ai} is getting ${what}` : `${ai} doesn't have ${what} yet`;
}

/** 1.171.0 C2 (CF11, K3): the owed verdict is the person's to handle only
 *  when it is a request for changes still to send (unsent, or its write
 *  failed). An approval — or an incomplete or failed review — is delivered
 *  by Plyloft at the Builder's next prompt and noted under Technical
 *  details only: never a headline, a banner or a button. */
export function verdictShownAsWork(owed: VerdictOwed | null | undefined, review: Pick<BuilderReview, "status" | "verdict"> | null | undefined): boolean {
  if (!owed || !review) return false;
  // 1.172.0 E2: Codex's search or message box kept it in a session still
  // open — the person acts there, then presses Send it again (any verdict).
  if (owed.sessionOpen && owed.delivery === "failed" && codexScreenNeedsPress(owed.deliveryError)) return true;
  if (!owed.findings) return false;
  if (review.status === "failed" || review.verdict !== "changes_requested") return false;
  return owed.delivery === "unsent" || owed.delivery === "failed";
}

/** Walk of #386 (step 7): a Builder record no session ever ran in — a pull
 *  request's card keeps its reviews there from the start, and a start the
 *  card's setup refused leaves it so. Nothing was closed, nothing can be
 *  resumed, and nothing "has not reached" a Builder that doesn't exist. */
export function builderNeverStarted(builder: KanbanCard["builder"] | null | undefined): boolean {
  return Boolean(builder) && (builder!.startedAt ?? 0) <= 0 && !builder!.ptyId;
}

/** The session section of a pull request's card whose Builder never ran. */
export const NOT_STARTED_ON_PR_WORDS =
  "The Builder hasn't started on this card. Fix with the Builder starts it on the card's copy of your branch, with the Reviewer's findings.";

/** The same, once the pull request is merged or closed: there is no Fix
 *  with the Builder to name any more. */
export const NEVER_STARTED_ON_CLOSED_PR_WORDS = "The Builder never started on this card.";

/** The session section's words on a pull request card whose Builder never ran. */
export function notStartedOnPrWords(prState: string | null | undefined): string {
  return prState === "open" ? NOT_STARTED_ON_PR_WORDS : NEVER_STARTED_ON_CLOSED_PR_WORDS;
}

/** The verdict the card still owes the Builder, or null. Owed only while
 *  the card's review is still the one that settled — a newer review says
 *  what matters itself, and the backend drops the record with it. A Builder
 *  that never started is owed nothing yet: its first session gets the
 *  request for changes (`review_kept_for_new_session`). */
export function verdictOwed(
  builder: KanbanCard["builder"] | null | undefined,
  lastDelivery?: VerdictDelivery | null,
  /** The card reviews a pull request (walk 3 of #386, finding 5). */
  prCard = false,
): VerdictOwed | null {
  const owed = builder?.undeliveredVerdict;
  const review = builder?.review ?? null;
  if (!owed || !review) return null;
  if (builderNeverStarted(builder)) return null;
  // Walk 3 of #386 (finding 5): on a pull request card an approval asks
  // nothing of a closed session (the backend owes it to none now; a record
  // from before says so here too).
  if (prCard && !builder?.ptyId && review.verdict === "approve") return null;
  if (review.snapshotN !== owed.snapshotN || review.at !== owed.at) return null;
  // GH #129: the message names a request for changes still owed beside it.
  const message = reviewSettledMessage(review, builder?.handedOver?.snapshotN);
  if (!message) return null;
  const current = verdictDeliveryFor(lastDelivery, owed.at, builder?.ptyId);
  const ackAttempts = current?.ackAttempts ?? 0;
  const delivery =
    current == null
      ? "unsent"
      : current.state === "failed"
        ? "failed"
        : current.state === "sending"
          ? "sending"
          : current.acked
            ? "sent"
            : "unrecorded";
  // The card's own session: with none open, nothing can be sent until the
  // human resumes it, and saying Ply is about to send it would be untrue.
  const open = Boolean(builder?.ptyId);
  // 1.171.0 C2 (CF11): a request for changes is the person's to send; any
  // other review goes in by itself (no press exists for it).
  const findings = review.status !== "failed" && review.verdict === "changes_requested";
  const status =
    delivery === "sending"
      ? "Plyloft is writing it into the session now."
      : delivery === "sent"
      ? "Sent to the Builder."
      : delivery === "unrecorded"
        ? ackAttempts < VERDICT_ACK_ATTEMPTS
          ? "Sent to the Builder — Plyloft is still recording that it went."
          : "Sent to the Builder, but Plyloft could not record that it went: after a restart the card may send it once more."
        : delivery === "failed"
          ? // 1.172.0 E2: Codex's transcript search or its message box kept
            // it — what to do there, in the session that is still open.
            (open ? codexScreenHelp(current?.error, current?.retryRequested === true) : null) ??
            (current?.retryRequested === true
            ? `It did not reach the Builder: ${sentence(current.error ?? "the delivery failed")} It goes in when the Builder is done with what it's doing.`
            : findings
              ? `It did not reach the Builder: ${current?.error ?? "the delivery failed"}`
              : // A new session hasn't had it: Resume sends it (no press).
                `It did not reach the Builder: ${sentence(current?.error ?? "the delivery failed")} It goes in when you Resume the session.`)
          : open
            ? "The Builder has not received it. Plyloft sends it as soon as the Builder is done with what it's doing."
            : "The Builder has not received it. Resume the session and Plyloft sends it.";
  const ai = builder?.vendor === "codex" ? "Codex" : "Claude";
  return {
    line: sentenceCase(verdictWhat(review, ai, delivery === "sending" ? "going" : delivery === "sent" || delivery === "unrecorded" ? "yes" : "no")),
    message,
    findings,
    // 1.171.0 C2 (CF11): only findings are ever sent by a press.
    // E2: any other verdict gets a press only after Codex's screen kept it.
    sendLabel: findings ? "Send the findings to the Builder" : "Send it again",
    snapshotN: owed.snapshotN,
    at: owed.at,
    sessionOpen: open,
    deliveredPtyId: current?.ptyId ?? null,
    delivery,
    deliveryError: delivery === "failed" ? current?.error ?? null : null,
    ackAttempts,
    ackAttemptAt: current?.ackAttemptAt ?? null,
    retryRequested: current?.retryRequested === true,
    status,
  };
}

/** 1.171.0 C2 (CF11, K3): the Technical details note for a verdict Plyloft
 *  delivers by itself (`verdictShownAsWork` false) — the only place it is
 *  said. Null when nothing is owed. */
export function verdictDetailsNote(owed: VerdictOwed | null | undefined): string | null {
  if (!owed) return null;
  return `${owed.line}. ${owed.status}`;
}

/** Tier 4 walk 2026-10-14: "The result"'s line on a request for changes,
 *  from the same record as the Now callout (`verdictOwed`): it went to the
 *  Builder only once it did. */
export function changesRequestedResultLine(who: string, owed: VerdictOwed | null): string {
  const asks = `The Reviewer (${who}) asks for changes`;
  if (!owed || !verdictNeedsSending(owed)) return `${asks}; they went to the Builder session.`;
  if (owed.delivery === "failed") return `${asks}; they did not reach the Builder session.`;
  return owed.sessionOpen
    ? `${asks}; they have not reached the Builder yet.`
    : `${asks}; they have not reached the Builder, and its session is closed.`;
}

/** GH #135: what "Build done" is, in the changes-requested helper — the
 *  press people get wrong, because it is the one that starts the next
 *  review. GH #253: said as a fact; what the button does is its title. */
const NEXT_REVIEW_NOTE =
  "Finish and check in the session saves the fixes and starts the next review.";

/** Walk of #378: with the Builder session closed there is no "Build done
 *  in the session" to press — the way on is a session first. */
const CLOSED_SESSION_NOTE =
  "Resume the session or Start fresh first: the findings go to it, and Finish and check there starts the next review.";

/** GH #135: the card header on `changes-requested`. The button used to
 *  read `Back to the Builder` and only open the Run step, whether or not
 *  the Builder had the findings. It now says what the press does: it sends
 *  the findings when they are owed, and opens the Builder when they are
 *  not. null keeps `base`. */
export function changesRequestedPresentation(
  state: CardPresentationState,
  base: CardStatePresentation,
  owed: VerdictOwed | null,
): CardStatePresentation | null {
  if (state !== "changes-requested") return null;
  if (owed && verdictNeedsSending(owed)) {
    return {
      label: owed.line,
      actionLabel: owed.sendLabel,
      helper:
        owed.delivery === "failed"
          ? `${owed.status}. ${NEXT_REVIEW_NOTE}`
          : owed.sessionOpen
            ? `The Builder has not received them. ${NEXT_REVIEW_NOTE}`
            : `The Builder has not received them, and its session is closed. ${CLOSED_SESSION_NOTE}`,
      actionTitle:
        owed.delivery === "failed"
          ? "Sends them into the Builder session again."
          : owed.sessionOpen
            ? "Sends them into the Builder session."
            : "Resume the session first; then this sends them.",
      tone: "accent",
      actionId: "send-handed-over",
    };
  }
  return {
    ...base,
    helper: owed
      ? `${owed.status} ${owed.sessionOpen ? NEXT_REVIEW_NOTE : CLOSED_SESSION_NOTE}`
      : NEXT_REVIEW_NOTE,
  };
}

/**
 * CL-2: the skills the Challenger followed, as the card's chips show them.
 * A review since CL-2 stores them; an older one is read from its excerpt —
 * every `Followed: a, b` line (a review in passes has one per pass), each
 * name once, and a note from the `Skills followed` section when the excerpt
 * still holds it.
 */
/** CL-11 (Mac walk, step 2): which finished review's verdict the card holds
 *  — a key that changes with each review — or null while none has one (no
 *  review, running, failed or skipped). The card opens "The result" by
 *  itself once per key. */
export function reviewVerdictKey(
  review: Pick<BuilderReview, "status" | "verdict" | "reviewId" | "snapshotN" | "at"> | null | undefined,
): string | null {
  if (!review || review.status !== "done" || review.verdict == null) return null;
  return review.reviewId ?? `${review.snapshotN}@${review.at}`;
}

/** CL-11 (second walks): Plyloft's own skills a review may follow — none of
 *  the four that ship is about reviewing (`review_answer.rs`'s
 *  `PLY_REVIEW_SKILLS`). */
export const PLY_REVIEW_SKILLS: readonly string[] = [];

/** CL-11: whether a review can legitimately have followed `name` — any
 *  repository, team or personal skill, and only those of Plyloft's own
 *  (`ply:…`) meant for reviews. A Builder's skill such as
 *  `ply:answer-the-challenger` is not shown as followed, in old records too. */
export function reviewMayFollow(name: string): boolean {
  const own = /^\s*ply:(.+)$/i.exec(name);
  if (!own) return true;
  const skill = own[1].trim().toLowerCase();
  return PLY_REVIEW_SKILLS.some((each) => each.toLowerCase() === skill);
}

export function skillsFollowedOf(
  review: Pick<BuilderReview, "skillsFollowed" | "excerpt"> | null | undefined,
): SkillFollowed[] {
  return followedIn(review).filter((entry) => reviewMayFollow(entry.skill));
}

function followedIn(
  review: Pick<BuilderReview, "skillsFollowed" | "excerpt"> | null | undefined,
): SkillFollowed[] {
  if (!review) return [];
  const stored = (review.skillsFollowed ?? []).filter((entry) => entry.skill.trim() !== "");
  if (stored.length > 0) return stored;
  const excerpt = review.excerpt ?? "";
  if (!excerpt) return [];
  const out: SkillFollowed[] = [];
  const add = (skill: string, note = "") => {
    const name = skill.trim();
    if (!name) return;
    const known = out.find((entry) => entry.skill === name);
    if (!known) out.push({ skill: name, note });
    else if (!known.note && note) known.note = note;
  };
  // Only where `review_answer.rs::render` writes it: the line right after a
  // Verdict heading (demoted a level or two inside a review in passes) and
  // its verdict word — never a finding's body or a fenced block.
  const lines = excerpt.split("\n");
  const fenced = fencedLines(lines);
  for (let i = 0; i + 2 < lines.length; i++) {
    if (fenced[i] || !/^#{2,4} Verdict\s*$/.test(lines[i])) continue;
    if (!/^(APPROVE|CHANGES_REQUESTED|INCOMPLETE|\(none\))\s*$/.test(lines[i + 1])) continue;
    const followed = /^Followed: (.+)$/.exec(lines[i + 2]);
    if (followed) for (const name of followed[1].split(",")) add(name);
  }
  if (out.length === 0) return out;
  // The notes, quoted under each name, in the section render() writes last
  // (a heading level deeper inside a review in passes).
  let inSection = false;
  let current: string | null = null;
  let note: string[] = [];
  const settle = () => {
    const known = current === null ? undefined : out.find((entry) => entry.skill === current!.trim());
    const text = note.join("\n").trim();
    if (known && !known.note && text) known.note = text;
    current = null;
    note = [];
  };
  for (const [index, line] of lines.entries()) {
    if (fenced[index]) continue;
    if (/^#{2,6}\s+Skills followed\s*$/.test(line)) {
      settle();
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^#{1,6}\s/.test(line)) {
      settle();
      inSection = false;
      continue;
    }
    const item = /^- (.+)$/.exec(line);
    if (item) {
      settle();
      current = item[1];
      continue;
    }
    const quoted = /^> ?(.*)$/.exec(line);
    if (quoted && current !== null) note.push(quoted[1]);
  }
  settle();
  return out;
}

/** Which lines sit inside a ``` fence (the fence lines included). */
function fencedLines(lines: string[]): boolean[] {
  let inside = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inside = !inside;
      return true;
    }
    return inside;
  });
}

// ── PR #375 review: the review panel's Merge and the Challenger ──────────
//
// The panel's "Merge to <target>" landed a Builder card's snapshot whatever
// its review said. It is offered plainly only when Ship would call the last
// snapshot reviewed (an approve — a dismissal's included — or an accepted
// pushback; 1.171.0 C3: never a review skipped on purpose); otherwise the
// member chooses "Merge anyway",
// and the backend (`builder::merge_review_gap`) refuses without that choice.

/** Tier 4 walk 2026-10-14: what "The result" offers as its pull request —
 *  nothing while commits sit past the last snapshot (Ship publishes the
 *  snapshot and refuses a worktree past it), "Open the pull request anyway
 *  (I merge it)" with the diff panel's gap note while the snapshot has no
 *  approved review, else the plain pull request (1.171.0 B3: Ship ▾'s
 *  choices, `SHIP_CHOICE_LABELS`). */
export type PrShipOffer =
  | { kind: "plain"; label: string }
  | { kind: "anyway"; label: string; note: string }
  | { kind: "wait"; note: string };

export const PR_SHIP_WAIT_NOTE =
  "A pull request waits for Finish and check: commits were made after the last one.";

export function prShipOffer(
  builder: KanbanCard["builder"] | null | undefined,
  branchTip: string | null | undefined,
): PrShipOffer {
  const last = builder?.snapshots[builder.snapshots.length - 1];
  if (last && branchTip && branchTip !== last.sha) return { kind: "wait", note: PR_SHIP_WAIT_NOTE };
  const gap = mergeReviewGap(builder);
  if (gap) {
    // G1 Challenger (1): unreviewed, it never merges by itself — whatever
    // the workspace remembers (Rust's `ship_auto_merge_guarded`). 1.171.0
    // B3 (LG-03): the label says so.
    return {
      kind: "anyway",
      label: SHIP_ANYWAY_LABEL,
      note: `${gap} ${SHIP_ANYWAY_LABEL} opens it without an approved review; the receipt and the pull request say so.`,
    };
  }
  return { kind: "plain", label: "Open the pull request" };
}

/** 1.171.0 C3: `mergeReviewGap`'s words for a review skipped on purpose —
 *  the pull request's line says the same (`builder.rs::SKIPPED_REVIEW_REASON`). */
export const SKIPPED_REVIEW_GAP = "You skipped the review of the last round.";

/** Why Merge would land the last build snapshot without an approved
 *  review, in words; null when it may merge plainly, and for cards without
 *  a Builder or a snapshot (the panel says those can't merge). */
export function mergeReviewGap(builder: KanbanCard["builder"] | null | undefined): string | null {
  if (!builder) return null;
  const last = builder.snapshots[builder.snapshots.length - 1];
  if (!last) return null;
  const review = builder.review;
  if (!review) return `The Reviewer has not reviewed round ${last.n}.`;
  // Merge lands the last snapshot, so that is the tip the review must cover.
  const truth = reviewTruth({ builder, branchTip: last.sha });
  if (truth.kind === "running" || truth.kind === "retrying") {
    return `The Reviewer is still reviewing round ${last.n}.`;
  }
  if (truth.kind === "not-reviewed") return truth.reason;
  if (builder.handedOver) {
    return `The changes round ${builder.handedOver.snapshotN}'s review requested went to a follow-up and were not re-checked.`;
  }
  // A skip (or an accepted pushback) stands for its own snapshot only, as
  // in the backend: one on an older snapshot leaves the last one unreviewed.
  if (review.snapshotN !== last.n) return `The Reviewer has not reviewed round ${last.n}.`;
  // 1.171.0 C3 (owner 2026-10-27; Rust `unreviewed_ship_summary`): an
  // override (`note`) is the person's decision on the findings; a review
  // skipped with "Check without the Reviewer" is no review, so
  // Ship ▾ offers only the pull request the person merges, or this Mac.
  if (truth.kind === "skipped") return review.note ? null : SKIPPED_REVIEW_GAP;
  if (review.status === "done" && review.verdict === "changes_requested") {
    return `The Reviewer requested changes on round ${last.n}.`;
  }
  if (review.status === "done" && review.verdict === "incomplete") {
    return `The review of round ${last.n} is incomplete.`;
  }
  return null;
}

/** P-D2 Windows walk: the review's base note in plain words. The backend's
 *  notes (`review_base.rs`: "Review base: the recorded base (origin is a
 *  local path).", "Local main was ahead of origin; reviewed from …", "This
 *  card's commits are already in origin's main.") name git's remote; these
 *  sentences say which starting point the review used, and the note itself
 *  stays under Details. Null for no note. */
export function reviewBaseWords(note: string | null | undefined): string | null {
  if (!note) return null;
  const said: string[] = [];
  if (note.startsWith("Review base: the recorded base")) {
    said.push("Reviewed from the point this card started, because Plyloft couldn't compare it with GitHub's latest copy.");
  } else if (note.startsWith("Review base: not checked")) {
    said.push("Reviewed from your project folder's copy of the branch, because Plyloft couldn't compare it with GitHub's latest copy.");
  } else if (/was ahead of origin|pointed past origin's/.test(note)) {
    said.push("Reviewed from GitHub's copy of the branch: commits that are only on this computer were left out of the comparison.");
  }
  const alreadyIn = note.includes("This card's commits are already in origin's");
  if (alreadyIn) said.push("These changes are already on GitHub, so there was nothing new to review.");
  if (said.length === 0) return "Plyloft noted where this review started; Details says how.";
  if (!alreadyIn) said.push("Nothing to do unless the changes look wrong.");
  return said.join(" ");
}

// ── QoL 14.2 (G27): Copy findings ────────────────────────────────────────

const VERDICT_WORDS: Record<string, string> = {
  approve: "Approved",
  changes_requested: "Changes requested",
  incomplete: "Incomplete",
};

function findingMarkdown(f: {
  id?: string | null;
  severity: string | null;
  title: string;
  body: string;
  location?: string | null;
  preExisting: boolean;
}): string {
  const head = [f.id, severityWord(f.severity), f.preExisting ? "pre-existing" : null]
    .filter(Boolean)
    .join(" · ");
  const where = f.location?.trim() ? ` (\`${f.location.trim()}\`)` : "";
  const body = f.body.trim();
  const lines = [`- **${head}** — ${f.title.trim()}${where}`];
  if (body && body !== f.title.trim()) {
    for (const line of body.split("\n")) lines.push(line.trim() ? `  ${line}` : "");
  }
  return lines.join("\n");
}

/** QoL 14.2 (G27): the Challenger's findings as Markdown, for a teammate:
 *  the verdict, then the open (or blocking) findings by severity with their
 *  `path:line` and text, then the non-blocking ones. Plain text that reads
 *  the same pasted anywhere; Plyloft never posts it to GitHub. */
export function findingsMarkdown(title: string, review: BuilderReview): string {
  const out: string[] = [`## Review · ${title.trim()}`];
  const verdict = review.verdict ? VERDICT_WORDS[review.verdict] : null;
  const facts = [verdict, review.reviewedRevision ? `revision ${review.reviewedRevision.slice(0, 12)}` : null]
    .filter(Boolean)
    .join(" · ");
  if (facts) out.push("", facts);
  const ledger = review.ledger ?? [];
  if (ledger.length > 0) {
    const { open, closed, dismissed } = ledgerSections(ledger);
    out.push("", `### Open (${open.length})`);
    out.push(open.length > 0 ? open.map(findingMarkdown).join("\n") : "None.");
    if (closed.length > 0) {
      out.push("", `### Closed (${closed.length})`, closed.map((f) => `- ${ledgerLine(f)}`).join("\n"));
    }
    if (dismissed.length > 0) {
      out.push(
        "",
        `### Dismissed (${dismissed.length})`,
        dismissed.map((f) => `- ${ledgerLine(f)}${f.dismissal ? ` — ${dismissalWords(f.dismissal)}` : ""}`).join("\n"),
      );
    }
  } else {
    const findings = review.findings ?? [];
    if (findings.length === 0) out.push("", "No blocking findings.");
    for (const group of findingsBySeverity(findings)) {
      out.push("", `### ${severityWord(group.severity)} (${group.findings.length})`, group.findings.map(findingMarkdown).join("\n"));
    }
  }
  const nonBlocking = review.nonBlocking ?? [];
  if (ledger.length === 0 && nonBlocking.length > 0) {
    out.push("", `### Non-blocking (${nonBlocking.length})`, nonBlocking.map(findingMarkdown).join("\n"));
  }
  const checklist = review.checklist ?? [];
  if (checklist.length > 0) {
    out.push("", "### Risk checklist", checklist.map((line) => `- ${line}`).join("\n"));
  }
  return `${out.join("\n")}\n`;
}
