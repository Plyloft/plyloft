import { create } from "zustand";
import {
  planExchangeAccept,
  planExchangeDiscard,
  planExchangeGet,
  planExchangeMore,
  planExchangeOpenCards,
  planExchangeRetry,
  planExchangeStart,
  planExchangeStop,
  type ChatVendor,
  type KanbanCard,
  type PlanConversation,
  type PlanExchange,
  type PlanExchangeSnapshot,
  type PlanMessagesEvent,
  type PlanOpenCard,
  type PlanStateEvent,
  onPlanState,
} from "../ipc";
import { mergeChatMessages } from "../lib/chatView";
import { exchangeOpen } from "../lib/planExchangeView";
import { chatKey } from "./chatStore";
import { useWorkspaces } from "./workspaceStore";

/**
 * Plan with two AIs (part 2): a card's exchanges, mirrored from the backend
 * (`plan_exchange.rs`), keyed like `chatStore` (`workspaceId::cardId`).
 * `plan://state` replaces the current exchange's state (keeping its
 * messages); `plan://messages` merges a side's messages by id. While a
 * snapshot is on its way the card's events are held and applied after it,
 * as `chatStore` does. Nothing is persisted here: `plan.json` is the record.
 */

/** A Plan-form request this recent is followed by a card page or a Chat tab
 *  that mounts after it. */
export const FORM_REQUEST_FRESH_MS = 10_000;

export function formRequestFresh(at: number | undefined, now = Date.now()): boolean {
  return at != null && at > 0 && now - at < FORM_REQUEST_FRESH_MS;
}

/** The light record of a card's open or paused exchange, from its full
 *  form (null once it is accepted or discarded). */
export function openCardOf(workspaceId: string, cardId: string, current: PlanExchange | null | undefined): PlanOpenCard | null {
  if (!current || (current.status !== "running" && current.status !== "awaitingMember" && current.status !== "paused")) return null;
  return {
    workspaceId,
    cardId,
    exchangeId: current.id,
    status: current.status,
    proposer: current.proposer,
    critic: current.critic,
    roundsDone: current.roundsDone,
    updatedAt: current.updatedAt,
    pause: current.pause ?? null,
  };
}

export type CardPlanView = {
  loaded: boolean;
  snapshot: PlanExchangeSnapshot | null;
};

type Shape = {
  byKey: Record<string, CardPlanView>;
  /** Every card whose exchange runs, waits for the member or is paused,
   *  any workspace, the card's Chat open or not: read once at launch
   *  (`plan_exchange_open_cards`), then kept by every `plan://state` and
   *  snapshot. The Board, the card's Now and the Inbox read it. */
  open: Record<string, PlanOpenCard>;
  loadOpen: () => Promise<void>;
  /** A card's exchange as it is now (null: none open). */
  noteOpen: (workspaceId: string, cardId: string, current: PlanExchange | null | undefined) => void;
  /** Deleted workspaces: their cards' exchanges are gone. */
  dropWorkspaces: (workspaceIds: readonly string[]) => void;
  /** The card page asked for the Plan form (its Plan step, a new card made
   *  to be planned): when (ms), for the card page and the Chat tab to
   *  follow — a page that mounts just after it (a new card) follows it too. */
  formRequests: Record<string, number>;
  requestForm: (workspaceId: string, cardId: string) => void;
  /** "Create and plan with two AIs": the next card made on this
   *  workspace's board opens on the Plan form. */
  newCardPlan: string | null;
  armNewCardPlan: (workspaceId: string | null) => void;
  /** Takes the armed request for `workspaceId` (once). */
  takeNewCardPlan: (workspaceId: string) => boolean;
  load: (workspaceId: string, cardId: string) => Promise<void>;
  applySnapshot: (snapshot: PlanExchangeSnapshot) => void;
  applyState: (event: PlanStateEvent) => void;
  applyMessages: (event: PlanMessagesEvent) => void;
  start: (workspaceId: string, cardId: string, preferred: ChatVendor, ask: string, attachmentIds: string[]) => Promise<void>;
  stop: (workspaceId: string, cardId: string) => Promise<void>;
  retry: (workspaceId: string, cardId: string) => Promise<void>;
  more: (workspaceId: string, cardId: string, note: string | null) => Promise<void>;
  /** Use this plan (null) or Edit… saved (the text). The card comes back;
   *  `settle` (the board read again) runs before the exchange's end shows. */
  accept: (
    workspaceId: string,
    cardId: string,
    editedText: string | null,
    settle?: (card: KanbanCard) => Promise<void>,
  ) => Promise<KanbanCard>;
  discard: (workspaceId: string, cardId: string) => Promise<void>;
  /** The card's exchange runs or waits for the member (P1), as far as this
   *  window knows (the backend refuses a build anyway). */
  openFor: (workspaceId: string, cardId: string) => boolean;
};

const inFlight = new Map<string, { depth: number; held: Array<() => void> }>();

function hold(key: string, apply: () => void) {
  const flight = inFlight.get(key);
  if (flight && flight.depth > 0) flight.held.push(apply);
  else apply();
}

async function withSnapshot(key: string, read: () => Promise<PlanExchangeSnapshot>, apply: (s: PlanExchangeSnapshot) => void) {
  const flight = inFlight.get(key) ?? { depth: 0, held: [] };
  inFlight.set(key, flight);
  flight.depth += 1;
  try {
    apply(await read());
  } finally {
    flight.depth -= 1;
    if (flight.depth === 0) {
      inFlight.delete(key);
      flight.held.forEach((run) => run());
    }
  }
}

function withMessages(
  exchange: PlanExchange,
  role: "proposer" | "critic",
  vendor: ChatVendor,
  change: (c: PlanConversation) => PlanConversation,
): PlanExchange {
  const field = role === "proposer" ? "proposerConversation" : "criticConversation";
  const before: PlanConversation = exchange[field] ?? {
    vendor,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
  };
  return { ...exchange, [field]: change(before) };
}

export const usePlanExchange = create<Shape>((set, get) => {
  const patch = (key: string, change: (view: CardPlanView) => Partial<CardPlanView>) =>
    set((state) => {
      const view = state.byKey[key] ?? { loaded: false, snapshot: null };
      return { byKey: { ...state.byKey, [key]: { ...view, ...change(view) } } };
    });

  const snapshotCall = (workspaceId: string, cardId: string, call: () => Promise<PlanExchangeSnapshot>) =>
    withSnapshot(chatKey(workspaceId, cardId), call, (snapshot) => get().applySnapshot(snapshot));

  return {
    byKey: {},
    open: {},
    formRequests: {},
    newCardPlan: null,

    requestForm: (workspaceId, cardId) =>
      set((state) => ({ formRequests: { ...state.formRequests, [chatKey(workspaceId, cardId)]: Date.now() } })),

    armNewCardPlan: (workspaceId) => set({ newCardPlan: workspaceId }),

    takeNewCardPlan: (workspaceId) => {
      if (get().newCardPlan !== workspaceId) return false;
      set({ newCardPlan: null });
      return true;
    },

    loadOpen: async () => {
      const list = await planExchangeOpenCards();
      set((state) => {
        const open: Record<string, PlanOpenCard> = {};
        for (const o of list) open[chatKey(o.workspaceId, o.cardId)] = o;
        // A card this window already follows keeps what it read since.
        for (const [key, view] of Object.entries(state.byKey)) {
          if (!view.loaded || !view.snapshot) continue;
          const mine = openCardOf(view.snapshot.workspaceId, view.snapshot.cardId, view.snapshot.current);
          if (mine) open[key] = mine;
          else delete open[key];
        }
        return { open };
      });
    },

    noteOpen: (workspaceId, cardId, current) =>
      set((state) => {
        const key = chatKey(workspaceId, cardId);
        const next = openCardOf(workspaceId, cardId, current);
        const before = state.open[key];
        if (!next && !before) return {};
        if (
          next &&
          before &&
          before.status === next.status &&
          before.exchangeId === next.exchangeId &&
          before.roundsDone === next.roundsDone &&
          before.pause?.reason === next.pause?.reason
        ) {
          return {};
        }
        const open = { ...state.open };
        if (next) open[key] = next;
        else delete open[key];
        return { open };
      }),

    dropWorkspaces: (workspaceIds) =>
      set((state) => {
        const prefixes = workspaceIds.map((ws) => chatKey(ws, ""));
        const gone = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
        if (!Object.keys(state.open).some(gone) && !Object.keys(state.byKey).some(gone)) return {};
        return {
          open: Object.fromEntries(Object.entries(state.open).filter(([key]) => !gone(key))),
          byKey: Object.fromEntries(Object.entries(state.byKey).filter(([key]) => !gone(key))),
        };
      }),

    load: (workspaceId, cardId) => snapshotCall(workspaceId, cardId, () => planExchangeGet(workspaceId, cardId)),

    applySnapshot: (snapshot) => {
      patch(chatKey(snapshot.workspaceId, snapshot.cardId), (view) => {
        // Messages an event brought before the snapshot came back stay.
        const before = view.snapshot?.current;
        let current = snapshot.current;
        if (current && before && before.id === current.id) {
          for (const role of ["proposer", "critic"] as const) {
            const field = role === "proposer" ? "proposerConversation" : "criticConversation";
            const old = before[field]?.messages ?? [];
            const known = new Set((current[field]?.messages ?? []).map((m) => m.id));
            const extra = old.filter((m) => !known.has(m.id));
            if (extra.length) {
              current = withMessages(current, role, current[role === "proposer" ? "proposer" : "critic"], (c) => ({
                ...c,
                messages: mergeChatMessages(c.messages, extra),
              }));
            }
          }
        }
        return { loaded: true, snapshot: { ...snapshot, current } };
      });
      get().noteOpen(snapshot.workspaceId, snapshot.cardId, snapshot.current);
    },

    applyState: (event) => {
      const key = chatKey(event.workspaceId, event.cardId);
      hold(key, () => {
        const view = get().byKey[key];
        const before = view?.snapshot;
        // The exchange ended (accepted, discarded) or another began: the
        // earlier list changed too — read it again.
        if (!before || (before.current?.id ?? null) !== (event.current?.id ?? null)) {
          void get().load(event.workspaceId, event.cardId).catch(() => {});
          if (!before) return;
        }
        patch(key, (v) => {
          const snapshot = v.snapshot ?? before;
          const old = snapshot.current;
          const current: PlanExchange | null = event.current
            ? {
                ...event.current,
                proposerConversation: old && old.id === event.current.id ? old.proposerConversation : null,
                criticConversation: old && old.id === event.current.id ? old.criticConversation : null,
              }
            : null;
          return {
            snapshot: {
              ...snapshot,
              current,
              readOnly: event.readOnly,
              runningElsewhere: event.runningElsewhere,
              lanes: event.lanes,
              waitingForPrompt: event.waitingForPrompt,
            },
          };
        });
      });
    },

    applyMessages: (event) => {
      const key = chatKey(event.workspaceId, event.cardId);
      hold(key, () =>
        patch(key, (view) => {
          const snapshot = view.snapshot;
          if (!snapshot?.current || snapshot.current.id !== event.exchangeId) return {};
          const current = withMessages(snapshot.current, event.role, event.vendor, (c) => ({
            ...c,
            messages: mergeChatMessages(c.messages, event.messages),
          }));
          return { snapshot: { ...snapshot, current } };
        }),
      );
    },

    start: (workspaceId, cardId, preferred, ask, attachmentIds) =>
      snapshotCall(workspaceId, cardId, () => planExchangeStart(workspaceId, cardId, preferred, ask, attachmentIds)),

    stop: (workspaceId, cardId) => planExchangeStop(workspaceId, cardId),

    retry: (workspaceId, cardId) => snapshotCall(workspaceId, cardId, () => planExchangeRetry(workspaceId, cardId)),

    more: (workspaceId, cardId, note) => snapshotCall(workspaceId, cardId, () => planExchangeMore(workspaceId, cardId, note)),

    accept: async (workspaceId, cardId, editedText, settle) => {
      // The exchange's end (`plan://state`, to the panel and to the Board /
      // Now / Inbox follower) is held until the board has read the written
      // card: applied first, the card showed its old Draft words and the
      // Plan form ("Starting…") for an instant (Windows walk of c26f197e,
      // step 10).
      let card: KanbanCard | null = null;
      await snapshotCall(workspaceId, cardId, async () => {
        card = await planExchangeAccept(workspaceId, cardId, editedText);
        await settle?.(card);
        return planExchangeGet(workspaceId, cardId);
      });
      return card as unknown as KanbanCard;
    },

    discard: async (workspaceId, cardId) => {
      await planExchangeDiscard(workspaceId, cardId);
      await get().load(workspaceId, cardId);
    },

    openFor: (workspaceId, cardId) => {
      const key = chatKey(workspaceId, cardId);
      const view = get().byKey[key];
      if (view?.loaded) return exchangeOpen(view.snapshot?.current);
      // Not read in this window (a relaunch, the card never opened): the
      // launch's list says.
      const open = get().open[key];
      return open?.status === "running" || open?.status === "awaitingMember";
    },
  };
});

/**
 * Follows every card's exchange for the surfaces outside its Chat (the
 * Board, the card's Now, the Inbox): the launch's list, then each
 * `plan://state`. Returns the unlisten.
 */
export function followPlanExchanges(): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  void onPlanState((e) =>
    hold(chatKey(e.workspaceId, e.cardId), () => usePlanExchange.getState().noteOpen(e.workspaceId, e.cardId, e.current)),
  )
    .then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    })
    .catch(() => {});
  void usePlanExchange
    .getState()
    .loadOpen()
    .catch(() => {});
  // A deleted workspace's exchanges are forgotten by the backend without a
  // `plan://state`: its cards leave the Inbox and the attention number too.
  let known = new Set(useWorkspaces.getState().workspaces.map((w) => w.id));
  const offWorkspaces = useWorkspaces.subscribe((s) => {
    const listed = new Set(s.workspaces.map((w) => w.id));
    const gone = [...known].filter((id) => !listed.has(id));
    known = listed;
    if (gone.length > 0) usePlanExchange.getState().dropWorkspaces(gone);
  });
  return () => {
    cancelled = true;
    off?.();
    offWorkspaces();
  };
}
