import { create } from "zustand";
import {
  buildBothCompareAgain,
  buildBothLaneDone,
  buildBothLaneResume,
  buildBothLaneStartFresh,
  buildBothLaneStop,
  buildBothPick,
  buildBothStart,
  buildBothStartLanes,
  buildBothStop,
  projectConfigGet,
  type BuildBothModels,
  type BuildLaneId,
} from "../ipc";
import { buildBothOffer, laneDoneWords, laneKey, laneOf, noChecksSetUp } from "../lib/buildBoth";
import { cardInWorkspace, startBuildWithClaim } from "../lib/cardClaim";
import { dismissStartRefusalToasts, noteStartRefusalToast } from "./startRefusalToasts";
import { showPlanRefusal } from "./planPrompts";
import { vendorReadiness } from "../lib/vendorReadiness";
import { noteBuilderResumed, startPermissions, useBuilder } from "./builderStore";
import { useDoctor } from "./doctorStore";
import { useKanban } from "./kanbanStore";
import { ensureCardArea } from "./cardAreaStore";
import { pushToast } from "./toastStore";
import { setUpAction, useUi } from "./uiStore";
import { offerWorktreeEnvCopy } from "./worktreeSetupFlow";
import { autoSetUpForStart } from "../lib/autoSetUp";
import { FINISH_LABEL } from "../lib/cardLifecycle";
import { pushErrorToast } from "../lib/errorToast";

/**
 * SL-6 — Build with both, from the card: every press goes to the backend
 * (`build_both.rs`), then the board is read again. What is running is on the
 * card (`buildBoth`); this store only keeps which press is under way per
 * card, so its button stays off while it runs.
 */
interface BuildBothStore {
  busy: Record<string, string | undefined>;
  /** Which build each card's run section shows (`<ws>::<cardId>`), so the
   *  Inbox's Open session on one build's row shows that build (round 3).
   *  In memory; Claude's by default. */
  shownLane: Record<string, BuildLaneId | undefined>;
  showLane: (workspaceId: string, cardId: string, lane: BuildLaneId) => void;
  /** CL-8: the card whose start sheet is open — each build's model is
   *  chosen there before anything moves. */
  choosing: { workspaceId: string; cardId: string } | null;
  /** Build with both, pressed: checked, then the start sheet opens. */
  start: (workspaceId: string, cardId: string) => Promise<void>;
  cancelStart: () => void;
  /** The start sheet's Start both builds: the card advances and both start
   *  on the models chosen. */
  startWith: (workspaceId: string, cardId: string, models?: BuildBothModels) => Promise<void>;
  startLanes: (workspaceId: string, cardId: string) => Promise<void>;
  resume: (workspaceId: string, cardId: string, lane: BuildLaneId) => Promise<void>;
  startFresh: (workspaceId: string, cardId: string, lane: BuildLaneId) => Promise<void>;
  done: (workspaceId: string, cardId: string, lane: BuildLaneId) => Promise<void>;
  stopLane: (workspaceId: string, cardId: string, lane: BuildLaneId) => Promise<void>;
  compareAgain: (workspaceId: string, cardId: string) => Promise<void>;
  pick: (workspaceId: string, cardId: string, lane: BuildLaneId) => Promise<boolean>;
  stop: (workspaceId: string, cardId: string) => Promise<void>;
}

/** The key of `shownLane`: card ids repeat across repositories. */
export function shownLaneKey(workspaceId: string, cardId: string): string {
  return `${workspaceId}::${cardId}`;
}


export const useBuildBoth = create<BuildBothStore>((set, get) => {
  /** One press per card at a time; the board is read again after it. */
  async function press<T>(
    workspaceId: string,
    cardId: string,
    what: string,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    if (get().busy[cardId]) return undefined;
    set((s) => ({ busy: { ...s.busy, [cardId]: what } }));
    try {
      const out = await run();
      return out;
    } catch (e) {
      pushErrorToast(`${what} didn't go through`, e, { then: "Nothing else changed on the card." });
      return undefined;
    } finally {
      set((s) => {
        const busy = { ...s.busy };
        delete busy[cardId];
        return { busy };
      });
      await useKanban.getState().loadFromDisk(workspaceId, true).catch(() => {});
    }
  }

  return {
    busy: {},
    shownLane: {},
    showLane: (workspaceId, cardId, lane) =>
      set((s) => ({ shownLane: { ...s.shownLane, [shownLaneKey(workspaceId, cardId)]: lane } })),

    choosing: null,
    cancelStart: () => set({ choosing: null }),

    start: async (workspaceId, cardId) => {
      const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
      if (!card) return;
      const offer = buildBothOffer(card, vendorReadiness(useDoctor.getState().report));
      if (!offer.offered) {
        if (offer.reason) {
          pushToast({
            kind: "error",
            title: offer.reason,
            action: { label: "Open Diagnostics", onClick: () => useUi.getState().openSettingsSection("diagnostics") },
          });
        }
        return;
      }
      if (get().busy[cardId]) return;
      // CL-8: the two model fields come first, prefilled; nothing moves yet.
      set({ choosing: { workspaceId, cardId } });
    },

    startWith: async (workspaceId, cardId, models) => {
      set({ choosing: null });
      const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
      if (!card) return;
      // Refused before the card moves, with the reason (both CLIs, a card
      // not built yet); the backend checks the same again.
      const offer = buildBothOffer(card, vendorReadiness(useDoctor.getState().report));
      if (!offer.offered) {
        if (offer.reason) {
          pushToast({
            kind: "error",
            title: offer.reason,
            action: { label: "Open Diagnostics", onClick: () => useUi.getState().openSettingsSection("diagnostics") },
          });
        }
        return;
      }
      if (get().busy[cardId]) return;
      // A new press answers the last failure; if it fails it says so anew.
      useBuilder.getState().clearError(cardId);
      // 1.171.0 (D1): the lanes take "Never asks" as their bypass; the other
      // two choices start them as before.
      const bypass =
        (useBuilder.getState().bypassPref[cardId] ?? false) || startPermissions(workspaceId, card) === "neverAsks";
      useBuilder.getState().clearBypassPref(cardId);
      set((s) => ({ busy: { ...s.busy, [cardId]: "Build with both" } }));
      try {
        // 1.173.0 (B3 Challenger 2): a card with no area to start in asks
        // first — before the `.env` question, the claim and any copy.
        if (!(await ensureCardArea(workspaceId, cardId, "start"))) return;
        const started = await startBuildWithClaim({
          claimStep: () => useKanban.getState().claimBeforeBuild(workspaceId, cardId),
          // SL-4: the one-time `.env` question comes before the first
          // worktree — v1.154.1 (K1) only in a repository that is set up:
          // one that isn't is refused here, before the question and before
          // its issue is claimed.
          beforeClaim: () => offerWorktreeEnvCopy(workspaceId, cardId),
          // n16: a repository not set up is set up once, then the start goes on.
          autoSetUp: () => autoSetUpForStart(workspaceId, cardId),
          onPlanRefusal: showPlanRefusal,
          start: async () => {
            await buildBothStart(workspaceId, cardId, bypass, models);
          },
          notify: ({ setUp, ...notice }) => {
            // CL-11: said on the card too, with Set up (see builderStore).
            if (setUp) useBuilder.getState().noteSetUpNeeded(cardId, "Build with both", notice.details ?? notice.body ?? "");
            else if (notice.details) useBuilder.getState().noteStartBranchMissing(cardId, "Build with both", notice.details);
            const id = pushToast(setUp ? { ...notice, action: setUpAction(workspaceId) } : notice);
            // 1.172 A3: a refusal is kept, so the start that goes through takes it away.
            if (notice.kind === "error") noteStartRefusalToast(cardId, id);
          },
          issueNumber: card.ghIssueNumber,
          title: card.title,
          press: "Build with both",
          notStarted: "Build with both didn't start",
        });
        // 1.172 A3: an earlier refusal of this card says nothing true now.
        if (started) dismissStartRefusalToasts(cardId);
      } catch {
        // v1.154.1 (J2): said once, by `startBuildWithClaim`'s toast (a
        // repository not set up offers Set up); nothing is left to reject.
      } finally {
        set((s) => {
          const busy = { ...s.busy };
          delete busy[cardId];
          return { busy };
        });
        await useKanban.getState().loadFromDisk(workspaceId, true).catch(() => {});
      }
    },

    startLanes: async (workspaceId, cardId) => {
      await press(workspaceId, cardId, "Start the builds", () => buildBothStartLanes(workspaceId, cardId));
    },

    resume: async (workspaceId, cardId, lane) => {
      const pressedAt = Date.now();
      const card = await press(workspaceId, cardId, "Resume", () => buildBothLaneResume(workspaceId, cardId, lane));
      // 1.174.3: as the card's own Resume: it started no turn.
      const ptyId = card ? laneOf(card.buildBoth, lane)?.ptyId : null;
      if (ptyId) noteBuilderResumed(laneKey(cardId, lane), ptyId, pressedAt);
    },

    startFresh: async (workspaceId, cardId, lane) => {
      await press(workspaceId, cardId, "Start fresh", () => buildBothLaneStartFresh(workspaceId, cardId, lane));
    },

    done: async (workspaceId, cardId, lane) => {
      const card = await press(workspaceId, cardId, FINISH_LABEL, () => buildBothLaneDone(workspaceId, cardId, lane));
      // Said only when its checks did start: an unchanged build whose checks
      // already have a result starts nothing, and the card says so.
      if (card && laneOf(card.buildBoth, lane)?.verify?.status === "running") {
        // Round 3: with no checks set up, none run — the toast says so.
        const noChecks = await projectConfigGet(workspaceId)
          .then(noChecksSetUp)
          .catch(() => false);
        pushToast({ kind: "info", ...laneDoneWords(card.buildBoth, lane, noChecks) });
      }
    },

    stopLane: async (workspaceId, cardId, lane) => {
      await press(workspaceId, cardId, "Stop this build", () => buildBothLaneStop(workspaceId, cardId, lane));
    },

    compareAgain: async (workspaceId, cardId) => {
      await press(workspaceId, cardId, "Compare again", () => buildBothCompareAgain(workspaceId, cardId));
    },

    pick: async (workspaceId, cardId, lane) => {
      const card = await press(workspaceId, cardId, "Pick", () => buildBothPick(workspaceId, cardId, lane));
      if (!card) return false;
      // The pick's session is now the card's own (the backend re-keyed it).
      for (const id of ["a", "b"] as const) {
        const rt = useBuilder.getState().byCard[laneKey(cardId, id)];
        if (rt) useBuilder.getState().detach(laneKey(cardId, id), rt.ptyId);
      }
      // The normal loop goes on: Finish and check saves the picked build, then
      // its checks and the Challenger's full review run.
      try {
        await useBuilder.getState().done(workspaceId, cardId);
      } catch {
        // Said on the card by the Builder store; Finish and check stays offered.
      }
      return true;
    },

    stop: async (workspaceId, cardId) => {
      await press(workspaceId, cardId, "Stop building with both", () => buildBothStop(workspaceId, cardId));
    },
  };
});
