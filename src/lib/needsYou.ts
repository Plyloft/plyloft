/**
 * UX-4.4 (C4): one attention signal. "Needs you" is one number, counted one
 * way everywhere it shows — the sidebar's Inbox row, each workspace in the
 * switcher, the dock — and every unit of it is a row in the Inbox:
 *
 * - a Needs you item of the feed (persisted state, cold workspaces
 *   included): a card's until the card resolves it, one with no card while
 *   unseen (1.173.0 F1, `countedFeedRow`), and
 * - a live session waiting for its person: a Claude or Codex tile, or a
 *   card's Builder, idle at its prompt (the silence/prompt-box derivation in
 *   `attention.ts`). Ephemeral: it counts while the session waits and goes
 *   when it gets its answer.
 *
 * QoL 1.168 (owner D7): a tile counts only when it asks (a decision, the
 * folder-trust question, the bypass warning, a Codex approval) or when it
 * finished a turn the person has not seen yet (`tileTurnEpisode`, seen in
 * `store/tileSeenStore.ts`). A fresh tile nobody typed into and a turn
 * already seen are not listed; a session at its usage limit (a tile's or a
 * Builder's) is listed `muted` (grey) and counts nowhere.
 *
 * Pure — no React and no store — so the counts and the rows are tested once.
 */
import { cardIdOfSessionKey, parseLaneKey } from "./buildBoth.ts";
import type { BuildLaneId, InboxFeed, KanbanCard, PlanOpenCard } from "../ipc";
import { bothAwaitPick, liveBuilderSessionState } from "./cardLifecycle.ts";
import { deriveTileAttention, type AttentionTile } from "./attention.ts";
import { trustWords, type TrustAsking } from "./trustQuestion.ts";
import { sessionBlockWords, type SessionBlocks } from "./sessionBlock.ts";
import { typingAtPrompt } from "./sessionActor.ts";
import { intakeStoppedWords, type StoppedIntake } from "./intakeStopped.ts";
import { planInboxWords } from "./planExchangeView.ts";
import { tileHeaderStatusFor, type Readiness } from "./tileHeaderStatus.ts";
import { SESSION_WORDS } from "./deliveryWords.ts";

/** A live session waiting for an answer. */
export type WaitingSession = {
  /** Stable while the session waits: `tile:<id>` or `builder:<cardId>`. */
  id: string;
  workspaceId: string;
  /** Who is waiting, for the title: "Claude · Asks you something". */
  agent: "Claude" | "Codex";
  /** What it is, for the detail: the tile's label or the card's title. */
  where: string;
  /** Since when it has been quiet (its last output). */
  since: number;
  /** A card's session; `lane` names which of its two builds (SL-6), so
   *  opening it shows that build (round 3). */
  target: { kind: "tile"; tileId: string } | { kind: "card"; cardId: string; lane?: BuildLaneId };
  /** v1.154.1 (walk G1): it waits on its CLI's folder-trust question.
   *  N14 walk F14: `intake-stopped` — the card's intake conversation ended
   *  while the card still plans; the card offers Plan again and Cancel. */
  question?: "trust" | "intake-stopped" | "plan" | "bypass" | "usage-limit";
  /** UX P-F: a usage limit's reset time as Claude wrote it (`question:
   *  "usage-limit"`). */
  resetsAt?: string | null;
  /** Plan with two AIs: the card's exchange waits for the person or is
   *  paused (`question: "plan"`). */
  plan?: PlanOpenCard;
  /** N14 walk F10: the card's intake conversation asks, not its Builder. */
  intake?: boolean;
  /** N14 walk F14: why the intake stopped (`intakeStopReason`). */
  reason?: string;
  /** UX P1 point 4 (P-B): a card's Builder row — what its session waits
   *  with (`liveBuilderSessionState`'s id): a question, its turn over at its
   *  prompt, or quiet. The Board's column and words read the same fact
   *  (`builderWaiting.ts`). */
  session?: BuilderWaitingState;
  vendor?: "claude" | "codex";
  /** QoL 1.168 (D7): listed grey, not counted — a session at its usage
   *  limit (nothing to do until it resets). */
  muted?: "usage-limit";
  /** QoL 1.168 (D7): a tile's finished turn (`tileTurnEpisode`) — what
   *  marking the row seen records. */
  episode?: string;
};

/** What a waiting Builder waits with. */
export type BuilderWaitingState = "question" | "stopped" | "quiet";

/** UX P1 point 4: the waiting state of a session whose attention waits
 *  (`asking-you` or `wants-you`), as `liveBuilderSessionState` names it. */
export function waitingStateOf(attention: "asking-you" | "wants-you", turnIdle: boolean): BuilderWaitingState {
  if (attention === "wants-you") return "quiet";
  return turnIdle ? "stopped" : "question";
}

export type WaitingTileInput = AttentionTile & {
  id: string;
  label: string;
  /** The header's readiness (`tileStore.markReadiness`): Ready now, and
   *  the last activity, after the member's line. */
  readiness?: Readiness;
  /** When the member last submitted a line (`tileStore.markSubmitted`). */
  submittedAt?: number;
};

/**
 * QoL 1.168 (D7): the turn a tile finished and now waits after, or null when
 * it has had none — a fresh tile nobody typed into, or one still working. A
 * Claude or Codex TUI tile is back at Ready after leaving it since it started
 * (`waitingNotify.ts::turnsEnded`'s rule, so the count and the notification
 * agree), keyed by when it left Ready; a Codex chat by its turn's end. The
 * key is the same for the whole wait and new for every turn.
 */
export function tileTurnEpisode(t: WaitingTileInput, now: number): string | null {
  if (t.status !== "running") return null;
  if (t.kind === "codex-chat") {
    if (t.sessionBusy === true || t.sessionIdleSince == null) return null;
    return `idle@${t.sessionIdleSince}`;
  }
  if (t.kind !== "claude" && t.kind !== "codex") return null;
  return ptyTurnEpisode(t, now);
}

/**
 * QoL 1.168 (D7, Windows walk): a Claude or Codex TUI tile's finished turn —
 * the member submitted a line since it started (`submittedAt`), the screen
 * moved after it (the answer), and the tile reads Ready now. Keyed by that
 * submission, so a redraw, a resize repaint or the CLI's own startup (on
 * ConPTY it leaves Ready and comes back with nobody typing) is never a turn,
 * and a repaint after a seen turn is not a new one. Shared with the
 * notifier (`waitingNotify.ts::turnsEnded`).
 */
export function ptyTurnEpisode(
  t: { status: string; kind: string; startedAt: number; readiness?: Readiness; submittedAt?: number },
  now: number,
): string | null {
  if (t.status !== "running" || (t.kind !== "claude" && t.kind !== "codex")) return null;
  const r = t.readiness;
  const sent = t.submittedAt;
  if (!r || sent == null || sent < t.startedAt) return null;
  if (r.lastOutputAt <= sent) return null;
  if (!tileHeaderStatusFor(t.kind, r, t.startedAt, now).ready) return null;
  return `ready@${sent}`;
}

/** A tile asking its person something: counted while it asks, seen or not. */
function tileAsks(t: WaitingTileInput): boolean {
  if (t.kind === "codex-chat") return t.sessionApprovalPending === true;
  return t.questionInView === true || t.question === "decision" || t.question === "trust" || t.question === "bypass";
}

export type WaitingBuilderInput = {
  workspaceId: string;
  vendor: "claude" | "codex";
  startedAt: number;
  lastOutputAt?: number;
  promptBoxIdle?: boolean;
  /** v1.154.1 (I6): its turn is over at an idle prompt, no question. */
  turnIdle?: boolean;
  /** CL-11: an approval in view — waiting for you at once. */
  questionInView?: boolean;
  /** The scan's turn-over facts (`BuilderRuntime`), read by
   *  `typingAtPrompt` as the session's header reads them. */
  turnIdleAt?: number;
  lastSettledScanAt?: number;
  turnIdleSettled?: boolean;
  /** The PTY this runtime was attached to — checked against the card's
   *  live session (`liveSessionPty`). */
  ptyId?: string;
};

/**
 * PR #347 walk: the card's live session for a session key — its Builder's
 * `ptyId`, or the lane's (SL-6). Null once the session was closed, ended or
 * killed: the backend clears it (`builder::close`, `session_ended`).
 */
export function liveSessionPty(card: KanbanCard, key: string): string | null {
  const lane = parseLaneKey(key)?.lane;
  if (lane) return card.buildBoth?.lanes.find((l) => l.lane === lane)?.ptyId ?? null;
  return card.builder?.ptyId ?? null;
}

/**
 * PR #347 walk: a Builder runtime whose session is gone. The runtime is
 * dropped by its terminal's exit listener, which is not there when the
 * session is closed from the card or ends while its page is not open — so
 * the Inbox kept "Claude is waiting for your answer" for a closed session
 * beside the card's own "Session ended". A runtime counts only while its
 * card's live session is the one it attached to. A card missing from a
 * loaded board (deleted) is gone too; a board not loaded is not judged.
 */
export function builderSessionGone(
  key: string,
  rt: { workspaceId: string; ptyId?: string },
  card: (workspaceId: string, cardId: string) => KanbanCard | null | undefined,
  loaded?: (workspaceId: string) => boolean,
): boolean {
  const owner = card(rt.workspaceId, cardIdOfSessionKey(key));
  if (!owner) return loaded?.(rt.workspaceId) === true;
  const live = liveSessionPty(owner, key);
  if (live == null) return true;
  return rt.ptyId != null && rt.ptyId !== live;
}

function waits(a: ReturnType<typeof deriveTileAttention>): boolean {
  return a === "wants-you" || a === "asking-you";
}

/** Every session waiting for its person, Builders first, per workspace in
 *  the order given. */
export function waitingSessions(input: {
  tilesByWorkspace: Record<string, { tiles: readonly WaitingTileInput[] } | undefined>;
  builders: Record<string, WaitingBuilderInput>;
  cardTitle: (workspaceId: string, cardId: string) => string | null;
  now: number;
  /** v1.154.1 (walk G1): sessions at their CLI's folder-trust question —
   *  waiting whatever their output says, attached here or not. */
  trustAsking?: TrustAsking;
  /** UX P-F (point 8): sessions stopped at Claude's Bypass Permissions
   *  warning or its usage limit — waiting whatever their output says. */
  sessionBlocks?: SessionBlocks;
  /** Round 3 (challenger M1): the card a session belongs to, and when work
   *  last went into each session and its last Build done went through
   *  (`builderStore.sentAt` / `doneAt`). A Builder whose build is done and
   *  that is only idle, and the builds of a card waiting for its pick, are
   *  not waiting for an answer — the card says what it waits on. */
  card?: (workspaceId: string, cardId: string) => KanbanCard | null;
  sentAt?: Record<string, number>;
  /** When a message was last submitted into each session
   *  (`builderStore.submittedAt`): a submit after the scan that found the
   *  turn over is a new turn (UX P-B Mac walk 3). */
  submittedAt?: Record<string, number>;
  doneAt?: Record<string, number>;
  /** Whether a workspace's board is loaded: with `card`, a Builder whose
   *  card was deleted is not waiting (`builderSessionGone`). */
  loaded?: (workspaceId: string) => boolean;
  /** N14 walk F14: intakes that ended while their card still plans
   *  (`lib/intakeStopped.ts::stoppedIntakes`) — each needs the person. */
  intakesStopped?: readonly StoppedIntake[];
  /** (Challenger, P-B) Finish and check is under way for this session key
   *  (its self-check, ADR 0006, or the press itself): a Builder at its
   *  prompt or quiet then is not waiting for the person — the card says the
   *  self-check's words. A question in view still is (CL-11: a self-check
   *  sat six minutes on an approval). */
  finishing?: (sessionKey: string) => boolean;
  /** Plan with two AIs: every open or paused exchange
   *  (`planExchangeStore.open`); one that waits for the person or is paused
   *  is a row, a running one is not. */
  plans?: readonly PlanOpenCard[];
  /** QoL 1.168 (D7): each tile's finished turn the person has seen
   *  (`tileSeenStore`), by tile id. */
  tileSeen?: Readonly<Record<string, string>>;
}): WaitingSession[] {
  const out: WaitingSession[] = [];
  for (const p of input.plans ?? []) {
    if (p.status !== "awaitingMember" && p.status !== "paused") continue;
    const where = input.cardTitle(p.workspaceId, p.cardId);
    // A card a loaded board doesn't have was deleted.
    if (where == null && input.loaded?.(p.workspaceId)) continue;
    const owner = input.card?.(p.workspaceId, p.cardId) ?? null;
    if (owner?.archived) continue;
    // A paused plan doesn't hold the build (P1): once it started, the plan
    // can't be used (Accept is refused) and the card's Now and Board speak
    // of the build — no row asks for the plan.
    if (owner && (owner.columnId !== "todo" || owner.builder != null || owner.buildBoth != null)) continue;
    out.push({
      id: `plan:${p.workspaceId}:${p.cardId}`,
      workspaceId: p.workspaceId,
      agent: p.proposer === "codex" ? "Codex" : "Claude",
      where: where ?? "a card",
      since: p.updatedAt,
      target: { kind: "card", cardId: p.cardId },
      question: "plan",
      plan: p,
    });
  }
  for (const q of input.intakesStopped ?? []) {
    out.push({
      id: `intake-stopped:${q.cardId}`,
      workspaceId: q.workspaceId,
      agent: q.vendor === "codex" ? "Codex" : "Claude",
      where: input.cardTitle(q.workspaceId, q.cardId) ?? "a card",
      since: q.since,
      target: { kind: "card", cardId: q.cardId },
      question: "intake-stopped",
      intake: true,
      reason: q.reason,
    });
  }
  const trust = input.trustAsking ?? {};
  for (const [key, q] of Object.entries(trust)) {
    const card = cardIdOfSessionKey(key);
    const lane = parseLaneKey(key)?.lane;
    out.push({
      id: `builder:${key}`,
      workspaceId: q.workspaceId,
      agent: q.vendor === "codex" ? "Codex" : "Claude",
      where: input.cardTitle(q.workspaceId, card) ?? "a card's session",
      since: input.builders[key]?.lastOutputAt ?? input.builders[key]?.startedAt ?? input.now,
      target: lane ? { kind: "card", cardId: card, lane } : { kind: "card", cardId: card },
      question: "trust",
      ...(q.intake ? { intake: true } : {}),
    });
  }
  const blocks = input.sessionBlocks ?? {};
  for (const [key, q] of Object.entries(blocks)) {
    if (trust[key]) continue;
    const card = cardIdOfSessionKey(key);
    const lane = parseLaneKey(key)?.lane;
    out.push({
      id: `builder:${key}`,
      workspaceId: q.workspaceId,
      agent: q.vendor === "codex" ? "Codex" : "Claude",
      where: input.cardTitle(q.workspaceId, card) ?? "a card's session",
      since: input.builders[key]?.lastOutputAt ?? input.builders[key]?.startedAt ?? input.now,
      target: lane ? { kind: "card", cardId: card, lane } : { kind: "card", cardId: card },
      question: q.kind === "usageLimit" ? "usage-limit" : "bypass",
      ...(q.kind === "usageLimit" ? { resetsAt: q.resetsAt, muted: "usage-limit" as const } : {}),
    });
  }
  for (const [cardId, b] of Object.entries(input.builders)) {
    if (trust[cardId] || blocks[cardId]) continue;
    // PR #347 walk: a closed or ended session is not waiting.
    if (input.card && builderSessionGone(cardId, b, input.card, input.loaded)) continue;
    const a = deriveTileAttention(
      {
        kind: b.vendor === "codex" ? "codex" : "claude",
        status: "running",
        startedAt: b.startedAt,
        lastOutputAt: b.lastOutputAt,
        promptBoxIdle: b.promptBoxIdle,
        questionInView: b.questionInView,
      },
      input.now,
    );
    // UX P-B Mac walk 3: a turn a settled scan found over, nothing submitted
    // since, is the Builder stopped at once — as the session's header and
    // its sidebar row say it (`sessionActor.ts::typingAtPrompt`) — not
    // "Building" for the rest of the ten seconds of silence its last lines
    // started (the walk's Inbox said "Building" beside "Claude · stopped").
    const attention =
      a === "working" &&
      typingAtPrompt(
        { ...b, ptyId: b.ptyId ?? "" },
        input.sentAt?.[cardId] ?? null,
        input.submittedAt?.[cardId] ?? null,
      )
        ? ("asking-you" as const)
        : a;
    if (!waits(attention)) continue;
    const state = waitingStateOf(attention as "asking-you" | "wants-you", b.turnIdle === true);
    if (state !== "question" && input.finishing?.(cardId)) continue;
    // SL-6: a build of a card built by both is that card's.
    const card = cardIdOfSessionKey(cardId);
    const lane = parseLaneKey(cardId)?.lane;
    const owner = input.card?.(b.workspaceId, card) ?? null;
    if (owner) {
      // Round 3 (M1): its builds were compared and the pick waits — the
      // card's own row says so; the two sessions are not two more asks.
      if (lane && owner.buildBoth && bothAwaitPick(owner.buildBoth)) continue;
      // (Challenger, P-B) A build whose Finish and check went through, with
      // nothing sent to it since, waits for the other build, not for the
      // person — as a single Builder whose work is saved. A question stays.
      if (lane && state !== "question") {
        const done = owner.buildBoth?.lanes.find((l) => l.lane === lane)?.done ?? null;
        const sent = input.sentAt?.[cardId] ?? null;
        if (done && (sent == null || sent <= done.at)) continue;
      }
      // Its build is done and it is only idle (quiet, or its turn over at
      // its prompt): its work is saved. A real question stays. P-A: decided
      // on the state's id, never on its words (point 3 renames them).
      if (
        !lane &&
        liveBuilderSessionState(owner, attention, input.sentAt?.[cardId] ?? null, input.doneAt?.[cardId] ?? null, b.turnIdle === true)
          .id === "saved"
      ) {
        continue;
      }
    }
    out.push({
      id: `builder:${cardId}`,
      workspaceId: b.workspaceId,
      agent: b.vendor === "codex" ? "Codex" : "Claude",
      where: input.cardTitle(b.workspaceId, card) ?? "a card's session",
      since: b.lastOutputAt ?? b.startedAt,
      target: lane ? { kind: "card", cardId: card, lane } : { kind: "card", cardId: card },
      session: state,
      vendor: b.vendor,
    });
  }
  for (const [workspaceId, state] of Object.entries(input.tilesByWorkspace)) {
    for (const t of state?.tiles ?? []) {
      if (!waits(deriveTileAttention(t, input.now))) continue;
      // QoL 1.168 (D7): a question counts; a usage limit is listed, grey; a
      // finished turn counts until seen, then leaves the list; anything else
      // (a fresh tile, a quiet one still working) is not listed.
      const asks = tileAsks(t);
      const limit = !asks && t.question === "usageLimit";
      const episode = asks || limit ? null : tileTurnEpisode(t, input.now);
      if (!asks && !limit && episode == null) continue;
      if (episode != null && input.tileSeen?.[t.id] === episode) continue;
      const muted = limit ? ("usage-limit" as const) : undefined;
      out.push({
        ...(muted ? { muted } : {}),
        ...(episode != null ? { episode } : {}),
        id: `tile:${t.id}`,
        workspaceId,
        agent: t.kind === "claude" ? "Claude" : "Codex",
        where: t.label,
        since: t.sessionIdleSince ?? t.lastOutputAt ?? t.startedAt,
        target: { kind: "tile", tileId: t.id },
        // P3: the trust question and the usage limit in their own words.
        ...(t.question === "trust"
          ? { question: "trust" as const }
          : t.question === "usageLimit"
            ? { question: "usage-limit" as const, resetsAt: t.questionResetsAt ?? null }
            : t.question === "bypass"
              ? { question: "bypass" as const }
              : {}),
      });
    }
  }
  return out;
}

/** QoL 1.168 (D7): a finished, unseen turn — the Inbox row, the stack and
 *  the notification say it the same way. */
export function finishedTitle(agent: "Claude" | "Codex"): string {
  return `${agent} finished · see what it did`;
}

/** A session that asks the person something, by the AI's name. */
export function askedTitle(agent: string): string {
  return `${agent} · ${SESSION_WORDS.asks}`;
}

/** The Inbox row's words for a waiting session. */
export function waitingWords(s: WaitingSession): { title: string; detail: string } {
  const tile = s.target.kind === "tile";
  if (s.question === "trust") {
    return trustWords(s.agent === "Codex" ? "codex" : "claude", s.where, tile ? "tile" : s.intake === true ? "intake" : "builder");
  }
  if (s.question === "usage-limit" || s.question === "bypass") {
    const vendor = s.agent === "Codex" ? "codex" : "claude";
    const kind = s.question === "bypass" ? "bypass" : "usageLimit";
    return sessionBlockWords(vendor, kind, s.where, s.resetsAt ?? null, tile ? "tile" : "builder");
  }
  if (s.question === "plan" && s.plan) {
    const words = planInboxWords(s.plan, s.where);
    if (words) return words;
  }
  if (s.question === "intake-stopped") {
    return intakeStoppedWords(s.agent === "Codex" ? "codex" : "claude", s.where, s.reason ?? "");
  }
  // UX P1 point 3 (P-B): a Builder that stopped or went quiet says so, as
  // its card does ("Builder stopped", "Maybe waiting for you").
  // QoL 1.168 (D7, Mac walk): a tile that finished a turn the person hasn't
  // seen did not ask anything — it finished. "Waiting for your answer" is
  // only for a real question or decision.
  if (tile && s.episode != null) return { title: finishedTitle(s.agent), detail: `In “${s.where}”` };
  // 1.171.0 C2 (CF8): the session words, after the AI's name.
  if (s.session === "stopped" || s.session === "quiet") {
    return { title: `${s.agent} · ${SESSION_WORDS.yourTurn}`, detail: `In “${s.where}”` };
  }
  return { title: askedTitle(s.agent), detail: `In “${s.where}”` };
}

/** F1 (BI-14): a feed row the one count counts — a Needs you row. A card's
 *  row counts until the card resolves it, seen or not (it leaves the feed
 *  then). A row with no card behind it (a review someone asked for, a team
 *  plugin refused, a run that failed, a skill's OK) may have nothing the
 *  person can press to resolve it here: it counts only while unseen
 *  (Challenger 1), and reads grayed once seen. 1.174.0 (A5, P10, D4 b): a
 *  Next improvement row is News and never counts, whatever group a feed
 *  gives it, so the sidebar, the Inbox's Needs you and the Board's Needs
 *  you column say one number. */
export function countedFeedRow(
  e: Pick<InboxFeed["events"][number], "group" | "seenEligible" | "cardId" | "seenAt"> &
    Partial<Pick<InboxFeed["events"][number], "kind">>,
): boolean {
  if (e.kind === "next_improvement_ideas") return false;
  return e.seenEligible && e.group === "needs_you" && (e.cardId != null || e.seenAt == null);
}

/** THE count, per workspace: unseen feed attention plus waiting sessions. */
export function needsYouByWorkspace(
  feed: InboxFeed | null,
  waiting: readonly WaitingSession[],
): Record<string, number> {
  return attentionCounts(feed, waiting).byWorkspace;
}

/** The one attention count, and the split the Inbox page's sentence says. */
export type AttentionCounts = {
  /** Per workspace (the switcher, the palette). */
  byWorkspace: Record<string, number>;
  /** Across workspaces (the sidebar's Inbox row, the dock): `needs`. */
  total: number;
  /** Needs you items plus waiting sessions — the page's "N things need
   *  you", the Needs you group's number. */
  needs: number;
};

/**
 * GH #104 walk 2: the sidebar said 23 while the Inbox page said "26 things
 * need you" — the page counted every Needs you row, seen ones too, and the
 * badge (rightly, `docs/ux-language/PATTERNS.md` UX-4.4: "No surface counts
 * attention any other way") counted unseen Needs you and Failed items plus
 * waiting sessions. Both read this now. 1.173.0 (F1, BI-15): one number —
 * the Needs you rows still to do, seen or not, plus waiting sessions — the
 * sidebar's, the page's Needs you group and, per project, the Board's Needs
 * you column (`oneCount.test.ts`).
 */
export function attentionCounts(
  feed: InboxFeed | null,
  waiting: readonly WaitingSession[],
  /** N18: other Needs you rows, per workspace (the card-branch cleanup's
   *  asks), counted as needing you until answered. */
  extra: Readonly<Record<string, number>> = {},
): AttentionCounts {
  const byWorkspace: Record<string, number> = {};
  let needs = 0;
  for (const e of feed?.events ?? []) {
    // F1 (BI-14, BI-15): to-do rows count until resolved, seen or not;
    // news, working, on hold and scheduled rows never count.
    if (!countedFeedRow(e)) continue;
    needs += 1;
    byWorkspace[e.workspaceId] = (byWorkspace[e.workspaceId] ?? 0) + 1;
  }
  for (const s of waiting) {
    // QoL 1.168 (D7): a usage limit is listed, not counted.
    if (s.muted) continue;
    needs += 1;
    byWorkspace[s.workspaceId] = (byWorkspace[s.workspaceId] ?? 0) + 1;
  }
  for (const [workspaceId, n] of Object.entries(extra)) {
    needs += n;
    byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + n;
  }
  return { byWorkspace, total: needs, needs };
}

export function sumCounts(byWorkspace: Record<string, number>): number {
  let total = 0;
  for (const n of Object.values(byWorkspace)) total += n;
  return total;
}
