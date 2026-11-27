// QoL 7.2 (B2): one "Add a project" sheet, from every entry outside Setup —
// the sidebar switcher's `+`, ⌘K and the zero-project screen. It holds Setup
// step 8's own body (`FirstProjectStep`): a folder on this Mac, from GitHub,
// or a new project — the same checks (a folder that isn't a Git project is
// made one after a consent sheet; a clone runs in its own terminal) and the
// same words. Failures stay in the sheet, in the way's own words; nothing is
// only logged.
import { useCallback, useEffect, useState } from "react";
import { CBtn, Sheet } from "./ux";
import { FirstProjectStep } from "./setup/FirstProjectStep";
import type { Registered } from "./setup/ProjectFromFolder";
import type { StepPrimary } from "./setup/GitStep";
import { ADD_PROJECT_LABEL, useAddProject } from "../store/addProjectStore";
import { useGithubStatus } from "../store/githubStatusStore";
import { useSetupRun } from "../store/setupRunStore";
import { useSetup } from "../store/setupStore";
import { useWorkspaces } from "../store/workspaceStore";
import { openCenterMode } from "../store/uiStore";
import { pushToast } from "../store/toastStore";
import { focusActivePane } from "../store/tileActions";
import { githubConnected } from "../lib/githubStep";
import { autoSetUp, autoSetUpAdded } from "../lib/autoSetUp";
import { platform } from "../lib/platform";

/** The sheet's lede, with the machine's word ("Mac", "PC") as step 8's
 *  ways use it. */
export function addProjectLede(machine: "Mac" | "PC"): string {
  return `A folder on this ${machine}, one from GitHub, or a new one. Plyloft keeps a Board, terminals and a Library for each project.`;
}

/** 1.174.0 C16 round 1: the done state's primary, shown only when a note
 *  says something failed (`Registered.failed`); otherwise the sheet closes
 *  onto the Board once a project is in. */
const FAILED_DONE_LABEL = "Open its Board";

/** 1.174.0 C16 (NIW-6): the toast once the sheet has closed onto the
 *  project's Board. */
export function addedToast(name: string): string {
  return `${name} is in Plyloft.`;
}

export function AddProjectSheetHost() {
  const open = useAddProject((s) => s.open);
  if (!open) return null;
  return <AddProjectSheet onClose={() => useAddProject.getState().closeAddProject()} />;
}

export function AddProjectSheet({ onClose }: { onClose: () => void }) {
  const status = useGithubStatus((s) => s.status);
  useEffect(() => {
    void useGithubStatus.getState().refresh(false);
  }, []);
  const connected = githubConnected(status) === true;
  const [primary, setPrimary] = useState<StepPrimary | null>(null);
  // A download under way can't be left by a stray Esc or click: the way's own
  // Cancel stops it first (Setup asks "Stop the download?" the same way).
  const cloning = useSetupRun((s) => s.run?.actionId === "project.clone" && s.phase !== "done");

  /** 1.174.0 C16 (NIW-6): no step after the way's own primary — the sheet
   *  closes, the project's Board opens and a toast says it is in, with the
   *  way's notes under it (changes left in the folder). A note that says
   *  something failed stays in the sheet first (`told`: no toast then). */
  const finish = useCallback(
    (ws: Registered, told: boolean) => {
      onClose();
      const notes = (ws.notes ?? []).filter(Boolean);
      if (!told) pushToast({ kind: "info", title: addedToast(ws.name), ...(notes.length ? { body: notes.join(" ") } : {}) });
      void useWorkspaces
        .getState()
        .setActive(ws.id)
        .catch(() => {})
        .then(() => {
          openCenterMode(ws.id, "board");
          // Lane 1 (QoL 1.168 A1): the keyboard goes into the new project's
          // page, as after any workspace switch.
          focusActivePane(ws.id);
          // N14 walk F9 (was `pickAndCreateWorkspace`): the plain proposal, so
          // the first Start build isn't stopped by "isn't set up yet". Quiet.
          void autoSetUp(ws.id, { justAdded: true }).catch(() => {});
        });
    },
    [onClose],
  );

  // Git's name and GitHub's sign-in live in Setup: the sheet closes onto
  // that step (nothing is lost — the project isn't added yet).
  const goStep = useCallback(
    (id: "git" | "github") => {
      onClose();
      useSetup.getState().openSetup("rerun", id);
    },
    [onClose],
  );

  return (
    <Sheet
      title={ADD_PROJECT_LABEL}
      lede={addProjectLede(platform() === "windows" ? "PC" : "Mac")}
      size="wide"
      onClose={onClose}
      canDismiss={!cloning}
      actions={
        <>
          <CBtn onClick={onClose} disabled={cloning}>
            Cancel
          </CBtn>
          {/* Before a way is chosen there is no primary (FirstProjectStep). */}
          {primary && (
            <CBtn tone="accent" onClick={primary.onClick} disabled={primary.disabled}>
              {primary.label}
            </CBtn>
          )}
        </>
      }
    >
      <FirstProjectStep
        githubConnected={connected}
        done={false}
        identityShown={false}
        onGoStep={goStep}
        onPrimary={setPrimary}
        onDone={onClose}
        doneLabel={FAILED_DONE_LABEL}
        // 1.171.0 walk fix: set up for builds as soon as it is added. Quiet.
        onAdded={(id) => void autoSetUpAdded(id).catch(() => {})}
        onFinished={finish}
      />
    </Sheet>
  );
}
