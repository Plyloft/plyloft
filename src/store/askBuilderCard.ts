/**
 * QoL 1.168 (C2, C4, block 5.2): the card's ways out of an error that go
 * through its Builder — the failing checks sent to it, and the project
 * folder's own changes it is asked to commit. Both are a message into the
 * card's Builder session (`builderStore.askBuilder`, the "Not right"
 * delivery); Plyloft itself runs no git for them. The words are
 * `checksFix.ts`'s.
 */
import type { KanbanCard } from "../ipc";
import { useBuilder } from "./builderStore";
import { openCenterMode } from "./uiStore";
import { useVerify } from "./verifyStore";
import { pushToast } from "./toastStore";
import { useWorkspaces } from "./workspaceStore";
import { builderMayCommit, checksFixMessage, commitDirtyMessage, failingSteps, hookFixMessage } from "../lib/checksFix";
import { openInEditor } from "../lib/openInEditor";
import { joinPath } from "../lib/paths";
import { CHANGES_NEXT, type ChangesOutcome } from "../lib/reviewChanges";
import type { TargetDirtyState } from "../lib/shipPreflight";

/** Ask the card's Builder to fix the checks that failed. */
export async function askBuilderToFixChecks(card: KanbanCard): Promise<ChangesOutcome> {
  const live = useVerify.getState().byKey[`${card.workspaceId}::${card.id}`] ?? null;
  const liveSteps = live && live.state.kind === "failed" ? live.steps : null;
  const failed = failingSteps(card, liveSteps);
  const last = card.verifyHistory?.[card.verifyHistory.length - 1] ?? null;
  const summary = live?.state.kind === "failed" ? live.state.reason : (last?.summary ?? null);
  return useBuilder.getState().askBuilder(card.workspaceId, card.id, checksFixMessage(failed, summary), {
    next: CHANGES_NEXT,
    sentBody: "The failing checks are in its session. When it says it's done, press Finish and check.",
    markSent: true,
    key: "checks-fix",
  });
}

/** Ask the card's Builder to commit the project folder's own changes there,
 *  so the Ship that stopped on them can go in. */
export async function askBuilderToCommit(card: KanbanCard, dirty: TargetDirtyState): Promise<ChangesOutcome> {
  if (!builderMayCommit(card)) return "failed";
  const folder = useWorkspaces.getState().workspaces.find((w) => w.id === card.workspaceId)?.cwd ?? null;
  if (!folder) {
    pushToast({ kind: "warn", title: "Nothing was sent to the Builder", body: "The card's project isn't open." });
    return "failed";
  }
  return useBuilder.getState().askBuilder(card.workspaceId, card.id, commitDirtyMessage(folder, dirty), {
    next: "",
    sentBody: "It has the project folder's changes to commit. When it says it's done, press Ship it again.",
    markSent: false,
    key: "commit-dirty",
  });
}

/** R8: ask the card's Builder to fix what the project's hook refused in the
 *  commit of its work (`hookFixMessage`). */
export async function askBuilderToFixHook(card: KanbanCard, said: string): Promise<ChangesOutcome> {
  return useBuilder.getState().askBuilder(card.workspaceId, card.id, hookFixMessage(said), {
    next: CHANGES_NEXT,
    sentBody: "What the hook said is in its session. When it says it's done, press Finish and check.",
    markSent: true,
    key: "hook-fix",
  });
}

/** At most this many of the project folder's changed files open in Code;
 *  the error's Details lists them all. */
export const SHOW_FILES_MAX = 3;

/** "Show the files": the project folder's changed files, in Code. A file
 *  that is gone (a deletion) says so in its own toast. */
export async function showProjectFiles(workspaceId: string, dirty: TargetDirtyState): Promise<boolean> {
  const folder = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.cwd ?? null;
  if (!folder) return false;
  let opened = false;
  for (const rel of dirty.paths.slice(0, SHOW_FILES_MAX)) {
    if (await openInEditor(workspaceId, joinPath(folder, rel), rel)) opened = true;
  }
  if (opened) openCenterMode(workspaceId, "code");
  // E3 round 2: whether anything opened, so a caller can say why not.
  return opened;
}
