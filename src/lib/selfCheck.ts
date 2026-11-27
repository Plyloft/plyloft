/**
 * ADR 0006 (third card) — the Builder's self-check at Build done.
 *
 * Build done first sends the Builder one message (the risk checklist,
 * quoted; `review_passes::self_check_prompt`), waits for it to be back at
 * its prompt, then goes on by itself into the snapshot, Verify and the
 * Challenger. Skip goes straight on; a Builder that is not back within
 * `SELF_CHECK_TIMEOUT_SECS` is skipped, with a note on the card.
 *
 * Pure — no Tauri or React import — so the waiting rule is unit-tested
 * under node. `builderStore` owns the timer and the IPC.
 */

import type { SelfCheckOutcome, SelfCheckRecord } from "../ipc";
import { CHECK_STOPPED_LABEL, CHECKING_WORK_LABEL, checkStoppedSentence, LEAVE_LINE } from "./deliveryWords.ts";

/** The Builder has printed nothing for this long: it is not working. The
 *  same threshold the attention badge uses (`attention.ts::SILENCE_MS`). */
export const SELF_CHECK_SILENCE_MS = 10_000;

/** One self-check in flight, in memory only (a restart kills the session). */
export interface SelfCheckRun {
  workspaceId: string;
  startedAt: number;
  /** When the message reached the Builder's prompt; null while it waits
   *  in the pending queue for the Builder to finish what it was doing. */
  deliveredAt: number | null;
  /** The message: written into the Builder's composer only when its turn is
   *  over (GH #111 F32), and never after the check ended (F5). */
  message: string;
  /** Names this run in the completion line the Builder ends with. */
  token: string;
}

/** What Ply knows about the Builder's terminal right now. */
export interface SelfCheckObservation {
  /** The card's live terminal is attached now (`BuilderSession` mounted)
   *  and scanning every byte. Without it nothing is delivered and nothing
   *  completes: the check waits for Skip or the timeout (the owner's rule,
   *  GH #111). */
  observed?: boolean;
  /** The last output, from the attached terminal or the PTY reader,
   *  whichever is later. */
  lastOutputAt?: number | null;
  /** The last screen scan found the turn over: the idle prompt, with no
   *  running turn and no question in view (`attention::turnIdleMatcherFor`). */
  turnIdle?: boolean;
  /** When the screen was last scanned; a scan older than the last output
   *  says nothing about the screen now. */
  promptScanAt?: number | null;
  /** The Builder printed this run's completion line
   *  (`Self-check complete: N classes (token)`) — GH #111 F2. */
  completionSeen?: boolean;
}

export type SelfCheckStep = "wait" | "answered" | "timedOut";

/** Whether Build done goes on: the Builder answered and is back at its
 *  prompt, or the time is up. */
export function selfCheckStep(
  run: SelfCheckRun,
  seen: SelfCheckObservation,
  now: number,
  timeoutMs: number,
): SelfCheckStep {
  if (now - run.startedAt >= timeoutMs) return "timedOut";
  if (run.deliveredAt == null) return "wait";
  const last = Math.max(seen.lastOutputAt ?? 0, run.deliveredAt);
  // It has to have printed something after the message: the echo of the
  // paste at the least, and then its work.
  if ((seen.lastOutputAt ?? 0) <= run.deliveredAt) return "wait";
  const silent = now - last;
  // A scan older than the last output says nothing about the screen now:
  // keep waiting — silence alone is no answer (GH #111 F2). Reopening the
  // card replays the screen and scans it; Skip and the timeout still end it.
  const screenKnown = seen.promptScanAt != null && seen.promptScanAt >= last;
  // Only the live terminal's own scan counts: a closed card, or a scan older
  // than the Builder's last output, never completes.
  if (seen.observed !== true || !screenKnown) return "wait";
  // Evidence of an answer, not only of a pause (a Codex stream can pause
  // with its composer drawn): the completion line of this run.
  if (seen.completionSeen !== true) return "wait";
  return silent >= SELF_CHECK_SILENCE_MS && seen.turnIdle === true ? "answered" : "wait";
}

/** GH #111 F32: the self-check may be written into the Builder: a scan
 *  newer than its last output shows the turn over — the idle composer, no
 *  question, no running turn — and it has been silent for
 *  `SELF_CHECK_SILENCE_MS` (a Codex stream can pause with its composer
 *  drawn; a pause that short is not the end of a turn). */
export function canDeliver(seen: SelfCheckObservation, now: number): boolean {
  const last = seen.lastOutputAt ?? 0;
  const fresh = seen.promptScanAt != null && seen.promptScanAt >= last;
  return (
    seen.observed === true && fresh && seen.turnIdle === true && now - last >= SELF_CHECK_SILENCE_MS
  );
}

/** A token naming one self-check run: letters and digits after `ply-`. */
export function selfCheckToken(random: () => number = Math.random): string {
  return `ply-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** Whether `screen` shows the run's completion line with its number
 *  filled in — the message itself says `<number of classes>`, so its echo
 *  never matches. */
export function seesCompletion(screen: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Self-check complete:\\s*\\d+\\s+classes\\s*\\(${escaped}\\)`).test(screen);
}

/** `pending` without one copy of `message`: an undelivered self-check taken
 *  back out of the queue, the other messages kept in order. */
export function withoutMessage(pending: readonly string[], message: string): string[] {
  const at = pending.indexOf(message);
  return at < 0 ? [...pending] : [...pending.slice(0, at), ...pending.slice(at + 1)];
}

/** The record the card keeps (`kanban.rs::SelfCheckRecord`). */
export function selfCheckRecord(
  run: SelfCheckRun,
  outcome: SelfCheckOutcome,
  now: number,
): SelfCheckRecord {
  return {
    outcome,
    startedAt: run.startedAt,
    durationMs: Math.max(0, now - run.startedAt),
  };
}

/** What Build done's own message into the session says first after a
 *  self-check it did not wait out; empty when the Builder answered. */
export function selfCheckLead(outcome: SelfCheckOutcome | null): string {
  if (outcome === "skipped") return "The human skipped your self-check. ";
  if (outcome === "timedOut") {
    return "Your self-check did not finish within 10 minutes, so Finish and check went on without it. ";
  }
  return "";
}

/** The note on the card for the last self-check, or null when it is
 *  nothing to remark on. */
export function selfCheckNote(record: SelfCheckRecord | null | undefined): string | null {
  if (!record) return null;
  // 1.171.0 C2 (CF10, CF12): no snapshot numbers and no "Verify" on the card.
  const took = formatDuration(record.durationMs);
  if (record.outcome === "timedOut") {
    return "The Builder didn't finish re-reading its work within 10 minutes, so Plyloft went on to your checks and the review without it.";
  }
  if (record.outcome === "skipped") return `Re-reading its work was skipped after ${took}.`;
  return `Re-reading its work took ${took}.`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

// ── The flow, with its effects injected (the store wires the real ones) ──

/** What the flow needs from the app. `finish` is Build done's own work:
 *  the snapshot, Verify and the Challenger, with the self-check recorded. */
export interface SelfCheckDeps {
  now(): number;
  timeoutMs: number;
  getRun(cardId: string): SelfCheckRun | undefined;
  setRun(cardId: string, run: SelfCheckRun | null): void;
  /** The Builder session is live in this app. */
  sessionAlive(cardId: string): boolean;
  /** The self-check message, or null when none runs (switch off, nothing
   *  new since the last snapshot). */
  message(workspaceId: string, cardId: string, token: string): Promise<string | null>;
  /** Write into the session (the flow has checked `canDeliver`); true once
   *  the write succeeded. */
  send(cardId: string, text: string): Promise<boolean>;
  /** Take an undelivered message back out of the pending queue. */
  unsend(cardId: string, text: string): void;
  /** Build done's own work (`finish`) is running for this card. */
  busy(cardId: string): boolean;
  /** A fresh token for a run. */
  token(): string;
  observe(cardId: string): Promise<SelfCheckObservation>;
  finish(workspaceId: string, cardId: string, check: SelfCheckRecord | null): Promise<unknown>;
  notify(kind: "info" | "warn", title: string, body: string, details?: string): void;
  /** The card's Builder AI, by name ("Claude", "Codex"). */
  ai?(cardId: string): string;
}

export type BuildDoneStart = "self-check" | "finished" | "already";

/** Build done pressed: send the self-check when the review will run into a
 *  live session and the repository wants one; otherwise straight on. */
export async function startBuildDone(
  deps: SelfCheckDeps,
  workspaceId: string,
  cardId: string,
  skipReview: boolean,
): Promise<BuildDoneStart> {
  if (deps.getRun(cardId) || deps.busy(cardId)) return "already";
  if (!skipReview && deps.sessionAlive(cardId)) {
    let message: string | null = null;
    const token = deps.token();
    try {
      message = await deps.message(workspaceId, cardId, token);
    } catch (e) {
      deps.notify(
        "warn",
        "Self-check not sent",
        "Plyloft couldn't ask the Builder to check its own work. Finish and check goes on without it.",
        String(e),
      );
    }
    if (message) {
      // A second press while the message was being asked for.
      if (deps.getRun(cardId) || deps.busy(cardId)) return "already";
      const startedAt = deps.now();
      // Not written yet: each tick writes it once the Builder's turn is
      // confirmed over (`canDeliver`), the first tick included.
      deps.setRun(cardId, { workspaceId, startedAt, deliveredAt: null, message, token });
      // 1.171.0 C2 (CF3): what happens next, without "Verify" or "prompt";
      // the card's Now says it too, with the time, until it is done.
      deps.notify(
        "info",
        CHECKING_WORK_LABEL,
        `When the Builder is done re-reading its work, Plyloft runs your checks and the Reviewer reviews it. ${LEAVE_LINE}`,
      );
      return "self-check";
    }
  }
  await deps.finish(workspaceId, cardId, null);
  return "finished";
}

/** One look at the Builder: settle the self-check when it answered or the
 *  time is up; drop it when the session ended (nothing is snapshotted
 *  behind the human's back). */
export async function tickSelfCheck(
  deps: SelfCheckDeps,
  cardId: string,
): Promise<SelfCheckStep | "ended" | "none"> {
  const current = deps.getRun(cardId);
  if (!current) return "none";
  if (!deps.sessionAlive(cardId)) {
    deps.setRun(cardId, null);
    if (current.deliveredAt == null) deps.unsend(cardId, current.message);
    // 1.171.0 C2 (Challenger 3): the card's own words — Finish and check
    // again leads, Resume is beside it.
    deps.notify("warn", CHECK_STOPPED_LABEL, checkStoppedSentence(deps.ai?.(cardId) ?? "Claude", false));
    return "ended";
  }
  const seen = await deps.observe(cardId);
  // Read again after the await: Skip may have settled it meanwhile.
  let run = deps.getRun(cardId);
  if (!run) return "none";
  // GH #111 F38: an expired run is settled before anything is written — the
  // observation may have crossed the deadline.
  if (deps.now() - run.startedAt >= deps.timeoutMs) {
    await settleSelfCheck(deps, cardId, "timedOut");
    return "timedOut";
  }
  if (run.deliveredAt == null && canDeliver(seen, deps.now())) {
    const sent = await deps.send(cardId, run.message);
    // Skip may have settled it while the write was under way.
    const current = deps.getRun(cardId);
    if (!current) return "none";
    if (sent && current.token === run.token && current.deliveredAt == null) {
      deps.setRun(cardId, { ...current, deliveredAt: deps.now() });
    }
    run = deps.getRun(cardId) ?? current;
  }
  const step = selfCheckStep(run, seen, deps.now(), deps.timeoutMs);
  if (step !== "wait") await settleSelfCheck(deps, cardId, step);
  return step;
}

/** End a self-check and go on with Build done. The first of the answer,
 *  Skip and the timeout wins; later ones find nothing to settle. */
export async function settleSelfCheck(
  deps: SelfCheckDeps,
  cardId: string,
  outcome: SelfCheckOutcome,
): Promise<boolean> {
  const run = deps.getRun(cardId);
  if (!run) return false;
  deps.setRun(cardId, null);
  // Never delivered: it must not reach the Builder after the snapshot
  // (GH #111 F5).
  if (run.deliveredAt == null) deps.unsend(cardId, run.message);
  if (outcome === "timedOut") {
    deps.notify(
      "warn",
      "Re-reading skipped",
      "The Builder didn't finish re-reading its work within 10 minutes, so Plyloft went on to your checks and the review without it.",
    );
  }
  try {
    await deps.finish(run.workspaceId, cardId, selfCheckRecord(run, outcome, deps.now()));
  } catch {
    // `finish` reports its own failure.
  }
  return true;
}
