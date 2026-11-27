// OB-12 (ONBOARDING_SPEC §5 step 8a): "A folder on this Mac".
//
// The folder picker, then Rust's read-only look (`project_inspect`) and one
// screen per row of the spec's outcome table (`lib/firstProject.ts::
// folderView`): add it as it is, open it when it's already in Plyloft, make
// the first commit after a consent sheet that names every command and lists
// what is left out (large files, likely secrets — ticked, untickable with a
// warning), use the enclosing repository instead, ask which branch cards
// start from for a detached HEAD, or say why not in words. The workspace's
// GitHub account is asked when its origin is on github.com and gh has more
// than one account (OB-7b).
//
// 1.171.0 D3 (FR-5): a folder on a branch with changes not saved in Git asks
// first — "Leave my changes in the folder" (added as it is, and said so; the
// default since 1.174.0 C16) or "Save them as a commit on <branch> first"
// (one local commit on that branch, after the same kind of consent sheet;
// never pushed).
import { useCallback, useEffect, useRef, useState } from "react";
import { openDialog } from "../../lib/nativeDialog";
import { homeDir } from "@tauri-apps/api/path";
import { useSettings } from "../../store/settingsStore";
import { DEFAULT_PROJECTS_FOLDER } from "../../lib/settingsShape";
import { projectsFolderLook } from "../../ipc";
import { FOLDER_HELP, pickerStart } from "../../lib/projectFolderPicker";
import { CBtn, Callout, CheckList, CheckRow, ChoiceList, Details, Group, Row, Select, Sheet } from "../ux";
import { IdentityNeeded, type StepPrimary } from "./GitStep";
import { openExistingProject, registerProject } from "../../store/firstProjectStore";
import { openPutOnGithub } from "../../store/putOnGithubStore";
import { machineWords } from "../../lib/platform";
import { ADD_NOT_CONNECTED, keepCopyTick } from "../../lib/putOnGithub";
import { AddAndPutOnGithubSheet } from "../PutOnGithubSheet";
import {
  projectIgnorePlan,
  projectInit,
  projectInspect,
  projectInspectWork,
  projectSaveWork,
  projectWorkIgnorePlan,
  type GithubStatus,
  type ProjectInspection,
  type ProjectWorkspaceRef,
} from "../../ipc";
import { accountChoiceNeeded } from "../settings/GitHubAccountsSection";
import {
  accountChoices,
  count,
  DEFAULT_WORK_WAY,
  defaultBranch,
  folderView,
  initialLeaveOut,
  SAVE_WORK_LABEL,
  saveSheet,
  saveWorkSheet,
  secretKeptWarning,
  splitDetails,
  untrackedLeaveOut,
  size,
  IDENTITY_FOR_SAVE,
  unsavedSkippedNote,
  type UnsavedWorkWay,
} from "../../lib/firstProject";

/** `fresh`: 1.171.0 walk fix (Challenger 2) — this way added it now (not a
 *  project already in Plyloft, opened). */
export type Registered = {
  id: string;
  name: string;
  notes?: string[];
  fresh?: boolean;
  /** 1.174.0 C16 round 1: a note says something didn't happen (the copy on
   *  GitHub, the first push): the Add a project sheet keeps it on screen
   *  instead of closing onto the Board. */
  failed?: boolean;
};

const words = (e: unknown) => (typeof e === "string" ? e : String((e as Error)?.message ?? e));

export function ProjectFromFolder({
  initialPath,
  github,
  identityShown,
  onGoGit,
  onRegistered,
  onPrimary,
}: {
  /** "Add that folder instead" from 8b / 8c: look at this one at once. */
  initialPath: string | null;
  github: GithubStatus | null;
  /** Setup already shows "Git needs your name and email…" above the step. */
  identityShown: boolean;
  onGoGit: () => void;
  onRegistered: (ws: Registered) => void;
  onPrimary: (primary: StepPrimary | null) => void;
}) {
  const [insp, setInsp] = useState<ProjectInspection | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string>("main");
  const choices = accountChoices(github);
  const asksAccount = accountChoiceNeeded(github);
  const [account, setAccount] = useState<string | null>(choices.preselected);
  const [sheet, setSheet] = useState(false);
  const [leaveOut, setLeaveOut] = useState<string[]>([]);
  const [goOn, setGoOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  /** Rust's `.gitignore` plan for the sheet's choices; null while read. */
  const [plan, setPlan] = useState<string[] | null>(null);
  /** D3: leave the folder's changes (the default, C16) or save them first. */
  const [workWay, setWorkWay] = useState<UnsavedWorkWay>(DEFAULT_WORK_WAY);
  /** D3: the save-work sheet's look (`projectInspectWork`); null for the
   *  first-commit sheet. */
  const [workInsp, setWorkInsp] = useState<ProjectInspection | null>(null);
  /** 1.175.0 F3 (owner I5): "Also keep a private copy on GitHub", off by
   *  default; with it on, Add asks first (`addAsk`). */
  const [keepCopy, setKeepCopy] = useState(false);
  const [addAsk, setAddAsk] = useState(false);

  const inspect = useCallback(async (path: string) => {
    setLooking(true);
    setError(null);
    setInsp(null);
    try {
      const found = await projectInspect(path);
      setInsp(found);
      setBranch(defaultBranch(found));
      setLeaveOut(initialLeaveOut(found));
      setGoOn(false);
      setWorkWay(DEFAULT_WORK_WAY);
      setWorkInsp(null);
      setKeepCopy(false);
    } catch (e) {
      setError(words(e));
    } finally {
      setLooking(false);
    }
  }, []);

  const lookedAt = useRef<string | null>(null);
  useEffect(() => {
    if (initialPath && lookedAt.current !== initialPath) {
      lookedAt.current = initialPath;
      void inspect(initialPath);
    }
  }, [initialPath, inspect]);

  const projectsFolder = useSettings((st) => st.settings.projects?.folder ?? DEFAULT_PROJECTS_FOLDER);
  const choose = useCallback(async () => {
    try {
      // 1.176.3: the panel opens on the Projects folder Setup knows, or on
      // the home folder when it isn't there (no message: the dialog plugin
      // has none for an open panel).
      const home = await homeDir().catch(() => null);
      const look = await projectsFolderLook(projectsFolder).catch(() => null);
      const defaultPath = pickerStart(look, home);
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose your project folder",
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (picked && !Array.isArray(picked)) await inspect(picked);
    } catch (e) {
      setError(words(e));
    }
  }, [inspect, projectsFolder]);

  const view = insp ? folderView(insp) : null;
  // Git mid-way combining changes offers only "skip".
  const canSaveWork = Boolean(view?.unsavedWork?.options.some((o) => o.value === "save"));
  const way: UnsavedWorkWay = canSaveWork ? workWay : "skip";
  const savesWork = Boolean(view?.unsavedWork) && way === "save";
  const workNeedsIdentity = savesWork && insp?.identityReady === false;
  /** What the open sheet is about: the save-work look, or the folder's. */
  const sheetInsp = workInsp ?? insp;
  // The account is asked for a github.com origin with several accounts,
  // whether the folder is added as it is or after its first commit.
  const accountAsked =
    asksAccount &&
    insp?.githubOrigin != null &&
    (view?.primary.action === "add" || view?.primary.action === "save");
  // 1.175.0 F3: a project with commits and no origin, added as it is.
  const copyLogin = github?.accounts?.find((a) => a.active && a.state === "signed-in")?.login ?? null;
  const localOnly = Boolean(insp && insp.hasOrigin === false && view?.primary.action === "add" && !savesWork);
  const copyName = insp?.githubName ?? insp?.name ?? "";
  const tick =
    localOnly && insp
      ? keepCopyTick({
          hasRemote: false,
          githubConnected: copyLogin !== null,
          login: copyLogin,
          name: copyName,
          branch: view?.asksBranch ? branch : defaultBranch(insp),
        })
      : null;
  const copyAsked = tick !== null && keepCopy;

  // The sheet's Details: exactly the lines `project_init` will add for the
  // ticks as they are (Rust plans them, `project_ignore_plan`).
  const leaveKey = leaveOut.join("\n");
  useEffect(() => {
    if (!sheet || !sheetInsp) return;
    let live = true;
    setPlan(null);
    // D3: a save of the work adds only a line per new file left out.
    (workInsp
      ? projectWorkIgnorePlan(workInsp.path, untrackedLeaveOut(workInsp, leaveOut))
      : projectIgnorePlan(
          sheetInsp.path,
          sheetInsp.secrets.map((f) => f.path),
          leaveOut,
        )
    )
      .then((lines) => {
        if (live) setPlan(lines);
      })
      .catch((e) => {
        if (live) setSheetError(words(e));
      });
    return () => {
      live = false;
    };
    // `leaveOut` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, sheetInsp, leaveKey]);

  const add = async (found: ProjectInspection) => {
    setBusy(true);
    setError(null);
    try {
      const ws = await registerProject({
        path: found.path,
        name: found.name,
        account: accountAsked ? account : null,
        targetBranch: view?.asksBranch ? branch : null,
      });
      // 1.175.0 F3: the ticked copy runs in its own sheet (Stop, outcome),
      // as pressed in the Add sheet.
      if (copyAsked && copyLogin) {
        openPutOnGithub({ workspaceId: ws.id, project: ws.name, start: { login: copyLogin, name: copyName } });
      }
      // D3: added without its changes — said once it is in.
      const skipped = view?.unsavedWork && way === "skip";
      onRegistered({
        id: ws.id,
        name: ws.name,
        fresh: true,
        ...(skipped ? { notes: [unsavedSkippedNote(found.uncommittedFiles ?? 0)] } : {}),
      });
    } catch (e) {
      setError(words(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (ws: ProjectWorkspaceRef) => {
    await openExistingProject(ws.id);
    onRegistered({ id: ws.id, name: ws.name });
  };

  /** D3: Save and add — look at what saving would put in Git, then the
   *  sheet. Nothing is written before its own Save and add. */
  const openWorkSheet = async (found: ProjectInspection) => {
    setBusy(true);
    setError(null);
    try {
      const work = await projectInspectWork(found.path);
      setWorkInsp(work);
      setLeaveOut(initialLeaveOut(work));
      setGoOn(false);
      setSheetError(null);
      setSheet(true);
    } catch (e) {
      setError(words(e));
    } finally {
      setBusy(false);
    }
  };

  const closeSheet = () => {
    setSheet(false);
    setWorkInsp(null);
  };

  const save = async () => {
    if (!insp) return;
    setBusy(true);
    setSheetError(null);
    try {
      if (workInsp) await projectSaveWork(insp.path, { leaveOut, acceptIncomplete: goOn });
      else await projectInit(insp.path, { leaveOut, acceptIncomplete: goOn });
      closeSheet();
      const ws = await registerProject({ path: insp.path, name: insp.name, account: accountAsked ? account : null });
      onRegistered({ id: ws.id, name: ws.name });
    } catch (e) {
      setSheetError(words(e));
    } finally {
      setBusy(false);
    }
  };

  // ── The footer's primary ───────────────────────────────────────────
  let primary: StepPrimary;
  if (!view || !insp) {
    primary = { label: "Choose a folder", onClick: () => void choose(), disabled: looking };
  } else {
    switch (view.primary.action) {
      case "add":
        primary = savesWork
          ? { label: SAVE_WORK_LABEL, onClick: () => void openWorkSheet(insp), disabled: busy || workNeedsIdentity }
          : copyAsked
            ? { label: view.primary.label, onClick: () => setAddAsk(true), disabled: busy }
            : { label: view.primary.label, onClick: () => void add(insp), disabled: busy };
        break;
      case "open":
        primary = {
          label: view.primary.label,
          onClick: () => insp.existingWorkspace && void open(insp.existingWorkspace),
        };
        break;
      case "save":
        primary = {
          label: view.primary.label,
          onClick: () => {
            setSheetError(null);
            setSheet(true);
          },
          disabled: view.needsIdentity || busy,
        };
        break;
      case "use-top":
        primary = {
          label: view.primary.label,
          onClick: () => insp.git.kind === "inside-another" && void inspect(insp.git.topLevel),
          disabled: looking,
        };
        break;
      default:
        primary = { label: view.primary.label, onClick: () => void choose(), disabled: looking };
    }
  }
  const click = useRef(primary.onClick);
  click.current = primary.onClick;
  const stableClick = useCallback(() => click.current(), []);
  useEffect(() => {
    onPrimary({ label: primary.label, disabled: primary.disabled, onClick: stableClick });
  }, [onPrimary, primary.label, primary.disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  const blocked = view?.blocked ?? null;
  const warn = insp?.outcome === "refused" || blocked !== null;
  const words8a = workInsp ? saveWorkSheet(workInsp, plan, leaveOut) : insp ? saveSheet(insp, plan) : null;

  return (
    <>
      {!insp && !looking && <p className="ux-setup-note">{FOLDER_HELP}</p>}
      {!insp && !looking && (
        <p className="ux-setup-note">Plyloft looks at the folder first and changes nothing until you say so.</p>
      )}
      {looking && <p className="ux-setup-note">Looking at the folder…</p>}
      {view && insp && (
        <Callout
          kind={warn ? "warn" : "info"}
          title={view.title}
          text={blocked ?? view.text ?? undefined}
          actions={
            view.secondary ? (
              <CBtn tone="quiet" onClick={() => void choose()}>
                {view.secondary.label}
              </CBtn>
            ) : undefined
          }
        />
      )}
      {view && insp && view.notes.map((note) => <p key={note} className="ux-setup-note">{note}</p>)}
      {view?.unsavedWork && (
        <>
          <p className="ux-setup-note">{view.unsavedWork.text}</p>
          <ChoiceList<UnsavedWorkWay>
            label="Changes not saved in Git"
            value={way}
            onChange={setWorkWay}
            options={view.unsavedWork.options}
          />
        </>
      )}
      {workNeedsIdentity && (
        <Callout
          kind="warn"
          text={IDENTITY_FOR_SAVE}
          actions={
            identityShown ? undefined : (
              <CBtn tone="strong" onClick={onGoGit}>
                Go to Git and your name
              </CBtn>
            )
          }
        />
      )}
      {view && insp && view.primary.action === "save" && insp.toSave && !blocked && (
        <p className="ux-setup-note">{words8a?.list}</p>
      )}
      {view?.asksBranch && insp && (
        <Group label="Branch">
          <Row kind="choice" label="Cards start from" hint="Plyloft doesn't switch your folder's branch.">
            <Select
              label="Cards start from"
              value={branch}
              onChange={setBranch}
              options={insp.branches.map((b) => ({ value: b, label: b }))}
            />
          </Row>
        </Group>
      )}
      {accountAsked && (
        <Group label="GitHub account">
          <Row kind="choice" label="GitHub account" hint="Plyloft's GitHub calls for this project use this account.">
            <Select
              label="GitHub account"
              value={account ?? ""}
              onChange={setAccount}
              options={choices.logins.map((l) => ({ value: l, label: l }))}
            />
          </Row>
        </Group>
      )}
      {tick && (
        <CheckList label="GitHub">
          <CheckRow checked={keepCopy} onChange={setKeepCopy} hint={machineWords(tick.hint)}>
            {tick.label}
          </CheckRow>
        </CheckList>
      )}
      {localOnly && !tick && <p className="ux-setup-note">{machineWords(ADD_NOT_CONNECTED)}</p>}
      {addAsk && insp && copyLogin && (
        <AddAndPutOnGithubSheet
          project={insp.name}
          line={tick?.hint ?? ""}
          busy={busy}
          onCancel={() => setAddAsk(false)}
          onConfirm={() => {
            setAddAsk(false);
            void add(insp);
          }}
        />
      )}
      {view?.needsIdentity && !identityShown && <IdentityNeeded onGo={onGoGit} />}
      {error && <Callout kind="danger" text={error} />}

      {sheet && sheetInsp && words8a && (
        <Sheet
          title={words8a.title}
          lede={words8a.lede}
          onClose={closeSheet}
          actions={
            <>
              <CBtn tone="quiet" onClick={closeSheet}>
                Cancel
              </CBtn>
              <CBtn
                tone="accent"
                onClick={() => void save()}
                disabled={busy || plan === null || Boolean(words8a.refused) || (words8a.incomplete !== null && !goOn)}
              >
                {words8a.confirm}
              </CBtn>
            </>
          }
        >
          <p className="ux-setup-note">{words8a.list}</p>
          {words8a.filesLine && <p className="ux-setup-note" data-ply-save-files="">{words8a.filesLine}</p>}
          {words8a.hugeWarning && <Callout kind="warn" text={words8a.hugeWarning} />}
          {sheetInsp.toSave && sheetInsp.toSave.topLevel.length > 0 && (words8a.hugeWarning || words8a.incomplete) && (
            <Details summary="Show what will be saved">
              <pre className="ux-output">
                {sheetInsp.toSave.topLevel
                  .map((e) => `${e.name}${e.isDir ? "/" : ""}  ${count(e.files)} ${e.files === 1 ? "file" : "files"}, ${size(e.bytes)}`)
                  .join("\n")}
              </pre>
            </Details>
          )}
          {words8a.incomplete && (
            <>
              <Callout kind="warn" text={words8a.incomplete} />
              <CheckList label="Go on anyway">
                <CheckRow checked={goOn} onChange={setGoOn}>
                  Save it anyway
                </CheckRow>
              </CheckList>
            </>
          )}
          {words8a.largeIntro && (
            <>
              <p className="ux-setup-note">{words8a.largeIntro}</p>
              <CheckList label="Large files left out">
                {sheetInsp.largeFiles.map((f) => (
                  <CheckRow
                    key={f.path}
                    checked={leaveOut.includes(f.path)}
                    onChange={(on) => setLeaveOut((l) => (on ? [...l, f.path] : l.filter((p) => p !== f.path)))}
                    note={size(f.bytes)}
                  >
                    {f.path}
                  </CheckRow>
                ))}
              </CheckList>
            </>
          )}
          {words8a.refused && <Callout kind="warn" text={words8a.refused} />}
          {words8a.buildIntro && (
            <>
              <p className="ux-setup-note">{words8a.buildIntro}</p>
              <CheckList label="Package and build folders left out">
                {(sheetInsp.buildFolders ?? []).map((f) => (
                  <CheckRow
                    key={f.path}
                    checked={leaveOut.includes(f.path)}
                    onChange={(on) => setLeaveOut((l) => (on ? [...l, f.path] : l.filter((p) => p !== f.path)))}
                    note={f.files === 1 ? "1 file" : `${count(f.files)} files`}
                  >
                    {f.path}
                  </CheckRow>
                ))}
              </CheckList>
            </>
          )}
          {words8a.nestedLine && <p className="ux-setup-note">{words8a.nestedLine}</p>}
          {words8a.secretsIntro && (
            <>
              <p className="ux-setup-note">{words8a.secretsIntro}</p>
              <CheckList label="Passwords or keys left out">
                {sheetInsp.secrets.map((f) => (
                  <CheckRow
                    key={f.path}
                    checked={leaveOut.includes(f.path)}
                    onChange={(on) => setLeaveOut((l) => (on ? [...l, f.path] : l.filter((p) => p !== f.path)))}
                  >
                    {f.path}
                  </CheckRow>
                ))}
              </CheckList>
              {sheetInsp.secrets
                .filter((f) => !leaveOut.includes(f.path))
                .map((f) => (
                  <Callout key={f.path} kind="warn" text={secretKeptWarning(f.path)} />
                ))}
            </>
          )}
          <Details summary="Details">
            <pre className="ux-output">{words8a.commands.join("\n")}</pre>
          </Details>
          {sheetError && <Callout kind="danger" text={splitDetails(sheetError).text} />}
          {sheetError && splitDetails(sheetError).details && (
            <Details summary="What Git said">
              <pre className="ux-output">{splitDetails(sheetError).details}</pre>
            </Details>
          )}
        </Sheet>
      )}
    </>
  );
}
