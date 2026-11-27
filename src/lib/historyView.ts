/**
 * QoL 11.1 (F8): History's tabs, filters and numbers — pure, so the rules
 * are tested once (`node --experimental-strip-types src/lib/historyView.test.ts`).
 *
 * The feed (inbox.rs `assemble_activity`) sends a card once per kind — its
 * ships, its checks, its Builder rounds — with `count` the events the row
 * stands for. Every number History shows is read from the rows it lists
 * under the same filter, so the totals and the list always agree.
 */
import type { ActivityRow } from "../ipc.ts";
import { NO_CHECKS_WORD } from "./checksWords.ts";

export type HistoryTab = "runs" | "ships" | "checks" | "sessions" | "discussions" | "cleanup";

/** The tabs in their order, with their names. Cleanup shows only when it
 *  has rows (worktree trash passes). */
export const HISTORY_TABS: readonly { id: HistoryTab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "ships", label: "Ships" },
  { id: "checks", label: "Checks" },
  { id: "sessions", label: "Sessions" },
  { id: "discussions", label: "Discussions" },
  { id: "cleanup", label: "Cleanup" },
];

/** The tab a feed row is listed under — the same split as Rust's
 *  `activity_tab`. Runs holds agent runs, swarms and Builder rounds. */
export function historyTabOf(kind: ActivityRow["kind"]): Exclude<HistoryTab, "sessions"> {
  switch (kind) {
    case "run":
    case "swarm":
    case "build":
      return "runs";
    case "ship":
      return "ships";
    case "verify":
      return "checks";
    case "discussion":
      return "discussions";
    default:
      return "cleanup";
  }
}

export interface HistoryFilter {
  /** One workspace, or every one (null). */
  workspaceId: string | null;
  /** Typed words; matches the title, the workspace and the detail. */
  text: string;
}

/** Whether a text filter matches any of the given strings (case-insensitive,
 *  every word somewhere). An empty filter matches everything. */
export function textMatches(text: string, ...fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter(Boolean).join(" \u0000 ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function filterHistoryRows(rows: readonly ActivityRow[], filter: HistoryFilter): ActivityRow[] {
  return rows.filter(
    (r) =>
      (filter.workspaceId == null || r.workspaceId === filter.workspaceId) &&
      textMatches(filter.text, r.title, r.workspaceName, r.detail),
  );
}

/** How many events a row stands for (older feeds send no `count`). */
export function rowCount(r: Pick<ActivityRow, "count">): number {
  return r.count ?? 1;
}

export interface HistoryNumbers {
  /** Rows per tab — what each tab lists. */
  perTab: Record<Exclude<HistoryTab, "sessions">, number>;
  /** Agent runs and swarms (Runs rows that are not a card's Builder work),
   *  and how many of them failed or stopped. */
  agentRuns: number;
  agentFailed: number;
  /** Builder rounds (one per Finish and check), and the cards they were on. */
  builderRounds: number;
  builderCards: number;
  /** Ships: the cards shipped (rows) and every ship (events). */
  shippedCards: number;
  ships: number;
  /** Checks, per card: the cards whose latest checks passed, of those whose
   *  latest checks ran (a card with no checks set up is neither). */
  checksPassedCards: number;
  checkedCards: number;
  /** 1.174.0 (TX1, T6): the cards whose latest pass had no checks set up. */
  noChecksCards: number;
}

const FAILED_STATES = new Set(["failed", "killed", "aborted", "timed_out", "max_iter", "generation_failed"]);

export function historyNumbers(rows: readonly ActivityRow[]): HistoryNumbers {
  const perTab = { runs: 0, ships: 0, checks: 0, discussions: 0, cleanup: 0 };
  const n: HistoryNumbers = {
    perTab,
    agentRuns: 0,
    agentFailed: 0,
    builderRounds: 0,
    builderCards: 0,
    shippedCards: 0,
    ships: 0,
    checksPassedCards: 0,
    checkedCards: 0,
    noChecksCards: 0,
  };
  for (const r of rows) {
    const tab = historyTabOf(r.kind);
    perTab[tab] += 1;
    if (tab === "runs") {
      if (r.kind === "build") {
        n.builderCards += 1;
        n.builderRounds += rowCount(r);
      } else {
        n.agentRuns += 1;
        if (FAILED_STATES.has(r.state)) n.agentFailed += 1;
      }
    } else if (tab === "ships") {
      n.shippedCards += 1;
      n.ships += rowCount(r);
    } else if (tab === "checks") {
      if (r.state === "passed") {
        n.checksPassedCards += 1;
        n.checkedCards += 1;
      } else if (r.state === "failed") n.checkedCards += 1;
      else if (r.state === "no_checks") n.noChecksCards += 1;
    }
  }
  return n;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Shipped fact: "12", or "14 times, 12 cards" when cards shipped again. */
export function shippedWords(n: Pick<HistoryNumbers, "shippedCards" | "ships">): string {
  if (n.ships > n.shippedCards) return `${n.ships} times, ${plural(n.shippedCards, "card")}`;
  return String(n.shippedCards);
}

/** The Checks fact: "2 of 3 cards passed their latest checks". 1.174.0
 *  (TX1, T6; WALK 14): a tab whose every row had no checks set up says so in
 *  the card's own words (`NO_CHECKS_WORD`), never "None run" beside them. */
export function checksWords(
  n: Pick<HistoryNumbers, "checksPassedCards" | "checkedCards" | "noChecksCards"> & {
    perTab: Pick<HistoryNumbers["perTab"], "checks">;
  },
): string {
  if (n.checkedCards === 0 && n.noChecksCards > 0 && n.noChecksCards === n.perTab.checks) {
    return `${NO_CHECKS_WORD} on these cards`;
  }
  if (n.checkedCards === 0) return "None run";
  return `${n.checksPassedCards} of ${plural(n.checkedCards, "card")} passed their latest checks`;
}

/** The Other AI runs fact (the Runs that are not a card's Builder work;
 *  "Agent runs" before 1.174.0): "4", "4, 1 failed". */
export function agentRunWords(n: Pick<HistoryNumbers, "agentRuns" | "agentFailed">): string {
  return n.agentFailed > 0 ? `${n.agentRuns}, ${n.agentFailed} failed` : String(n.agentRuns);
}

/** The Builder fact: "9 cards, 14 rounds" — the cards first, so they and
 *  the other AI runs add up to the Runs tab (1.174.0, TX1 T5, owner). */
export function builderWords(n: Pick<HistoryNumbers, "builderRounds" | "builderCards">): string {
  return `${plural(n.builderCards, "card")}, ${plural(n.builderRounds, "round")}`;
}

/** What a folded row adds after its result: "2 times", "3 rounds",
 *  "last of 2 runs" (a card's checks show their latest result). */
export function countWords(r: Pick<ActivityRow, "kind" | "count">): string | null {
  const c = rowCount(r);
  if (r.kind === "build") return c === 0 ? null : plural(c, "round");
  if (r.kind === "ship" && c > 1) return `${c} times`;
  if (r.kind === "verify" && c > 1) return `last of ${c} runs`;
  return null;
}

/** A tab's number. `listed` is the tab's rows as sent (after the 200-row
 *  cap), `total` its rows before the cap, `matches` those of the listed ones
 *  the text filter keeps. Without a text filter: every row the tab has. With
 *  one: the matches, and "+" when the tab was cut, so more may match. */
export function tabCountWords(matches: number, listed: number, total: number | undefined, textFiltered: boolean): string {
  const all = Math.max(total ?? listed, listed);
  if (!textFiltered) return String(all);
  return all > listed ? `${matches}+` : String(matches);
}

/** Whether a tab was cut by the cap. */
export function tabCut(listed: number, total: number | undefined): boolean {
  return total != null && total > listed;
}

/** 1.168.1 (A4, Windows walk): the rows of a card deleted on this Mac but
 *  not yet in the backend's feed — its Undo window is still open (the delete
 *  runs only when it ends), or the backend is still clearing its worktree —
 *  read as deleted now: marked, opening nothing. An Undo gives them back. */
export function withPendingDeletes(rows: ActivityRow[], pending: Readonly<Record<string, string>>): ActivityRow[] {
  if (!rows.some((r) => r.cardId != null && pending[r.cardId] === "delete")) return rows;
  return rows.map((r) =>
    r.cardId != null && pending[r.cardId] === "delete" ? { ...r, cardId: null, cardDeleted: true } : r,
  );
}

/** A row that opens something: a card, or a standalone run's output. */
export function rowOpens(r: Pick<ActivityRow, "cardId" | "runId">): "card" | "run" | null {
  if (r.cardId != null) return "card";
  if (r.runId != null) return "run";
  return null;
}
