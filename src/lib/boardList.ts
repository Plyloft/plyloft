// UX-5.6: the Board's List view — the same cards as the columns, one row
// each: Title · Status · Builder · Checks · Updated. Pure, so node tests it.
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import { NO_CHECKS_WORD, cardHasNoChecks } from "./checksWords.ts";
import { verifyNotNeeded } from "./skillCards.ts";
import {
  ATTENTION_COLUMNS,
  readyToShipForStage,
  shortDuration,
  type AttentionColumn,
  type AttentionGroups,
  type BoardRunState,
} from "./boardSemantics.ts";
import { swarmTemplateInUse } from "./cardLifecycle.ts";
import type { CardPresentation } from "./cardPresentation.ts";

export type BoardBuilder = "claude" | "codex" | "agent" | "swarm" | "none";

export const BOARD_BUILDER_LABEL: Record<BoardBuilder, string> = {
  claude: "Claude",
  codex: "Codex",
  agent: "Agent",
  swarm: "Swarm",
  none: "None",
};

/** Who builds the card: the Builder session's vendor, else the legacy agent
 *  or swarm binding, else the AI Start build would launch (`effective`, the
 *  card page's Builder: its own pick, else Settings' — 1.171.0 re-walk,
 *  step 4), else nobody yet. */
export function boardBuilder(
  card: Pick<KanbanCard, "builder" | "agentConfigId" | "swarmTemplateId"> &
    Partial<Pick<KanbanCard, "linkedSwarmId" | "columnId">>,
  effective?: "claude" | "codex" | null,
): BoardBuilder {
  if (card.builder?.vendor) return card.builder.vendor;
  if (swarmTemplateInUse(card)) return "swarm";
  if (card.agentConfigId) return "agent";
  return effective ?? "none";
}

const CHECKS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

/** The Checks column: the verify pipeline's word, or a dash. GH #333: a
 *  pass with no checks set up says so, never "Passed". */
export function boardChecksLabel(card: Pick<KanbanCard, "verifyStatus" | "verifyHistory">): string {
  // Skills hub H3a: a skill card's commit changed only skill files.
  if (card.verifyStatus === "passed" && verifyNotNeeded(card.verifyHistory)) return "Not needed";
  if (cardHasNoChecks(card)) return NO_CHECKS_WORD;
  return CHECKS_LABEL[card.verifyStatus ?? "none"] ?? "—";
}

/** "Just now", "6m ago", "3h ago", "2d ago". */
export function updatedLabel(updatedAt: number, now: number): string {
  const ms = now - updatedAt;
  if (ms < 60_000) return "Just now";
  return `${shortDuration(ms)} ago`;
}

export interface BoardListRow {
  id: string;
  card: KanbanCard;
  title: string;
  status: string;
  /** C7: the Status is "Blocked by …" (drawn with the blockedBy icon). */
  blocked: boolean;
  run: { state: BoardRunState; live: boolean };
  builder: BoardBuilder;
  checks: string;
  updatedAt: number;
  /** P-A: the rule of `presentCard` the Status came from. */
  rule: string;
  /** CL-9: in the stage grouping, where the card needs the person — its
   *  Board column, said on the row. */
  attention?: AttentionColumn;
}

/** P-A (UX P1 point 2): the row says what `presentCard` says — the same
 *  headline as the Board card and the card page; a held card's Status says
 *  what holds it (C7). */
export function boardListRow(
  card: KanbanCard,
  p: CardPresentation,
  effectiveVendor?: "claude" | "codex" | null,
): BoardListRow {
  return {
    id: card.id,
    card,
    title: card.title,
    status: p.blocked ?? p.headline,
    blocked: p.blocked != null,
    run: p.dot,
    builder: boardBuilder(card, effectiveVendor),
    checks: boardChecksLabel(card),
    updatedAt: card.updatedAt,
    rule: p.rule,
  };
}

export type BoardListSortKey = "title" | "status" | "builder" | "checks" | "updated" | "attention";
export type BoardListSort = { key: BoardListSortKey; dir: "asc" | "desc" } | null;

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Sorted within a group; `null` keeps the Board's own order. Ties keep it
 *  too (the sort is stable). */
export function sortBoardRows(
  rows: readonly BoardListRow[],
  sort: BoardListSort,
): BoardListRow[] {
  if (!sort) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  const text = (r: BoardListRow): string =>
    sort.key === "title"
      ? r.title
      : sort.key === "status"
        ? r.status
        : sort.key === "builder"
          ? BOARD_BUILDER_LABEL[r.builder]
          : r.checks;
  return [...rows].sort((a, b) =>
    sort.key === "updated"
      ? sign * (a.updatedAt - b.updatedAt)
      : sort.key === "attention"
        ? sign * (attentionRank(a) - attentionRank(b))
        : sign * collator.compare(text(a), text(b)),
  );
}

/** CL-9: Needs you, Working, Waiting, Done — the Board's column order. */
function attentionRank(row: Pick<BoardListRow, "attention">): number {
  const i = ATTENTION_COLUMNS.findIndex((c) => c.id === row.attention);
  return i < 0 ? ATTENTION_COLUMNS.length : i;
}

/** CL-9 (round 2, F1): sorted within a stage, what needs the person stays
 *  first — the chosen key orders the rows inside each attention word. A
 *  sort by Attention itself orders by it, either way. */
export function sortStageRows(
  rows: readonly BoardListRow[],
  sort: BoardListSort,
): BoardListRow[] {
  const sorted = sortBoardRows(rows, sort);
  if (!sort || sort.key === "attention") return sorted;
  return sorted.sort((a, b) => attentionRank(a) - attentionRank(b));
}

// ── CL-9: the List grouped by stage ─────────────────────────────────────

/** How the List groups its rows: by attention (the Board's columns, the
 *  default) or by stage, To do → Finished. Remembered per workspace. */
export type ListGrouping = "attention" | "stage";

export const LIST_GROUPING_OPTIONS: ReadonlyArray<{ value: ListGrouping; label: string }> = [
  { value: "attention", label: "By attention" },
  { value: "stage", label: "By stage" },
];

/** Where the work is, not who acts next: the card's lifecycle, in order. */
export type BoardStage = "to-do" | "in-progress" | "in-review" | "ready-to-ship" | "finished";

export const BOARD_STAGES: ReadonlyArray<{ id: BoardStage; label: string }> = [
  { id: "to-do", label: "Ready to start" },
  { id: "in-progress", label: "Working" },
  { id: "in-review", label: "In review" },
  { id: "ready-to-ship", label: "Ready to ship" },
  { id: "finished", label: "Done" },
];

/**
 * Every canonical state of `cardLifecycle.ts`, in its stage. `null` is the
 * archive, which the List does not show (it has its own row). Two facts
 * move a card on from its state's stage (`boardStageFor`): an open pull
 * request, and a verified result the Ship batch can ship.
 */
export const STATE_STAGE = {
  // To do: nothing is being built yet.
  draft: "to-do",
  "intake-live": "to-do",
  ready: "to-do",
  queued: "to-do",
  // In progress: a build is under way, or stopped part-way.
  running: "in-progress",
  "session-closed": "in-progress",
  paused: "in-progress",
  failed: "in-progress",
  // In review: a build is done and is being judged.
  "challenger-reviewing": "in-review",
  "changes-requested": "in-review",
  checking: "in-review",
  "verify-failed": "in-review",
  "result-ready": "in-review",
  "review-stale": "in-review",
  "no-changes": "in-review",
  // Ready to ship.
  "ready-to-ship": "ready-to-ship",
  shipping: "ready-to-ship",
  // Finished: it landed (shipped or merged), or it was closed with nothing
  // to land. Not "Done": that is an Attention word on the same row.
  shipped: "finished",
  closed: "finished",
  archived: null,
} as const satisfies Record<CardPresentationState, BoardStage | null>;

export function boardStageFor(
  state: CardPresentationState,
  facts: {
    /** SL-1: its work is in a pull request still open on GitHub. */
    openPullRequest: boolean;
    /** Ready to ship as the Board's chip says (`boardSaysReadyToShip`). */
    shipEligible: boolean;
  },
): BoardStage | null {
  if (state === "shipped" && facts.openPullRequest) return "ready-to-ship";
  if (state === "result-ready" && facts.shipEligible) return "ready-to-ship";
  return STATE_STAGE[state];
}

// CL-10's `readyToShipForStage` lives beside the Board's state words
// (`boardSemantics.ts`, SP-7), which say "Ready to ship" by it too.
export { readyToShipForStage };

/** The card's stage is `cardPresentation.ts::presentationStage`: the same
 *  state and the same ship rule as its chip. */

/** The attention word and dot each row keeps in the stage grouping, so a
 *  card that needs the person is never hidden by it. */
export const ATTENTION_DOT: Record<AttentionColumn, BoardRunState> = {
  "needs-you": "aborted",
  "not-started": "empty",
  working: "running",
  waiting: "empty",
  done: "done",
};

export const ATTENTION_LABEL = Object.fromEntries(
  ATTENTION_COLUMNS.map((c) => [c.id, c.label]),
) as Record<AttentionColumn, string>;

export type StagedCard = { card: KanbanCard; attention: AttentionColumn };

/**
 * The Board's attention groups regrouped by stage. Within a stage, what
 * needs the person comes first — then Working, Waiting, Done — each in the
 * Board's own order. Every card in `groups` lands in exactly one stage.
 */
export function stageGroups(
  groups: AttentionGroups,
  stageOf: (card: KanbanCard) => BoardStage | null,
): Array<{ id: BoardStage; label: string; cards: StagedCard[] }> {
  const byStage = new Map<BoardStage, StagedCard[]>(BOARD_STAGES.map((s) => [s.id, []]));
  for (const column of ATTENTION_COLUMNS) {
    for (const card of groups[column.id]) {
      // Only an archived card has no stage, and the Board's groups hold none;
      // anything else unexpected is shown To do rather than hidden.
      const stage = stageOf(card) ?? "to-do";
      byStage.get(stage)!.push({ card, attention: column.id });
    }
  }
  return BOARD_STAGES.map((s) => ({ id: s.id, label: s.label, cards: byStage.get(s.id)! }));
}
