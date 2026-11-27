/**
 * 1.169.0 (A3): "Retry on…" — a finished or failed Builder or Challenger
 * round run again once on another model and effort. Pure: when it is
 * offered, and how a retry reads in Activity. The mirror of `retry_on.rs`;
 * both are held to `retryOn.fixtures.json` (CH-4).
 */

import { ROLE_WORDS } from "./words.ts";
import type { KanbanCard, ModelRetry } from "../ipc.ts";
import type { AgentRole } from "./roleModels.ts";
import { modelSentenceWords } from "./roleModels.ts";

/** The button's words. */
export const RETRY_ON_LABEL = "Retry on…";

type RetryCard = Pick<KanbanCard, "builder"> &
  Partial<Pick<KanbanCard, "buildBoth" | "archived" | "prReview" | "worktreePath">>;

/** Whether the round of `role` can be retried now (owner, 2026-10-23), as
 *  `retry_on::retryable`:
 *  - the Builder: a session that ran and is over — closed, ended on its own
 *    while the app ran, or a failed resume — with real work (a snapshot, or
 *    changes in the copy, which only Rust can see); never one lost when
 *    Plyloft restarted (Resume's), never a record no session ran in, never
 *    while built by both;
 *  - the Challenger: its latest review has settled and reviewed the latest
 *    snapshot;
 *  - never on an archived card nor a pull request's card. */
export function retryOffered(card: RetryCard, role: AgentRole): boolean {
  const builder = card.builder;
  // Owner (c): not on a pull request's card, for now.
  if (!builder || card.archived || card.prReview) return false;
  if (role === "builder") {
    if (builder.ptyId) return false;
    if ((builder.startedAt ?? 0) <= 0) return false;
    // Lost when Plyloft quit or restarted: Resume's (owner a). A session
    // that ended on its own while the app ran is retried.
    if (builder.lostOnRestart) return false;
    // Real work: a snapshot, or (Rust checks) changes in the card's copy.
    if ((builder.snapshots ?? []).length === 0 && !card.worktreePath) return false;
    return !(card.buildBoth && !card.buildBoth.outcome);
  }
  const review = builder.review;
  const status = review?.status as string | undefined;
  if (!status || status === "running" || status === "queued") return false;
  const last = (builder.snapshots ?? [])[(builder.snapshots ?? []).length - 1];
  return !last || last.n <= (review?.snapshotN ?? 0);
}

// G2: the saved role id, in the word on screen (the Reviewer).
const ROLE_WORD: Record<AgentRole, string> = ROLE_WORDS;

const OUTCOME_WORDS: Record<string, string> = {
  finished: "finished",
  stopped: "stopped",
  ended: "ended",
  failed: "failed",
  approve: "approved",
  changes_requested: "changes requested",
  incomplete: "couldn't see enough to judge",
  skipped: "skipped",
  done: "done",
};

function outcomeWords(outcome: string | null | undefined): string | null {
  return outcome ? OUTCOME_WORDS[outcome] ?? outcome : null;
}

/** Activity's entries for one retry (owner C): the attempt it retried and
 *  the retry itself, each with its model and how it ended —
 *  "Builder attempt on gpt-6-astra with high effort · finished",
 *  "Retried the Builder on gpt-6-luna with xhigh effort · running". A
 *  Challenger's earlier attempt is its own review round, listed already. */
export function retryActivityEntries(
  r: Pick<ModelRetry, "role" | "model" | "fromModel" | "fromOutcome" | "fromStartedAt" | "outcome" | "at">,
): { at: number; text: string; earlier: boolean }[] {
  const on = (label: string | null | undefined) => modelSentenceWords(label) ?? "the tool's default";
  const entries: { at: number; text: string; earlier: boolean }[] = [];
  if (r.role === "builder" && r.fromStartedAt) {
    const ended = outcomeWords(r.fromOutcome);
    entries.push({ at: r.fromStartedAt, text: `Builder attempt on ${on(r.fromModel)}${ended ? ` · ${ended}` : ""}`, earlier: true });
  }
  const ended = outcomeWords(r.outcome) ?? "running";
  entries.push({ at: r.at, text: `Retried the ${ROLE_WORD[r.role]} on ${on(r.model)} · ${ended}`, earlier: false });
  return entries;
}

/** The line one retry reads as (the retry's own entry). */
export function retryActivityWords(r: Parameters<typeof retryActivityEntries>[0]): string {
  const entries = retryActivityEntries(r);
  return entries[entries.length - 1]!.text;
}
