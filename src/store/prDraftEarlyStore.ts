/**
 * 1.175.0 F6 (UX-6; owner I8): the pull request's title and description
 * written while the Reviewer reviews. When a card's review starts on its
 * last build, its live Builder is asked for the draft once it is idle
 * (walk 6.1: again after a busy moment, while that review runs), once
 * for that commit (`card_pr_draft_prepare` with `duringReview`, the request
 * kept on the card as `builder.prDraft`). The draft file is read until it
 * is ready. Ship uses it at once, or waits what is left of the 90 seconds
 * (`builderStore.draftPullRequestFor`, `prDraft.ts::earlyDraftAtShip`).
 *
 * The same guard as Ship's own request: never into a session that isn't at
 * its idle prompt, asks something, holds a message or text the person
 * typed, or would ask before writing the file; then the card says Plyloft
 * writes the text itself. Nothing is written to GitHub here.
 */
import { create } from "zustand";
import type { KanbanCard } from "../ipc";
import { PR_DRAFT_POLL_MS, earlyDraftAtShip, type EarlyDraft, type PrDraftOutcome } from "../lib/prDraft";
import { cardPrDraftForget, cardPrDraftPrepareEarly, cardPrDraftRead } from "../lib/prDraftIpc";
import { canDeliver } from "../lib/selfCheck";
import { builderDraftInTheWay, selfCheckDeps, useBuilder, writePaste } from "./builderStore";
import { useKanban } from "./kanbanStore";
import { useFixRound } from "./fixRoundStore";

const TICK_MS = 2_000;
/** A draft not ready this long after its request is no longer read for. */
const READ_FOR_MS = 10 * 60_000;

type State = { byCard: Record<string, EarlyDraft | undefined> };
export const usePrDraftEarly = create<State>(() => ({ byCard: {} }));

function setEntry(cardId: string, entry: EarlyDraft | null) {
  usePrDraftEarly.setState((s) => {
    const byCard = { ...s.byCard };
    if (entry) byCard[cardId] = entry;
    else delete byCard[cardId];
    return { byCard };
  });
}

function tipOf(card: KanbanCard): { n: number; sha: string } | null {
  const snaps = card.builder?.snapshots ?? [];
  return snaps[snaps.length - 1] ?? null;
}

/** The card's last build is being reviewed now. */
function reviewingTip(card: KanbanCard): boolean {
  const tip = tipOf(card);
  const review = card.builder?.review;
  return Boolean(tip && review && review.status === "running" && review.snapshotN === tip.n);
}

/** Everything of the idle rule that can be read at once: the card's own
 *  session attached, nothing pending, typed, escaped, asked, blocked, no
 *  self-check, save, fix or check by itself under way. Its PTY, or null.
 *  Round 2 (review): asked again right before the request is typed. */
function quietNow(card: Pick<KanbanCard, "id" | "builder">): string | null {
  const s = useBuilder.getState();
  const rt = s.byCard[card.id];
  if (!rt || !card.builder?.ptyId || rt.ptyId !== card.builder.ptyId) return null;
  if (rt.pending.length > 0 || rt.composerEscaped === true || rt.composerDraft === true || builderDraftInTheWay(card.id) || rt.questionInView === true) return null;
  if (s.selfCheck[card.id] || s.doneBusy[card.id] || s.fixBusy[card.id] || s.trustAsking[card.id] || s.sessionBlocks[card.id]) return null;
  // F5: a check Plyloft started by itself is its own turn.
  if (useFixRound.getState().checking[card.id]) return null;
  return rt.ptyId;
}

/** The card's Builder is at its idle prompt with nothing asked or held. */
async function idlePty(card: KanbanCard): Promise<string | null> {
  const pty = quietNow(card);
  if (!pty) return null;
  const seen = await selfCheckDeps().observe(card.id);
  return canDeliver(seen, Date.now()) && quietNow(card) === pty ? pty : null;
}

const inFlight = new Set<string>();

/** One card: ask once per reviewed commit; read until the draft is ready. */
export async function stepEarlyDraft(card: KanbanCard, now = Date.now()): Promise<void> {
  if (card.prReview || !card.builder || card.archived || inFlight.has(card.id)) return;
  const tip = tipOf(card);
  let entry = usePrDraftEarly.getState().byCard[card.id];
  // After a relaunch: the request the card kept.
  if (!entry && card.builder.prDraft) {
    entry = { requestId: card.builder.prDraft.requestId, commit: card.builder.prDraft.commit, askedAt: card.builder.prDraft.askedAt };
    setEntry(card.id, entry);
  }
  // Walk 6.1: a Builder busy at the review's start (answering Plyloft's own
  // "No checks are set up…", say) is asked again once it is idle — only
  // for this commit and while its review runs; then Ship asks, as before.
  // A request that failed at the moment it typed waits for the session's
  // next turn end: never prepared again (a new record each time) per tick.
  const idleAt = useBuilder.getState().byCard[card.id]?.turnIdleAt ?? null;
  const askAgain =
    entry?.commit === tip?.sha &&
    !entry?.requestId &&
    entry?.skip === "busy" &&
    (entry.failedAtIdle === undefined || entry.failedAtIdle !== idleAt);
  if (tip && reviewingTip(card) && (entry?.commit !== tip.sha || askAgain)) {
    inFlight.add(card.id);
    try {
      const pty = await idlePty(card);
      if (!pty) {
        setEntry(card.id, { requestId: null, commit: tip.sha, askedAt: now, skip: "busy" });
        return;
      }
      const ask = await cardPrDraftPrepareEarly(card.workspaceId, card.id, "ship_it").catch(() => null);
      if (!ask?.message || !ask.requestId || ask.ptyId !== pty) {
        // A request the backend kept but nobody will type: forgotten, with
        // the card's record of it (F7 round 2), so Ship asks as before.
        if (ask?.requestId) await cardPrDraftForget(card.workspaceId, card.id, ask.requestId).catch(() => {});
        setEntry(card.id, {
          requestId: null,
          commit: tip.sha,
          askedAt: now,
          skip: ask?.skip ?? "busy",
          ...(ask?.requestId ? { failedAtIdle: idleAt } : {}),
        });
        return;
      }
      // Round 2 (review): the whole guard again at the moment it types — a
      // question, a trust prompt, a block, a self-check, a fix or a check by
      // itself that started during the asking, or keys typed since.
      const latest = useKanban.getState().byWorkspace[card.workspaceId]?.cards.find((c) => c.id === card.id) ?? card;
      if (quietNow(latest) !== pty) {
        // F7 round 2 (review of F6): the request was made and is never typed.
        await cardPrDraftForget(card.workspaceId, card.id, ask.requestId).catch(() => {});
        setEntry(card.id, { requestId: null, commit: tip.sha, askedAt: now, skip: "busy", failedAtIdle: idleAt });
        return;
      }
      await writePaste(pty, ask.message);
      setEntry(card.id, { requestId: ask.requestId, commit: tip.sha, askedAt: now });
    } catch (e) {
      console.warn("prDraftEarly: the draft wasn't asked for", e);
    } finally {
      inFlight.delete(card.id);
    }
    return;
  }
  if (entry?.requestId && !entry.ready && tip && entry.commit === tip.sha && now - entry.askedAt < READ_FOR_MS) {
    inFlight.add(card.id);
    try {
      const read = await cardPrDraftRead(card.workspaceId, card.id).catch(() => null);
      const latest = usePrDraftEarly.getState().byCard[card.id];
      if (read?.state === "ready" && latest?.requestId === entry.requestId) setEntry(card.id, { ...latest, ready: true });
    } finally {
      inFlight.delete(card.id);
    }
  }
}

/** Ship it on a card whose draft was asked during the review: use it now,
 *  or wait only what is left of the 90 seconds (Ship's own "The Builder is
 *  writing the pull request…" line, no toast). Null: ask as before — no
 *  early request, or one for another commit. */
export async function earlyDraftForShip(card: KanbanCard): Promise<PrDraftOutcome | null> {
  const entry = usePrDraftEarly.getState().byCard[card.id];
  const tip = tipOf(card)?.sha ?? null;
  const at = earlyDraftAtShip(entry, tip, Date.now());
  if (at.use === "ask") return null;
  if (at.use === "template") return { kind: "template", why: entry?.skip ?? "no draft asked during the review" };
  if (at.use === "wait") {
    const writing = (on: boolean) =>
      useBuilder.setState((s) => {
        const next = { ...s.prDraftWriting };
        if (on) next[card.id] = true;
        else delete next[card.id];
        return { prDraftWriting: next };
      });
    writing(true);
    try {
      const until = Date.now() + at.ms;
      while (Date.now() < until) {
        const read = await cardPrDraftRead(card.workspaceId, card.id).catch(() => null);
        if (read?.state === "ready") break;
        await new Promise((r) => setTimeout(r, PR_DRAFT_POLL_MS));
      }
    } finally {
      writing(false);
    }
  }
  forgetEarlyDraft(card.id);
  // `card_ship` reads the file for this request and this commit only.
  return { kind: "draft", requestId: at.requestId };
}

/** Read it saved the person's text: the draft is ready. */
export function noteEarlyDraftSaved(cardId: string): void {
  const entry = usePrDraftEarly.getState().byCard[cardId];
  if (entry) setEntry(cardId, { ...entry, ready: true });
}

/** Ship used the request: it is gone. */
export function forgetEarlyDraft(cardId: string): void {
  setEntry(cardId, null);
}

function stepAll() {
  const now = Date.now();
  for (const ws of Object.values(useKanban.getState().byWorkspace)) {
    for (const card of ws?.cards ?? []) {
      if (card.builder && !card.prReview && (card.builder.review?.status === "running" || usePrDraftEarly.getState().byCard[card.id] || card.builder.prDraft)) {
        void stepEarlyDraft(card, now);
      }
    }
  }
}

let started = false;

/** Started once, at launch (`App.tsx`). */
export function startPrDraftEarly(): void {
  if (started) return;
  started = true;
  useKanban.subscribe((s, prev) => {
    if (s.byWorkspace !== prev.byWorkspace) stepAll();
  });
  setInterval(stepAll, TICK_MS);
}

/** Tests only. */
export function resetPrDraftEarlyForTests(): void {
  inFlight.clear();
  usePrDraftEarly.setState({ byCard: {} });
}
