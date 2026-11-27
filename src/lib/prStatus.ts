/**
 * SL-1 (ship loop): what a card says about its pull request on GitHub —
 * pure, no React and no store, so the words are tested once
 * (`prStatus.test.ts`).
 *
 * "Checks on GitHub" are the pull request's status checks (CI). They are
 * never called just "Checks": that word is the card's own verify pipeline
 * (`cardPage.ts::checksFact`).
 *
 * The card keeps `reviewStatus: "merged"` from the moment its PR opens (as
 * before SL-1: the work is in the PR); `pr.state` says whether that PR is
 * open, merged or closed. v1.154.1 (F11): whether it is open follows
 * `pr.state` alone — the review loop writes `reviewStatus` too (a request
 * for changes on the fix), and the PR stays open meanwhile.
 */
import type { KanbanCard, LocalCommits, MergeMethod, PrStatus } from "../ipc.ts";
import { cardShippedOrPrOpen, challengerRequestedChanges } from "./cardLifecycle.ts";
import { mergeReviewGap } from "./challengerReview.ts";
import { LAUNCH_LOOK_MS } from "./appStartedAt.ts";
import { latestTaggedEntry, ownShipEntry } from "./shipVersion.ts";
import { machineWords } from "./platform.ts";
import {
  ON_GITHUB_MERGES_BY_ITSELF,
  ON_GITHUB_WAITING,
  PLYLOFT_MERGES_WHEN_OPEN,
  PLYLOFT_MERGES_WHILE_OPEN,
  READY_TO_MERGE,
  SOMEONE_ELSE_CHANGED,
} from "./deliveryWords.ts";

type RunState = "running" | "done" | "aborted" | "empty";
type PrCard = Pick<KanbanCard, "reviewStatus" | "pr" | "prUrl"> & Partial<Pick<KanbanCard, "shipStatus" | "archived" | "builder">>;
type MergeCard = PrCard;

/** The card's work is in a pull request that is still open (mirrors
 *  `pr_status.rs::card_pr_open`). */
export function prOpen(card: PrCard): boolean {
  return card.pr?.state === "open" && Boolean(card.prUrl) && card.shipStatus !== "shipped";
}

/** The card's pull request merged (read from GitHub, SL-1). */
export function prMerged(card: Pick<KanbanCard, "pr">): boolean {
  return card.pr?.state === "merged";
}

/** Closed without merging, and not shipped again since: the card is back
 *  to review. */
export function prClosed(card: PrCard): boolean {
  return card.pr?.state === "closed" && card.reviewStatus !== "merged";
}

/** v1.154.1 (F15): what GitHub last said of the pull request, as one key —
 *  a refusal about one read is not shown once the next says something new.
 *  The read time is not part of it (a read that changed nothing). */
export function prFactsKey(pr: PrStatus): string {
  return [pr.state, pr.checks, pr.mergeable, pr.reviewDecision, pr.headSha ?? "", pr.autoMerge ? "auto" : "", pr.awaitingChecks ? "awaiting" : ""].join("|");
}

/** "workflow / name" when the workflow says something the name doesn't
 *  (mirrors `pr_status.rs::PrCheck::label`). */
export function checkLabel(c: { name: string; workflow?: string | null }): string {
  return c.workflow && c.workflow !== c.name ? `${c.workflow} / ${c.name}` : c.name;
}

/** v1.154.1 (walk I1): the checks as they stand for what the pull request
 *  holds now. Right after a push (or the opening) GitHub may report none,
 *  or still the old head's, before it starts the new run: that is running,
 *  not "none" and not the old failure. */
export function prChecksNow(pr: PrStatus): PrStatus["checks"] {
  return pr.state === "open" && pr.awaitingChecks === true && pr.checkedAt != null ? "pending" : pr.checks;
}

function names(pr: PrStatus): string {
  return pr.failingChecks.map(checkLabel).join(", ");
}

/** The "Checks on GitHub" property: one word and its dot. */
export function githubChecksFact(pr: PrStatus): { word: string; state: RunState } {
  if (pr.checkedAt == null) return { word: "Not read yet", state: "empty" };
  // Walk I1: GitHub hasn't started the checks of the latest push yet.
  if (pr.state === "open" && pr.awaitingChecks) return { word: "Starting on GitHub", state: "running" };
  switch (pr.checks) {
    case "pending":
      return {
        word:
          pr.checksTotal > 0
            ? `Running · ${pr.checksTotal - pr.checksPending} of ${pr.checksTotal} done`
            : "Running",
        state: "running",
      };
    case "passing":
      return { word: "Passed", state: "done" };
    case "failing": {
      const failed = names(pr);
      return { word: failed ? `Failed · ${failed}` : "Failed", state: "aborted" };
    }
    default:
      return { word: "None", state: "empty" };
  }
}

/** 1.169.1 (R1): the words of a green pull request that asks for the
 *  person — the Board's label and the Inbox row's detail. */
//  1.171.0 B3 (BI-8): "Ready to merge" — not "on GitHub", which read as
//  "go to GitHub to merge it" beside Plyloft's own Merge; the Inbox detail
//  says where the checks ran.
export const PR_READY_LABEL = READY_TO_MERGE;
export const PR_READY_INBOX_DETAIL = `${PR_READY_LABEL} · checks passed on GitHub`;
export const PR_READY_NO_CHECKS_INBOX_DETAIL = `${PR_READY_LABEL} · no checks on GitHub`;
export const PR_REVIEW_WAIT_LABEL = "Waiting for a review on GitHub";

/** The Inbox row's detail Rust writes for a pull request ready to merge
 *  with no checks on GitHub (`pr_status.rs::READY_NO_CHECKS_DETAIL`). */
export const PR_READY_NO_CHECKS_DETAIL = "no checks";

/** Open and read at least once, its checks on GitHub passed — or it has
 *  none, once the wait after the opening or a push is over — and GitHub
 *  isn't merging it on its own. */
function greenOpen(pr: PrStatus): boolean {
  return (
    pr.state === "open" &&
    pr.checkedAt != null &&
    !pr.awaitingChecks &&
    (pr.checks === "passing" || pr.checks === "none") &&
    !pr.autoMerge
  );
}

/** Two names of one commit: equal, or one the start of the other. */
function sameCommit(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}

/** 1.170.0 (G1–G3 Challenger, 2): GitHub's pull request is no longer at the
 *  commit Plyloft pushed — GitHub's "Update branch", a bot, someone else's
 *  push. Not while GitHub may still be catching up with a push. Nothing
 *  merges it by itself and it is never "ready"; Merge what's on GitHub now
 *  is the person's press. Mirrors `pr_status.rs::PrStatus::head_moved`. */
export function prHeadMoved(pr: PrStatus): boolean {
  if (pr.state !== "open" || pr.awaitingChecks) return false;
  const pushed = pr.pushedHead ?? "";
  const head = pr.headSha ?? "";
  return pushed.length > 0 && head.length > 0 && !sameCommit(pushed, head);
}

/** G1–G3 Challenger (2): the card's line while it is so
 *  (`pr_merge.rs::HEAD_MOVED_LINE`). */
export const PR_HEAD_MOVED_LINE = `${SOMEONE_ELSE_CHANGED}: the pull request has commits Plyloft didn't push.`;
/** The press that merges what GitHub has, on the person's decision. */
export const PR_MERGE_GITHUB_HEAD_LABEL = "Merge what's on GitHub now";
/** The Board's label for it (1.171.0 B3, DL-24, BI-8: who, not "Changed"). */
export const PR_HEAD_MOVED_LABEL = SOMEONE_ELSE_CHANGED;

/** GitHub's merge states that stand in the way of a merge (Challenger M1). */
export const MERGE_STATE_IN_THE_WAY: ReadonlySet<string> = new Set(["blocked", "behind", "draft", "dirty"]);

/** 1.169.1 (R1): GitHub would merge it if asked now — green, GitHub
 *  reports it mergeable and its merge state isn't blocked, behind, a draft
 *  or dirty, no review in the way, auto-merge off. Mirrors
 *  `pr_status.rs::PrStatus::ready_to_merge`. */
export function prReadyToMerge(pr: PrStatus): boolean {
  return (
    greenOpen(pr) &&
    pr.mergeable === "mergeable" &&
    !MERGE_STATE_IN_THE_WAY.has(pr.mergeState ?? "") &&
    pr.reviewDecision !== "changes_requested" &&
    pr.reviewDecision !== "review_required"
  );
}

/** 1.169.1 (R1): the card's pull request asks for its Merge — GitHub would
 *  merge it now and nothing on Plyloft's side stands in the way (a build
 *  waiting for Push update, the Challenger's request for changes). Mirrors
 *  `pr_status.rs::card_ready_to_merge`. */
export function prCardReadyToMerge(card: PrCard): boolean {
  // Walk fix: one Plyloft merges by itself asks nothing of the person.
  return Boolean(
    card.pr && prOpen(card) && prReadyToMerge(card.pr) && !card.pr.plyloftAutoMerge && !prMergeBlocked(card),
  );
}

/** 1.169.1 (R1): green, and a review GitHub requires is what it waits for
 *  (`reviewDecision` REVIEW_REQUIRED, with merge state BLOCKED) — On hold,
 *  nothing asked of the person (owner, 2026-10-26). Mirrors
 *  `pr_status.rs::PrStatus::waits_for_review`. */
export function prWaitsForReview(pr: PrStatus): boolean {
  return greenOpen(pr) && pr.mergeable !== "conflicting" && pr.reviewDecision === "review_required";
}

// ── 1.171.0 (B1): where an open pull request is ────────────────────────

/** The Board's and the headline's word for a pull request that is open and
 *  asks nothing, with nothing running for it. */
export const PR_OPEN_LABEL = "On GitHub · pull request open";
/** Plyloft's own merge was due while Plyloft was closed (owner D6): On hold
 *  until its poller reads GitHub again. */
export const PR_MERGES_WHEN_OPEN_LABEL = `On GitHub · ${PLYLOFT_MERGES_WHEN_OPEN}`;
/** A read the GitHub sign-in refused (`PrStatus.signInNeeded`): the Board's
 *  word, and the card's line with its Sign in to GitHub. */
export const PR_SIGN_IN_LABEL = "Plyloft can't read GitHub";
export const PR_SIGN_IN_LINE = "Plyloft can't read GitHub: sign in again";

/** Plyloft's own "Merge when checks pass" would merge it now, by the last
 *  read — open, green and mergeable, nothing on Plyloft's side in the way,
 *  a commit Plyloft pushed, and that commit reviewed (mirrors the guards of
 *  `pr_merge.rs::merge_due`: `pushed_head`, `ship_review_record`). */
export function plyloftMergeDue(card: PrCard): boolean {
  const pr = card.pr;
  return Boolean(
    pr &&
      pr.plyloftAutoMerge &&
      !pr.autoMerge &&
      Boolean(pr.pushedHead?.trim()) &&
      prOpen(card) &&
      prReadyToMerge(pr) &&
      !prMergeBlocked(card) &&
      mergeReviewGap(card.builder) === null,
  );
}

/** When this launch started and the clock now: a merge of Plyloft's own is
 *  owed from before the launch only within `LAUNCH_LOOK_MS` of it. */
export type LaunchClock = { appStartedAt?: number | null; now?: number | null };

/** Where an open pull request is on its way to the merge. */
export type OpenPrStage = "waitingForChecks" | "mergesByItself" | "plyloftMerges" | "plyloftMergesWhenOpen";

/**
 * 1.171.0 (B1, owner D6): the stage of the card's open pull request, or
 * null when it has none. Plyloft's own merge (`plyloftAutoMerge`) is
 * `plyloftMergesWhenOpen` when it was due by a read made before this launch
 * (`appStartedAt`), within the poller's first look (`LAUNCH_LOOK_MS`):
 * Plyloft was closed when it could have merged it, and merges it once its
 * poller reads GitHub again. While it runs, a due merge goes through on the
 * same read, so it is `plyloftMerges`.
 */
export function openPrStage(card: PrCard, clock: LaunchClock = {}): OpenPrStage | null {
  if (!prOpen(card)) return null;
  const pr = card.pr!;
  if (pr.plyloftAutoMerge && !pr.autoMerge) {
    const { appStartedAt, now } = clock;
    // Challenger 1: only for one look of the poller after the launch — a
    // read that changes nothing is not written, and a merge GitHub didn't
    // answer stays due, so the record alone can't end it.
    const firstLook = appStartedAt != null && now != null && now < appStartedAt + LAUNCH_LOOK_MS;
    const readBefore = firstLook && (pr.checkedAt ?? 0) < appStartedAt!;
    return readBefore && plyloftMergeDue(card) ? "plyloftMergesWhenOpen" : "plyloftMerges";
  }
  return pr.autoMerge ? "mergesByItself" : "waitingForChecks";
}

/** Something runs for it on GitHub now: its checks (or GitHub starting
 *  them), or a read Plyloft hasn't made yet. */
function checksUnderWay(pr: PrStatus): boolean {
  return pr.checkedAt == null || pr.awaitingChecks === true || prChecksNow(pr) === "pending";
}

/**
 * An open pull request on the Board: its label, and whether it asks
 * something of the person (Needs you), runs (Working: its checks, or a
 * merge by itself — owner D6) or waits with nothing running (On hold). The
 * Board keeps a merged or legacy PR where it always was (Done).
 */
export function openPrBoard(
  card: PrCard,
  /** 1.171.0 (D6): when this launch of Plyloft started, and now
   *  (`openPrStage`). */
  clock: LaunchClock = {},
): { label: string; attention: "needs-you" | "working" | "waiting" } | null {
  if (!prOpen(card)) return null;
  const pr = card.pr!;
  if (prChecksNow(pr) === "failing") return { label: "Checks failed on GitHub", attention: "needs-you" };
  if (pr.reviewDecision === "changes_requested") {
    return { label: "Changes requested on GitHub", attention: "needs-you" };
  }
  if (pr.mergeable === "conflicting") return { label: "Can't merge: conflict", attention: "needs-you" };
  // G1–G3 Challenger (2): commits Plyloft didn't push — the person looks first.
  if (prHeadMoved(pr)) return { label: PR_HEAD_MOVED_LABEL, attention: "needs-you" };
  // R1: ready to merge — its Merge is the person's. A review GitHub
  // requires first is On hold (owner, 2026-10-26), as is auto-merge on
  // (GitHub merges it).
  if (prCardReadyToMerge(card)) return { label: PR_READY_LABEL, attention: "needs-you" };
  if (prWaitsForReview(pr)) return { label: PR_REVIEW_WAIT_LABEL, attention: "waiting" };
  // B1: a read the GitHub sign-in refused — what it waits for can't be
  // read, so it is no wait that never ends. Below the rows Rust keeps (a
  // failed check, ready to merge…), which the Inbox shows as they are.
  if (pr.signInNeeded) return { label: PR_SIGN_IN_LABEL, attention: "waiting" };
  // B1 (D6): on its way to a merge by itself, or its checks running —
  // Working; with nothing running for it, On hold.
  const running = checksUnderWay(pr);
  switch (openPrStage(card, clock)) {
    case "plyloftMergesWhenOpen":
      return { label: PR_MERGES_WHEN_OPEN_LABEL, attention: "waiting" };
    case "plyloftMerges":
      return running || plyloftMergeDue(card)
        ? { label: PLYLOFT_MERGES_WHILE_OPEN, attention: "working" }
        : { label: PR_OPEN_LABEL, attention: "waiting" };
    case "mergesByItself":
      return {
        label: ON_GITHUB_MERGES_BY_ITSELF,
        attention: running || !MERGE_STATE_IN_THE_WAY.has(pr.mergeState ?? "") ? "working" : "waiting",
      };
    default:
      return running ? { label: ON_GITHUB_WAITING, attention: "working" } : { label: PR_OPEN_LABEL, attention: "waiting" };
  }
}

/** The Now callout's line for a card whose work is in a pull request. */
export function prNowFact(card: PrCard, dayWords: (at: number) => string): string | null {
  const pr = card.pr;
  if (!pr || !card.prUrl) return null;
  const n = `#${pr.number}`;
  // B1: what Plyloft last read may be stale; never an endless wait.
  if (pr.signInNeeded && prOpen(card)) return `Its pull request ${n} is on GitHub, but ${PR_SIGN_IN_LINE}.`;
  if (pr.state === "merged") {
    return pr.mergedAt != null
      ? `Its pull request ${n} was merged on ${dayWords(pr.mergedAt)}.`
      : `Its pull request ${n} was merged.`;
  }
  if (!prOpen(card)) return null;
  const checks = prChecksNow(pr);
  const asks: string[] = [];
  if (checks === "failing") asks.push(`checks failed on GitHub (${names(pr)})`);
  if (pr.reviewDecision === "changes_requested") asks.push("a reviewer asked for changes");
  if (pr.mergeable === "conflicting") asks.push("it can't merge: it conflicts with its base branch");
  // G1–G3 Challenger (2).
  if (prHeadMoved(pr)) asks.push("it has commits on GitHub Plyloft didn't push");
  if (asks.length > 0) {
    const line = asks.join("; ");
    return `Its pull request ${n} is open: ${line}.`;
  }
  // Walk I1: right after a push, before GitHub shows its checks.
  // Walk fix: Plyloft's own "Merge when checks pass" merges it too.
  const merges = pr.autoMerge || pr.plyloftAutoMerge === true;
  if (pr.awaitingChecks && checks === "pending") {
    return merges
      ? `Its pull request ${n} is open; GitHub is starting its checks on the latest push, and it merges when they pass.`
      : `Its pull request ${n} is open; GitHub is starting its checks on the latest push.`;
  }
  // SL-3: GitHub merges it on its own once they pass.
  if (merges && checks === "pending") {
    return `Its pull request ${n} is open; checks on GitHub are running, and it merges when they pass.`;
  }
  // v1.154.1 (F14): said in the Now callout too, not only under Shipping.
  if (pr.autoMerge && checks === "passing") {
    return `Its pull request ${n} is open; checks on GitHub passed, and GitHub merges it on its own.`;
  }
  if (pr.autoMerge) return `Its pull request ${n} is open, and it merges when checks pass.`;
  // R1: what it waits for is a person's review on GitHub; or it has no
  // checks to wait for.
  if (prWaitsForReview(pr)) return `Its pull request ${n} is open; checks on GitHub passed, and it's waiting for a review on GitHub.`;
  if (checks === "pending") return `Its pull request ${n} is open; checks on GitHub are running.`;
  if (checks === "passing") return `Its pull request ${n} is open; checks on GitHub passed.`;
  if (prReadyToMerge(pr) && pr.checks === "none") return `Its pull request ${n} is open; no checks on GitHub.`;
  return `Its pull request ${n} is open.`;
}

/** 1.171.0 (B1, CP-2): the Now sentence of a card whose pull request is
 *  open — what GitHub last said (`prNowFact`), never "It shipped." */
export function prOpenSentence(card: PrCard): string | null {
  return prOpen(card) ? prNowFact(card, () => "") : null;
}

/** The Shipping section's first line about the pull request. Null for a
 *  card shipped as a PR before SL-1 (its page keeps the words it had) and
 *  for a closed PR once the card landed another way. */
export function prShipLine(
  card: PrCard & Partial<Pick<KanbanCard, "shipStatus" | "prReview">>,
): { text: string; state: RunState } | null {
  const pr = card.pr;
  if (!card.prUrl || !pr) return null;
  const n = `#${pr.number}`;
  if (pr.state === "merged") {
    // 1.171.0 (D8, Block A walk): what shipped, by its title on GitHub.
    const title = pr.title?.trim();
    return {
      text: `Shipped as pull request ${n}${title ? ` “${title}”` : ""}, and it was merged.`,
      state: "done",
    };
  }
  if (pr.state === "closed") {
    if (card.reviewStatus === "merged" || card.shipStatus === "shipped") return null;
    return {
      text: `Pull request ${n} was closed without merging. The card's copy and its branch are kept; Ship opens a new pull request.`,
      state: "aborted",
    };
  }
  if (!prOpen(card)) return null;
  // B1: the read the GitHub sign-in refused.
  if (pr.signInNeeded) return { text: `Pull request ${n} is open. ${PR_SIGN_IN_LINE}.`, state: "aborted" };
  // R1: green is not a problem — ready to merge, or waiting for a review.
  // 1.174.0 C5 (BCI-8, T46): the card's own pull request is merged from
  // the card; one it reviews for someone else keeps GitHub's words.
  if (prCardReadyToMerge(card)) {
    return card.prReview
      ? { text: `Pull request ${n} is open: ready to merge on GitHub.`, state: "done" }
      : { text: `Pull request ${n} is ready to merge. Merge it here with Merge, or on GitHub.`, state: "done" };
  }
  if (prWaitsForReview(pr)) return { text: `Pull request ${n} is open: waiting for a review on GitHub.`, state: "running" };
  const board = openPrBoard(card)!;
  return {
    text: board.attention === "needs-you" ? `Pull request ${n} is open: ${lower(board.label)}.` : `Pull request ${n} is open.`,
    state: board.attention === "needs-you" ? "aborted" : "running",
  };
}

/** m2: a ship-history entry that is a merged pull request, not a release:
 *  "Pull request #12" · "Merged on GitHub". */
export function shipEntryPullRequest(
  card: Pick<KanbanCard, "pr" | "prUrl">,
  entry: { commitSha: string },
): string | null {
  const pr = card.prUrl ? card.pr : null;
  if (!pr || pr.state !== "merged" || !entry.commitSha) return null;
  return entry.commitSha === pr.mergeCommit || entry.commitSha === pr.headSha ? `Pull request #${pr.number}` : null;
}

/** 1.171.0 (D8): the pull request a card's latest ship entry is the merge
 *  of, or null — a merge recorded no release, whatever version it carries
 *  (`pr_status.rs` stamps the project's version on every merge). */
function lastShipMergedPr(card: Pick<KanbanCard, "pr" | "prUrl" | "shipHistory" | "commitSha">): PrStatus | null {
  // 1.174.0 (DR2 round 1): the card's own ship, not a release that carried it.
  const last = ownShipEntry(card);
  return last && shipEntryPullRequest(card, last) ? (card.pr ?? null) : null;
}

/** 1.171.0 (D8): the line atop a shipped card's result. "Shipped as vX" only
 *  after a release; a merged pull request says so, without a version. */
export function shippedResultLine(
  card: Pick<KanbanCard, "pr" | "prUrl" | "shipHistory" | "commitSha">,
  version: (shipped: string) => string | null,
  when: (at: number) => string,
  /** 1.175.0 F3 walk (R13): GitHub has the land's commit since. */
  onGitHubSince = false,
): string {
  // 1.174.0 (DR2 round 1): the card's own ship; the release that carried it
  // since (D1(b)) is said apart, "In site-v3.0.2".
  const last = ownShipEntry(card);
  if (!last) return "Shipped.";
  const pr = lastShipMergedPr(card);
  if (pr) {
    const release = latestTaggedEntry(card);
    const inTag = release && release !== last ? ` In ${release.tag!.trim()}.` : "";
    return `Merged on GitHub as pull request #${pr.number} on ${when(last.shippedAt)}.${inTag}`;
  }
  // 1.173.0 (B4): the release's own tag (an area's `site-v…`) when recorded.
  const v = last.tag?.trim() || version(last.shippedVersion);
  // 1.171.0 B1 (Challenger 6): a land here says where ("this PC" on
  // Windows: the caller's StatusLine).
  if (last.releaseKind === "local" && !onGitHubSince) {
    return v ? `Shipped as ${v}, only on this Mac, on ${when(last.shippedAt)}.` : `Shipped only on this Mac on ${when(last.shippedAt)}.`;
  }
  return `Shipped${v ? ` as ${v}` : ""} on ${when(last.shippedAt)}.`;
}

/** 1.171.0 (D8): what "What shipped" names — the pull request's title for a
 *  merge (GitHub's subject of a one-commit squash is that commit's, e.g.
 *  "chore: snapshot 1 for …"); the card's title for a merge read before the
 *  title was (Ship opens its pull request with it unless the Builder wrote
 *  one); else the shipped commit's subject. */
export function whatShippedName(
  card: Pick<KanbanCard, "pr" | "prUrl" | "shipHistory" | "title">,
  subject: string | null | undefined,
): string | null {
  const pr = lastShipMergedPr(card);
  if (pr) return pr.title?.trim() || card.title.trim() || subject || null;
  return subject || null;
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "Read from GitHub 09:12" — when the card last read its pull request. */
export function prCheckedWords(pr: PrStatus, when: (at: number) => string): string {
  return pr.checkedAt == null ? "Not read from GitHub yet." : `Read from GitHub ${when(pr.checkedAt)}.`;
}

/** Whether the card page reads the PR when it opens: only while it is open
 *  (a merged or closed PR doesn't change; a card shipped before SL-1 is
 *  read on Refresh). */
export function refreshOnOpen(card: PrCard & Pick<KanbanCard, "archived">): boolean {
  return !card.archived && Boolean(card.prUrl) && card.pr?.state === "open";
}

/** G5 (1.170.0): the press, on a merged card whose project folder is still
 *  behind GitHub's — the card's and the Inbox row's. 1.174.1 P5 (T5): "this
 *  Mac", drawn through `machineWords` where it shows (this PC on Windows);
 *  the Inbox compares the press with it as it is here. */
export const BRING_UP_TO_DATE_ACTION = "Bring this Mac up to date";

/** G5: the merged card's line, from the reason `after_merge.rs` kept
 *  ("You have changes that aren't in a commit"). */
export function upToDateRefusedLine(reason: string, noPress = false): string {
  const said = reason.trim().replace(/\.$/, "");
  // Challenger 4: one only the person can settle says what to do itself.
  if (noPress) return machineWords(`Merged. ${said}.`);
  return machineWords(`Merged. ${said}, so this Mac wasn't brought up to date.`);
}

/** G5 (Challenger 7): the merged card's muted line when its branch stayed
 *  on GitHub (kept on purpose, or the delete failed). */
export function branchKeptLine(reason: string): string {
  return `The pull request's branch was left on GitHub: ${reason.trim().replace(/\.$/, "")}.`;
}

/** The Inbox row's words for a pull-request event (`inboxView.ts`). */
export function prInboxDetail(kind: string, detail: string | null): string | null {
  switch (kind) {
    case "pr_checks_failed":
      return detail ? `Checks failed on GitHub · ${detail}` : "Checks failed on GitHub";
    case "pr_changes_requested":
      return detail ? `Changes requested on GitHub · ${firstLine(detail)}` : "Changes requested on GitHub";
    case "pr_conflict":
      return "The pull request can't merge: conflict";
    case "pr_ready_to_merge":
      return detail === PR_READY_NO_CHECKS_DETAIL ? PR_READY_NO_CHECKS_INBOX_DETAIL : PR_READY_INBOX_DETAIL;
    case "pr_head_moved":
      return PR_HEAD_MOVED_LINE;
    case "pr_closed":
      return detail
        ? `Pull request ${detail} closed without merging · back to review`
        : "Pull request closed without merging · back to review";
    case "pr_merged":
      return detail ? `Pull request ${detail} merged` : "Pull request merged";
    default:
      return null;
  }
}

/** The first line of a review, cut to a row's width. */
function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// ── SL-3: Merge, and Merge when checks pass ─────────────────────────────

/** The card offers Merge: its pull request is open (a card shipped before
 *  SL-1 has no `pr` and keeps its page as it was). */
export function prMergeOffered(card: PrCard): boolean {
  // v1.154.1 (M1, ADR 0006): not while the Challenger's request for changes
  // covers the latest snapshot — the fix round comes first.
  return !card.archived && prOpen(card) && !challengerRequestedChanges(card.builder);
}

/**
 * v1.154.1 round 3 (RW-A): something stands between the open pull request
 * and a merge — what Now and Shipping both follow. A failed check (not one
 * GitHub still shows for the head before a push), a conflict, a request for
 * changes on GitHub or from the Challenger, or a build GitHub doesn't have
 * yet (a fix waiting for Push update, or being pushed).
 */
export function prMergeBlocked(card: MergeCard): boolean {
  if (!prMergeOffered(card)) return true;
  const pr = card.pr!;
  // G1–G3 Challenger (2): commits on GitHub Plyloft didn't push.
  if (prHeadMoved(pr)) return true;
  if (prChecksNow(pr) === "failing") return true;
  if (pr.mergeable === "conflicting" || pr.reviewDecision === "changes_requested") return true;
  return prFixesNotSent(card);
}

/** 1.171.0 B walk: the card's latest build isn't on its open pull request
 *  and wasn't sent to it — what GitHub shows (its checks, ready to merge)
 *  is the commit before it. */
export function prFixesNotSent(card: PrCard): boolean {
  if (!prOpen(card)) return false;
  const pr = card.pr!;
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1];
  return Boolean(last && pr.headSha && !sameCommit(last.sha, pr.headSha) && !pushedIs(pr, last.sha));
}

function pushedIs(pr: PrStatus, sha: string): boolean {
  const pushed = pr.pushedHead;
  return Boolean(pushed && (pushed.startsWith(sha) || sha.startsWith(pushed)));
}

/** G3: what Merge does, in GitHub's words for it, beside Merge — the way
 *  the repository allows (`mergeMethod`); null until it is read. */
export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  // GitHub calls it "Rebase and merge"; the app's words avoid the git term.
  rebase: "Add the commits one by one",
};

export function mergeMethodLabel(pr: Pick<PrStatus, "mergeMethod">): string | null {
  return pr.mergeMethod ? (MERGE_METHOD_LABEL[pr.mergeMethod] ?? null) : null;
}

/** The line about GitHub merging it on its own, or null when it won't. */
export function prAutoMergeLine(pr: PrStatus): string | null {
  if (pr.state === "open" && !pr.autoMerge && pr.plyloftAutoMerge) return PLYLOFT_AUTO_MERGE_LINE;
  if (pr.state !== "open" || !pr.autoMerge) return null;
  // G1–G3 Challenger (3): Plyloft turned it on again once reviewed.
  if (pr.autoMergeWanted === "resumed") return AUTO_MERGE_RESUMED_LINE;
  return "Will merge when checks pass.";
}

/** 1.170.0 (walk fix): Plyloft keeps "Merge when checks pass" — the base
 *  branch requires no checks, so GitHub's own would merge it at once.
 *  1.174.0 G3 Windows walk: "this Mac", drawn through `machineWords` ("this
 *  PC" on Windows), as Now and the toast say it. */
export const PLYLOFT_AUTO_MERGE_LINE =
  "Merges when the checks pass (Plyloft merges it while it's open on this Mac).";

/** G1–G3 Challenger (1, 3): Plyloft's hold on "Merge when checks pass". */
export const AUTO_MERGE_TURNED_OFF_LINE =
  "Merge when checks pass was turned off: the last commit isn't reviewed. Plyloft turns it on again once it is.";
export const AUTO_MERGE_HELD_LINE =
  "Merge when checks pass waits: the last commit isn't reviewed. Plyloft turns it on once it is.";
export const AUTO_MERGE_RESUMED_LINE = "Merge when checks pass is on again: the last commit is reviewed.";

/** The card's line while a press wanted auto-merge and the last commit
 *  isn't reviewed; null otherwise. */
export function prAutoMergeHeldLine(pr: PrStatus): string | null {
  if (pr.state !== "open" || pr.autoMerge) return null;
  if (pr.autoMergeWanted === "turnedOff") return AUTO_MERGE_TURNED_OFF_LINE;
  if (pr.autoMergeWanted === "held") return AUTO_MERGE_HELD_LINE;
  return null;
}

/** What GitHub's refusal to turn on auto-merge means, in words. Its own
 *  answer goes under Details. */
export function autoMergeRefusedWords(github: string): string {
  const lower = github.toLowerCase();
  const tail = " Merge it from here once checks pass.";
  // G1: the repository's setting is off, or this account may not turn it
  // on — the pull request stays open and Merge is the way on.
  if (
    lower.includes("auto merge is not allowed") ||
    lower.includes("auto-merge is not allowed") ||
    lower.includes("resource not accessible") ||
    lower.includes("does not have permission") ||
    lower.includes("must have admin rights")
  ) {
    // G1: the card's own words for it.
    return "GitHub doesn't allow merging by itself in this repository; press Merge when it's ready.";
  }
  if (lower.includes("protected branch rules not configured")) {
    return "Its base branch requires no checks or reviews, so GitHub has nothing to wait for. Merge it from here.";
  }
  if (lower.includes("clean status")) {
    return "It was ready to merge already, so GitHub didn't wait. Merge it from here.";
  }
  return `Merge when checks pass couldn't be turned on.${tail}`;
}

// ── v1.154.1 walk I3: the Builder session after a ship ──────────────────

/**
 * UX P-A Mac walk 1: what a ship's outcome means for the card's Builder
 * session, or nothing. Only a real ship counts — a pull request opened or a
 * merge that went through; a land stopped on a conflict merged nothing.
 * G11 (1.170.0): nothing asks any more — a pull request's session follows
 * it and closes at Done, a merge here closes it at once, both with Undo
 * (`store/builderAtDone.ts`).
 */
export function shippedSessionKind(res: { kind: string; merged: boolean }): "pr" | "merged" | null {
  if (res.kind === "pr") return "pr";
  return res.merged ? "merged" : null;
}

/** 1.171.0 A3 (DL-11): the press that ships this card with the earlier
 *  changes. Not "Include them and ship as a PR" (Ship as a PR is gone). */
export const SHIP_BOTH_LABEL = "Ship both";
/** Its other way: nothing is pushed. */
export const SHIP_BOTH_NOT_NOW = "Not now";
/** DL-21: the list of the commits, folded under this. */
export const SHOW_THEM_LABEL = "Show them";

/** A land subject (`commit_message::land_subject`: `feat: <title>`, or the
 *  older `Land card: <title>`) or a title, read for comparing: its type
 *  prefix off, spaces collapsed, no full stop, lower case. */
function landKey(text: string): string {
  const t = text.trim().replace(/^Land card: /, "").replace(/^[a-z]+(?:\([^)]+\))?!?: /i, "");
  return t.split(/\s+/).join(" ").replace(/\.+$/, "").toLowerCase();
}

/** DL-11: the cards whose Land commits these subjects are, by title, in the
 *  order of the subjects — the cards are named when they are known. Only a
 *  card that landed here counts (`cardShippedOrPrOpen`, its pull request not the
 *  way it merged): one not shipped, or merged on GitHub, made no such commit. */
export function landedCardTitles(
  subjects: readonly string[],
  cards: readonly (Pick<KanbanCard, "title" | "shipStatus" | "reviewStatus"> & { pr?: Pick<PrStatus, "state"> | null })[],
): string[] {
  const out: string[] = [];
  const landedHere = cards.filter((c) => cardShippedOrPrOpen(c) && c.pr?.state !== "merged");
  for (const subject of subjects) {
    const key = landKey(subject);
    if (!key) continue;
    const card = landedHere.find((c) => c.title.trim() && landKey(c.title) === key);
    if (card && !out.includes(card.title.trim())) out.push(card.title.trim());
  }
  return out;
}

function quoted(titles: readonly string[]): string {
  const q = titles.map((t) => `“${t}”`);
  return q.length <= 1 ? q.join("") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/**
 * R2: Ship it to GitHub stopped before any push (`carries_local_commits`):
 * the pull request would also carry commits that aren't the card's own and
 * aren't on GitHub (`remote`: `worktreeBase.remoteWords`) yet. 1.171.0 A3
 * (DL-11, DL-21): said as what it is — earlier changes on this Mac — with
 * the cards they came from named when known (`cardTitles`,
 * `landedCardTitles`), the commits under Show them, and two ways: Not now
 * (the default, nothing pushed) and Ship both.
 */
export function carriesLocalCommitsQuestion(
  local: LocalCommits,
  remote = "GitHub",
  cardTitles: readonly string[] = [],
): {
  title: string;
  body: string;
  items: string[];
  itemsLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  cautious: true;
} {
  const n = local.count;
  const title =
    n === 1
      ? `1 earlier change on this Mac isn't on ${remote} yet`
      : `${n} earlier changes on this Mac aren't on ${remote} yet`;
  const them = n === 1 ? "it" : "them";
  const items = [...local.subjects];
  const more = n - items.length;
  if (more > 0) items.push(`…and ${more} more`);
  const from = cardTitles.length
    ? `${n === 1 ? "It's" : "They're"} from ${cardTitles.length === 1 ? "the card" : "the cards"} ${quoted(cardTitles)}, shipped only on this Mac. `
    : "";
  return {
    title,
    body:
      `${from}${n === 1 ? "It is" : "They are"} on ${local.target} on this Mac, not this card's own work. ` +
      `${SHIP_BOTH_LABEL} sends ${them} to ${remote} in this card's pull request. Nothing has been pushed yet.`,
    items,
    itemsLabel: SHOW_THEM_LABEL,
    confirmLabel: SHIP_BOTH_LABEL,
    cancelLabel: SHIP_BOTH_NOT_NOW,
    cautious: true,
  };
}
