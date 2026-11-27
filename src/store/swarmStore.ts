import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  onSwarmMailbox,
  swarmAbort,
  swarmGet,
  swarmList,
  swarmMailboxRead,
  swarmResume,
  swarmStart,
  type MailboxEntry,
  type Swarm,
  type SwarmKind,
} from "../ipc";
import { useWorkspaces } from "./workspaceStore";
import { pushToast } from "./toastStore";
import { confirmSheet } from "../store/confirmStore";
import { joinPath } from "../lib/paths";
import { pushErrorToast } from "../lib/errorToast";

type WorkspaceSlice = {
  swarms: Swarm[];
  /** Most-recent-first selection; null when no swarms exist for this workspace. */
  activeSwarmId: string | null;
  /** Per-swarm mailbox cache, keyed by swarm id. */
  mailboxes: Record<string, MailboxEntry[]>;
  loaded: boolean;
  error: string | null;
};

type SwarmStore = {
  byWorkspace: Record<string, WorkspaceSlice>;
  /**
   * v1.24.0 (G4): session-only map from swarmId → cardId for swarms
   * started for a card (`start`'s `linkedCardId`: today only a card that
   * already ran a swarm, from `kanbanStore.moveCard` — launch G4 removed
   * Brainstorm and its modal). Powers the Promote-to-knowledge button's
   * auto-routing in MailboxFeed for those and for older brainstorms. Cleared
   * on app restart — promoting from a brainstorm started in a prior
   * session falls back to the kanban-side `card.linkedSwarmId` lookup
   * via `useKanban.byWorkspace[wsId].cards`.
   */
  linkedCardId: Record<string, string>;
  /** Initialize / refresh the slice for one workspace. Idempotent. */
  refresh: (workspaceId: string) => Promise<void>;
  /** Drop a workspace's slice (called when the workspace is deleted). */
  dropWorkspace: (workspaceId: string) => void;
  /** Select which swarm Activity/card-linked history should focus on. */
  setActiveSwarm: (workspaceId: string, swarmId: string | null) => void;
  /**
   * Start a swarm in this workspace. Returns the new Swarm record. v1.2.0:
   * `templateId` selects which built-in or user template to run. Defaults
   * to "feature" (the v1.2 equivalent of v1.0/v1.1's hardcoded
   * scout-build-review chain).
   */
  start: (
    workspaceId: string,
    goal: string,
    templateId?: string,
    /** v1.10.x Cycle A: when set, the swarm runs in this directory
     *  (typically the per-card worktree) instead of the workspace cwd. */
    cwdOverride?: string | null,
    /** v1.22.0: initiation tag. Omit (or "adhoc") for the default
     *  Start-swarm button; "card" for kanban moveCard; "brainstorm"
     *  for the Brainstorm modal (gone since launch G4; the backend refuses
     *  any swarm not tied to a card that ran one). */
    kind?: SwarmKind,
    /** v1.24.0 (G4): when set, remembers (FE-only) that this swarm was
     *  launched in the context of a specific card. The Promote button
     *  in `MailboxFeed` auto-routes appends to this card's knowledge. */
    linkedCardId?: string | null,
  ) => Promise<Swarm>;
  /** Abort a swarm. */
  abort: (workspaceId: string, swarmId: string) => Promise<void>;
  /**
   * v1.1.0 (resumable swarms): re-fire the in-flight role of a Suspended
   * swarm. Backend re-runs validation; the frontend re-fetches the
   * swarm record post-resume to reflect the Running status.
   */
  resume: (workspaceId: string, swarmId: string) => Promise<void>;
  /** Fetch full mailbox for a swarm and cache it. */
  loadMailbox: (workspaceId: string, swarmId: string) => Promise<void>;
  /** Re-fetch a single swarm's record (e.g. after a state transition). */
  refreshSwarm: (workspaceId: string, swarmId: string) => Promise<void>;
  /**
   * v1.30.0 (parallel swarms): insert (or replace) a swarm into its
   * workspace slice without disturbing the active selection. The
   * card-queue pump starts swarms backend-side, so the FE first learns
   * of them via their `created` mailbox event rather than `start()`.
   */
  upsertSwarm: (swarm: Swarm) => void;
};

function emptySlice(): WorkspaceSlice {
  return {
    swarms: [],
    activeSwarmId: null,
    mailboxes: {},
    loaded: false,
    error: null,
  };
}

export const useSwarms = create<SwarmStore>((set, get) => ({
  byWorkspace: {},
  linkedCardId: {},

  refresh: async (workspaceId) => {
    try {
      const swarms = await swarmList(workspaceId);
      // Most recent first.
      swarms.sort((a, b) => b.startedAt - a.startedAt);
      const activeSwarmId =
        swarms.find((s) => s.status === "running")?.id ?? swarms[0]?.id ?? null;
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...(s.byWorkspace[workspaceId] ?? emptySlice()),
            swarms,
            activeSwarmId,
            loaded: true,
            error: null,
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...(s.byWorkspace[workspaceId] ?? emptySlice()),
            loaded: true,
            error: String(e),
          },
        },
      }));
    }
  },

  dropWorkspace: (workspaceId) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),

  setActiveSwarm: (workspaceId, swarmId) =>
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...(s.byWorkspace[workspaceId] ?? emptySlice()),
          activeSwarmId: swarmId,
        },
      },
    })),

  start: async (
    workspaceId,
    goal,
    templateId = "feature",
    cwdOverride = null,
    kind,
    linkedCardId = null,
  ) => {
    // v1.2.0: empty role_bindings → backend reads
    // RoleBindingsStore for the workspace; auto-seeds + persists any
    // missing bindings per role in the resolved template.
    // v1.10.x Cycle A: cwdOverride threads the per-card worktree path
    // through to the swarm so parallel cards in one workspace don't
    // collide on the working tree.
    // v1.22.0: `kind` tags the persisted swarm so the UI can later
    // differentiate brainstorm-driven runs from card-driven and
    // direct adhoc starts.
    // v1.24.0 (G4): linkedCardId is FE-only state; stored in the
    // session-only map keyed by swarm id after the BE returns.
    const swarm = await swarmStart({
      workspaceId,
      templateId,
      goal,
      roleBindings: {},
      cwdOverride,
      kind,
      cardId: kind === "card" ? linkedCardId : null,
    });
    if (linkedCardId) {
      set((s) => ({
        linkedCardId: { ...s.linkedCardId, [swarm.id]: linkedCardId },
      }));
    }
    set((s) => {
      const slice = s.byWorkspace[workspaceId] ?? emptySlice();
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...slice,
            // Dedup defensively: the `created` mailbox event may race
            // ahead of this and have already inserted the swarm.
            swarms: [swarm, ...slice.swarms.filter((sw) => sw.id !== swarm.id)],
            activeSwarmId: swarm.id,
          },
        },
      };
    });
    // R8: one-time per-workspace .gitignore prompt. Fire-and-forget — never
    // blocks the swarm from starting.
    void maybeOfferGitignoreFix(workspaceId);
    return swarm;
  },

  abort: async (workspaceId, swarmId) => {
    await swarmAbort(swarmId);
    // Re-fetch — backend updates status to Aborted and writes terminate entry.
    await get().refreshSwarm(workspaceId, swarmId);
  },

  resume: async (workspaceId, swarmId) => {
    await swarmResume(swarmId);
    // Backend flipped status Suspended -> Running, fired the in-flight
    // role's run, and appended Resume + Dispatch mailbox entries. Re-fetch
    // both the swarm record and the mailbox so the UI updates immediately.
    await get().refreshSwarm(workspaceId, swarmId);
    await get().loadMailbox(workspaceId, swarmId);
  },

  loadMailbox: async (workspaceId, swarmId) => {
    const entries = await swarmMailboxRead(swarmId, 0);
    set((s) => {
      const slice = s.byWorkspace[workspaceId] ?? emptySlice();
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...slice,
            mailboxes: { ...slice.mailboxes, [swarmId]: entries },
          },
        },
      };
    });
  },

  refreshSwarm: async (workspaceId, swarmId) => {
    const fresh = await swarmGet(swarmId);
    if (!fresh) return;
    set((s) => {
      const slice = s.byWorkspace[workspaceId] ?? emptySlice();
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...slice,
            swarms: slice.swarms.map((sw) => (sw.id === swarmId ? fresh : sw)),
          },
        },
      };
    });
  },

  upsertSwarm: (swarm) =>
    set((s) => {
      const slice = s.byWorkspace[swarm.workspaceId];
      // Workspace not loaded into the store yet — its next history refresh
      // lists everything including this swarm.
      if (!slice) return s;
      const present = slice.swarms.some((sw) => sw.id === swarm.id);
      const swarms = present
        ? slice.swarms.map((sw) => (sw.id === swarm.id ? swarm : sw))
        : [swarm, ...slice.swarms].sort((a, b) => b.startedAt - a.startedAt);
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [swarm.workspaceId]: { ...slice, swarms },
        },
      };
    }),
}));

/**
 * R8: First time a swarm runs in a workspace whose project root has a
 * `.gitignore` not excluding `.atelier/`, prompt the user to add it. Tracked
 * via localStorage per workspace so the prompt is one-time. Best-effort —
 * any error short-circuits silently.
 */
async function maybeOfferGitignoreFix(workspaceId: string): Promise<void> {
  const flagKey = `atelier:swarm-gitignore-toast-shown:${workspaceId}`;
  if (localStorage.getItem(flagKey)) return;
  const ws = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId);
  if (!ws?.cwd) return;
  const path = joinPath(ws.cwd, ".gitignore");
  let contents: string;
  try {
    contents = await invoke<string>("fs_read_text_file", { path });
  } catch {
    // No .gitignore (or unreadable) — nothing to update; mark seen.
    localStorage.setItem(flagKey, "1");
    return;
  }
  // Already covered? Match `.atelier/` or `.atelier` at start of line.
  if (/(^|\n)\.atelier\/?(\n|$)/.test(contents)) {
    localStorage.setItem(flagKey, "1");
    return;
  }
  const accept = await confirmSheet({
    title: "Add .atelier/ to .gitignore?",
    body:
      "A multi-AI run writes its work in progress to .atelier/ in this " +
      "workspace, and your project's .gitignore doesn't list it yet.",
    confirmLabel: "Add to .gitignore",
    cancelLabel: "Not now",
  });
  if (accept) {
    const next = contents.endsWith("\n")
      ? `${contents}.atelier/\n`
      : `${contents}\n.atelier/\n`;
    try {
      await invoke<void>("fs_write_text_file", { path, content: next });
      pushToast({
        kind: "info",
        title: "Added to .gitignore",
        body: "`.atelier/` is now ignored in this project.",
      });
    } catch (e) {
      pushErrorToast("Could not update .gitignore", e);
    }
  }
  localStorage.setItem(flagKey, "1");
}

/**
 * App-boot subscription: live-tail `swarm://mailbox` events into the cache.
 * Idempotent (registers once via a module-scoped flag); call from `App.tsx`.
 */
let mailboxSubscriptionStarted = false;
export function startSwarmSubscriptions(): Promise<void> {
  if (mailboxSubscriptionStarted) return Promise.resolve();
  mailboxSubscriptionStarted = true;
  return onSwarmMailbox((entry) => {
    // Append into every workspace slice that has this swarm cached, plus
    // refresh the swarm record so the UI sees status/state transitions.
    let foundAnywhere = false;
    useSwarms.setState((s) => {
      const next: Record<string, WorkspaceSlice> = {};
      let touched = false;
      for (const [wsId, slice] of Object.entries(s.byWorkspace)) {
        const containsSwarm = slice.swarms.some((sw) => sw.id === entry.swarmId);
        if (!containsSwarm) {
          next[wsId] = slice;
          continue;
        }
        foundAnywhere = true;
        touched = true;
        const existing = slice.mailboxes[entry.swarmId] ?? [];
        next[wsId] = {
          ...slice,
          mailboxes: { ...slice.mailboxes, [entry.swarmId]: [...existing, entry] },
        };
        // Also nudge a refresh on terminate / dispatch events so status pills update.
        if (entry.kind === "terminate" || entry.kind === "dispatch") {
          // Fire-and-forget; the resulting setState is batched naturally.
          void useSwarms.getState().refreshSwarm(wsId, entry.swarmId);
        }
      }
      return touched ? { byWorkspace: next } : s;
    });
    // v1.30.0 (parallel swarms): a swarm started backend-side (the
    // card-queue pump, when a queued card auto-starts) is unknown to the
    // FE store — its `created` event is the first signal. Fetch the
    // record and insert it so it appears in Activity/card-linked history
    // just like an FE-started swarm.
    if (!foundAnywhere && entry.kind === "created") {
      void swarmGet(entry.swarmId).then((swarm) => {
        if (swarm) useSwarms.getState().upsertSwarm(swarm);
      });
    }
    // v1.26.0 (Cycle H): completion toast for card-linked brainstorms.
    // Side effect — kept outside the setState reducer because pushToast
    // is not a pure state transition. Runs only on `terminate` so the
    // signal fires exactly once per swarm.
    if (entry.kind === "terminate") {
      void maybePushBrainstormCompletionToast(entry.swarmId);
    }
  }).then(() => undefined);
}

/**
 * v1.26.0 (Cycle H): when a brainstorm terminates with a linked card,
 * surface a toast so the user knows insights are waiting. Otherwise
 * completion is silent and the user (per real-user report 2026-05-12)
 * assumes the brainstorm output was lost.
 *
 * Resolution chain mirrors `PromoteButton.useLinkedCardId`:
 *  1. Session map (`linkedCardId[swarmId]`) — same-session brainstorms.
 *  2. Kanban-side `card.linkedBrainstormId` — durable, cross-restart.
 *
 * Deliberately does NOT match on `card.linkedSwarmId` — that's the
 * dispatch field, would surface "Brainstorm finished" toasts for
 * completed kanban dispatches.
 */
async function maybePushBrainstormCompletionToast(
  swarmId: string,
): Promise<void> {
  // v1.26.1 hotfix: the mailbox listener fires refreshSwarm() as
  // fire-and-forget right before we run. A single microtask is NOT
  // enough for the swarm_get RPC to complete — reading status here
  // would see the pre-terminate value (typically "running"), causing
  // the toast to mis-classify a clean completion as "ended early"
  // while the banner (which subscribes reactively) shows the fresh
  // "done" status a moment later. Explicitly await the refresh.
  let foundWsId: string | null = null;
  for (const [wsId, slice] of Object.entries(useSwarms.getState().byWorkspace)) {
    if (slice.swarms.some((s) => s.id === swarmId)) {
      foundWsId = wsId;
      break;
    }
  }
  if (!foundWsId) return;
  await useSwarms.getState().refreshSwarm(foundWsId, swarmId);

  const swarmState = useSwarms.getState();
  const foundSwarm: Swarm | null =
    swarmState.byWorkspace[foundWsId]?.swarms.find((s) => s.id === swarmId) ??
    null;
  if (!foundSwarm) return;
  if (foundSwarm.kind !== "brainstorm") return;

  // Pull kanban cards via dynamic import to avoid a top-level circular
  // import (kanbanStore.ts already imports useSwarms from this module).
  const kanbanCards = await getKanbanCardsForWorkspace(foundWsId);
  if (!kanbanCards) return;

  // Resolve the linked card. Session map first; durable field as fallback.
  let cardId: string | null = swarmState.linkedCardId[swarmId] ?? null;
  if (!cardId) {
    cardId =
      kanbanCards.find((c) => c.linkedBrainstormId === swarmId)?.id ?? null;
  }
  if (!cardId) return;

  const card = kanbanCards.find((c) => c.id === cardId);
  if (!card) return;

  // Count promote-worthy artifact entries.
  const entries =
    useSwarms.getState().byWorkspace[foundWsId]?.mailboxes[swarmId] ?? [];
  const n = entries.filter((e) => e.kind === "artifact").length;
  const status = foundSwarm.status;

  // Title and body vary by terminal kind. "done" with insights is the
  // happy path; everything else either had no insights or ended early.
  const isHappy = status === "done" && n > 0;
  const isEmpty = n === 0;
  const titlePrefix = isHappy
    ? "✓ Brainstorm finished"
    : status === "done"
      ? "Brainstorm finished"
      : "Brainstorm ended early";
  const title = `${titlePrefix} for '${card.title}'`;
  const body = isEmpty
    ? "No insights produced — review run log"
    : `${n} ${n === 1 ? "insight" : "insights"} ready to review`;

  const wsId = foundWsId;
  pushToast({
    kind: isHappy ? "info" : "warn",
    title,
    body,
    action: {
      label: "Review",
      onClick: () => {
        useSwarms.getState().setActiveSwarm(wsId, swarmId);
        // The UI store is dynamically imported below for the same
        // circular-import reason as kanbanStore.
        void openSwarmActivity(wsId);
      },
    },
  });
}

// Dynamic-import helpers to avoid circular imports at module load time.
// swarmStore is imported by both kanbanStore (indirectly) and uiStore
// consumers, so a top-level `import { useKanban } from "./kanbanStore"`
// here creates a cycle that resolves to undefined at module init.
async function getKanbanCardsForWorkspace(
  wsId: string,
): Promise<Array<{ id: string; title: string; linkedBrainstormId?: string | null }> | null> {
  try {
    const mod = await import("./kanbanStore");
    return mod.useKanban.getState().byWorkspace[wsId]?.cards ?? null;
  } catch {
    return null;
  }
}

async function openSwarmActivity(wsId: string): Promise<void> {
  try {
    // v1.81.0 (P2-3): Swarm tab retired — land on Activity instead.
    const mod = await import("./uiStore");
    mod.openCenterMode(wsId, "activity");
  } catch {
    // best-effort — no UI store, no navigation, but toast still
    // appeared.
  }
}
