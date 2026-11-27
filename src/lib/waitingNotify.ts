/**
 * A system notification when a Claude or Codex session finishes a turn and
 * waits for its person — in another workspace, or anywhere while Ply is not
 * in front. The sidebar's stack shows it in the window; this is for when the
 * person is looking elsewhere.
 *
 * Agent runs and swarms already send their own (`agentNotifier.ts`,
 * `swarms.rs`); this covers the sessions nothing notified for.
 *
 * **Not the silence rule.** `deriveTileAttention` calls a tile waiting after
 * ten quiet seconds, which is right for a count but wrong for a notification:
 * a fresh tile nobody has typed into also goes quiet, and a quiet stretch
 * says nothing about a turn. (A resize's redraw no longer restarts that
 * clock — `outputRestartsSilence`, the same `RESIZE_REDRAW_MS` window the
 * readiness scan rebaselines for — so the count holds steady through one.) So a notification is
 * decided from what says a TURN ended:
 *
 * - a PTY tile (Claude, Codex TUI): its header readiness (`tile.readiness`,
 *   which a resize's redraw does not move — Terminal rebaselines it) reads
 *   Ready **and** the tile has left Ready since it started
 *   (`leftReadyAt > startedAt`): it was at its prompt, worked, and is back.
 *   Each such episode is keyed by its `leftReadyAt`, so a redraw never makes
 *   a new one and every real turn does. A tile started with its first prompt
 *   already given (never Ready before that turn) is not told about for that
 *   first turn — the price of never calling a fresh tile finished;
 * - a Codex chat: the App Server's own turn end (`sessionIdleSince`) or an
 *   approval request;
 * - a card's Builder: the strict turn-over matcher (`turnIdle`) with nothing
 *   left to deliver to it.
 *
 * Pure: the tracker is a value, so `waitingNotify.test.ts` runs under node.
 */
import type { Readiness } from "./tileHeaderStatus.ts";
import { askedTitle, finishedTitle, ptyTurnEpisode } from "./needsYou.ts";

/** A session that finishes turn after turn is told about at most once in
 *  this long. */
export const NOTIFY_COOLDOWN_MS = 60_000;

/** One session waiting after a real turn. */
export type TurnEnded = {
  /** The session: `tile:<id>` or `builder:<cardId>`. */
  id: string;
  /** This waiting episode: a new one is news. */
  episode: string;
  workspaceId: string;
  agent: "Claude" | "Codex";
  /** The tile's label or the card's title. */
  where: string;
};

export type TurnTileInput = {
  id: string;
  kind: string;
  label: string;
  status: string;
  startedAt: number;
  readiness?: Readiness;
  submittedAt?: number;
  sessionIdleSince?: number;
  sessionApprovalPending?: boolean;
  sessionTurnStartedAt?: number;
};

export type TurnBuilderInput = {
  workspaceId: string;
  vendor: "claude" | "codex";
  turnIdle?: boolean;
  pending?: readonly unknown[];
};

/** Every session that is waiting after a real turn, now. */
export function turnsEnded(input: {
  tilesByWorkspace: Record<string, { tiles: readonly TurnTileInput[] } | undefined>;
  builders: Record<string, TurnBuilderInput>;
  cardTitle: (workspaceId: string, cardId: string) => string | null;
  now: number;
}): TurnEnded[] {
  const out: TurnEnded[] = [];
  for (const [cardId, b] of Object.entries(input.builders)) {
    if (b.turnIdle !== true || (b.pending?.length ?? 0) > 0) continue;
    out.push({
      id: `builder:${cardId}`,
      episode: `builder:${cardId}`,
      workspaceId: b.workspaceId,
      agent: b.vendor === "codex" ? "Codex" : "Claude",
      where: input.cardTitle(b.workspaceId, cardId) ?? "a card's session",
    });
  }
  for (const [workspaceId, state] of Object.entries(input.tilesByWorkspace)) {
    for (const t of state?.tiles ?? []) {
      if (t.status !== "running") continue;
      const id = `tile:${t.id}`;
      const base = { id, workspaceId, where: t.label };
      if (t.kind === "codex-chat") {
        if (t.sessionApprovalPending === true) {
          out.push({ ...base, agent: "Codex", episode: `${id}@approval:${t.sessionTurnStartedAt ?? 0}` });
        } else if (t.sessionIdleSince != null) {
          out.push({ ...base, agent: "Codex", episode: `${id}@${t.sessionIdleSince}` });
        }
        continue;
      }
      if (t.kind !== "claude" && t.kind !== "codex") continue;
      // QoL 1.168 (D7, Windows walk): a turn is the member's line answered
      // and back at Ready (`ptyTurnEpisode`) — never the CLI's own startup.
      const turn = ptyTurnEpisode(t, input.now);
      if (turn == null) continue;
      out.push({
        ...base,
        agent: t.kind === "claude" ? "Claude" : "Codex",
        episode: `${id}@${turn}`,
      });
    }
  }
  return out;
}

export type WaitingTracker = {
  /** The episodes seen at the last look; null before the first. */
  episodes: ReadonlySet<string> | null;
  /** When each session was last notified. */
  sentAt: ReadonlyMap<string, number>;
};

export const EMPTY_TRACKER: WaitingTracker = { episodes: null, sentAt: new Map() };

/**
 * The sessions to notify about now, and the tracker for the next look.
 *
 * - The first look only records: what already waits when the notifier
 *   starts is not news.
 * - An episode is news once, when it first appears. One that began while
 *   the person was looking at it is not news later, after a switch.
 * - `onScreen` is the workspace the person is looking at — the active one
 *   while Ply is focused and visible, none otherwise. Its sessions show in
 *   front of them; every other session notifies, including another
 *   workspace's while Ply is focused: the stack is in the sidebar, but the
 *   person asked to be told. (`maybeNotifyRunDone` drops only a manual
 *   run's notification while focused — that run's toast is on screen; a
 *   session in another workspace has no toast.)
 */
export function sessionsToNotify(
  tracker: WaitingTracker,
  ended: readonly TurnEnded[],
  onScreen: string | null,
  now: number,
): { notify: TurnEnded[]; next: WaitingTracker } {
  const episodes = new Set(ended.map((s) => s.episode));
  if (tracker.episodes === null) {
    return { notify: [], next: { episodes, sentAt: tracker.sentAt } };
  }
  const sentAt = new Map(tracker.sentAt);
  const notify: TurnEnded[] = [];
  for (const s of ended) {
    if (tracker.episodes.has(s.episode)) continue;
    if (s.workspaceId === onScreen) continue;
    const last = sentAt.get(s.id);
    if (last != null && now - last < NOTIFY_COOLDOWN_MS) continue;
    sentAt.set(s.id, now);
    notify.push(s);
  }
  const live = new Set(ended.map((s) => s.id));
  for (const [id, at] of sentAt) {
    if (!live.has(id) && now - at >= NOTIFY_COOLDOWN_MS) sentAt.delete(id);
  }
  return { notify, next: { episodes, sentAt } };
}

/** The notification's words — the Inbox row's (`waitingWords`), plus the
 *  workspace. */
export function waitingNotification(
  s: Pick<TurnEnded, "agent" | "where"> & Partial<Pick<TurnEnded, "id" | "episode">>,
  workspaceName: string,
): { title: string; body: string } {
  // QoL 1.168 (D7): a tile's turn that ended is "finished"; a Codex chat's
  // approval and a Builder (its card speaks for it) still wait for an answer.
  const finished = s.id?.startsWith("tile:") === true && !(s.episode ?? "").includes("@approval:");
  return {
    title: finished ? finishedTitle(s.agent) : askedTitle(s.agent),
    body: `${workspaceName} · In “${s.where}”`,
  };
}
