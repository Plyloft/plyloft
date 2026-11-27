import { useMemo } from "react";
import { create } from "zustand";
import { showRelease } from "./projectRelease";
import {
  inboxFeed,
  inboxMarkSeen,
  onAgentRunDone,
  onKanbanChanged,
  onImprovementProposalChanged,
  onNiProgress,
  onSkillsHubDecision,
  onWorkspaceDefinitionEdited,
  onWorkspaceDefinitionRefreshed,
  type InboxEvent,
  type InboxFeed,
} from "../ipc";
import { useWorkspaces } from "./workspaceStore";
import { useSolo } from "./workModeStore";
import { decisionSkillOf, feedForMode, needsOkSkillOf, prOfInboxId, reviewCardOf } from "../lib/inboxView";
import { useKanban } from "./kanbanStore";
import { useBoard } from "./boardStore";
import { useLibrary } from "./libraryStore";
import { useAllSkills } from "./allSkillsStore";
import { openCenterMode, openLibraryPage, useUi } from "./uiStore";
import { useProposal } from "./proposalStore";
import { proposalPage } from "../lib/proposals";
import { conflictFieldOfInboxId } from "../lib/settingConflict";
import { useSettingConflict } from "./settingConflictStore";
import { useChecksConsent } from "./checksConsentStore";
import { knownCause } from "../lib/plainError";
import { isInstallOkRow } from "../lib/inboxView";
import { lookAtTheIdeas } from "./nextImprovementStore";
import { niOfInboxId } from "../lib/nextImprovement";
import {
  createInboxMutationQueue,
  inboxRefreshIsCurrent,
  markSeenThenRefresh,
} from "../lib/inboxEligibilityFlow";

const inboxMutationQueue = createInboxMutationQueue();

/** What the Inbox says when a read fails — one sentence, never the raw text. */
const inboxReadError = (cause: unknown) => {
  const why = knownCause(cause);
  return why ? `The Inbox couldn't be read. ${why}` : "The Inbox couldn't be read.";
};

/**
 * v1.65.0 (UX revamp step 1): the GLOBAL Inbox store — flat, not
 * per-workspace (the Prompts precedent). The feed is a backend-derived
 * view (`inbox_feed`); the only mutation surface is the per-user seen
 * store. docs/ux-revamp/STEP1.md.
 */
type InboxStore = {
  feed: InboxFeed | null;
  proofReady: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** 1.176.3: "Read it again" — waits for the read running now and for a
   *  mark-as-seen in flight, then reads, so the press never does nothing. */
  readItAgain: () => Promise<void>;
  /** After a change this read must see: one running now may predate it, so
   *  one more follows it. `refresh` itself stays coalescing. */
  refreshAfterChange: () => Promise<void>;
  /** Optimistic: stamps `seenAt` locally, then persists. */
  markSeen: (eventIds: string[]) => Promise<void>;
  /** Jump-and-open (decision card #6): switch to the event's workspace
   *  (warming it if cold — the existing staged-mount path) and open the
   *  most specific surface for the event. Marks the row seen. */
  open: (ev: InboxEvent) => void;
};

/** A read already repeated once for "refresh required". */
let retriedOnce = false;

/** A read asked for while another ran, by `refreshAfterChange`. */
let readAgain = false;

export const useInbox = create<InboxStore>((set, get) => ({
  feed: null,
  proofReady: false,
  loading: false,
  error: null,

  refreshAfterChange: async () => {
    if (get().loading) {
      readAgain = true;
      return;
    }
    await get().refresh();
  },

  refresh: async () => {
    if (get().loading || inboxMutationQueue.pending() > 0) return;
    const startedAtGeneration = inboxMutationQueue.generation();
    set({ loading: true, proofReady: false });
    try {
      const feed = await inboxFeed();
      if (!inboxRefreshIsCurrent(startedAtGeneration, inboxMutationQueue)) {
        set({ loading: false });
      } else {
        set({
          feed,
          proofReady: inboxMutationQueue.pending() === 0,
          loading: false,
          error: null,
        });
      }
    } catch (e) {
      if (!inboxRefreshIsCurrent(startedAtGeneration, inboxMutationQueue)) {
        set({ loading: false });
      } else if (/refresh required/i.test(String((e as Error)?.message ?? e)) && !retriedOnce) {
        // The backend's "the feed changed under you": read it again, quietly.
        set({ loading: false });
        retriedOnce = true;
        try {
          await get().refresh();
        } finally {
          retriedOnce = false;
        }
        return;
      } else {
        set({ loading: false, proofReady: false, error: inboxReadError(e) });
      }
    }
    if (readAgain) {
      readAgain = false;
      await get().refresh();
    }
  },

  readItAgain: async () => {
    // A press that finds the store busy waits its turn (bounded), then reads.
    for (let tries = 0; tries < 400; tries++) {
      while (get().loading || inboxMutationQueue.pending() > 0) await new Promise((r) => setTimeout(r, 25));
      await get().refresh();
      // refresh() declines only when something started in between: go again.
      if (!(get().loading || inboxMutationQueue.pending() > 0)) return;
    }
  },

  markSeen: async (eventIds) => {
    if (eventIds.length === 0) return;
    const now = Date.now();
    const feed = get().feed;
    // A row-seen write changes the backend candidate set. Invalidate the
    // displayed proof synchronously until the authoritative feed is back.
    set({ proofReady: false });
    if (feed) {
      const ids = new Set(eventIds);
      set({
        feed: {
          ...feed,
          events: feed.events.map((e) =>
            ids.has(e.id) && e.seenEligible && e.seenAt == null
              ? { ...e, seenAt: now }
              : e,
          ),
        },
      });
    }
    // Bypass refresh()'s coalescing guard: proofReady becomes true only
    // after an authoritative server feed actually arrives.
    const outcome = await inboxMutationQueue.run(() =>
      markSeenThenRefresh(eventIds, {
        markSeen: inboxMarkSeen,
        refresh: inboxFeed,
      }),
    );
    if (inboxMutationQueue.pending() > 0) return;
    if (outcome.feed) {
      set({
        feed: outcome.feed,
        proofReady: outcome.proofReady,
        error: outcome.error ? inboxReadError(outcome.error) : null,
      });
    } else {
      set({ proofReady: false, error: outcome.error ? inboxReadError(outcome.error) : null });
    }
  },

  open: (ev) => {
    if (ev.seenEligible && ev.seenAt == null) {
      void get().markSeen([ev.id]);
    }
    const ui = useUi.getState();
    const workspaces = useWorkspaces.getState();
    if (workspaces.activeId !== ev.workspaceId) {
      // Warming a cold workspace rides the existing staged-mount path
      // (skeleton → stage 4); selectCard below is uiStore state set
      // immediately — CardDetailPanel renders the card once the warm
      // kanban load lands (decision card #9: open card = session state).
      void workspaces.setActive(ev.workspaceId);
    }
    // QoL 14.2 (F7): a pull request someone asked this member to review
    // opens its "Review: …" card when the Board has one, else the Board's
    // Review a pull request sheet with it picked (the one way a review card
    // is made; nothing starts until Review is pressed there). Open on GitHub
    // and Copy link are the row's extras.
    // 1.174.0 (DR4): a release stopped opens the Release sheet (it shows
    // the release on its way and its ways on); a release row the Board.
    if (ev.kind === "release_stopped") {
      openCenterMode(ev.workspaceId, "board");
      showRelease(ev.workspaceId);
      return;
    }
    if (ev.kind === "released") {
      openCenterMode(ev.workspaceId, "board");
      return;
    }
    if (ev.kind === "pr_review") {
      const pr = prOfInboxId(ev.id);
      const cards = useKanban.getState().byWorkspace[ev.workspaceId]?.cards ?? [];
      const card = pr ? reviewCardOf(cards, pr) : null;
      if (card) {
        ui.selectCard(ev.workspaceId, card.id, true);
      } else if (pr) {
        openCenterMode(ev.workspaceId, "board");
        useBoard.getState().setPrReviewAsk({ workspaceId: ev.workspaceId, number: pr.number, at: Date.now() });
      }
      return;
    }
    // GH #104: the improvement proposal's row opens the **Library page** that
    // holds the block (BOARDS.md §4 state C: "Both carry an accent dot and open
    // this page"), not the card — the change is about a skill or the
    // instructions, and the card it came out of is only how it is named. The
    // row does not carry which of the two pages it is, so the proposal itself
    // says; a proposal that has been dropped meanwhile lands on Skills, where
    // the list is, rather than nowhere.
    if (ev.kind === "skill_change_waiting") {
      void useProposal
        .getState()
        .refresh(ev.workspaceId)
        .then(() => {
          const view = useProposal.getState().byWorkspace[ev.workspaceId]?.view;
          openLibraryPage(ev.workspaceId, view ? proposalPage(view) : "skills");
        });
      return;
    }
    // Skills hub H6a: a team skill waiting for an OK opens its sheet in the
    // Library of the workspace the row is filed under (the team library
    // reaches every workspace, so any of them can show it).
    // Skills hub H2 (R16): the question about a team library GitHub no longer
    // lets this account read is answered in Settings › Team.
    if (ev.kind === "library_access_lost" || ev.kind === "team_plugin_refused") {
      useUi.getState().openSettingsSection("team-workspaces");
      return;
    }
    // 1.173.0 (C3): the question about a shared setting both sides changed,
    // over the workspace it is about (made active above).
    // 1.175.0 B2: "v1.4.0's install step needs your OK" opens its sheet.
    if (isInstallOkRow(ev)) {
      useChecksConsent.getState().openInstallSheet(ev.workspaceId);
      return;
    }
    if (ev.kind === "shared_setting_conflict") {
      void useSettingConflict.getState().show(ev.workspaceId, conflictFieldOfInboxId(ev.id));
      return;
    }
    // 1.173.0 (E3): a round's ideas open the Board on that area, with the
    // Next improvement section shown.
    if (ev.kind === "next_improvement_ideas") {
      const ni = niOfInboxId(ev.id);
      if (ni) lookAtTheIdeas(ev.workspaceId, ni.area);
      else openCenterMode(ev.workspaceId, "board");
      return;
    }
    // Skills hub H4 (R3, R8): a linked copy's decision is answered on its
    // own row's page in that workspace's Library.
    if (ev.kind === "skill_decision") {
      const skill = decisionSkillOf(ev.id);
      openLibraryPage(ev.workspaceId, "skills");
      if (skill) useLibrary.getState().openSkill(ev.workspaceId, `repository:${skill}`);
      return;
    }
    if (ev.kind === "skill_needs_ok") {
      const skill = needsOkSkillOf(ev.id);
      // Skills hub H10: a My library skill is answered on its All skills
      // page (a workspace Library only lists My library, read-only — X3).
      if (ev.id.startsWith("skill:library:")) {
        useUi.getState().setAllSkillsOpen(true);
        if (skill) useAllSkills.getState().setOpenKey(`myLibrary:${skill}`);
        return;
      }
      openLibraryPage(ev.workspaceId, "skills");
      if (skill) useLibrary.getState().setFlow(ev.workspaceId, { kind: "scripts", key: `team:${skill}` });
      return;
    }
    if (ev.cardId) {
      // v1.76.0 (STEP6 D7): selectCard lands the center stage on Board
      // mode with the card's lifecycle open — no right-panel involved.
      ui.selectCard(ev.workspaceId, ev.cardId, true);
    } else {
      // Run / schedule rows: land on Activity (v1.81.0 P2-3 — the Agents
      // tab retired; run history's home is the Activity view).
      openCenterMode(ev.workspaceId, "activity");
    }
  },
}));

/** OB-9 (onboarding §10 row 6): the feed every surface draws and counts —
 *  without review-requested pull requests in solo mode. */
export function useShownFeed(): InboxFeed | null {
  const feed = useInbox((s) => s.feed);
  const solo = useSolo();
  return useMemo(() => feedForMode(feed, solo), [feed, solo]);
}

let subscribed = false;
let debounceTimer: number | null = null;

/**
 * Wire the event-driven refresh (STEP1.md D8): `kanban://changed`,
 * `agent://run-done`, and `improvement-proposal://changed` (GH #104, which
 * replaced the retired `knowledge://proposal-updated`) cover every local
 * transition the feed derives from except PR freshness (which the
 * InboxPanel's visible-gated interval handles).
 * Also fires the startup fetch — sidebar badges need the feed before the
 * tab is ever opened. Call once from App startup.
 */
export function startInboxSubscriptions() {
  if (subscribed) return;
  subscribed = true;
  const kick = () => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void useInbox.getState().refresh();
    }, 500);
  };
  void onKanbanChanged(() => kick());
  void onAgentRunDone(() => kick());
  void onImprovementProposalChanged(() => kick());
  void onSkillsHubDecision(() => kick());
  // 1.173.0 (C3): a refresh that held or published a shared setting adds or
  // removes its row.
  void onWorkspaceDefinitionRefreshed((report) => {
    if (report.publish) kick();
  });
  void onWorkspaceDefinitionEdited(() => kick());
  // 1.173.0 (E3): a round that ends with ideas, or an idea answered, adds or
  // takes away its Next improvement row.
  void onNiProgress((view) => {
    if (view.round?.status !== "running") kick();
  });
  void useInbox.getState().refresh();
}
