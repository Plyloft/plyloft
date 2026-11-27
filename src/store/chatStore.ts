import { create } from "zustand";
import {
  chatAttachmentAdd,
  chatAttachmentRemove,
  chatInterrupt,
  chatMessages,
  chatOpen,
  chatSend,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessagesEvent,
  type ChatSnapshot,
  type ChatStateEvent,
  type ChatStatus,
  type ChatTokenUsage,
  type ChatVendor,
} from "../ipc";
import { mergeChatMessages } from "../lib/chatView";

/**
 * Card chat (part 2): the card's Chat tab, mirrored from the backend
 * (`chat.rs`). Keyed by `workspaceId::cardId`. A card keeps one
 * conversation per vendor — both are held here, so switching the vendor
 * never loses either history — and one live session (its state comes from
 * `chat://state`). Messages are merged by `id` from `chat://messages`.
 *
 * The draft and the files waiting for the next message live here too, so
 * they survive the tab being hidden and the card page switching cards.
 * Nothing here is persisted: Plyloft's copy of the chat is `chat.json`.
 * An entry stays for the session once a card's chat was read (a draft, both
 * conversations); a deleted card's entry is never read again.
 *
 * **Snapshots and events.** While a snapshot (`chat_messages`, `chat_open`)
 * is on its way, the card's `chat://state` and `chat://messages` are held
 * and applied after it, in the order they came: the backend emits one for
 * every change, so the last one held is never older than the snapshot, and
 * an event that the snapshot already reflects changes nothing again.
 */

export type ChatConversationView = {
  messages: ChatMessage[];
  usage: ChatTokenUsage;
  status: ChatStatus;
  reason: string | null;
  attention: string | null;
  ptyId: string | null;
};

export type CardChatView = {
  /** The vendor the tab shows (the card's active chat vendor). */
  vendor: ChatVendor;
  /** `chat_open` made `vendor` the card's active chat in this session. */
  opened: boolean;
  loaded: boolean;
  conversations: Partial<Record<ChatVendor, ChatConversationView>>;
  attachments: ChatAttachment[];
  /** One draft per vendor: what was written for Claude is not Codex's. */
  drafts: Partial<Record<ChatVendor, string>>;
  /** Attachments added since the last send: they go with the next message. */
  pendingIds: string[];
  /** 1.175.0 F10 round 2: the messages the person wrote and sent here, in
   *  this window session (`send`) — the only ones Send to the Builder may
   *  offer back. A `user` message read back from the CLI's transcript (the
   *  session's priming, a relay) is never in it. Not persisted. */
  typedIds?: string[];
  /** Immediacy walk 4.8: what the person last sent, from the chat's Send or
   *  with Send to the Builder — the newest of the two is what an empty
   *  field's Send to the Builder puts back. This window session only. */
  lastSaid?: string;
};

export const EMPTY_USAGE: ChatTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

export const EMPTY_CONVERSATION: ChatConversationView = {
  messages: [],
  usage: EMPTY_USAGE,
  status: "idle",
  reason: null,
  attention: null,
  ptyId: null,
};

/** Assistant messages still marked streaming, marked finished (a copy only
 *  when one changes). */
function finishStreaming(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.role === "assistant" && !m.done)) return messages;
  return messages.map((m) => (m.role === "assistant" && !m.done ? { ...m, done: true } : m));
}

export function chatKey(workspaceId: string, cardId: string): string {
  return `${workspaceId}::${cardId}`;
}

function blank(): CardChatView {
  return {
    vendor: "claude",
    opened: false,
    loaded: false,
    conversations: {},
    attachments: [],
    drafts: {},
    pendingIds: [],
  };
}

type ChatStoreShape = {
  byKey: Record<string, CardChatView>;
  /** Reads the card's chat (its active vendor) from Plyloft's copy. A chat
   *  that never chose a vendor opens on `preferred` (1.171.0, E1: the card's
   *  Builder, else the default Builder). */
  load: (workspaceId: string, cardId: string, preferred?: ChatVendor) => Promise<void>;
  /** Makes `vendor` the card's chat (`chat_open`); the other's history stays. */
  open: (workspaceId: string, cardId: string, vendor: ChatVendor) => Promise<void>;
  applySnapshot: (snapshot: ChatSnapshot, opened: boolean) => void;
  applyState: (event: ChatStateEvent) => void;
  applyMessages: (event: ChatMessagesEvent) => void;
  /** Sets the shown vendor's draft. */
  setDraft: (workspaceId: string, cardId: string, draft: string) => void;
  /** Immediacy walk 4.8: the person sent `text` to the Builder from here. */
  told: (workspaceId: string, cardId: string, text: string) => void;
  /** Sends the draft and the pending files; refusals throw (the draft stays). */
  send: (workspaceId: string, cardId: string) => Promise<ChatMessage>;
  interrupt: (workspaceId: string, cardId: string) => Promise<void>;
  /** Attaches a file's bytes; it waits for the next message. Throws the reason. */
  addAttachment: (workspaceId: string, cardId: string, name: string, bytes: Uint8Array) => Promise<ChatAttachment>;
  removeAttachment: (workspaceId: string, cardId: string, attachmentId: string) => Promise<void>;
};

/** Per card: snapshots on their way, and the events held meanwhile. */
const inFlight = new Map<string, { depth: number; held: Array<() => void> }>();

function holdWhileInFlight(key: string, apply: () => void): void {
  const flight = inFlight.get(key);
  if (flight && flight.depth > 0) flight.held.push(apply);
  else apply();
}

async function withSnapshot<T>(key: string, read: () => Promise<T>, apply: (value: T) => void): Promise<void> {
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

export const useChat = create<ChatStoreShape>((set, get) => {
  const patch = (key: string, change: (view: CardChatView) => Partial<CardChatView>) =>
    set((state) => {
      const view = state.byKey[key] ?? blank();
      return { byKey: { ...state.byKey, [key]: { ...view, ...change(view) } } };
    });

  const patchConversation = (
    key: string,
    vendor: ChatVendor,
    change: (conversation: ChatConversationView) => Partial<ChatConversationView>,
  ) =>
    patch(key, (view) => {
      const conversation = view.conversations[vendor] ?? EMPTY_CONVERSATION;
      return {
        conversations: { ...view.conversations, [vendor]: { ...conversation, ...change(conversation) } },
      };
    });

  return {
    byKey: {},

    load: (workspaceId, cardId, preferred) =>
      withSnapshot(
        chatKey(workspaceId, cardId),
        () => chatMessages(workspaceId, cardId, undefined, preferred),
        (snapshot) => get().applySnapshot(snapshot, false),
      ),

    open: (workspaceId, cardId, vendor) =>
      withSnapshot(
        chatKey(workspaceId, cardId),
        () => chatOpen(workspaceId, cardId, vendor),
        (snapshot) => get().applySnapshot(snapshot, true),
      ),

    applySnapshot: (snapshot, opened) => {
      const key = chatKey(snapshot.workspaceId, snapshot.cardId);
      patch(key, (view) => {
        const before = view.conversations[snapshot.vendor];
        // Messages an event brought before the snapshot came back stay.
        const known = new Set(snapshot.messages.map((m) => m.id));
        const extra = (before?.messages ?? []).filter((m) => !known.has(m.id));
        const live = new Set(snapshot.attachments.map((a) => a.id));
        const merged = mergeChatMessages(snapshot.messages, extra);
        return {
          vendor: snapshot.vendor,
          opened: opened || (view.opened && view.vendor === snapshot.vendor),
          loaded: true,
          attachments: snapshot.attachments,
          pendingIds: view.pendingIds.filter((id) => live.has(id)),
          conversations: {
            ...view.conversations,
            [snapshot.vendor]: {
              // No turn runs: an answer still marked streaming (stopped, or
              // an older `chat.json`) is finished — a vendor switch's
              // `chat_open` must not make it stream again.
              messages:
                snapshot.status === "working" || snapshot.status === "starting" ? merged : finishStreaming(merged),
              usage: snapshot.usage ?? EMPTY_USAGE,
              status: snapshot.status,
              reason: snapshot.reason ?? null,
              attention: snapshot.attention ?? null,
              ptyId: snapshot.ptyId ?? null,
            },
          },
        };
      });
    },

    applyState: (event) => {
      const key = chatKey(event.workspaceId, event.cardId);
      holdWhileInFlight(key, () =>
        patchConversation(key, event.vendor, (conversation) => ({
          // An answer still marked streaming when no turn runs any more
          // (stopped, interrupted) is as finished as it will be.
          messages:
            event.status === "working" || event.status === "starting"
              ? conversation.messages
              : finishStreaming(conversation.messages),
          status: event.status,
          reason: event.reason ?? null,
          attention: event.attention ?? null,
          usage: event.usage ?? EMPTY_USAGE,
          ptyId: event.ptyId ?? null,
        })),
      );
    },

    applyMessages: (event) => {
      const key = chatKey(event.workspaceId, event.cardId);
      holdWhileInFlight(key, () =>
        patchConversation(key, event.vendor, (conversation) => {
          const merged = mergeChatMessages(conversation.messages, event.messages);
          // "You stopped this answer": the answer above it is finished.
          return { messages: event.messages.some((m) => m.role === "interrupted") ? finishStreaming(merged) : merged };
        }),
      );
    },

    setDraft: (workspaceId, cardId, draft) =>
      patch(chatKey(workspaceId, cardId), (view) => ({ drafts: { ...view.drafts, [view.vendor]: draft } })),

    told: (workspaceId, cardId, text) =>
      patch(chatKey(workspaceId, cardId), () => (text.trim() ? { lastSaid: text.trim() } : {})),

    send: async (workspaceId, cardId) => {
      const key = chatKey(workspaceId, cardId);
      const view = get().byKey[key] ?? blank();
      // A send goes to the card's active vendor: make sure it is the one
      // shown (a card whose chat was only read has none yet).
      if (!view.opened) await get().open(workspaceId, cardId, view.vendor);
      const text = view.drafts[view.vendor] ?? "";
      const ids = view.pendingIds;
      // The vendor the message went to: the conversation it belongs in,
      // whatever the tab shows when the reply comes back.
      const vendor = view.vendor;
      const message = await chatSend(workspaceId, cardId, text, ids);
      patchConversation(key, vendor, (conversation) => ({
        messages: mergeChatMessages(conversation.messages, [message]),
      }));
      patch(key, (current) => ({
        // What was typed meanwhile stays.
        drafts: { ...current.drafts, [vendor]: current.drafts[vendor] === text ? "" : (current.drafts[vendor] ?? "") },
        pendingIds: current.pendingIds.filter((id) => !ids.includes(id)),
        typedIds: [...(current.typedIds ?? []), message.id],
        ...(text.trim() ? { lastSaid: text.trim() } : {}),
      }));
      return message;
    },

    interrupt: (workspaceId, cardId) => chatInterrupt(workspaceId, cardId),

    addAttachment: async (workspaceId, cardId, name, bytes) => {
      const attachment = await chatAttachmentAdd(workspaceId, cardId, name, bytes);
      patch(chatKey(workspaceId, cardId), (view) => ({
        attachments: [...view.attachments.filter((a) => a.id !== attachment.id), attachment],
        pendingIds: view.pendingIds.includes(attachment.id) ? view.pendingIds : [...view.pendingIds, attachment.id],
      }));
      return attachment;
    },

    removeAttachment: async (workspaceId, cardId, attachmentId) => {
      await chatAttachmentRemove(workspaceId, cardId, attachmentId);
      patch(chatKey(workspaceId, cardId), (view) => ({
        attachments: view.attachments.filter((a) => a.id !== attachmentId),
        pendingIds: view.pendingIds.filter((id) => id !== attachmentId),
      }));
    },
  };
});
