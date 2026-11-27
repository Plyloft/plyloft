import { create } from "zustand";
import {
  projectConfigSet,
  projectDetectForSetup,
  projectLocalOrigin,
  workspaceDefinitionGet,
} from "../ipc";
import { refreshConfiguredProjects } from "../store/setupFinishStore";
import { pushToast } from "../store/toastStore";
import { changeSetUpAction } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { autoSetUpConfig } from "./projectSettingsStep";
import { autoSetUpBranchIsSafe, setUpOnAddNotice, setUpOnStartNotice } from "./projectSetup";

/** What an automatic set-up did: saved a config (`branch`), or found the
 *  repository already set up (another press, or Settings, got there
 *  first) — nothing saved, nothing to say. */
export type AutoSetUp =
  | {
      kind: "saved";
      branch: string;
      /** 1.171.0 walk fix: saved only by `justAdded`'s wider rule — the
       *  start's own rule wouldn't have taken this branch; Add a project
       *  says so (`setUpOnAddNotice`). */
      widened?: boolean;
    }
  | { kind: "already" };

/** One set-up at a time per workspace: two presses share it — one save, one
 *  toast. */
const inFlight = new Map<string, Promise<AutoSetUp | null>>();

/** N14 walk F9 / n16: read the repository as Setup's step 9 does and save
 *  the plain proposal (`autoSetUpConfig`). `null` — nothing saved, the
 *  start keeps its Set up — when:
 *  - the workspace has a shared definition (a save there would publish to
 *    the team: that is the person's call, from Settings);
 *  - there is nothing plain to propose (no branch, no commit, not a
 *    repository, shared settings);
 *  - the branch is not safely the one to build from: origin's own default
 *    (`refs/remotes/origin/HEAD`, read locally), or — with no origin —
 *    `main`, `master` or the only branch (`justAdded`: a project Add a
 *    project just added, `autoSetUpBranchIsSafe`'s wider rule);
 *  - a read or the save failed. */
export function autoSetUp(workspaceId: string, opts: { justAdded?: boolean } = {}): Promise<AutoSetUp | null> {
  const running = inFlight.get(workspaceId);
  if (running) return running;
  const run = setUpOnce(workspaceId, opts.justAdded === true).finally(() => inFlight.delete(workspaceId));
  inFlight.set(workspaceId, run);
  return run;
}

async function setUpOnce(workspaceId: string, justAdded: boolean): Promise<AutoSetUp | null> {
  try {
    const definition = await workspaceDefinitionGet(workspaceId);
    if (definition?.effective != null) return null;
    // Windows walk of 1.160.0: git is slow to start there, so the two reads
    // of the repository (each a few git calls) run side by side, not one
    // after the other. Origin is read from local refs only: an offline or
    // slow first start isn't held up.
    const originRead = projectLocalOrigin(workspaceId).then(
      (origin) => ({ origin }),
      (error: unknown) => ({ error }),
    );
    const view = await projectDetectForSetup(workspaceId, null);
    if ((view.state === "existing" || view.state === "shared") && view.config) return { kind: "already" };
    const config = autoSetUpConfig(view);
    if (!config) return null;
    const read = await originRead;
    if ("error" in read) throw read.error;
    const strict = autoSetUpBranchIsSafe(config.targetBranch, view.branches, read.origin);
    if (!strict && !autoSetUpBranchIsSafe(config.targetBranch, view.branches, read.origin, justAdded)) return null;
    await projectConfigSet(workspaceId, config);
    refreshConfiguredProjects();
    return { kind: "saved", branch: config.targetBranch, ...(strict ? {} : { widened: true }) };
  } catch (e) {
    console.warn("auto set-up:", e);
    return null;
  }
}

/** Windows walk of 1.160.0: the cards whose start is setting the repository
 *  up right now, so their start button says "Setting up…" rather than a
 *  bare "Starting…" through the wait. */
export const useSettingUp = create<{ byCard: Record<string, true> }>(() => ({ byCard: {} }));

function markSettingUp(cardId: string, on: boolean): void {
  useSettingUp.setState((s) => {
    const byCard = { ...s.byCard };
    if (on) byCard[cardId] = true;
    else delete byCard[cardId];
    return { byCard };
  });
}

/** The same set-up for a start a missing config refused. Resolves what the
 *  start says once its retry went through (a saved config's toast, with
 *  Change; nothing for one already there), or `null`: the refusal stands.
 *  `cardId`: the card whose start waits on it, marked in `useSettingUp`
 *  meanwhile. */
export async function autoSetUpForStart(
  workspaceId: string,
  cardId?: string,
): Promise<(() => void) | null> {
  if (cardId) markSettingUp(cardId, true);
  let outcome: AutoSetUp | null;
  try {
    outcome = await autoSetUp(workspaceId);
  } finally {
    if (cardId) markSettingUp(cardId, false);
  }
  if (!outcome) return null;
  if (outcome.kind === "already") return () => {};
  return () => announce(workspaceId, outcome);
}

/** 1.171.0 walk fix: a project Add a project just added, set up for
 *  builds at once. A branch only the wider rule took is said, with Change
 *  (Challenger 1); the plain one stays quiet, as before. */
export async function autoSetUpAdded(workspaceId: string): Promise<void> {
  const outcome = await autoSetUp(workspaceId, { justAdded: true });
  if (outcome?.kind !== "saved" || !outcome.widened || announced.has(outcome)) return;
  announced.add(outcome);
  const name =
    useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.name?.trim() || "This repository";
  pushToast({ kind: "info", ...setUpOnAddNotice(name, outcome.branch), action: changeSetUpAction(workspaceId) });
}

/** Each saved set-up is said once, however many starts waited on it. */
const announced = new WeakSet<AutoSetUp>();

function announce(workspaceId: string, outcome: AutoSetUp & { kind: "saved" }): void {
  if (announced.has(outcome)) return;
  announced.add(outcome);
  const name =
    useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.name?.trim() || "This repository";
  pushToast({ kind: "info", ...setUpOnStartNotice(name, outcome.branch), action: changeSetUpAction(workspaceId) });
}
