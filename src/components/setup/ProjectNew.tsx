// OB-12 (ONBOARDING_SPEC §5 step 8c): "A new, empty project".
//
// A Name field with the folder it makes shown live (`project_new_preview`:
// "It goes in ~/Projects/my-app."), or why that name can't be a folder —
// symbols only, a reserved name, a name whose letters are all outside a–z
// (the carried-forward wording). A folder with files already there offers
// "Add that folder instead" (8a) or another name; an empty one is used.
// When GitHub is connected, `Also keep a private copy on GitHub` is offered
// and **off** by default (D10). `[Create project]` opens a sheet naming every
// command; a GitHub name already taken keeps the project on this computer.
// 1.175.0 F2 (§2b): the "Projects folder" row under the name — `~/Projects`
// or the folder chosen before, `Change…`, nothing to press to accept it. The
// line under Name follows it; the folder is saved when the project is
// created, not before (`chooseProjectsFolder`; F2 round 2: after Rust made
// the project, never before the attempt).
import { useCallback, useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { CBtn, Callout, CheckList, CheckRow, Details, Group, Row, Select, Sheet, TextField } from "../ux";
import { IdentityNeeded, type StepPrimary } from "./GitStep";
import type { Registered } from "./ProjectFromFolder";
import { ProjectsFolderRow, useProjectsFolderChoice } from "./ProjectsFolderRow";
import { accountChoiceNeeded } from "../settings/GitHubAccountsSection";
import { registerProject } from "../../store/firstProjectStore";
import { chooseProjectsFolder } from "../../store/projectsFolderWrite";
import { projectNew, projectNewPreview, projectsFolderCreate, type GithubStatus, type ProjectNewPreview } from "../../ipc";
import { DEFAULT_PROJECTS_FOLDER } from "../../lib/settingsShape";
import {
  accountChoices,
  githubCopyHint,
  githubCopyLine,
  hasFilesOffer,
  newNameLine,
  newSheet,
  previewParent,
} from "../../lib/firstProject";

const words = (e: unknown) => (typeof e === "string" ? e : String((e as Error)?.message ?? e));

/** How long the preview waits for typing to pause. */
const PREVIEW_MS = 200;

export function ProjectNew({
  githubConnected,
  github,
  identityShown,
  onGoGit,
  onAddFolder,
  onRegistered,
  onPrimary,
}: {
  githubConnected: boolean;
  github: GithubStatus | null;
  identityShown: boolean;
  onGoGit: () => void;
  onAddFolder: (path: string) => void;
  onRegistered: (ws: Registered) => void;
  onPrimary: (primary: StepPrimary | null) => void;
}) {
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ProjectNewPreview | null>(null);
  // D10: off by default.
  const [copy, setCopy] = useState(false);
  const choices = accountChoices(github);
  const several = accountChoiceNeeded(github);
  const [account, setAccount] = useState<string | null>(choices.preselected);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identityNeeded, setIdentityNeeded] = useState(false);
  /** Rust's "folder-has-files" answer at Create (the preview may be stale). */
  const [hasFiles, setHasFiles] = useState<{ path: string; words: string } | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const folderChoice = useProjectsFolderChoice();
  const { folder, stored: storedFolder, notAFolder } = folderChoice;

  useEffect(() => {
    const typed = name.trim();
    setHasFiles(null);
    if (!typed) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      // F2: the preview is asked in the row's folder, so "It goes in …"
      // follows a folder changed but not saved yet.
      const parentOf = async () =>
        previewParent(storedFolder, folder, folder.startsWith("~") ? await homeDir().catch(() => null) : null);
      parentOf()
        .then((parent) => projectNewPreview(typed, parent ?? undefined))
        .then((p) => {
          if (live) setPreview(p);
        })
        .catch((e) => {
          if (live) setError(words(e));
        });
    }, PREVIEW_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [name, folder, storedFolder]);

  const line = newNameLine(name, preview);
  const offer = hasFilesOffer(preview) && preview?.path ? { path: preview.path, words: preview.problem ?? "" } : hasFiles;
  const login = several ? account : choices.preselected;
  const ready = Boolean(line && !line.problem && preview?.slug && preview.displayPath) && !notAFolder;

  const create = async () => {
    const typed = name.trim();
    setBusy(true);
    setError(null);
    try {
      // F2 round 2: the project is made in the row's folder (made for the
      // attempt when it is missing); the setting is saved only once the
      // project was created. Rust's own folder needs no parent.
      const parent = folder === (storedFolder ?? DEFAULT_PROJECTS_FOLDER) ? null : await projectsFolderCreate(folder);
      const outcome = await projectNew({ name: typed, parent, githubCopy: copy && login ? { login } : null });
      setSheet(false);
      switch (outcome.kind) {
        case "created": {
          // The first creation saves the folder (the team's clone root kept
          // first). A project made is not undone by a setting not saved.
          await chooseProjectsFolder(folder).catch((e) => console.warn("setup: projects folder not saved", e));
          const onGithub = outcome.github?.state === "created";
          const ws = await registerProject({
            path: outcome.path,
            name: outcome.name,
            account: onGithub && several ? login : null,
          });
          const note = githubCopyLine(outcome.github, outcome.slug);
          onRegistered({
            id: ws.id,
            name: ws.name,
            fresh: true,
            notes: note ? [note] : [],
            // C16 round 1: the copy on GitHub wasn't made (name taken, failed).
            failed: Boolean(outcome.github) && outcome.github?.state !== "created",
          });
          break;
        }
        case "folder-has-files":
          setHasFiles({ path: outcome.path, words: outcome.words });
          break;
        case "identity-needed":
          setIdentityNeeded(true);
          break;
        case "refused":
          setError(outcome.words);
          break;
      }
    } catch (e) {
      setSheet(false);
      setError(words(e));
    } finally {
      setBusy(false);
    }
  };

  // ── The footer's primary ───────────────────────────────────────────
  const primary: StepPrimary = {
    label: "Create project",
    onClick: () => {
      setError(null);
      setSheet(true);
    },
    disabled: !ready || busy || offer !== null,
  };
  const click = useRef(primary.onClick);
  click.current = primary.onClick;
  const stableClick = useCallback(() => click.current(), []);
  useEffect(() => {
    onPrimary({ label: primary.label, disabled: primary.disabled, onClick: stableClick });
  }, [onPrimary, primary.label, primary.disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  const sheetWords =
    preview?.slug && preview.displayPath
      ? newSheet(name.trim(), preview.displayPath, preview.slug, copy && login ? login : null)
      : null;

  return (
    <>
      <div ref={field}>
        <Group label="New project">
          <Row
            kind="text"
            label="Name"
            hint={line && !line.problem ? line.text : undefined}
            error={line?.problem ? line.text : undefined}
          >
            <TextField value={name} onChange={setName} label="Name" placeholder="My app" wide />
          </Row>
        </Group>
      </div>
      <ProjectsFolderRow choice={folderChoice} disabled={busy} />
      {offer && (
        <Callout
          kind="warn"
          text={offer.words}
          actions={
            <>
              <CBtn tone="strong" onClick={() => onAddFolder(offer.path)}>
                Add that folder instead
              </CBtn>
              <CBtn
                tone="quiet"
                onClick={() => {
                  setHasFiles(null);
                  field.current?.querySelector("input")?.select();
                }}
              >
                Choose another name
              </CBtn>
            </>
          }
        />
      )}
      {githubConnected && login && (
        <>
          <CheckList label="GitHub">
            <CheckRow
              checked={copy}
              onChange={setCopy}
              note={githubCopyHint(login, preview?.slug ?? "my-app")}
            >
              Also keep a private copy on GitHub
            </CheckRow>
          </CheckList>
          {copy && several && (
            <Group label="GitHub account">
              <Row kind="choice" label="GitHub account" hint="The private copy is made in this account.">
                <Select
                  label="GitHub account"
                  value={account ?? ""}
                  onChange={setAccount}
                  options={choices.logins.map((l) => ({ value: l, label: l }))}
                />
              </Row>
            </Group>
          )}
        </>
      )}
      {identityNeeded && !identityShown && <IdentityNeeded onGo={onGoGit} />}
      {error && <Callout kind="danger" text={error} />}

      {sheet && sheetWords && (
        <Sheet
          size="confirm"
          title={sheetWords.title}
          lede={sheetWords.lede}
          onClose={() => setSheet(false)}
          actions={
            <>
              <CBtn tone="quiet" onClick={() => setSheet(false)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void create()} disabled={busy}>
                Create project
              </CBtn>
            </>
          }
        >
          <Details summary="Details">
            <pre className="ux-output">{sheetWords.commands.join("\n")}</pre>
          </Details>
        </Sheet>
      )}
    </>
  );
}
