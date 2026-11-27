/**
 * G7 (1.170.0): the driver of "Fix failing checks by itself". It watches
 * the loaded boards and the Builder sessions, asks `lib/prAutoFix.ts` what
 * comes next for each card whose switch is on, and does it — one step at a
 * time per card: count the try (`card_pr_auto_fix_begin`), paste the failed
 * logs into the open session when it is at its prompt, Finish and check
 * once the Builder's turn is over, Push update once Verify passed and the
 * Challenger's review settled. Every stop is recorded on the card
 * (`card_pr_auto_fix_stop`, the Inbox row) and said in a toast.
 *
 * It runs in the window because only the window reads the Builder's
 * terminal. Where a try is lives in memory; the record (the heads tried)
 * is on the card, so a relaunch never tries the same head twice — the
 * card's own presses carry on from there. It never resumes a closed
 * session, never answers a prompt, never turns on auto-merge, never merges.
 */
import { create } from "zustand";
import type { KanbanCard, PrAutoFixStopReason } from "../ipc";
import {
  AUTO_FIX_MAX_ATTEMPTS,
  AUTO_FIX_NOT_SHOWN_WORDS,
  autoFixDefaultSince,
  autoFixFailingHead,
  autoFixNext,
  autoFixOn,
  autoFixSaved,
  autoFixStoppedWords,
  type AutoFixPhase,
  type AutoFixSession,
} from "../lib/prAutoFix";
import { prFixKinds } from "../lib/prFix";
import { prFixKey } from "../lib/prFix";
import { sanitizeForPaste } from "../lib/lineComments";
import { cardTrustQuestion } from "../lib/trustQuestion";
import { cardIdOfSessionKey } from "../lib/buildBoth";
import { rawError } from "../lib/cardPage";
import { builderLastOutputAt, cardPrFixMessage } from "../ipc";
import { useKanban } from "./kanbanStore";
import { NOT_AT_PROMPT_ERROR, builderDraftInTheWay, isBuilderObserved, useBuilder } from "./builderStore";
import { useWorkspaces } from "./workspaceStore";
import { dismissToast, pushToast } from "./toastStore";
import { pressOnce, prPushPressKey } from "../lib/pressOnce";

/** `deliverWhenIdle`'s key: Fix with the Builder's, so a press and the
 *  loop never paste the same fix twice at once. */
const PR_FIX_KEY = "pr-fix";
/** How often the bounds (a busy Builder's grace, a step's limit) are read
 *  again with nothing else changing. */
const TICK_MS = 15_000;
/** G7 fixes (M1): how long a "live in Plyloft" answer for a card whose
 *  terminal isn't attached stands before it is asked again. */
const LIVE_TTL_MS = 10_000;
/** The detail of a try no window followed to its end. */
const INTERRUPTED_DETAIL = "Plyloft stopped following this try before it ended (it was closed or restarted).";

type PrAutoFixState = {
  /** Where each card's try is, by card id. */
  phases: Record<string, AutoFixPhase | undefined>;
  /** When each card's Builder was first seen busy for its failing head. */
  busySince: Record<string, number | undefined>;
};

export const usePrAutoFix = create<PrAutoFixState>(() => ({ phases: {}, busySince: {} }));

function setPhase(cardId: string, phase: AutoFixPhase | null) {
  usePrAutoFix.setState((s) => {
    const phases = { ...s.phases };
    const busySince = { ...s.busySince };
    if (phase) phases[cardId] = phase;
    else delete phases[cardId];
    delete busySince[cardId];
    return { phases, busySince };
  });
}

function setBusySince(cardId: string, at: number | null) {
  usePrAutoFix.setState((s) => {
    const busySince = { ...s.busySince };
    if (at == null) delete busySince[cardId];
    else busySince[cardId] = at;
    return { busySince };
  });
}

/** G7 fixes (M1): per card, whether its session was live in Plyloft's
 *  registry when last asked (`builder_last_output_at`), and when. */
const liveSeen = new Map<string, { live: boolean; at: number }>();

/** Ask the registry whether the card's session is live (its card not
 *  shown, its terminal not attached). Cached for `LIVE_TTL_MS`. */
async function refreshLive(card: Pick<KanbanCard, "id" | "builder">, now: number): Promise<void> {
  const seen = liveSeen.get(card.id);
  if (seen && now - seen.at < LIVE_TTL_MS) return;
  let live = false;
  if (card.builder?.ptyId) {
    try {
      live = (await builderLastOutputAt(card.id)) != null;
    } catch {
      live = false;
    }
  }
  liveSeen.set(card.id, { live, at: now });
}

/** The card's Builder session as the loop reads it. */
export function sessionOf(card: Pick<KanbanCard, "id" | "builder">): AutoFixSession {
  const b = useBuilder.getState();
  const rt = b.byCard[card.id];
  // 1.176.2 (A5F-02): the runtime outlives its card's terminal, its screen
  // read frozen at the last scan; only a terminal attached now is attached.
  const attached = Boolean(
    rt && card.builder?.ptyId && rt.ptyId === card.builder.ptyId && isBuilderObserved(card.id),
  );
  const live = !attached && Boolean(card.builder?.ptyId) && liveSeen.get(card.id)?.live === true;
  const blocked = Object.keys(b.sessionBlocks).some((k) => cardIdOfSessionKey(k) === card.id);
  const asking = Boolean(rt?.questionInView) || cardTrustQuestion(card.id, b.trustAsking) != null || blocked;
  const held =
    (rt?.pending.length ?? 0) > 0 ||
    Boolean(rt?.composerEscaped) ||
    builderDraftInTheWay(card.id) ||
    Boolean(b.fixBusy[card.id]) ||
    Boolean(b.doneBusy[card.id]) ||
    Boolean(b.selfCheck[card.id]);
  return {
    attached,
    live,
    promptIdle: rt?.promptBoxIdle === true,
    turnIdle: rt?.turnIdle === true,
    turnIdleAt: rt?.turnIdleAt ?? null,
    asking,
    held,
  };
}

// One step at a time per card; a head the backend said isn't the loop's
// now (`not_now`, `already_tried`), or whose stop after a try couldn't be
// written, is not asked about again in this window. A stop before a try
// isn't settled: it clears on its own (G7 fixes, M1).
const inFlight = new Set<string>();
const settledHeads = new Set<string>();

function cardNow(workspaceId: string, cardId: string): KanbanCard | undefined {
  return useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === cardId);
}

/** Since when the workspace's default is on (null: off). */
function workspaceDefault(workspaceId: string): number | null {
  return autoFixDefaultSince(useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId));
}

/** Record a stop. `soft`: before a try was counted for `head` (M1) — it
 *  clears on its own, so the head isn't settled, and the same stop isn't
 *  written or said twice. */
async function stopTry(
  card: KanbanCard,
  head: string,
  reason: PrAutoFixStopReason,
  detail?: string | null,
  soft = false,
) {
  setPhase(card.id, null);
  if (soft) {
    const latest = cardNow(card.workspaceId, card.id) ?? card;
    const stop = latest.pr?.autoFix?.stopped;
    if (stop && stop.head === head && stop.reason === reason) return;
  } else {
    settledHeads.add(`${card.id}\u0000${head}`);
  }
  try {
    await useKanban.getState().stopPrAutoFix(card.workspaceId, card.id, head, reason, detail ?? null);
  } catch (e) {
    console.warn("prAutoFix: couldn't record the stop", e);
    if (soft) settledHeads.add(`${card.id}\u0000${head}`);
  }
  if (reason === "not_shown") {
    waitToasts.set(card.id, pushToast({
      kind: "info",
      title: AUTO_FIX_NOT_SHOWN_WORDS,
      body: `Pull request #${card.pr?.number}: its checks failed. Plyloft starts fixing them once the card is shown.`,
    }));
    return;
  }
  const id = pushToast({
    kind: "warn",
    title: autoFixStoppedWords(reason),
    body: soft
      ? `Pull request #${card.pr?.number}: Plyloft starts once that's settled, or open the card to fix it yourself.`
      : `Pull request #${card.pr?.number}: open the card to fix it yourself.`,
    details: detail ?? undefined,
  });
  if (soft) waitToasts.set(card.id, id);
}

/** Walk 7: the toasts that say a try starts later ("…once that's settled",
 *  "…once the card is shown"), by card. */
const waitToasts = new Map<string, string>();

/** The switch went off (Undo of Turn on, the card's switch): a toast that
 *  says the fix starts later is no longer true, and goes. */
export function forgetAutoFixWaitToast(cardId: string): void {
  const id = waitToasts.get(cardId);
  if (id == null) return;
  waitToasts.delete(cardId);
  dismissToast(id);
}

/** G7 fixes (M2): the session is ready for the paste right now — attached,
 *  at its prompt with nothing typed, its turn over, nothing asking, nothing
 *  of Plyloft's or the member's waiting. The reason when it isn't. */
function notReady(card: KanbanCard): PrAutoFixStopReason | null {
  const session = sessionOf(card);
  if (!session.attached) return session.live ? "session_busy" : "session_closed";
  if (session.asking) return "question";
  if (!session.promptIdle || !session.turnIdle || session.held) return "session_busy";
  return null;
}

async function beginTry(card: KanbanCard, head: string) {
  const begin = await useKanban.getState().beginPrAutoFix(card.workspaceId, card.id, head);
  if (begin.kind === "exhausted") {
    settledHeads.add(`${card.id}\u0000${head}`);
    pushToast({
      kind: "warn",
      title: autoFixStoppedWords("exhausted"),
      body: `Pull request #${card.pr?.number}: its checks on GitHub still fail. Open the card to fix it yourself.`,
    });
    return;
  }
  if (begin.kind !== "started") {
    settledHeads.add(`${card.id}\u0000${head}`);
    return;
  }
  const attempt = begin.attempt;
  setPhase(card.id, { step: "sending", head, attempt, at: Date.now() });
  let message: string;
  try {
    const fix = await cardPrFixMessage(card.workspaceId, card.id, true);
    message = sanitizeForPaste(fix.message);
  } catch (e) {
    await stopTry(card, head, "gather_failed", rawError(e));
    return;
  }
  // G7 fixes (M2): the gather took a while — the switch and the session
  // are read again, and the failed logs go only into a session ready for
  // them now: never held for later, never through the held-message valve.
  const latest = cardNow(card.workspaceId, card.id) ?? card;
  if (!autoFixOn(latest, workspaceDefault(card.workspaceId)) || latest.pr?.headSha !== head) {
    setPhase(card.id, null);
    return;
  }
  const busy = notReady(latest);
  if (busy) {
    await stopTry(latest, head, busy);
    return;
  }
  const written = useBuilder.getState().deliverWhenIdle(card.id, message, undefined, PR_FIX_KEY, { noHold: true });
  if (written === null) {
    await stopTry(latest, head, "session_closed");
    return;
  }
  try {
    await written;
  } catch (e) {
    const reason = (e as Error)?.message === NOT_AT_PROMPT_ERROR ? "session_busy" : "not_delivered";
    await stopTry(latest, head, reason, reason === "not_delivered" ? rawError(e) : null);
    return;
  }
  const after = cardNow(card.workspaceId, card.id) ?? latest;
  setPhase(card.id, {
    step: "working",
    head,
    attempt,
    at: Date.now(),
    snapshots: after.builder?.snapshots.length ?? 0,
  });
  // The card shows the fix round (walk I4's key) — G7 fixes (M3): only when
  // the failed checks are all the pull request needs; with a review or a
  // conflict too, Fix with the Builder stays offered for those.
  if (after.pr && prFixKinds(after.pr).join(",") === "checks") {
    const key = prFixKey(after.pr);
    useBuilder.setState((s) => ({ fixSent: { ...s.fixSent, [card.id]: key } }));
  }
  pushToast({
    kind: "info",
    title: "Fixing the failed checks by itself",
    body: `Try ${attempt} of ${AUTO_FIX_MAX_ATTEMPTS}: the failed logs of pull request #${card.pr?.number} went to the Builder. When it's done, Plyloft runs Finish and check and pushes the fix.`,
  });
}

async function finishTry(card: KanbanCard, phase: AutoFixPhase) {
  const snapshots = card.builder?.snapshots.length ?? 0;
  const idleAtFinish = useBuilder.getState().byCard[card.id]?.turnIdleAt ?? null;
  setPhase(card.id, { step: "finishing", head: phase.head, attempt: phase.attempt, at: Date.now(), snapshots });
  let result;
  try {
    result = await useBuilder.getState().done(card.workspaceId, card.id);
  } catch (e) {
    await stopTry(card, phase.head, "finish_failed", rawError(e));
    return;
  }
  // Null: its self-check went to the Builder first; the snapshot follows.
  if (result && !result.newSnapshot) {
    // Walk 7: the turn went on after Finish and check began (its end was
    // only a pause): back to waiting for it, never "didn't change anything".
    const now = sessionOf(cardNow(card.workspaceId, card.id) ?? card);
    if (!now.turnIdle || !now.promptIdle || (now.turnIdleAt ?? 0) > (idleAtFinish ?? 0)) {
      setPhase(card.id, { step: "working", head: phase.head, attempt: phase.attempt, at: phase.at, snapshots, turnStarted: true });
      return;
    }
    await stopTry(card, phase.head, "no_change");
  }
}

async function pushTry(card: KanbanCard, phase: AutoFixPhase) {
  // 1.175.0 F7 round 2: the switch may have gone off since this step was
  // chosen (Undo of Turn on, a card's switch): the try ends quietly, as
  // `sendTry` does — never a push Rust then refuses, said as a stop.
  const latest = cardNow(card.workspaceId, card.id) ?? card;
  if (!autoFixOn(latest, workspaceDefault(card.workspaceId))) {
    setPhase(card.id, null);
    return;
  }
  // 1.176.2 F2 (review F1): the card's own Send the fixes to GitHub and this
  // loop share one slot. While the person's push runs, this step does
  // nothing — no try counted, no "push refused", the phase as it was — and
  // the next tick reads what that push did (a new head on GitHub: forget).
  const pushed = await pressOnce(prPushPressKey(card.workspaceId, card.id), async () => {
    setPhase(card.id, { step: "pushing", head: phase.head, attempt: phase.attempt, at: Date.now() });
    try {
      // 1.174.0 B6 (CH-3): `auto` — Rust refuses it unless every G7 condition
      // holds; this loop's own checks are no longer the only gate.
      const r = await useKanban.getState().pushPrUpdate(card.workspaceId, card.id, true);
      if (!r.pushed) {
        await stopTry(card, phase.head, "push_refused", [r.refused, r.git].filter(Boolean).join("\n") || null);
        return false;
      }
    } catch (e) {
      await stopTry(card, phase.head, "push_refused", rawError(e));
      return false;
    }
    return true;
  });
  if (pushed !== true) return;
  setPhase(card.id, { step: "pushed", head: phase.head, attempt: phase.attempt, at: Date.now() });
  pushToast({
    kind: "info",
    title: "Fix pushed",
    body: `Try ${phase.attempt} of ${AUTO_FIX_MAX_ATTEMPTS} is on pull request #${card.pr?.number}; checks on GitHub run on it again.`,
  });
}

/** One card, once: the next step, if any, started. Exported for tests. */
export async function stepCard(card: KanbanCard, now = Date.now()): Promise<void> {
  if (inFlight.has(card.id)) return;
  const { phases, busySince } = usePrAutoFix.getState();
  let phase = phases[card.id] ?? null;
  if (!phase && !autoFixOn(card, workspaceDefault(card.workspaceId))) return;
  const failing = autoFixFailingHead(card.pr);
  if (!phase) {
    if (!failing) {
      if (busySince[card.id] != null) setBusySince(card.id, null);
      return;
    }
    if (settledHeads.has(`${card.id}\u0000${failing}`)) return;
  }
  // G7 fixes (M1): a session not attached here may be live with its card
  // not shown — asked of the registry, not taken for closed.
  if (!sessionOf(card).attached && card.builder?.ptyId) {
    if (inFlight.has(card.id)) return;
    inFlight.add(card.id);
    try {
      await refreshLive(card, now);
    } finally {
      inFlight.delete(card.id);
    }
    card = cardNow(card.workspaceId, card.id) ?? card;
  }
  if (phase?.step === "finishing") {
    const saved = autoFixSaved(phase, card, now);
    if (saved) {
      setPhase(card.id, saved);
      phase = saved;
    }
  }
  const action = autoFixNext({
    card,
    workspaceDefault: workspaceDefault(card.workspaceId),
    session: sessionOf(card),
    phase,
    busySince: busySince[card.id] ?? null,
    now,
  });
  switch (action.do) {
    case "wait":
      return;
    case "note-busy":
      setBusySince(card.id, now);
      return;
    case "forget":
      setPhase(card.id, null);
      return;
    case "note-turn":
      if (phase?.step === "working") setPhase(card.id, { ...phase, turnStarted: true });
      return;
    case "hold":
      // 1.175.0 B2: waiting for the checks' OK spends no time of the try.
      if (phase?.step === "checking" && now - phase.at >= 30_000) setPhase(card.id, { ...phase, at: now });
      return;
  }
  inFlight.add(card.id);
  try {
    switch (action.do) {
      case "begin":
        await beginTry(card, action.head);
        break;
      case "stop":
        // Before a try is counted (no phase), a stop clears on its own —
        // unless it says a counted try went unfollowed.
        if (!phase && action.reason === "not_delivered") {
          await stopTry(card, action.head, action.reason, INTERRUPTED_DETAIL);
        } else {
          await stopTry(card, action.head, action.reason, null, !phase);
        }
        break;
      case "finish":
        if (phase) await finishTry(card, phase);
        break;
      case "push":
        if (phase) await pushTry(card, phase);
        break;
    }
  } catch (e) {
    console.warn("prAutoFix: a step failed", e);
    setPhase(card.id, null);
    if (failing) settledHeads.add(`${card.id}\u0000${failing}`);
  } finally {
    inFlight.delete(card.id);
  }
}

/** The cards the loop steps: an open pull request whose fixing by itself
 *  is on, or one it is already stepping. */
function watchedCards(): KanbanCard[] {
  const phases = usePrAutoFix.getState().phases;
  const out: KanbanCard[] = [];
  for (const [workspaceId, board] of Object.entries(useKanban.getState().byWorkspace)) {
    const on = workspaceDefault(workspaceId);
    for (const card of board?.cards ?? []) {
      if (!phases[card.id] && (card.pr?.state !== "open" || !autoFixOn(card, on))) continue;
      out.push(card);
    }
  }
  return out;
}

function stepAll() {
  for (const card of watchedCards()) void stepCard(card);
}

/** 1.174.0 (E13, CH-10): what the loop reads of the Builder, for the cards
 *  it steps only (`sessionOf`). The Builder's store changes on every
 *  session's output; a change that leaves this the same is no step. */
export function builderWatchKey(): string {
  const cards = watchedCards();
  if (cards.length === 0) return "";
  return cards
    .map((card) => `${card.id}:${JSON.stringify(sessionOf(card))}`)
    .join("|");
}

let started = false;
let pending: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    stepAll();
  }, 300);
}

/** Started once, at launch (`App.tsx`). */
export function startPrAutoFix(): void {
  if (started) return;
  started = true;
  useKanban.subscribe((s, prev) => {
    if (s.byWorkspace !== prev.byWorkspace) schedule();
  });
  let seenBuilder = builderWatchKey();
  useBuilder.subscribe(() => {
    const key = builderWatchKey();
    if (key === seenBuilder) return;
    seenBuilder = key;
    schedule();
  });
  useWorkspaces.subscribe(schedule);
  setInterval(schedule, TICK_MS);
}

/** The person turned the card's switch on again: the heads this window
 *  stopped on may be tried again (the record's stop is cleared too, unless
 *  the tries ran out). */
export function forgetPrAutoFixStops(cardId: string): void {
  for (const key of [...settledHeads]) if (key.startsWith(`${cardId}\u0000`)) settledHeads.delete(key);
  setPhase(cardId, null);
}

/** Tests only: forget what this window remembered. */
export function resetPrAutoFixForTests(): void {
  inFlight.clear();
  settledHeads.clear();
  liveSeen.clear();
  waitToasts.clear();
  usePrAutoFix.setState({ phases: {}, busySince: {} });
}
