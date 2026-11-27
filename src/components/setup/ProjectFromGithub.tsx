// OB-12 (ONBOARDING_SPEC §5 step 8b): "From GitHub".
//
// The account (only when gh lists several, OB-7b), then the repositories it
// can get (`project_repo_list`) grouped Yours · each organisation · Shared
// with you · Your team, with a filter above 12 rows. Choosing one asks
// "Get “lyra”?" with its size, and the clone runs in the guided terminal as
// `project.clone` (progress visible, Cancel removes the partial folder). Its
// end comes on the final `setup://progress` event's `clone`: added; empty on
// GitHub (Make the first commit · Keep it empty); only other branches have
// commits (which branch); or why not — this account (Fix sign-in / another
// account), single sign-on (Authorize), offline or interrupted (Try again).
// A folder already there offers "Add that folder instead" (8a).
// 1.175.0 F2 (§2b): the "Projects folder" row above the list — `~/Projects`
// or the folder chosen before, `Change…`, nothing to press to accept it; the
// sheet says where the download lands. The folder is saved at the first
// download, not before (`chooseProjectsFolder`); "Put it somewhere else"
// stays the one-off place for one project.
import { useCallback, useEffect, useRef, useState } from "react";
import { openDialog } from "../../lib/nativeDialog";
import { CBtn, Callout, Details, Group, PChip, Row, SearchField, Section, Select, Sheet } from "../ux";
import { SetupTerminal } from "../SetupTerminal";
import type { StepPrimary } from "./GitStep";
import type { Registered } from "./ProjectFromFolder";
import { accountChoiceNeeded } from "../settings/GitHubAccountsSection";
import { openExistingProject, registerProject } from "../../store/firstProjectStore";
import { useSetupRun } from "../../store/setupRunStore";
import { chooseProjectsFolder } from "../../store/projectsFolderWrite";
import { ProjectsFolderRow, useProjectsFolderChoice } from "./ProjectsFolderRow";
import { platform } from "../../lib/platform";
import { DEFAULT_PROJECTS_FOLDER } from "../../lib/settingsShape";
import {
  projectFirstCommitPush,
  projectRepoList,
  projectsFolderCreate,
  setupOpenGithubSso,
  type GithubStatus,
  type ProjectCloneStart,
  type ProjectRepoEntry,
  type ProjectRepoList,
} from "../../ipc";
import {
  FILTER_AFTER,
  accountChoices,
  cloneFailureView,
  cloneNext,
  cloneSheet,
  emptyBranchWords,
  emptyRepoWords,
  firstPushSheet,
  inFolder,
  repoGroups,
  updatedLine,
} from "../../lib/firstProject";

/** The folder a clone of `owner/name` lands in, and so the workspace's
 *  default name: one the shared definition's Name fills in (owner,
 *  2026-10-20), where `owner/name` would read as a name the person chose. */
function repoFolder(repo: string): string {
  return repo.split("/")[1] || repo;
}

/** A picked parent folder and the project's name, as the sheet shows it. */
function joinPath(parent: string, name: string, windows: boolean): string {
  const sep = windows || parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

const words = (e: unknown) => (typeof e === "string" ? e : String((e as Error)?.message ?? e));

type Answer = Exclude<ProjectCloneStart, { kind: "started" }>;

export function ProjectFromGithub({
  github,
  onGoGithub,
  onAddFolder,
  onRegistered,
  onPrimary,
}: {
  github: GithubStatus | null;
  /** "Fix sign-in": Setup's GitHub step. */
  onGoGithub: () => void;
  /** "Add that folder instead": 8a with that folder. */
  onAddFolder: (path: string) => void;
  onRegistered: (ws: Registered) => void;
  onPrimary: (primary: StepPrimary | null) => void;
}) {
  const windows = platform() === "windows";
  const folderChoice = useProjectsFolderChoice();
  const { folder, stored: storedFolder, notAFolder } = folderChoice;
  /** F2 round 2: the folder a download into the row's folder saves once it
   *  landed — never before, and not after a clone that failed or stopped. */
  const folderToSave = useRef<{ runId: string; folder: string } | null>(null);
  const choices = accountChoices(github);
  const several = accountChoiceNeeded(github);
  const [account, setAccount] = useState<string | null>(choices.preselected);
  const [list, setList] = useState<ProjectRepoList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<ProjectRepoEntry | null>(null);
  /** "Put it somewhere else": the folder the clone goes in instead of the
   *  projects folder, kept for the sheet and for Try again. */
  const [destParent, setDestParent] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** The run this step started, so its end is handled once. */
  const [mine, setMine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushSheet, setPushSheet] = useState(false);
  const [branch, setBranch] = useState<string>("");

  // The list, for the account chosen (gh's active one when not asked).
  useEffect(() => {
    let live = true;
    setList(null);
    setListError(null);
    projectRepoList(several && account ? account : undefined)
      .then((l) => {
        if (live) setList(l);
      })
      .catch((e) => {
        if (live) setListError(words(e));
      });
    return () => {
      live = false;
    };
  }, [account, several]);

  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const clone = useSetupRun((s) => s.clone);
  const runError = useSetupRun((s) => s.error);
  const cloneRun = run && run.actionId === "project.clone" && run.runId === mine ? run : null;
  const running = cloneRun !== null && phase !== "done";
  const ended = cloneRun && phase === "done" ? clone : null;
  const next = ended ? cloneNext(ended) : null;

  const get = useCallback(
    async (repo: ProjectRepoEntry, destParent: string | null) => {
      setAsking(false);
      setAnswer(null);
      setError(null);
      // F2 round 2: the clone lands in the row's folder (made for the
      // attempt when it is missing; Rust's own folder needs no parent), and
      // the setting is saved once it landed. A one-off place ("Put it
      // somewhere else") leaves it alone.
      let parent: string | undefined;
      if (destParent === null && folder !== (storedFolder ?? DEFAULT_PROJECTS_FOLDER)) {
        try {
          parent = await projectsFolderCreate(folder);
        } catch (e) {
          setError(words(e));
          return;
        }
      }
      const started = await useSetupRun
        .getState()
        .startClone(repo.nameWithOwner, {
          account: several && account ? account : undefined,
          destParent: destParent ?? parent,
        });
      if (!started) return;
      if (started.kind === "started") {
        setMine(started.run.runId);
        folderToSave.current = destParent === null ? { runId: started.run.runId, folder } : null;
      } else setAnswer(started);
    },
    [account, several, folder, storedFolder],
  );

  const register = useCallback(
    async (path: string, name: string, targetBranch?: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const ws = await registerProject({
          path,
          name,
          account: several ? account : null,
          targetBranch: targetBranch ?? null,
        });
        onRegistered({ id: ws.id, name: ws.name, fresh: true });
      } catch (e) {
        setError(words(e));
      } finally {
        setBusy(false);
      }
    },
    [account, several, onRegistered],
  );

  // F2 round 2: the first download that landed saves the folder (the team's
  // clone root kept first); one that failed or was stopped saves nothing.
  useEffect(() => {
    const pending = folderToSave.current;
    if (!cloneRun || !ended || !pending || pending.runId !== cloneRun.runId) return;
    folderToSave.current = null;
    if (ended.cloned) void chooseProjectsFolder(pending.folder).catch((e) => console.warn("setup: projects folder not saved", e));
  }, [cloneRun, ended]);

  // A clone with commits on its branch is added as soon as it lands (once).
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!cloneRun || !ended || handled.current === cloneRun.runId) return;
    if (next === "branch") setBranch(ended.remoteBranches[0] ?? "");
    if (next !== "add") return;
    handled.current = cloneRun.runId;
    void register(ended.path, picked?.name ?? repoFolder(ended.repo));
  }, [cloneRun, ended, next, picked, register]);

  const firstCommit = async () => {
    if (!ended) return;
    setBusy(true);
    setError(null);
    try {
      const done = await projectFirstCommitPush(ended.path, several && account ? account : undefined);
      setPushSheet(false);
      const ws = await registerProject({ path: ended.path, name: picked?.name ?? repoFolder(ended.repo), account: several ? account : null });
      const unpushed = !done.pushed && Boolean(done.words);
      onRegistered({ id: ws.id, name: ws.name, fresh: true, notes: unpushed ? [done.words as string] : [], failed: unpushed });
    } catch (e) {
      setPushSheet(false);
      setError(words(e));
    } finally {
      setBusy(false);
    }
  };

  const elsewhere = async () => {
    if (!picked) return;
    try {
      const parent = await openDialog({ directory: true, multiple: false, title: "Choose where to put it" });
      if (parent && !Array.isArray(parent)) {
        setDestParent(parent);
        setAnswer(null);
        setAsking(true);
      }
    } catch (e) {
      setError(words(e));
    }
  };

  // ── The footer's primary ───────────────────────────────────────────
  let primary: StepPrimary | null = null;
  if (running) primary = { label: "Add to Plyloft", onClick: () => {}, disabled: true };
  else if (next === "empty" && ended)
    primary = { label: "Make the first commit", onClick: () => setPushSheet(true), disabled: busy };
  else if (next === "branch" && ended)
    primary = {
      label: "Add to Plyloft",
      onClick: () => void register(ended.path, picked?.name ?? repoFolder(ended.repo), branch),
      disabled: busy || !branch,
    };
  else if (answer?.kind === "already-in-ply") {
    const ws = answer.workspace;
    primary = {
      label: "Open it",
      onClick: () => void openExistingProject(ws.id).then(() => onRegistered({ id: ws.id, name: ws.name })),
    };
  }
  const click = useRef<() => void>(() => {});
  click.current = primary?.onClick ?? (() => {});
  const stableClick = useCallback(() => click.current(), []);
  const label = primary?.label ?? null;
  const disabled = primary?.disabled;
  useEffect(() => {
    onPrimary(label ? { label, disabled, onClick: stableClick } : null);
  }, [onPrimary, label, disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  const repos = list?.repos ?? [];
  const groups = repoGroups(repos, filter);
  const failure = ended ? cloneFailureView(ended, several) : null;
  const sheetWords = picked
    ? cloneSheet(
        picked,
        destParent ? joinPath(destParent, picked.name, windows) : inFolder(folder, picked.name, windows),
      )
    : null;
  const pushWords = ended ? firstPushSheet(picked?.name ?? ended.repo, ended.branch ?? "main") : null;
  const showList = !cloneRun || (phase === "done" && next === "failed");

  return (
    <>
      {several && (
        <Group label="GitHub account">
          <Row kind="choice" label="GitHub account" hint="Plyloft's GitHub calls for this project use this account.">
            <Select
              label="GitHub account"
              value={account ?? ""}
              onChange={setAccount}
              disabled={running}
              options={choices.logins.map((l) => ({ value: l, label: l }))}
            />
          </Row>
        </Group>
      )}

      {showList && (
        <>
          <ProjectsFolderRow choice={folderChoice} disabled={running} />
          {!list && !listError && <p className="ux-setup-note">Looking at your repositories on GitHub…</p>}
          {listError && <Callout kind="warn" text={listError} />}
          {list && list.errors.length > 0 && (
            <Callout kind="warn" text={list.errors.map((e) => e.words).join(" ")} />
          )}
          {list && repos.length === 0 && list.errors.length === 0 && (
            <p className="ux-setup-note">This account has no repositories yet.</p>
          )}
          {repos.length > FILTER_AFTER && (
            <SearchField value={filter} onChange={setFilter} placeholder="Filter repositories" label="Filter repositories" />
          )}
          {groups.map((g) => (
            <Section key={g.key} title={g.label}>
              <Group label={g.label}>
                {g.repos.map((r) => (
                  <Row
                    key={r.nameWithOwner}
                    kind="item"
                    label={r.nameWithOwner}
                    hint={[r.description, updatedLine(r.updatedAt)].filter(Boolean).join(" · ") || undefined}
                    chips={
                      <>
                        <PChip>{r.isPrivate ? "Private" : "Public"}</PChip>
                        {r.inPly && <PChip>In Plyloft</PChip>}
                      </>
                    }
                    action={
                      r.inPly ? (
                        <CBtn
                          tone="quiet"
                          onClick={() =>
                            void openExistingProject(r.inPly!.id).then(() =>
                              onRegistered({ id: r.inPly!.id, name: r.inPly!.name }),
                            )
                          }
                        >
                          Open it
                        </CBtn>
                      ) : (
                        <CBtn
                          tone="strong"
                          disabled={running || notAFolder}
                          onClick={() => {
                            setPicked(r);
                            setDestParent(null);
                            setAnswer(null);
                            setAsking(true);
                          }}
                        >
                          Get
                        </CBtn>
                      )
                    }
                  />
                ))}
              </Group>
            </Section>
          ))}
          {list?.truncated && <p className="ux-setup-note">Only the first repositories are listed. Filter to find one.</p>}
        </>
      )}

      {answer?.kind === "destination-exists" && (
        <Callout
          kind="warn"
          text={answer.words}
          actions={
            <>
              <CBtn tone="strong" onClick={() => onAddFolder(answer.path)}>
                Add that folder instead
              </CBtn>
              <CBtn tone="quiet" onClick={() => void elsewhere()}>
                Put it somewhere else
              </CBtn>
            </>
          }
        />
      )}
      {answer?.kind === "already-in-ply" && <Callout kind="info" text={answer.words} />}

      {(cloneRun || (mine === null && runError && picked)) && <SetupTerminal />}

      {failure && (
        <Callout
          kind="warn"
          text={failure.text}
          actions={
            failure.action ? (
              <CBtn
                tone="strong"
                onClick={() => {
                  if (failure.action!.id === "fix-sign-in") onGoGithub();
                  else if (failure.action!.id === "authorise" && ended?.failure?.ssoOrg)
                    void setupOpenGithubSso(ended.failure.ssoOrg).catch(() => {});
                  else if (picked) setAsking(true);
                }}
              >
                {failure.action.label}
              </CBtn>
            ) : undefined
          }
        />
      )}

      {next === "empty" && ended && (
        <Callout
          kind="info"
          title={emptyRepoWords(picked?.name ?? ended.repo).title}
          text={emptyRepoWords(picked?.name ?? ended.repo).text}
          actions={
            <CBtn
              tone="quiet"
              disabled={busy}
              onClick={() => void register(ended.path, picked?.name ?? ended.repo)}
            >
              Keep it empty
            </CBtn>
          }
        />
      )}
      {next === "branch" && ended && (
        <>
          <Callout
            kind="info"
            title={emptyBranchWords(picked?.name ?? ended.repo, ended.branch).title}
            text={emptyBranchWords(picked?.name ?? ended.repo, ended.branch).text}
          />
          <Group label="Branch">
            <Row kind="choice" label="Cards start from" hint="Plyloft doesn't switch your folder's branch.">
              <Select
                label="Cards start from"
                value={branch}
                onChange={setBranch}
                options={ended.remoteBranches.map((b) => ({ value: b, label: b }))}
              />
            </Row>
          </Group>
        </>
      )}
      {error && <Callout kind="danger" text={error} />}

      {asking && picked && sheetWords && (
        <Sheet
          size="confirm"
          title={sheetWords.title}
          lede={sheetWords.lede}
          onClose={() => setAsking(false)}
          actions={
            <>
              <CBtn tone="quiet" onClick={() => setAsking(false)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void get(picked, destParent)}>
                Get it
              </CBtn>
            </>
          }
        >
          {sheetWords.sizeLine && <p className="ux-setup-note">{sheetWords.sizeLine}</p>}
          <Details summary="Details">
            <pre className="ux-output">{sheetWords.command}</pre>
          </Details>
        </Sheet>
      )}
      {pushSheet && pushWords && (
        <Sheet
          size="confirm"
          title={pushWords.title}
          lede={pushWords.lede}
          onClose={() => setPushSheet(false)}
          actions={
            <>
              <CBtn tone="quiet" onClick={() => setPushSheet(false)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void firstCommit()} disabled={busy}>
                Make the first commit
              </CBtn>
            </>
          }
        >
          <Details summary="Details">
            <pre className="ux-output">{pushWords.commands.join("\n")}</pre>
          </Details>
        </Sheet>
      )}
    </>
  );
}
