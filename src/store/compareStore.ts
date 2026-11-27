// 1.177.0 Compare: the relay bar's state, keyed by workspaceId. In memory
// only — nothing persisted (no localStorage, no workspace JSON): the toggle,
// the pairing, the last answers and the history die with the app, like tiles.
// An answer's text is held here and nowhere else.
import { create } from "zustand";
import type { CompareAnswer, ComparePreparedPaste } from "../lib/compareIpc";
import type { Pass, QuestionState, ReturnHeld, ReturnPending } from "../lib/compareView";
import type { CompareAsk, CompareVendor } from "../lib/compareWords";
import { answerToPass, nextHeld, stampOf } from "../lib/compareView";

/** The open composer: the answer being passed, as it was read. */
export interface Composer {
  from: CompareVendor;
  to: CompareVendor;
  answer: string;
  answerKind?: "text" | "plan";
  chars: number;
  cut: boolean;
  finishedAtMs?: number;
  ask: CompareAsk;
  note: string;
  expanded: boolean;
  busy: boolean;
  /** A sentence under the buttons: a refusal or a failure (never a text). */
  error: string | null;
  /** The press went past the "answer is cut further by the note" notice. */
  cutKnown?: boolean;
  /** Passed again from the history: it carries that pass's own answer. */
  fromHistory: boolean;
  /** 1.177.1: opened on the held answer to a pass (`WsCompare.returnHeld`):
   *  it carries that answer, whatever its tile answered since. */
  held?: boolean;
  /** The tile that had the keyboard when it opened: it gets it back. */
  returnTileId: string | null;
  /** 1.179.0 "Include my question": the member's question in the answer's
   *  turn (`questionFor`), or null when the switch isn't offered (a pass
   *  from the history that went without one). Memory only. */
  question?: QuestionState | null;
  /** The switch: on at each open when there is a question; the member's
   *  "off" lasts for this composer only. */
  includeQuestion?: boolean;
  /** What the backend prepares with the question on, for the preview; the
   *  write prepares again (`deliver`), from the same parts. */
  preview?: ComparePreparedPaste | null;
  /** 1.179.0: the pair it was opened on (`SINGLE_PAIR` when absent). A press
   *  writes only into that pair's tiles. */
  place?: string;
}

/** 1.179.0 two pairs: the state of one pair. With one pair (single-pair
 *  mode, as 1.178.0) it is the workspace's own fields; with two, each pair
 *  has its own under `WsCompare.pairs`, keyed by its place (the project
 *  folder, or a copy's id). Memory only, like everything here. */
export interface PairCompare {
  claudeId: string | null;
  codexId: string | null;
  /** A paired tile closed; its pair was undone. */
  closed: CompareVendor | null;
  answers: Partial<Record<CompareVendor, CompareAnswer>>;
  flipped: boolean;
  /** When each paired tile's newest PLAN answer finished (as seen in the reads
   *  so far); memory only. Says the tile planned, for the default ask. */
  planSeenAt: Partial<Record<CompareVendor, number>>;
  /** Newest first, capped. */
  history: Pass[];
  sent: { to: CompareVendor; at: number; mode: "send" | "put"; chars: number } | null;
  /** 1.177.1: after a pass into a tile, waiting for the first answer that
   *  tile finishes after it (memory only, never logged). */
  returnPending: ReturnPending | null;
  /** 1.177.1: that answer, held and offered back until a pass succeeds, the
   *  member swaps, the pair changes or Compare goes off — 1.179.0: or its
   *  tile finishes a newer answer that is not the answer to a pass
   *  (`heldLapsed`). Its text is held here and nowhere else. */
  returnHeld: ReturnHeld | null;
  /** A sentence for what happened after the composer was gone (text that
   *  reached a box and wasn't sent). Words only, never a text. */
  notice: { words: string; to: CompareVendor; at: number } | null;
}

export interface WsCompare extends PairCompare {
  on: boolean;
  /** One composer per workspace, whichever bar opened it (`Composer.place`). */
  composer: Composer | null;
  /** 1.179.0: two-pair mode's pairs by place; empty in single-pair mode,
   *  whose pair is the fields above. */
  pairs: Record<string, PairCompare>;
}

/** The single-pair mode's key: the workspace's own fields. */
export const SINGLE_PAIR = "";

export const HISTORY_CAP = 50;

const freshPair = (): PairCompare => ({
  claudeId: null,
  codexId: null,
  closed: null,
  answers: {},
  flipped: false,
  planSeenAt: {},
  history: [],
  sent: null,
  returnPending: null,
  returnHeld: null,
  notice: null,
});

const fresh = (): WsCompare => ({
  on: false,
  pairs: {},
  ...freshPair(),
  composer: null,
});

export const EMPTY_COMPARE: WsCompare = fresh();

interface CompareState {
  byWorkspace: Record<string, WsCompare>;
  setOn: (workspaceId: string, on: boolean) => void;
  // 1.179.0: every pair action takes the pair's place last; absent, the
  // single-pair mode's pair (`SINGLE_PAIR`), exactly as before. A place with
  // no pair of its own (a pair just dropped, a read that came back late)
  // changes nothing.
  choose: (workspaceId: string, vendor: CompareVendor, tileId: string, place?: string) => void;
  /** A tile that paired by itself (the only one of its kind) is remembered,
   *  so a second tile opening later doesn't change the pair, and its closing
   *  is noticed. Keeps the answers. */
  adopt: (workspaceId: string, vendor: CompareVendor, tileId: string, place?: string) => void;
  /** Undo a pair whose tile is no longer among the live ones; says which. */
  reconcile: (workspaceId: string, live: ReadonlyArray<{ id: string; vendor: CompareVendor }>, place?: string) => void;
  setAnswer: (workspaceId: string, vendor: CompareVendor, answer: CompareAnswer | null, place?: string) => void;
  /** Swap the direction on offer. With an answer held for a pass, it is
   *  dropped and `flipped` set to `to` (the direction the member chose). */
  flip: (workspaceId: string, to?: boolean, place?: string) => void;
  /** 1.177.1: the pass's tile was seen working after the pass. */
  noteReturnWork: (workspaceId: string, place?: string) => void;
  /** 1.177.1: forget the pass's answer, waited for or held. */
  dropReturn: (workspaceId: string, place?: string) => void;
  /** The workspace's one composer (1.179.0: one at a time, whichever pair). */
  openComposer: (workspaceId: string, composer: Composer) => void;
  patchComposer: (workspaceId: string, patch: Partial<Composer>) => void;
  closeComposer: (workspaceId: string) => void;
  clearSent: (workspaceId: string, place?: string) => void;
  setNotice: (workspaceId: string, notice: { words: string; to: CompareVendor; at: number } | null, place?: string) => void;
  /** Record a pass: history (newest first, capped), and the "sent" state.
   *  1.179.0: numbered within its pair. */
  addPass: (workspaceId: string, pass: Omit<Pass, "n">, place?: string) => Pass;
  /** 1.179.0: follow `pairsOf` — into two-pair mode (the single pair's state
   *  moves to `moveTo`, its place), out of it (`backFrom`'s state becomes the
   *  single pair's), or a pair dropped (its state goes with it). The open
   *  composer follows its pair, or closes when its pair is gone. */
  settlePairs: (workspaceId: string, view: PairsSettle) => void;
}

/** What `settlePairs` needs of `pairsOf`'s answer. */
export interface PairsSettle {
  mode: "single" | "two";
  /** Two-pair mode: the places with a bar. */
  places: readonly string[];
  moveTo: string | null;
  backFrom: string | null;
}

function patch(
  s: CompareState,
  workspaceId: string,
  f: (w: WsCompare) => Partial<WsCompare>,
): Pick<CompareState, "byWorkspace"> {
  const w = s.byWorkspace[workspaceId] ?? fresh();
  return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...w, ...f(w) } } };
}

/** One pair's state as the store has it: the workspace's own fields for the
 *  single pair, else its entry in `pairs` (undefined when it has none). */
export function pairState(w: WsCompare | undefined, place: string = SINGLE_PAIR): PairCompare | undefined {
  if (!w) return undefined;
  return place === SINGLE_PAIR ? w : w.pairs?.[place];
}

/** Only a pair's own fields (no toggle, composer or other pairs). */
function pairFields(w: WsCompare): PairCompare {
  return {
    claudeId: w.claudeId,
    codexId: w.codexId,
    closed: w.closed,
    answers: w.answers,
    flipped: w.flipped,
    planSeenAt: w.planSeenAt,
    history: w.history,
    sent: w.sent,
    returnPending: w.returnPending,
    returnHeld: w.returnHeld,
    notice: w.notice,
  };
}

/** `patch` for one pair. A place with no pair is left alone (never made). */
function patchPair(
  s: CompareState,
  workspaceId: string,
  place: string,
  f: (p: PairCompare, w: WsCompare) => Partial<PairCompare>,
): Pick<CompareState, "byWorkspace"> | CompareState {
  if (place === SINGLE_PAIR) return patch(s, workspaceId, (w) => f(w, w));
  const w = s.byWorkspace[workspaceId];
  const p = w?.pairs?.[place];
  if (!w || !p) return s;
  return {
    byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...w, pairs: { ...w.pairs, [place]: { ...p, ...f(p, w) } } } },
  };
}

/** What Off drops of a pair (it keeps the pairing and the history). */
const OFF_DROPS: Partial<PairCompare> = { answers: {}, sent: null, flipped: false, closed: null, notice: null, returnPending: null, returnHeld: null };

export const useCompare = create<CompareState>((set, get) => ({
  byWorkspace: {},
  setOn: (workspaceId, on) =>
    set((s) =>
      // Off keeps the pairing and the history (they die with the app); the
      // answers, an open composer and a "sent" state go — of every pair.
      on
        ? patch(s, workspaceId, () => ({ on: true }))
        : patch(s, workspaceId, (w) => ({
            on: false,
            ...OFF_DROPS,
            composer: null,
            pairs: Object.fromEntries(Object.entries(w.pairs ?? {}).map(([k, p]) => [k, { ...p, ...OFF_DROPS }])),
          })),
    ),
  choose: (workspaceId, vendor, tileId, place = SINGLE_PAIR) =>
    set((s) =>
      patchPair(s, workspaceId, place, () => ({
        ...(vendor === "claude" ? { claudeId: tileId } : { codexId: tileId }),
        closed: null,
        flipped: false,
        sent: null,
        answers: {},
        planSeenAt: {},
        returnPending: null,
        returnHeld: null,
      })),
    ),
  adopt: (workspaceId, vendor, tileId, place = SINGLE_PAIR) =>
    set((s) => {
      const w = s.byWorkspace[workspaceId];
      const p = pairState(w, place);
      if (!w?.on || !p || (vendor === "claude" ? p.claudeId : p.codexId) === tileId) return s;
      return patchPair(s, workspaceId, place, () => ({
        ...(vendor === "claude" ? { claudeId: tileId } : { codexId: tileId }),
        closed: p.closed === vendor ? null : p.closed,
      }));
    }),
  reconcile: (workspaceId, live, place = SINGLE_PAIR) => {
    const w = get().byWorkspace[workspaceId];
    const p = pairState(w, place);
    if (!w || !w.on || !p) return;
    const has = (id: string | null) => id !== null && live.some((t) => t.id === id);
    const goneClaude = p.claudeId !== null && !has(p.claudeId);
    const goneCodex = p.codexId !== null && !has(p.codexId);
    if (goneClaude || goneCodex) {
      set((s) => {
        const next = patchPair(s, workspaceId, place, (cur) => ({
          claudeId: goneClaude ? null : cur.claudeId,
          codexId: goneCodex ? null : cur.codexId,
          closed: goneClaude ? "claude" : "codex",
          answers: {},
          sent: null,
          flipped: false,
          returnPending: null,
          returnHeld: null,
        }));
        // The composer goes with its pair's tile (only this pair's).
        const nw = next.byWorkspace[workspaceId];
        return nw?.composer && (nw.composer.place ?? SINGLE_PAIR) === place
          ? { byWorkspace: { ...next.byWorkspace, [workspaceId]: { ...nw, composer: null } } }
          : next;
      });
      return;
    }
    // A kind with exactly one tile left pairs by itself again: nothing to say.
    if (p.closed && live.filter((t) => t.vendor === p.closed).length === 1) {
      set((s) => patchPair(s, workspaceId, place, () => ({ closed: null })));
    }
  },
  setAnswer: (workspaceId, vendor, answer, place = SINGLE_PAIR) =>
    set((s) =>
      patchPair(s, workspaceId, place, (w) => {
        const answers = { ...w.answers };
        if (answer) answers[vendor] = answer;
        else delete answers[vendor];
        // Round 5 (final walk, step 13): a Swap applies to the offer the
        // member was looking at. A new finished answer from either tile is a
        // new offer: the flip goes (an answer held for a pass ignores it).
        const before = w.answers[vendor];
        // 1.179.0: a Put into this tile learns the first answer finished after
        // it: the turn that took it (`questionFor`, rule 12).
        const at = answer?.answer ? stampOf(answer, Date.now()) : undefined;
        const history =
          at !== undefined && w.history.some((p) => p.to === vendor && p.mode === "put" && p.answeredAt === undefined && at > p.at)
            ? w.history.map((p) => (p.to === vendor && p.mode === "put" && p.answeredAt === undefined && at > p.at ? { ...p, answeredAt: at } : p))
            : w.history;
        const fresh =
          !!answer?.answer &&
          answer.finishedAtMs != null &&
          (before?.finishedAtMs == null || answer.finishedAtMs > before.finishedAtMs || answer.answer !== before.answer);
        const flipped = fresh && before !== undefined ? false : w.flipped;
        const seen = answer?.answerKind === "plan" && answer.answer ? (answer.finishedAtMs ?? Date.now()) : null;
        const planSeenAt = seen !== null && seen > (w.planSeenAt[vendor] ?? 0) ? { ...w.planSeenAt, [vendor]: seen } : w.planSeenAt;
        // 1.177.1: the first answer the pass's tile finished after the pass
        // is the answer to it, and is held.
        const returnHeld = answerToPass(w.returnPending, vendor, answer, Date.now());
        if (returnHeld) return { answers, planSeenAt, flipped, history, returnHeld, returnPending: null };
        // Review round 1 (H2): a held plan of a turn still open follows that
        // turn (plan v2, then its final answer). 1.179.0: a final one lapses
        // once its tile finishes a newer answer with no pass into it waited
        // for (`heldLapsed`): the bar offers the newest again.
        const held = nextHeld(w.returnHeld, vendor, answer, Date.now(), w.returnPending);
        return held !== w.returnHeld ? { answers, planSeenAt, flipped, history, returnHeld: held } : { answers, planSeenAt, flipped, history };
      }),
    ),
  flip: (workspaceId, to, place = SINGLE_PAIR) =>
    set((s) =>
      patchPair(s, workspaceId, place, (w) => ({ flipped: to ?? !w.flipped, returnHeld: null, returnPending: null })),
    ),
  noteReturnWork: (workspaceId, place = SINGLE_PAIR) =>
    set((s) => {
      const p = pairState(s.byWorkspace[workspaceId], place)?.returnPending;
      return p && !p.sawWork ? patchPair(s, workspaceId, place, () => ({ returnPending: { ...p, sawWork: true } })) : s;
    }),
  dropReturn: (workspaceId, place = SINGLE_PAIR) =>
    set((s) => {
      const w = pairState(s.byWorkspace[workspaceId], place);
      return w && (w.returnPending || w.returnHeld) ? patchPair(s, workspaceId, place, () => ({ returnPending: null, returnHeld: null })) : s;
    }),
  openComposer: (workspaceId, composer) =>
    set((s) =>
      patch(s, workspaceId, (w) => {
        const place = composer.place ?? SINGLE_PAIR;
        if (place === SINGLE_PAIR) return { composer, notice: null };
        // Its pair's notice goes, as the single pair's does.
        const p = w.pairs?.[place];
        return p ? { composer, pairs: { ...w.pairs, [place]: { ...p, notice: null } } } : {};
      }),
    ),
  clearSent: (workspaceId, place = SINGLE_PAIR) =>
    set((s) => (pairState(s.byWorkspace[workspaceId], place)?.sent ? patchPair(s, workspaceId, place, () => ({ sent: null })) : s)),
  setNotice: (workspaceId, notice, place = SINGLE_PAIR) => set((s) => patchPair(s, workspaceId, place, () => ({ notice }))),
  patchComposer: (workspaceId, p) =>
    set((s) => patch(s, workspaceId, (w) => (w.composer ? { composer: { ...w.composer, ...p } } : {}))),
  closeComposer: (workspaceId) => set((s) => patch(s, workspaceId, () => ({ composer: null }))),
  addPass: (workspaceId, pass, place = SINGLE_PAIR) => {
    // 1.179.0: numbered within its pair, from 1.
    const n = (pairState(get().byWorkspace[workspaceId], place)?.history[0]?.n ?? 0) + 1;
    const full: Pass = { ...pass, n };
    set((s) =>
      patchPair(s, workspaceId, place, (w) => ({
        history: [full, ...w.history].slice(0, HISTORY_CAP),
        sent: { to: pass.to, at: pass.at, mode: pass.mode, chars: pass.sent.length },
        flipped: false,
        // 1.177.1: a pass that went through consumes the answer it carried
        // back, and waits for its own target's answer.
        returnHeld: null,
        returnPending: { into: pass.to, at: pass.at, sawWork: false },
      })),
    );
    return full;
  },
  settlePairs: (workspaceId, view) =>
    set((s) => {
      const w = s.byWorkspace[workspaceId];
      if (!w || !w.on) return s;
      const pairs = w.pairs ?? {};
      const keys = Object.keys(pairs);
      const composerPlace = w.composer ? (w.composer.place ?? SINGLE_PAIR) : null;
      if (view.mode === "single") {
        if (keys.length === 0) return s;
        // Back to one pair: the pair that is left carries on as it was.
        const back = view.backFrom !== null ? pairs[view.backFrom] : undefined;
        const composer = w.composer && view.backFrom !== null && composerPlace === view.backFrom ? { ...w.composer, place: SINGLE_PAIR } : null;
        return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...w, ...(back ?? {}), pairs: {}, composer } } };
      }
      const want = view.places;
      if (keys.length === want.length && want.every((p) => p in pairs)) return s;
      const entering = keys.length === 0;
      const next: Record<string, PairCompare> = {};
      for (const p of want) next[p] = pairs[p] ?? (entering && p === view.moveTo ? pairFields(w) : freshPair());
      let composer = w.composer;
      if (composer) {
        if (entering && composerPlace === SINGLE_PAIR && view.moveTo !== null && view.moveTo in next) composer = { ...composer, place: view.moveTo };
        else if (composerPlace === null || !(composerPlace in next)) composer = null;
      }
      // Entering: the single pair's state moved to its place; the fields
      // that held it start empty, as they will be when one pair is left.
      const top = entering ? freshPair() : pairFields(w);
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...w, ...top, pairs: next, composer } } };
    }),
}));

/** One workspace's Compare state (the empty one until it is turned on). */
export function useWsCompare(workspaceId: string): WsCompare {
  return useCompare((s) => s.byWorkspace[workspaceId]) ?? EMPTY_COMPARE;
}

const EMPTY_PAIR: PairCompare = freshPair();

/** 1.179.0: one pair's state (the empty one when it has none). */
export function usePairCompare(workspaceId: string, place: string = SINGLE_PAIR): PairCompare {
  return useCompare((s) => pairState(s.byWorkspace[workspaceId], place)) ?? EMPTY_PAIR;
}
