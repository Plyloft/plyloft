// 1.177.0 Compare: the relay bar's state, keyed by workspaceId. In memory
// only — nothing persisted (no localStorage, no workspace JSON): the toggle,
// the pairing, the last answers and the history die with the app, like tiles.
// An answer's text is held here and nowhere else.
import { create } from "zustand";
import type { CompareAnswer } from "../lib/compareIpc";
import type { Pass, ReturnHeld, ReturnPending } from "../lib/compareView";
import type { CompareAsk, CompareVendor } from "../lib/compareWords";
import { answerToPass, nextHeld } from "../lib/compareView";

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
}

export interface WsCompare {
  on: boolean;
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
   *  member swaps, the pair changes or Compare goes off. Its text is held
   *  here and nowhere else. */
  returnHeld: ReturnHeld | null;
  composer: Composer | null;
  /** A sentence for what happened after the composer was gone (text that
   *  reached a box and wasn't sent). Words only, never a text. */
  notice: { words: string; to: CompareVendor; at: number } | null;
}

export const HISTORY_CAP = 50;

const fresh = (): WsCompare => ({
  on: false,
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
  composer: null,
  notice: null,
});

export const EMPTY_COMPARE: WsCompare = fresh();

interface CompareState {
  byWorkspace: Record<string, WsCompare>;
  setOn: (workspaceId: string, on: boolean) => void;
  choose: (workspaceId: string, vendor: CompareVendor, tileId: string) => void;
  /** A tile that paired by itself (the only one of its kind) is remembered,
   *  so a second tile opening later doesn't change the pair, and its closing
   *  is noticed. Keeps the answers. */
  adopt: (workspaceId: string, vendor: CompareVendor, tileId: string) => void;
  /** Undo a pair whose tile is no longer among the live ones; says which. */
  reconcile: (workspaceId: string, live: ReadonlyArray<{ id: string; vendor: CompareVendor }>) => void;
  setAnswer: (workspaceId: string, vendor: CompareVendor, answer: CompareAnswer | null) => void;
  /** Swap the direction on offer. With an answer held for a pass, it is
   *  dropped and `flipped` set to `to` (the direction the member chose). */
  flip: (workspaceId: string, to?: boolean) => void;
  /** 1.177.1: the pass's tile was seen working after the pass. */
  noteReturnWork: (workspaceId: string) => void;
  /** 1.177.1: forget the pass's answer, waited for or held. */
  dropReturn: (workspaceId: string) => void;
  openComposer: (workspaceId: string, composer: Composer) => void;
  patchComposer: (workspaceId: string, patch: Partial<Composer>) => void;
  closeComposer: (workspaceId: string) => void;
  clearSent: (workspaceId: string) => void;
  setNotice: (workspaceId: string, notice: { words: string; to: CompareVendor; at: number } | null) => void;
  /** Record a pass: history (newest first, capped), and the "sent" state. */
  addPass: (workspaceId: string, pass: Omit<Pass, "n">) => Pass;
}

function patch(
  s: CompareState,
  workspaceId: string,
  f: (w: WsCompare) => Partial<WsCompare>,
): Pick<CompareState, "byWorkspace"> {
  const w = s.byWorkspace[workspaceId] ?? fresh();
  return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...w, ...f(w) } } };
}

export const useCompare = create<CompareState>((set, get) => ({
  byWorkspace: {},
  setOn: (workspaceId, on) =>
    set((s) =>
      // Off keeps the pairing and the history (they die with the app); the
      // answers, an open composer and a "sent" state go.
      on
        ? patch(s, workspaceId, () => ({ on: true }))
        : patch(s, workspaceId, () => ({ on: false, answers: {}, composer: null, sent: null, flipped: false, closed: null, notice: null, returnPending: null, returnHeld: null })),
    ),
  choose: (workspaceId, vendor, tileId) =>
    set((s) =>
      patch(s, workspaceId, () => ({
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
  adopt: (workspaceId, vendor, tileId) =>
    set((s) => {
      const w = s.byWorkspace[workspaceId];
      if (!w?.on || (vendor === "claude" ? w.claudeId : w.codexId) === tileId) return s;
      return patch(s, workspaceId, () => ({
        ...(vendor === "claude" ? { claudeId: tileId } : { codexId: tileId }),
        closed: w.closed === vendor ? null : w.closed,
      }));
    }),
  reconcile: (workspaceId, live) => {
    const w = get().byWorkspace[workspaceId];
    if (!w || !w.on) return;
    const has = (id: string | null) => id !== null && live.some((t) => t.id === id);
    const goneClaude = w.claudeId !== null && !has(w.claudeId);
    const goneCodex = w.codexId !== null && !has(w.codexId);
    if (goneClaude || goneCodex) {
      set((s) =>
        patch(s, workspaceId, (cur) => ({
          claudeId: goneClaude ? null : cur.claudeId,
          codexId: goneCodex ? null : cur.codexId,
          closed: goneClaude ? "claude" : "codex",
          answers: {},
          sent: null,
          flipped: false,
          composer: null,
          returnPending: null,
          returnHeld: null,
        })),
      );
      return;
    }
    // A kind with exactly one tile left pairs by itself again: nothing to say.
    if (w.closed && live.filter((t) => t.vendor === w.closed).length === 1) {
      set((s) => patch(s, workspaceId, () => ({ closed: null })));
    }
  },
  setAnswer: (workspaceId, vendor, answer) =>
    set((s) =>
      patch(s, workspaceId, (w) => {
        const answers = { ...w.answers };
        if (answer) answers[vendor] = answer;
        else delete answers[vendor];
        // Round 5 (final walk, step 13): a Swap applies to the offer the
        // member was looking at. A new finished answer from either tile is a
        // new offer: the flip goes (an answer held for a pass ignores it).
        const before = w.answers[vendor];
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
        if (returnHeld) return { answers, planSeenAt, flipped, returnHeld, returnPending: null };
        // Review round 1 (H2): a held plan of a turn still open follows that
        // turn (plan v2, then its final answer); a final one stays.
        const held = nextHeld(w.returnHeld, vendor, answer, Date.now());
        return held !== w.returnHeld ? { answers, planSeenAt, flipped, returnHeld: held } : { answers, planSeenAt, flipped };
      }),
    ),
  flip: (workspaceId, to) =>
    set((s) =>
      patch(s, workspaceId, (w) => ({ flipped: to ?? !w.flipped, returnHeld: null, returnPending: null })),
    ),
  noteReturnWork: (workspaceId) =>
    set((s) => {
      const p = s.byWorkspace[workspaceId]?.returnPending;
      return p && !p.sawWork ? patch(s, workspaceId, () => ({ returnPending: { ...p, sawWork: true } })) : s;
    }),
  dropReturn: (workspaceId) =>
    set((s) => {
      const w = s.byWorkspace[workspaceId];
      return w && (w.returnPending || w.returnHeld) ? patch(s, workspaceId, () => ({ returnPending: null, returnHeld: null })) : s;
    }),
  openComposer: (workspaceId, composer) => set((s) => patch(s, workspaceId, () => ({ composer, notice: null }))),
  clearSent: (workspaceId) => set((s) => (s.byWorkspace[workspaceId]?.sent ? patch(s, workspaceId, () => ({ sent: null })) : s)),
  setNotice: (workspaceId, notice) => set((s) => patch(s, workspaceId, () => ({ notice }))),
  patchComposer: (workspaceId, p) =>
    set((s) => patch(s, workspaceId, (w) => (w.composer ? { composer: { ...w.composer, ...p } } : {}))),
  closeComposer: (workspaceId) => set((s) => patch(s, workspaceId, () => ({ composer: null }))),
  addPass: (workspaceId, pass) => {
    const n = (get().byWorkspace[workspaceId]?.history[0]?.n ?? 0) + 1;
    const full: Pass = { ...pass, n };
    set((s) =>
      patch(s, workspaceId, (w) => ({
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
}));

/** One workspace's Compare state (the empty one until it is turned on). */
export function useWsCompare(workspaceId: string): WsCompare {
  return useCompare((s) => s.byWorkspace[workspaceId]) ?? EMPTY_COMPARE;
}
