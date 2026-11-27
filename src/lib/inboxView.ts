/**
 * UX-4.2 (the Inbox board, ADR 0007): what the Inbox page says — pure, no
 * React and no store, so the words are tested once.
 *
 * - Groups, in order: Needs you · Working · On hold · Scheduled · News.
 *   1.173.0 (F1): Failed folded into Needs you, where the Board has it; a
 *   to-do row stays until it is resolved, never grayed; News (a pull request
 *   merged, a run finished) is cleared on its own. Shipped is not a group:
 *   one quiet line counts this week's ships and opens History.
 * - One sentence under the title sums the page up.
 * - Every row has one action, named for what it does.
 */
import { EDIT_CHOOSE_ACTION, isEditInboxDetail } from "./editConflict.ts";
import type { InboxEvent, InboxFeed, InboxGroup } from "../ipc";
import { USAGE_LIMIT_HEADLINE } from "./sessionBlock.ts";
import { SESSION_WORDS } from "./deliveryWords.ts";
import { PAUSED_ON_CLOSE_HEADLINE, SESSION_CLOSED_HEADLINE } from "./cardLifecycle.ts";
import { BRING_UP_TO_DATE_ACTION, prInboxDetail } from "./prStatus.ts";
import { autoFixStoppedWords } from "./prAutoFix.ts";
import {
  OPEN_CARD_ACTION,
  READY_TO_SHIP_INBOX_DETAIL,
  SHIP_CONFLICT_HEADLINE,
  SHIP_CONFLICT_INBOX_DETAIL,
  SKILL_CARD_READY_INBOX_DETAIL,
  SHIP_IT_ACTION,
  SYNC_CONFLICT_INBOX_PREFIX,
} from "./cardPresentation.ts";
import { syncConflictHeadline } from "./shipConflict.ts";
// 1.172.0 (C2, Challenger 3): a row that opens the card opens its Review.
import { SEE_THE_REVIEW_LABEL } from "./reviewSection.ts";

export type InboxPageGroup = Exclude<InboxGroup, "shipped">;

/** The Board's column words where the two share one (F1). */
export const INBOX_GROUPS: { key: InboxPageGroup; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  // QoL 1.168 block 8 (A3): the app's one word for work going on.
  { key: "running", label: "Working" },
  { key: "on_hold", label: "On hold" },
  { key: "scheduled", label: "Scheduled" },
  { key: "news", label: "News" },
];

/** F1 (BI-7): the On hold row's detail of a card Plyloft's quit paused
 *  (`inbox.rs::PAUSED_ON_CLOSE_DETAIL`). */
export const PAUSED_ON_CLOSE_DETAIL = "paused when Plyloft closed";

/** F1: the News group's one action. */
export const CLEAR_THE_NEWS = "Clear the news";
/** A5 (P10): the ideas row stays, grayed, when the news is cleared. */
export const CLEAR_THE_NEWS_TITLE =
  "Takes the news off the Inbox. What needs you stays until it is done; ideas stay, grayed, until you answer them.";

/** F1 (BI-13): the empty Inbox. */
export const INBOX_EMPTY_TITLE = "Nothing needs you";
export const INBOX_EMPTY_SENTENCE = "When a card needs a decision or a press, it shows up here and on the Board.";
export const GO_TO_THE_BOARD = "Go to the Board";

/**
 * F1: a news row — something that happened and asks nothing: a card's pull
 * request merged (its ship-history row), a standalone run finished (Rust's
 * News group). Shown until seen (opened, or Clear the news), never counted.
 */
export function isNewsRow(ev: Pick<InboxEvent, "group" | "kind" | "seenEligible" | "seenAt">): boolean {
  if (!ev.seenEligible || ev.seenAt != null) return false;
  return ev.group === "news" || (ev.group === "shipped" && (ev.kind === "pr_merged" || ev.kind === "released"));
}

/** F1: what Clear the news marks seen — the news rows on the page. */
export function newsRowIds(events: readonly InboxEvent[]): string[] {
  return events.filter(isNewsRow).map((e) => e.id);
}

/**
 * 1.174.0 (A5, P10, D4 b): a Next improvement row is News, never counted —
 * but it asks a choice, so seeing it (opening it, or Clear the news) greys
 * it instead of taking it away; it goes once every idea has an answer
 * (`inbox.rs` stops deriving it), and a new round is a new, unseen row.
 */
export function isIdeasRow(ev: Pick<InboxEvent, "kind">): boolean {
  return ev.kind === "next_improvement_ideas";
}

/** A5: the rows the News section draws: the unseen news, and the ideas
 *  rows seen or not. */
export function onNewsShelf(ev: Pick<InboxEvent, "group" | "kind" | "seenEligible" | "seenAt">): boolean {
  return isNewsRow(ev) || (isIdeasRow(ev) && ev.seenEligible);
}

/** A5 (inbox.html scene 3): the ideas row's detail — "New · " before the
 *  round's byline until it is seen, then what it still waits for. */
export const IDEAS_SEEN_DETAIL = "Seen · waiting for your answer";
export function ideasRowDetail(ev: Pick<InboxEvent, "detail" | "seenAt">): string {
  if (ev.seenAt != null) return IDEAS_SEEN_DETAIL;
  const byline = ev.detail?.trim();
  return byline ? `New · ${byline}` : "New";
}

/** F1: the row kinds that say something failed — a Needs you row since
 *  1.173.0, which keeps its amber dot and sorts first. */
const FAILURE_KINDS: ReadonlySet<InboxEvent["kind"]> = new Set<InboxEvent["kind"]>([
  "card_failed",
  "verify_failed",
  "run_failed",
  "pr_checks_failed",
]);
export function isFailureRow(ev: Pick<InboxEvent, "kind" | "detail">): boolean {
  if (ev.kind === "pr_auto_fix_stopped") return ev.detail !== "not_shown";
  return FAILURE_KINDS.has(ev.kind);
}

/**
 * F1's hook for E3 (Next improvement): the row of a round's ideas —
 * "Next improvement for Site: 3 ideas" with *Look at the ideas*. 1.174.0
 * (A5): a News row, never counted (`isIdeasRow`). E3's
 * `next_improvement_ideas` rows, whose title `inbox.rs` writes in these same
 * words (`next_improvement_row_title`).
 */
export const LOOK_AT_THE_IDEAS = "Look at the ideas";
export function nextImprovementRowWords(area: string | null, ideas: number): { title: string; action: string } {
  const n = ideas === 1 ? "1 idea" : `${ideas} ideas`;
  return { title: area ? `Next improvement for ${area}: ${n}` : `Next improvement: ${n}`, action: LOOK_AT_THE_IDEAS };
}

/**
 * 1.174.0 (A5, inbox.html scene 1): Needs you in the order that says where
 * to start — a failure first (F1, BI-10), then a pull request to merge, then
 * a card to ship, then the rest; stable within each.
 */
export function needsYouOrder<T extends { failure?: boolean; press?: "merge" | "ship" }>(items: readonly T[]): T[] {
  const rank = (i: T) => (i.failure ? 0 : i.press === "merge" ? 1 : i.press === "ship" ? 2 : 3);
  return items
    .map((item, at) => ({ item, at }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.at - b.at)
    .map((x) => x.item);
}

/** F1 (BI-7): two cards or more paused by Plyloft's quit are one On hold
 *  row per workspace: "3 cards paused when Plyloft closed". */
export function pausedRowWords(titles: readonly string[]): { title: string; detail: string } {
  const shown = titles.slice(0, 3).map((t) => `“${t}”`).join(", ");
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
  return {
    title: `${titles.length} cards paused when Plyloft closed`,
    detail: `${shown}${more} · Resume each on its card`,
  };
}

/**
 * OB-9 (onboarding §10 row 6): the feed as the Inbox draws it. Solo mode
 * leaves out the pull requests waiting for your review — a team tier item —
 * from the rows and from every count read off the feed. The feed itself is
 * untouched (presentation only), so the same object comes back when there is
 * nothing to leave out.
 */
export function feedForMode<F extends Pick<InboxFeed, "events">>(
  feed: F | null,
  solo: boolean,
): F | null {
  if (!feed || !solo || !feed.events.some((e) => e.kind === "pr_review")) return feed;
  return { ...feed, events: feed.events.filter((e) => e.kind !== "pr_review") };
}

/** A group longer than this shows its first rows and "Show all N". */
export const INBOX_GROUP_CAP = 12;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How many cards shipped in the seven days before `now`. */
export function shippedThisWeek(events: readonly InboxEvent[], now: number): number {
  return events.filter(
    (e) => e.group === "shipped" && e.at != null && e.at >= now - WEEK_MS,
  ).length;
}

/** The one sentence under the title: "3 things need you, 2 are working,
 *  1 on hold." — or "Nothing needs you." F1 (BI-14): it counts what still
 *  needs the person, never what was seen. */
export function inboxSummary(counts: {
  needs: number;
  running: number;
  onHold?: number;
  scheduled?: number;
}): string {
  const first =
    counts.needs === 0
      ? "Nothing needs you"
      : counts.needs === 1
        ? "1 thing needs you"
        : `${counts.needs} things need you`;
  const rest: string[] = [];
  if (counts.running > 0) {
    rest.push(counts.running === 1 ? "1 is working" : `${counts.running} are working`);
  }
  if ((counts.onHold ?? 0) > 0) rest.push(`${counts.onHold} on hold`);
  if ((counts.scheduled ?? 0) > 0) rest.push(`${counts.scheduled} scheduled`);
  return `${[first, ...rest].join(", ")}.`;
}

/**
 * The section's number. F1 (one count): Needs you says the one attention
 * count (`attentionCounts`) — the sidebar's, the Board's Needs you column's
 * for a project — no number when nothing there counts (a usage limit is
 * listed, grey, not counted). The other groups count their rows; News has
 * no number (it asks nothing).
 */
export function inboxSectionCount(group: InboxPageGroup, rows: number, needs: number): string | null {
  if (group === "news") return null;
  if (group !== "needs_you") return String(rows);
  return needs > 0 ? String(needs) : null;
}

/** QoL 14.2 (F7): a review-requested pull request's row actions. */
export const REVIEW_WITH_CHALLENGER_ACTION = "Have it reviewed";
export const OPEN_REVIEW_CARD_ACTION = "Open the review card";

/** QoL 14.2 (F7): the pull request a `pr_review` row is about, out of its
 *  stable id `pr:<owner/name>#<number>` (`inbox.rs`). `null` for any other. */
export function prOfInboxId(id: string): { repo: string; number: number } | null {
  const m = /^pr:([^#\s]+\/[^#\s]+)#(\d+)$/.exec(id);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** QoL 14.2 (F7): the live card that reviews that pull request, if any. */
export function reviewCardOf<C extends { id: string; archived?: boolean; prReview?: { repo: string; number: number } | null }>(
  cards: readonly C[],
  pr: { repo: string; number: number },
): C | null {
  const lower = pr.repo.toLowerCase();
  return (
    cards.find(
      (c) => !c.archived && c.prReview?.number === pr.number && c.prReview.repo.toLowerCase() === lower,
    ) ?? null
  );
}

/** The row's one action; `null` is the chevron that opens it. */
export type InboxAction = string | null;

/** What the row knows about its card beyond the event: whether the card can
 *  ship now (`isShipBatchEligible`, on a Board that is not read-only), and
 *  with which checks. */
export type InboxRowContext = {
  ship?: "passed" | "none" | "skipped" | null;
  /** SL-2: the card's pull request has something its Builder can fix
   *  (`prFix.ts::prFixOffered`), on a Board that is not read-only. */
  fix?: boolean;
  /** UX P-A Mac walk 2: the card's Board is read-only (no Ship it). */
  readOnly?: boolean;
  /** UX P-A Mac walk 2: the Ship batch takes the card; when not, Ship it
   *  opens the card's own Ship step. */
  batch?: boolean;
  /** QoL 14.2 (F7): a review-requested pull request already has its
   *  "Review: …" card on the loaded Board. */
  prCard?: boolean;
  /** 1.169.1 (R1): the card's Now offers Merge (`prFix.ts::prMergeReady`),
   *  on a Board that is not read-only: the row's Merge is that press. */
  merge?: boolean;
};

/** 1.169.1 (R1): the row action that merges the card's pull request — the
 *  card's own Merge (`card_pr_merge`). */
export const MERGE_ACTION = "Merge";

/** G5 (1.170.0): the row action of a merged card whose project folder is
 *  still behind GitHub's — the card's own press (`card_bring_up_to_date`). */
export { BRING_UP_TO_DATE_ACTION };

/** Block 10 Mac walk: the chip a row shows. A team-library skill's scripts
 *  (`skill_needs_ok`) belong to no one workspace — the backend files the row
 *  under the active one only so its Library opens there — so its chip names
 *  the team library, not whichever workspace was active. */
export const TEAM_LIBRARY_CHIP = "Team library";
export function inboxChipName(ev: Pick<InboxEvent, "kind" | "workspaceName">): string {
  return ev.kind === "skill_needs_ok" ? TEAM_LIBRARY_CHIP : ev.workspaceName;
}

/** 1.175.0 B2: the row of an install step waiting for this Mac's OK. */
export function isInstallOkRow(ev: Pick<InboxEvent, "kind" | "id">): boolean {
  return ev.kind === "shared_setting_conflict" && ev.id.startsWith("install-ok:");
}

/** The detail line and the action of one feed row. `ship` marks the row
 *  action that ships the card ("Ship it"). 1.174.0 (A5, P16): no row action
 *  is filled — every one is bordered, as the Board's cards are. */
export function inboxRowWords(
  ev: InboxEvent,
  context: InboxRowContext = {},
): {
  detail: string | null;
  action: InboxAction;
  /** The action is Ship it: it opens the card's Ship step. */
  ship?: boolean;
  fix?: boolean;
  serious?: boolean;
  /** R1: the action is the card's Merge. */
  merge?: boolean;
  /** G5: the action is the card's Bring this computer up to date. */
  upToDate?: boolean;
} {
  switch (ev.kind) {
    case "review_needed": {
      // GH #310: a card the ship rule says can ship offers Ship it.
      if (context.ship) {
        return { detail: READY_TO_SHIP_INBOX_DETAIL[context.ship], action: SHIP_IT_ACTION, ship: true };
      }
      // P-A (UX P1 point 2): a local ship that stopped on a conflict, in the
      // Board's and the card's words, even for a cold workspace.
      if (ev.detail === SHIP_CONFLICT_INBOX_DETAIL) {
        return { detail: SHIP_CONFLICT_HEADLINE, action: OPEN_CARD_ACTION };
      }
      // 1.175.0 (D3): its issue changed on GitHub while it was changed
      // here — the choice is made on the card.
      if (isEditInboxDetail(ev.detail)) return { detail: ev.detail, action: EDIT_CHOOSE_ACTION };
      // 1.170.0 (G6): a conflict met bringing in the target's changes
      // ("Conflict with main"), as the card says it.
      if (ev.detail?.startsWith(SYNC_CONFLICT_INBOX_PREFIX) && ev.id.startsWith("conflict:")) {
        return { detail: syncConflictHeadline(ev.detail.slice(SYNC_CONFLICT_INBOX_PREFIX.length)), action: OPEN_CARD_ACTION };
      }
      // H8 Mac walk: a skill card in a cold workspace's board reads ready to
      // ship, as its Board says once opened (its checks: not needed).
      if (ev.detail === SKILL_CARD_READY_INBOX_DETAIL) {
        return { detail: READY_TO_SHIP_INBOX_DETAIL.none, action: OPEN_CARD_ACTION };
      }
      // CL-3: a P1 open on the review ("1 serious issue · changes
      // requested") is said as it is, in weight — no colour, no notification.
      if (ev.detail && SERIOUS_DETAIL.test(ev.detail)) {
        return { detail: ev.detail, action: SEE_THE_REVIEW_LABEL, serious: true };
      }
      const detail =
        ev.detail === "changes requested — needs you"
          ? "Changes requested"
          : ev.detail === "complete — decide what happens next"
            ? "Waiting for you to decide what happens next"
            : ev.detail ?? "The work is done · review it";
      return { detail, action: SEE_THE_REVIEW_LABEL };
    }
    case "skill_change_waiting":
      return { detail: ev.detail, action: "See the change" };
    // Skills hub H6a: the sheet is where the OK is given.
    case "skill_needs_ok":
      return { detail: ev.detail, action: "Decide" };
    // Skills hub H2 (R16): Settings › Team asks the question.
    case "library_access_lost":
      return { detail: ev.detail, action: "Open Settings" };
    // Skills hub H4 (R3, R8): the skill's row in the Library asks.
    case "skill_decision":
      return { detail: ev.detail, action: "Choose" };
    // Skills hub H6b walk (R15): Settings › Team names the refused plugin;
    // only the team owner can lift it.
    case "team_plugin_refused":
      return { detail: ev.detail, action: "Open Settings" };
    // 1.173.0 (C3): a shared setting both sides changed — the row opens the
    // question.
    case "shared_setting_conflict":
      // 1.175.0 B2: a release's install step waiting for this Mac's OK
      // rides this kind (`inbox.rs::derive_install_ok_events`); its row
      // opens the sheet.
      if (isInstallOkRow(ev)) return { detail: ev.detail, action: "Decide" };
      return { detail: ev.detail, action: "Choose" };
    // 1.173.0 (E3): a round's ideas — the row opens them above the Board.
    case "next_improvement_ideas":
      return { detail: ideasRowDetail(ev), action: LOOK_AT_THE_IDEAS };
    // QoL 14.2 (F7): the review happens in Plyloft, on the pull request's
    // own card; Open on GitHub and Copy link are the row's quiet extras.
    case "pr_review":
      return { detail: ev.detail, action: context.prCard ? OPEN_REVIEW_CARD_ACTION : REVIEW_WITH_CHALLENGER_ACTION };
    case "run_done":
      return { detail: "The run finished", action: SEE_THE_REVIEW_LABEL };
    case "card_failed": {
      const detail =
        ev.detail === "aborted"
          ? "The run was stopped"
          : ev.detail === "rate-limited"
            ? USAGE_LIMIT_HEADLINE
            : "The run failed";
      return { detail, action: "See what failed" };
    }
    case "verify_failed":
      return { detail: checksFailedDetail(ev.detail), action: "See what failed" };
    case "run_failed":
      return { detail: runFailedDetail(ev.detail), action: "See what failed" };
    case "card_queued":
      return { detail: "In line for a free slot", action: null };
    case "card_running":
      // v1.154.1 (G2): recorded as running, no session runs it (after a
      // relaunch) — under Needs you, in the Board's words.
      // F1 (BI-7): one Plyloft's quit paused is On hold, with Resume.
      if (ev.detail === PAUSED_ON_CLOSE_DETAIL) return { detail: PAUSED_ON_CLOSE_HEADLINE, action: "Resume" };
      if (ev.detail === "session ended") return { detail: SESSION_CLOSED_HEADLINE, action: "Resume" };
      // Round 3: built by both, the pick waits ("Pick one of the two builds").
      if (ev.group === "needs_you" && ev.detail) return { detail: ev.detail, action: null };
      return { detail: SESSION_WORDS.working, action: null };
    case "run_running":
      return { detail: "Running", action: null };
    // SL-1: the card's pull request on GitHub. Each opens the card, where
    // the pull request's checks and review are. SL-2: when its Builder can
    // fix it, that is the row's one action (the row still opens the card).
    case "pr_checks_failed":
      if (context.fix) return { detail: prInboxDetail(ev.kind, ev.detail), action: FIX_ACTION, fix: true };
      return { detail: prInboxDetail(ev.kind, ev.detail), action: "See what failed" };
    case "pr_changes_requested":
    case "pr_conflict":
      if (context.fix) return { detail: prInboxDetail(ev.kind, ev.detail), action: FIX_ACTION, fix: true };
      return { detail: prInboxDetail(ev.kind, ev.detail), action: "Open the card" };
    // 1.169.1 (R1): ready to merge. Merge is the card's own press,
    // offered when the card's Now offers it; otherwise the card says why.
    case "pr_ready_to_merge":
      if (context.merge) return { detail: prInboxDetail(ev.kind, ev.detail), action: MERGE_ACTION, merge: true };
      return { detail: prInboxDetail(ev.kind, ev.detail), action: "Open the card" };
    // G1–G3 Challenger (2): the card offers Merge what's on GitHub now.
    case "pr_head_moved":
    case "pr_closed":
      return { detail: prInboxDetail(ev.kind, ev.detail), action: "Open the card" };
    // G7: where Fix failing checks by itself stopped; the detail is its reason.
    case "pr_auto_fix_stopped":
      return { detail: autoFixStoppedWords(ev.detail ?? ""), action: "Open the card" };
    case "pr_merged":
      return { detail: prInboxDetail(ev.kind, ev.detail), action: null };
    // 1.174.0 (DR4): a release — its cards; a release stopped — why, and
    // Show it opens the Release sheet.
    case "released":
      return { detail: ev.detail, action: null };
    case "release_stopped":
      return { detail: ev.detail, action: SHOW_THE_RELEASE };
    // G5: merged on GitHub; the detail is why this computer stayed behind.
    case "bring_up_to_date":
      return { detail: ev.detail, action: BRING_UP_TO_DATE_ACTION, upToDate: true };
    default:
      return { detail: ev.detail, action: null };
  }
}

/** What started a run (`inbox.rs::derive_run_events`): the whole detail of
 *  a run that failed or was stopped without an error of its own. */
const RUN_TRIGGER_DETAIL = new Set(["manual", "scheduled", "event-triggered", "swarm"]);

/** P-D2 Mac walk: a failed run's detail line. Without an error of its own
 *  the detail is only what started the run ("manual"), which says neither
 *  what failed nor what to do; a run error recorded before P-D2 named
 *  Claude's settings key. */
export function runFailedDetail(detail: string | null | undefined): string {
  if (!detail || RUN_TRIGGER_DETAIL.has(detail)) {
    return "The run stopped before it finished · See what failed shows its output";
  }
  return detail.replace(" (your defaultMode)", "");
}

/** CL-3: the detail `inbox.rs::changes_requested_detail` writes when P1s are open. */
const SERIOUS_DETAIL = /^\d+ serious issues? · changes requested$/;

/** 1.174.0 (DR4): a stopped release's row opens the Release sheet. */
export const SHOW_THE_RELEASE = "Show it";

/** SL-2: the row action that sends the pull request's problem to the card's Builder. */
export const FIX_ACTION = "Fix with the Builder";

/** A fact short enough for the row's detail line ("Rust tests", "2 of 14"). */
const SHORT_FACT = 32;

/**
 * GH #269: "Checks failed", plus at most one short fact. A detail that is the
 * run's raw summary (`verify failed: <script tail>`, `Checks failed: …`) or
 * anything longer than a short fact stays on the card, behind See what failed.
 */
export function checksFailedDetail(detail: string | null): string {
  const fact = detail?.trim() ?? "";
  if (!fact || /^(verify|checks) failed\b/i.test(fact) || fact.length > SHORT_FACT) {
    return "Checks failed";
  }
  return `Checks failed · ${fact}`;
}

/** QoL 14.2 (F7, Challenger): a review-requested pull request's time is
 *  when it was opened — "opened 5m ago", "opened 3h ago", "opened 4d ago",
 *  "opened 3 wk ago"; no time, no words. */
export function prOpenedWords(at: number | null, now: number): string {
  if (at == null) return "";
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return `opened ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `opened ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `opened ${days}d ago`;
  return `opened ${Math.round(days / 7)} wk ago`;
}

/** "now", "4m", "2h", "3d"; a future time (a schedule) is "in 4m". */
export function inboxWhen(at: number | null, now: number): string {
  if (at == null) return "now";
  const delta = at - now;
  const span = (ms: number) => {
    const m = Math.round(ms / 60_000);
    if (m < 60) return `${Math.max(m, 1)}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  };
  if (delta > 60_000) return `in ${span(delta)}`;
  if (-delta < 60_000) return "now";
  return span(-delta);
}

/**
 * Skills hub H6a: the skill a `skill_needs_ok` row is about, out of its stable
 * id `skill:<origin>/<skill>:needs-ok:<ids>` (`skill_scripts::inbox_id`). A
 * skill's name is one directory, so it is the last `/` segment before the
 * state. `null` for any other id.
 */
export function needsOkSkillOf(id: string): string | null {
  const match = /^skill:.+\/([^/:]+):needs-ok:[^:]*$/.exec(id);
  return match ? match[1] : null;
}

/**
 * Skills hub H4: the repository skill a `skill_decision` row is about, out
 * of its stable id `skill-decision:<workspace>:<skill>:<state>:<about>`
 * (`skills_hub_decisions::decision_id`). `null` for any other id.
 */
export function decisionSkillOf(id: string): string | null {
  const match = /^skill-decision:[^:]+:([^:]+):(?:both|removed|renamed):.*$/.exec(id);
  return match ? match[1] : null;
}
