import { create } from "zustand";
import type { ItemKind } from "../lib/sharedLibrary";
import { shipPendingRelease, type LocalBranchReport, type UnpublishedRelease } from "../ipc";
import {
  asLocalBranchRefused,
  asRecordUnreadable,
  asUnpublishedRelease,
  readPendingRelease,
  recordUnreadableError,
  unpublishedReleaseError,
  blockFromLocalBranch,
  localBranchRefusalError,
  placementOf,
  publishRefusedError,
  type LocalBranchRefusal,
  refusalPage,
  type PublishRefusal,
  type StoppedOperation,
} from "../lib/uxError";
import { announceError, type ErrorWhere } from "../lib/announceError";
import { markReleaseScopesStale } from "./releaseScopeStore";

/**
 * UX language card 7 (GH #102): the errors that stay on a page until the
 * condition is gone (BOARDS.md §5).
 *
 * **Why a store and not the page's own state.** The block outlives the surface
 * that shows it: the Library is a centre mode, Settings is a modal, and either
 * can be closed and reopened — or the workspace switched away and back — while
 * the untracked file is still in the way. React state in `SkillsPage` would
 * take the way out away with the mode switch; here it survives, because
 * nothing but a later outcome clears it.
 *
 * Session-only, like `libraryStore`: a refusal is recomputed by the next Sync,
 * and a block restored from disk could outlive the file it is about. Nothing
 * here is persisted, so there is no schema to migrate.
 *
 * Keyed by `workspaceId` throughout (AGENTS.md), and read with selectors that
 * return a stored value or `null` — never a fresh object, which would re-render
 * every host on every unrelated change.
 */
export interface WorkspaceErrorBlocks {
  /** GH #88's refusal: `Local <branch> can't be updated`. */
  localBranch: LocalBranchRefusal | null;
  /**
   * GH #151: the whole operation that refusal stopped, when it was Ship or Land
   * that met it rather than a Sync. Its block is drawn on the Ship step of
   * these cards (PATTERNS.md §4). Only a marker: the refusal itself is
   * `localBranch` — one condition, one copy — so the Trash, a failed Trash and
   * a Sync update or clear it wherever it is drawn.
   */
  shipStep: ShipStepRefusal | null;
  /** A publish the branch refused with no pull request possible. */
  publishRefused: PublishRefusal | null;
  /**
   * GH #222: a release committed and tagged here and recorded, not yet
   * published. Review 2: a mirror of the backend's record
   * (`release_record`), which is the truth — refreshed by the Ship step when
   * it mounts and whenever the record changes (`ship-pending-release-changed`),
   * so it goes when the record is cleared any way at all.
   */
  unpublished: UnpublishedRelease | null;
  /** GH #222 review 3: why the workspace's record can't be read, if so. */
  unreadableRecord: string | null;
  /**
   * E3 (1.172.0): the local branch's lasting state from the last Sync —
   * behind GitHub with changes in the folder, open in another folder, both
   * moved, couldn't be updated — kept on Settings › Board and worktrees for
   * as long as it is true, so a toast said once is not its only copy. Null
   * when the last Sync found none (or GH #102's refusal, its own block).
   */
  localState: LocalBranchReport | null;
}

/** GH #151: which cards' Ship step holds the block, and the verb pressed. */
export interface ShipStepRefusal {
  /** The card Ship or Merge was pressed on; a batch's every card. */
  cardIds: string[];
  stopped: StoppedOperation;
}

const NONE: WorkspaceErrorBlocks = {
  localBranch: null,
  shipStep: null,
  publishRefused: null,
  unpublished: null,
  unreadableRecord: null,
  localState: null,
};

interface ErrorBlockStore {
  byWorkspace: Record<string, WorkspaceErrorBlocks>;
  /** `null` takes the condition down, and with it the Ship step's block. */
  setLocalBranch: (workspaceId: string, refusal: LocalBranchRefusal | null) => void;
  /** GH #151: put the block on these cards' Ship step, or take it off. */
  setShipStep: (workspaceId: string, at: ShipStepRefusal | null) => void;
  /** A `Move the local copy to Trash` that didn't go through: the block keeps
   *  the refusal, says why, and — when the move stopped part way — names what
   *  is in the Trash, so `What was left untouched` stays true (review 1). */
  setTrashError: (
    workspaceId: string,
    reason: string | null,
    stuckInTrash?: string[],
    /** The paths that press asked to move: a skill's page shows only a failure
     *  about its own files (review 2). */
    trashAsked?: string[],
  ) => void;
  setPublishRefused: (workspaceId: string, refusal: PublishRefusal | null) => void;
  /** GH #222: put the unpublished release up, or take it down. */
  setUnpublished: (workspaceId: string, release: UnpublishedRelease | null) => void;
  /** GH #222 review 3: the record can't be read (or `null`: it can). */
  setUnreadableRecord: (workspaceId: string, reason: string | null) => void;
  /** E3: the last Sync's lasting local-branch state, or `null`. */
  setLocalState: (workspaceId: string, report: LocalBranchReport | null) => void;
  reset: (workspaceId: string) => void;
}

function patch(
  state: ErrorBlockStore,
  workspaceId: string,
  next: Partial<WorkspaceErrorBlocks>,
): Pick<ErrorBlockStore, "byWorkspace"> {
  const was = state.byWorkspace[workspaceId] ?? NONE;
  return {
    byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...was, ...next } },
  };
}

export const useErrorBlocks = create<ErrorBlockStore>((set) => ({
  byWorkspace: {},
  setLocalBranch: (workspaceId, refusal) =>
    set((s) => {
      // Nothing to remember and nothing remembered: leave the map alone, so a
      // quiet Sync doesn't re-render every workspace's hosts.
      if (!refusal && !s.byWorkspace[workspaceId]?.localBranch) return s;
      // The condition gone is the Ship step's block gone too (GH #151).
      return patch(
        s,
        workspaceId,
        refusal ? { localBranch: refusal } : { localBranch: null, shipStep: null },
      );
    }),
  setShipStep: (workspaceId, at) =>
    set((s) => {
      if (!at && !s.byWorkspace[workspaceId]?.shipStep) return s;
      return patch(s, workspaceId, { shipStep: at });
    }),
  setTrashError: (workspaceId, reason, stuckInTrash = [], trashAsked = []) =>
    set((s) => {
      const was = s.byWorkspace[workspaceId]?.localBranch;
      if (!was) return s;
      const key = (paths: readonly string[]) => paths.join("\u0000");
      const same =
        (was.trashError ?? null) === reason &&
        key(was.stuckInTrash ?? []) === key(stuckInTrash) &&
        key(was.trashAsked ?? []) === key(trashAsked);
      if (same) return s;
      return patch(s, workspaceId, {
        localBranch: { ...was, trashError: reason, stuckInTrash, trashAsked },
      });
    }),
  setPublishRefused: (workspaceId, refusal) =>
    set((s) => {
      if (!refusal && !s.byWorkspace[workspaceId]?.publishRefused) return s;
      return patch(s, workspaceId, { publishRefused: refusal });
    }),
  setUnpublished: (workspaceId, release) =>
    set((s) => {
      if (!release && !s.byWorkspace[workspaceId]?.unpublished) return s;
      return patch(s, workspaceId, { unpublished: release });
    }),
  setUnreadableRecord: (workspaceId, reason) =>
    set((s) => {
      if ((s.byWorkspace[workspaceId]?.unreadableRecord ?? null) === reason) return s;
      return patch(s, workspaceId, { unreadableRecord: reason });
    }),
  setLocalState: (workspaceId, report) =>
    set((s) => {
      const was = s.byWorkspace[workspaceId]?.localState ?? null;
      if (!report && !was) return s;
      if (report && was && JSON.stringify(report) === JSON.stringify(was)) return s;
      return patch(s, workspaceId, { localState: report });
    }),
  reset: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.byWorkspace)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),
}));

/**
 * What a reconcile/Sync's local-branch outcome does to the block.
 *
 * `untrackedDiffers` puts the block up — every time, whether or not this pass
 * is the first to report it, so a member who Syncs twice does not lose the way
 * out — and announces it once (`repeated` is GH #88's guard against toasting
 * the same refusal at the same tips). **Any other outcome clears it**, which
 * is how the block goes when the fast-forward finally succeeds.
 *
 * Returns whether the outcome was the refusal, so the caller knows the ordinary
 * toast is not wanted.
 */
export function observeLocalBranch(
  workspaceId: string,
  report: LocalBranchReport,
): boolean {
  const next = blockFromLocalBranch(report);
  if (!next) {
    // UX P-A (Windows walk 2): files in the way of a card's merge are not the
    // fast-forward's, so no Sync outcome says they have gone; the Trash on
    // the card's Ship step, or the next land that merges, takes them down.
    if (useErrorBlocks.getState().byWorkspace[workspaceId]?.localBranch?.atMerge) return false;
    useErrorBlocks.getState().setLocalBranch(workspaceId, null);
    return false;
  }
  const { refusal, announce } = next;
  const blocks = useErrorBlocks.getState().byWorkspace[workspaceId];
  // GH #151 review 1: Ship or Land already announced this refusal, and Sync's
  // own guard (`repeated`, Rust's) never heard of it — Ship does not touch
  // it. While the Ship step holds the block, the same refusal from a Sync is
  // not news: the block is refreshed silently. A refusal that has changed is
  // Sync's news, said in Sync's words on Sync's page — never "Ship stopped",
  // for a press that did not happen.
  const silent = !!blocks?.shipStep && sameRefusal(blocks.localBranch, refusal);
  useErrorBlocks.getState().setLocalBranch(workspaceId, refusal);
  if (announce && !silent) {
    announceError(
      localBranchRefusalError(refusal),
      placementOf(refusal) === "library"
        ? { page: "library-skills", workspaceId }
        : { page: "settings-worktrees", workspaceId },
    );
  }
  return true;
}

/** The same refusal: the same branch, and the same paths in the way. */
function sameRefusal(was: LocalBranchRefusal | null | undefined, now: LocalBranchRefusal): boolean {
  if (!was || was.branch !== now.branch || was.paths.length !== now.paths.length) return false;
  const paths = new Set(was.paths);
  return now.paths.every((path) => paths.has(path));
}

/**
 * GH #151: what a Ship or Land rejection does to the card's Ship step.
 *
 * GH #88's refusal (`asLocalBranchRefused`) puts the block up on the Ship step
 * of `cardIds` — the card pressed, or a batch's every card — and announces it
 * with `Show`, which opens the first of them on that step. Announced on every
 * press, `repeated` or not: the member pressed Ship and has to hear why nothing
 * happened. Returns whether it was the refusal, so the caller does not also
 * toast the rejection its own way.
 *
 * `passedGate` (review 1) is true only when the attempt is known to have got
 * past the fast-forward check — a land that merged or conflicted, a release
 * that pushed. Only then is the refusal not what stops this card any more, and
 * the Ship step's block comes off. An attempt that never reached the check (a
 * PR, `verify_pending`, a local-only release) or stopped for another reason
 * leaves it where it is — unless the card `shipped` anyway (review 2).
 *
 * GH #183: the underlying condition comes down here only on Rust's word that
 * the fast-forward reached origin's tip (`fastForwarded`: FastForwarded or
 * UpToDate). The check also lets an attempt through offline, without an
 * origin or ahead, when nothing was fast-forwarded — then the condition stays
 * for Sync or the Trash. On that word it comes down in every workspace,
 * GitHub sync or not, and with it every block drawn from it (the Library,
 * Settings › Worktrees, any card's Ship step).
 */
export function observeShipAttempt(
  workspaceId: string,
  cardIds: string[],
  stopped: StoppedOperation,
  result:
    | { refused: unknown }
    | { passedGate: boolean; shipped?: boolean; fastForwarded?: boolean },
): boolean {
  const store = useErrorBlocks.getState();
  if ("refused" in result) {
    // GH #222: a release committed here whose push was stopped — on its cards'
    // Ship step until it is published, announced once. The dialog closes so
    // the block is what is seen, and a dialog closed mid-ship loses nothing.
    const unpublished = asUnpublishedRelease(result.refused);
    if (unpublished) {
      store.setUnpublished(workspaceId, unpublished);
      const cardId = unpublished.cardIds[0] ?? cardIds[0];
      const error = unpublishedReleaseError(unpublished);
      // Review 3: a Merge (or the Outcome screen's Ship) refused while the
      // release waits says what it was.
      if (stopped === "merge") error.toast = `Merge stopped: ${unpublished.tag} isn't published yet.`;
      if (cardId) announceError(error, { page: "card-ship", workspaceId, cardId });
      return true;
    }
    // GH #222 review 3: the record can't be read — on every card's Ship step
    // of the workspace, with Dismiss; `Show` opens the card pressed.
    const unreadable = asRecordUnreadable(result.refused);
    if (unreadable !== null) {
      store.setUnreadableRecord(workspaceId, unreadable);
      if (cardIds[0]) {
        announceError(recordUnreadableError(unreadable), { page: "card-ship", workspaceId, cardId: cardIds[0] });
      }
      return true;
    }
    const refusal = asLocalBranchRefused(result.refused);
    if (!refusal || cardIds.length === 0) return false;
    store.setLocalBranch(workspaceId, refusal);
    store.setShipStep(workspaceId, { cardIds, stopped });
    const where: ErrorWhere = { page: "card-ship", workspaceId, cardId: cardIds[0] };
    announceError(localBranchRefusalError(refusal, stopped), where);
    return true;
  }
  // DR3 round 1: a Ship it or a release is done — what the next release of
  // the workspace carries changed; its reading is read again.
  if (result.shipped) markReleaseScopesStale(workspaceId);
  // GH #222: a card of the unpublished release shipped — it was published.
  if (result.shipped) {
    const pending = store.byWorkspace[workspaceId]?.unpublished ?? null;
    if (pending && pending.cardIds.some((id) => cardIds.includes(id))) {
      store.setUnpublished(workspaceId, null);
    }
  }
  // GH #183: the branch is at origin's tip, so the refusal is not true any
  // more — the condition goes, and every block drawn from it.
  if (result.fastForwarded === true) {
    store.setLocalBranch(workspaceId, null);
    return false;
  }
  // Review 2: a card that shipped by a path that never ran the check (a PR, a
  // local-only release) is not stopped either — "Then ship again" under its
  // shipped result would be false. The condition itself stays Sync's.
  if (!result.passedGate && !result.shipped) return false;
  const at = store.byWorkspace[workspaceId]?.shipStep ?? null;
  if (at && at.cardIds.some((id) => cardIds.includes(id))) {
    // UX P-A (Windows walk 2): a merge's refusal is this press's card's
    // alone; the land got to its merge, so it goes with the step's block.
    if (store.byWorkspace[workspaceId]?.localBranch?.atMerge) store.setLocalBranch(workspaceId, null);
    else store.setShipStep(workspaceId, null);
  }
  return false;
}

/**
 * Immediacy walk 8.3 (Mac, 2026-11-10): a merge's refusal (`atMerge`: files
 * in the project folder in the way of *this card's* merge) is about the work
 * the card had when Ship met it. Once that work changes — a Bring in that
 * merged or met a conflict, a Finish and check that recorded a new snapshot —
 * it no longer stops the card: it comes off, so what is true now leads (the
 * conflict's Fix with the Builder, Ready to ship). Prudent: nothing is merged
 * without git's own check, and the next Ship meets the files again if they
 * are still there, announced as before. A fast-forward refusal (the local
 * branch itself) is the workspace's and Sync's: untouched here.
 */
export function cardWorkChanged(workspaceId: string, cardId: string): void {
  const store = useErrorBlocks.getState();
  const blocks = store.byWorkspace[workspaceId];
  const at = blocks?.shipStep ?? null;
  if (!blocks?.localBranch?.atMerge || !at || !at.cardIds.includes(cardId)) return;
  const rest = at.cardIds.filter((id) => id !== cardId);
  if (rest.length === 0) store.setLocalBranch(workspaceId, null);
  else store.setShipStep(workspaceId, { ...at, cardIds: rest });
}

/** The shared-library half of a definition refresh: a push the branch refused
 *  with no pull request possible. Announced only on the publish that met it
 *  (the refresh repeats the fact on every pass), but the block follows the
 *  condition: set while it holds, gone when the next report is clean. */
export function observeLibraryRefusal(
  workspaceId: string,
  moment: string,
  library:
    | {
        branch: string;
        refused: string | null;
        pending: string[];
        /** GH #101: the kinds still queued, so the block and the toast land on
         *  the Library page the member met the refusal on. */
        pendingKinds?: ItemKind[];
      }
    | null
    | undefined,
): void {
  // Two-account walk: a read for a page has no library half and says nothing
  // about the refusal, which stays until a read that tried again.
  if (moment === "pageRead") return;
  const store = useErrorBlocks.getState();
  // No library half at all — the workspace is off the shared channel, or the
  // pass never reached it — means the refusal is not what is true now either,
  // so the block goes (review 1: it used to stay for the session).
  if (!library || !library.refused) {
    store.setPublishRefused(workspaceId, null);
    return;
  }
  const refusal: PublishRefusal = {
    branch: library.branch,
    titles: library.pending,
    kinds: library.pendingKinds,
    output: library.refused,
  };
  const was = useErrorBlocks.getState().byWorkspace[workspaceId]?.publishRefused ?? null;
  store.setPublishRefused(workspaceId, refusal);
  if (moment === "publish" && !was) {
    // GH #101 review 1 (MAJOR): `Show` leads to the page that draws the block.
    // An instructions refusal used to land on Skills, where nothing said it.
    announceError(publishRefusedError(refusal), {
      page: refusalPage(refusal) === "instructions" ? "library-instructions" : "library-skills",
      workspaceId,
    });
  }
}

/**
 * GH #222 review 2: read the workspace's recorded release from the backend and
 * mirror it here (`null` when there is none). A failed read leaves what was
 * there: the block is never taken down on a guess.
 */
export async function refreshPendingRelease(workspaceId: string): Promise<void> {
  try {
    const state = await shipPendingRelease(workspaceId);
    const store = useErrorBlocks.getState();
    store.setUnpublished(workspaceId, readPendingRelease(state?.release ?? null));
    store.setUnreadableRecord(
      workspaceId,
      typeof state?.unreadable === "string" ? state.unreadable : null,
    );
  } catch (e) {
    console.warn("ship: pending release read failed", e);
  }
}
