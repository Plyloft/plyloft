// 1.175.0 F2 (UX-3, mockup §2b): the "Projects folder" row. Until 1.174.5
// it was a step of its own, "Where your projects live", with `Use this
// folder` to press (OB-12, §5 step 7). Now it is one row inside "Your first
// project", in the two ways that make a folder — From GitHub and A new,
// empty project (never "A folder on this Mac") — and in Add a project and
// the team step's projects. It already says `~/Projects`
// (`%USERPROFILE%\Projects` on Windows; D9), or the folder chosen before;
// there is nothing to press to accept it. `Change…` opens the folder picker.
// The same words, warnings and checks as the step had: "Plyloft found 6
// projects here." when the folder already holds Git projects, a warning
// (never a block) for a folder synced by iCloud Drive or OneDrive, and
// "There's a file with that name, not a folder." which turns the way's
// primary off. The choice is saved at the first creation or download
// (`store/projectsFolderWrite.ts::chooseProjectsFolder`: the team's clone
// root kept first, the folder made when it is missing, tilde form), not
// before.
//
// The words are pure in `lib/firstProject.ts`.
import { useEffect, useState } from "react";
import { openDialog } from "../../lib/nativeDialog";
import { homeDir } from "@tauri-apps/api/path";
import { CBtn, Callout, Details, Group, Row, RowValue } from "../ux";
import { useSettings } from "../../store/settingsStore";
import { projectsFolderLook, type ProjectsFolderLook } from "../../ipc";
import { platform } from "../../lib/platform";
import { tildeForm } from "../../lib/projectsFolder";
import { failure, type Failure } from "../../lib/failure";
import { DEFAULT_PROJECTS_FOLDER } from "../../lib/settingsShape";
import { PROJECTS_FOLDER_HINT, folderShown, foundProjectsLine, syncedBy, syncedWarning } from "../../lib/firstProject";

export const NOT_A_FOLDER = "There's a file with that name, not a folder. Choose another folder.";

/** The row's state, held by the way that shows it (it needs the folder at
 *  Create or Get, and whether it can go ahead). */
export interface ProjectsFolderChoice {
  /** Tilde form, as it will be saved. */
  folder: string;
  /** `settings.projects.folder`, or null while none was ever saved. */
  stored: string | null;
  /** What is at the folder (read-only), or null while it isn't read. */
  look: ProjectsFolderLook | null;
  /** A file stands where the folder would be: the primary waits. */
  notAFolder: boolean;
  change: () => Promise<void>;
  picking: boolean;
  error: Failure | null;
}

/** `shown`: the row is on screen; while it isn't, nothing is read. */
export function useProjectsFolderChoice(shown = true): ProjectsFolderChoice {
  const stored = useSettings((s) => s.settings.projects?.folder ?? null);
  const [folder, setFolder] = useState<string>(stored ?? DEFAULT_PROJECTS_FOLDER);
  const [look, setLook] = useState<ProjectsFolderLook | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  // What is at the folder shown (read-only).
  useEffect(() => {
    let live = true;
    setLook(null);
    if (!shown) return;
    projectsFolderLook(folder)
      .then((l) => {
        if (live) setLook(l);
      })
      .catch(() => {
        if (live) setLook(null);
      });
    return () => {
      live = false;
    };
  }, [folder, shown]);

  const change = async () => {
    setPicking(true);
    setError(null);
    try {
      const home = await homeDir().catch(() => null);
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose your projects folder",
        defaultPath: home && folder.startsWith("~") ? `${home}${folder.slice(1)}` : undefined,
      });
      if (picked && !Array.isArray(picked)) setFolder(tildeForm(picked, home));
    } catch (e) {
      setError(failure("The folder picker didn't open. Press Change… to try again.", e));
    } finally {
      setPicking(false);
    }
  };

  return { folder, stored, look, notAFolder: look?.notAFolder === true, change, picking, error };
}

export function ProjectsFolderRow({ choice, disabled = false }: { choice: ProjectsFolderChoice; disabled?: boolean }) {
  const windows = platform() === "windows";
  const { folder, look, change, picking, error } = choice;
  const synced = syncedBy(look?.path ?? folder) ?? syncedBy(folder);
  // After the first time: the count. Before: what the row is for.
  const found = look && !look.notAFolder ? foundProjectsLine(look.projects) : null;
  return (
    <>
      <Group label="Projects folder">
        <Row
          kind="value"
          label="Projects folder"
          hint={found ?? PROJECTS_FOLDER_HINT}
          error={look?.notAFolder ? NOT_A_FOLDER : undefined}
          action={
            <CBtn tone="quiet" onClick={() => void change()} disabled={picking || disabled}>
              Change…
            </CBtn>
          }
        >
          <RowValue mono>{folderShown(folder, windows)}</RowValue>
        </Row>
      </Group>
      {synced && <Callout kind="warn" text={syncedWarning(synced)} />}
      {error && <Callout kind="danger" text={error.sentence} />}
      {error?.details && (
        <Details>
          <pre className="ux-output">{error.details}</pre>
        </Details>
      )}
    </>
  );
}
