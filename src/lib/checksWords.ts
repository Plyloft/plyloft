/**
 * GH #333: a project with no verify pipeline still records a pass — Ply keeps
 * `verifyStatus: "passed"` so shipping and its rules are unchanged — but no
 * check ran, so no surface may say "Passed". A pass with no steps is "no
 * checks set up". (`skipped` is the user's skip-verify override; not this.)
 * Pure, so node runs it (`src/lib/checksWords.test.ts`).
 */
import type { KanbanCard, VerifyEntry } from "../ipc.ts";

/** Round 3 / 1.168.1 B3: said after a Finish and check (or an accepted
 *  pushback) on a project with no checks set up — none run. */
export const NO_CHECKS_TO_RUN = "No checks are set up for this project, so there are none to run.";

/** The words every surface uses for a pass with no checks. */
export const NO_CHECKS_WORD = "None set up";
export const NO_CHECKS_SENTENCE = "No checks set up";

/** 1.172.0 D2 (CP-26): a check step's name as the person reads it — never
 *  its kind (`claude-qa`, `npm-test`), which stays in the step's tooltip.
 *  The same words as `inbox.rs::verify_step_words`; any other kind is said
 *  in plain words ("my-lint" → "My lint"). */
export function checkStepWords(kind: string): string {
  const known: Record<string, string> = {
    "cargo-test": "Rust tests",
    "npm-test": "npm tests",
    "ppvp-sh": "Project checks",
    "tauri-build": "App build",
    "claude-qa": "Claude's review",
    shell: "Custom check",
    test: "Tests",
    build: "Build",
  };
  const said = known[kind];
  if (said) return said;
  // A name already in words ("npm test") is said as it is.
  if (!/[-_]/u.test(kind)) return kind.trim() || "Check";
  const plain = kind.replace(/[-_]+/gu, " ").trim();
  return plain ? plain[0].toUpperCase() + plain.slice(1) : "Check";
}

/** One verify entry passed without running a step. */
export function entryHasNoChecks(entry: Pick<VerifyEntry, "status" | "steps"> | null | undefined): boolean {
  return entry?.status === "passed" && (entry.steps ?? []).length === 0;
}

/** The card's checks passed because none are set up: its status is passed
 *  and its last recorded run had no steps. No history keeps "Passed". */
export function cardHasNoChecks(card: Pick<KanbanCard, "verifyStatus" | "verifyHistory">): boolean {
  if (card.verifyStatus !== "passed") return false;
  const history = card.verifyHistory ?? [];
  const last = history[history.length - 1];
  return last != null && entryHasNoChecks(last);
}

/** The message a passed verification injects into the Builder's session.
 *  Zero steps is a project with no checks set up: none ran. */
export function verifyPassedMessage(stepCount: number): string {
  if (stepCount === 0) {
    return "[Plyloft] No checks are set up for this project, so none ran. Nothing else is needed from you unless the review asks for changes.";
  }
  return `[Plyloft] Verification passed (${stepCount} check${stepCount === 1 ? "" : "s"}). Nothing else is needed from you unless the review asks for changes.`;
}
