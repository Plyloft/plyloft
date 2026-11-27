/**
 * GH #309: what History's Result column says for a row's state — plain words
 * from an explicit map, never the backend's state string capitalised with
 * its underscores turned into spaces. Pure, so every state is tested once.
 */
import { shortDuration } from "./boardSemantics.ts";

export type HistoryRunState = "running" | "done" | "aborted" | "empty";

/** Every state the activity feed sends (inbox.rs `activity_feed`,
 *  build_cache.rs), with its dot and its word. */
export const HISTORY_RESULTS: Record<string, { state: HistoryRunState; word: string }> = {
  running: { state: "running", word: "Running" },
  preparing: { state: "running", word: "Preparing" },
  generating: { state: "running", word: "Generating" },
  pending_generation: { state: "running", word: "Waiting to start" },
  done: { state: "done", word: "Done" },
  completed: { state: "done", word: "Done" },
  resolved: { state: "done", word: "Resolved" },
  shipped: { state: "done", word: "Shipped" },
  // QoL 11.1: a card's Builder rounds, folded into one Runs row.
  built: { state: "done", word: "Built" },
  // 1.168.1 (A1): its Builder is building now — the Board's word.
  working: { state: "running", word: "Working" },
  passed: { state: "done", word: "Checks passed" },
  // GH #333: a pass with no checks set up — nothing ran.
  no_checks: { state: "empty", word: "No checks set up" },
  failed: { state: "aborted", word: "Failed" },
  generation_failed: { state: "aborted", word: "Failed to start" },
  killed: { state: "aborted", word: "Stopped" },
  aborted: { state: "aborted", word: "Stopped" },
  interrupted: { state: "aborted", word: "Stopped" },
  timed_out: { state: "aborted", word: "Timed out" },
  max_iter: { state: "aborted", word: "Hit the step limit" },
  paused_provider_unavailable: { state: "aborted", word: "Paused — provider unavailable" },
  suspended: { state: "empty", word: "Paused" },
};

/** A row's result: its dot and word; a state Ply does not know is "Unknown". */
export function historyResult(state: string): { state: HistoryRunState; word: string } {
  return Object.prototype.hasOwnProperty.call(HISTORY_RESULTS, state)
    ? HISTORY_RESULTS[state]
    : { state: "empty", word: "Unknown" };
}

/** The facts block's typical run: "23m", "2h"; under a minute says so. */
export function typicalRun(seconds: number): string {
  return seconds < 60 ? "Under a minute" : shortDuration(seconds * 1000);
}
