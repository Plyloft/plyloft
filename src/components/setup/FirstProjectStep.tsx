// OB-12 (ONBOARDING_SPEC §5 step 8): "Your first project".
//
// Three ways, one line each — a folder on this Mac (8a), from GitHub (8b,
// waiting with "Connect GitHub first" until step 5 is done), a new, empty
// project (8c). Each ends by registering the workspace with the existing
// `workspace_create` (+ `workspace_set_github_account` when step 8 asked
// which account), which makes it Setup's active workspace. Existing users
// read "You already have 4 projects in Plyloft." and keep the three ways.
//
// The step is done when a workspace is a Git repository with a commit on its
// target branch (`setupSteps.ts`, read by Setup through `project_inspect`).
// The footer's primary is the way's own (`Add to Plyloft`, `Start Git and
// add`, `Create project` …), handed up as step 4 does; once a project is in,
// it is `Continue`.
import { useCallback, useEffect, useRef, useState } from "react";
import { CBtn, Callout, ChoiceList } from "../ux";
import type { StepPrimary } from "./GitStep";
import { ProjectFromFolder, type Registered } from "./ProjectFromFolder";
import { ProjectFromGithub } from "./ProjectFromGithub";
import { ProjectNew } from "./ProjectNew";
import { useWorkspaces } from "../../store/workspaceStore";
import { useGithubStatus } from "../../store/githubStatusStore";
import { useSetupRun } from "../../store/setupRunStore";
import { platform } from "../../lib/platform";
import { FOLDER_HELP } from "../../lib/projectFolderPicker";
import { existingLine, wayOptions, type ProjectWay } from "../../lib/firstProject";

export { PROJECT_TITLE, PROJECT_WHY } from "../../lib/firstProject";

export function FirstProjectStep({
  githubConnected,
  done,
  identityShown,
  onGoStep,
  onPrimary,
  onDone,
  onAdded,
  onFinished,
  doneLabel = "Continue",
}: {
  /** Step 5 is done: From GitHub is offered. */
  githubConnected: boolean;
  /** The step's state is done (a repo with a commit is in Plyloft). */
  done: boolean;
  /** Setup already shows "Git needs your name and email…" above the step. */
  identityShown: boolean;
  onGoStep: (id: "git" | "github") => void;
  onPrimary: (primary: StepPrimary | null) => void;
  onDone: () => void;
  /** QoL 7.2: the primary once a project is in — Setup's `Continue`;
   *  the Add a project sheet passes `onFinished` instead (1.174.0 C16). */
  doneLabel?: string;
  /** 1.171.0 walk fix: a project was added (the Add a project sheet sets
   *  it up for builds at once). */
  onAdded?: (workspaceId: string) => void;
  /** 1.174.0 C16 (NIW-6): the Add a project sheet has no step after the
   *  way's own primary — once a project is in, this runs instead of the
   *  done state (Setup leaves it out and keeps its `Continue`). `told`: the
   *  done state was shown first, because a note says something failed
   *  (`Registered.failed`), and its primary was pressed. Before a way is
   *  chosen there is no primary at all. */
  onFinished?: (ws: Registered, told: boolean) => void;
}) {
  const workspaces = useWorkspaces((s) => s.workspaces.length);
  // The count before this step added one: "You already have …" is for
  // projects that were there.
  const [already] = useState(workspaces);
  const github = useGithubStatus((s) => s.status);
  const [way, setWay] = useState<ProjectWay | null>(null);
  /** 8a with a folder 8b or 8c pointed at ("Add that folder instead"). */
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [added, setAdded] = useState<Registered | null>(null);
  const [wayPrimary, setWayPrimary] = useState<StepPrimary | null>(null);

  const choose = (next: ProjectWay) => {
    setWay(next);
    setAdded(null);
    if (next !== "folder") setFolderPath(null);
  };
  const addFolder = (path: string) => {
    setFolderPath(path);
    setWay("folder");
    setAdded(null);
  };
  const addedRef = useRef(onAdded);
  addedRef.current = onAdded;
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const registered = useCallback((ws: Registered) => {
    // Challenger 2: only a project this way added now, never one opened.
    if (ws.fresh) addedRef.current?.(ws.id);
    if (finishedRef.current && !ws.failed) {
      finishedRef.current(ws, false);
      return;
    }
    setAdded(ws);
  }, []);

  // ── The footer's primary ───────────────────────────────────────────
  const finishDone = () => {
    if (added && finishedRef.current) finishedRef.current(added, true);
    else onDone();
  };
  const primary: StepPrimary | null =
    added || !way || !wayPrimary
      ? onFinished && !added
        ? null
        : { label: doneLabel, onClick: finishDone, disabled: !added && !done }
      : wayPrimary;
  const hasPrimary = primary !== null;
  const click = useRef(primary?.onClick);
  click.current = primary?.onClick;
  const stableClick = useCallback(() => click.current?.(), []);
  useEffect(() => {
    onPrimary(primary ? { label: primary.label, disabled: primary.disabled, onClick: stableClick } : null);
  }, [onPrimary, hasPrimary, primary?.label, primary?.disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  // A clone under way belongs to From GitHub: the way can't change under it
  // (Cancel it first, or wait — leaving the step asks "Stop the download?").
  const cloning = useSetupRun((s) => s.run?.actionId === "project.clone" && s.phase !== "done");
  const machine = platform() === "windows" ? "PC" : "Mac";
  // 1.176.3 (walk): the help sentence is there from the start, as the folder
  // option's own sub-line; once the folder is chosen it is the paragraph below.
  const options = wayOptions(githubConnected, machine).map((o) => {
    const o2 = o.value === "folder" && way !== "folder" ? { ...o, hint: FOLDER_HELP } : o;
    return cloning ? { ...o2, disabled: true } : o2;
  });
  // 1.171.0 walk fix: once one is added, the count is today's — never the
  // stale "You already have 1 project" beside “x” is in Plyloft.
  const line = existingLine(added ? workspaces : already);

  return (
    <>
      {line && <p className="ux-setup-note">{line}</p>}
      <ChoiceList<ProjectWay | "">
        label={already > 0 ? "Add another project" : "Your first project"}
        value={way ?? ""}
        onChange={(v) => {
          if (v) choose(v);
        }}
        options={options}
      />
      {cloning && <p className="ux-setup-note">The download is under way. Cancel it to choose another way.</p>}
      {!githubConnected && (
        <div>
          <CBtn tone="quiet" onClick={() => onGoStep("github")}>
            Connect GitHub
          </CBtn>
        </div>
      )}
      {added ? (
        <>
          <Callout kind="info" text={`“${added.name}” is in Plyloft.`} />
          {(added.notes ?? []).map((n) => (
            <p key={n} className="ux-setup-note">
              {n}
            </p>
          ))}
        </>
      ) : way === "folder" ? (
        <ProjectFromFolder
          key={folderPath ?? "picker"}
          initialPath={folderPath}
          github={github}
          identityShown={identityShown}
          onGoGit={() => onGoStep("git")}
          onRegistered={registered}
          onPrimary={setWayPrimary}
        />
      ) : way === "github" && githubConnected ? (
        <ProjectFromGithub
          github={github}
          onGoGithub={() => onGoStep("github")}
          onAddFolder={addFolder}
          onRegistered={registered}
          onPrimary={setWayPrimary}
        />
      ) : way === "new" ? (
        <ProjectNew
          githubConnected={githubConnected}
          github={github}
          identityShown={identityShown}
          onGoGit={() => onGoStep("git")}
          onAddFolder={addFolder}
          onRegistered={registered}
          onPrimary={setWayPrimary}
        />
      ) : null}
    </>
  );
}
