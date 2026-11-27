// OB-12 (ONBOARDING_SPEC §5 steps 7 and 8): the words and choices of Setup's
// "Your first project" step and its "Projects folder" row (1.175.0 F2: the
// row that was the step "Where your projects live"), pure, so every row of
// the spec's tables is tested under node:
//
//     node --experimental-strip-types src/lib/firstProject.test.ts
//
// Rust does the looking and the work (`project_setup.rs`, OB-11); this file
// turns its answers into what the step says and which one action it offers.
import type {
  GithubCopyResult,
  GithubStatus,
  ProjectCloneResult,
  ProjectInspection,
  ProjectNewPreview,
  ProjectRepoEntry,
  ProjectRepoGroup,
  ProjectSaveSummary,
} from "../ipc.ts";
import { DEFAULT_PROJECTS_FOLDER } from "./settingsShape.ts";

// ── Numbers ──────────────────────────────────────────────────────────────

/** `1 240` (the spec's grouping: a space every three digits). */
export function count(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** `18 MB`, `2.4 GB`, `512 KB` (binary units, as disks and GitHub count). */
export function size(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(0, Math.round(kb))} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

// ── Step 7: where projects live ──────────────────────────────────────────

// 1.175.0 F2 (UX-3, mockup §2b): the "Projects folder" row's hint. The step
// "Where your projects live" (its title, "Why one folder?" and `Use this
// folder`) is gone: the row lives in "Your first project".
export const PROJECTS_FOLDER_HINT = "New projects and the ones you get from GitHub go here.";

/**
 * F2: the `parent` the new project's preview and creation are asked with,
 * so "It goes in ~/Projects/my-app." follows the row's folder before it is
 * saved. Null where Rust would use the same folder by itself (the saved one,
 * or `~/Projects` while none is saved): its own expansion then applies. Else
 * the row's folder, expanded (`~` is the home folder, when it is known).
 */
export function previewParent(stored: string | null, folder: string, home: string | null): string | null {
  if (folder === (stored ?? DEFAULT_PROJECTS_FOLDER)) return null;
  if (!folder.startsWith("~")) return folder;
  if (!home) return null;
  const rest = folder.slice(1).replace(/^[\\/]+/, "");
  const sep = home.includes("\\") ? "\\" : "/";
  return rest ? `${home.replace(/[\\/]+$/, "")}${sep}${rest.replace(/\//g, sep)}` : home;
}

/**
 * The folder as the step shows it: the tilde form on the Mac; on Windows the
 * stored `~/Projects` reads `%USERPROFILE%\Projects` (§5 step 7), and a
 * folder outside the home folder is shown as it was picked.
 */
export function folderShown(folder: string, windows: boolean): string {
  if (!windows) return folder;
  if (folder === "~") return "%USERPROFILE%";
  if (folder.startsWith("~/")) return `%USERPROFILE%\\${folder.slice(2).replace(/\//g, "\\")}`;
  return folder;
}

/** `~/Projects/lyra` — a project inside the projects folder, as shown. */
export function inFolder(folder: string, name: string, windows: boolean): string {
  const shown = folderShown(folder, windows);
  const sep = windows && (shown.includes("\\") || shown.startsWith("%")) ? "\\" : "/";
  return `${shown.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export type SyncedBy = "icloud" | "onedrive";

/** A folder synced by iCloud Drive or OneDrive (synced folders fight with
 *  Git). A warning, never a block. */
export function syncedBy(path: string): SyncedBy | null {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/library/mobile documents") || p.includes("/icloud drive") || p.includes("/clouddocs"))
    return "icloud";
  if (/(^|\/)onedrive( - [^/]*)?(\/|$)/.test(p) || p.includes("/library/cloudstorage/onedrive")) return "onedrive";
  return null;
}

export function syncedWarning(by: SyncedBy): string {
  return by === "icloud"
    ? "Folders synced by iCloud Drive can corrupt Git projects. Choose a folder outside it."
    : "Folders synced by OneDrive can corrupt Git projects. Choose a folder outside it.";
}

/** "Plyloft found 6 projects here." — only when there are some. */
export function foundProjectsLine(projects: number): string | null {
  if (projects <= 0) return null;
  return projects === 1 ? "Plyloft found 1 project here." : `Plyloft found ${count(projects)} projects here.`;
}

// ── Step 8: the three ways ───────────────────────────────────────────────

export const PROJECT_TITLE = "Your first project";
export const PROJECT_WHY = "Pick one to start with. You can add more any time.";

export type ProjectWay = "folder" | "github" | "new";

export function wayOptions(
  githubConnected: boolean,
  machine: "Mac" | "PC",
): { value: ProjectWay; label: string; hint: string; disabled?: boolean }[] {
  return [
    { value: "folder", label: `A folder on this ${machine}`, hint: "Code you already have." },
    {
      value: "github",
      label: "From GitHub",
      hint: githubConnected ? "One of your repositories, or your team's." : "Connect GitHub first.",
      disabled: !githubConnected,
    },
    { value: "new", label: "A new, empty project", hint: "Start from nothing." },
  ];
}

/** Existing users: "You already have 4 projects in Plyloft." */
export function existingLine(workspaces: number): string | null {
  if (workspaces <= 0) return null;
  return workspaces === 1
    ? "You already have 1 project in Plyloft."
    : `You already have ${count(workspaces)} projects in Plyloft.`;
}

// ── 8a: a folder on this Mac ─────────────────────────────────────────────

/** What the folder screen offers as its one primary. */
export type FolderAction =
  /** Register the workspace as it is. */
  | "add"
  /** It's already a workspace: Setup's active workspace becomes it. */
  | "open"
  /** The consent sheet: `git init` (when needed) and the first commit. */
  | "save"
  /** Inside another repo: look at that one instead. */
  | "use-top"
  /** Nothing to do with this one: pick again. */
  | "choose-again";

export interface FolderView {
  title: string;
  text: string | null;
  primary: { label: string; action: FolderAction };
  /** A quiet way out beside it (only "Choose another folder"). */
  secondary: { label: string; action: "choose-again" } | null;
  /** Hints under the text (uncommitted changes, a shared definition). */
  notes: string[];
  /** Why the first commit can't be made here, in words (the primary is then
   *  `choose-again`). */
  blocked: string | null;
  /** The first commit needs a name and email: "Go to Git and your name". */
  needsIdentity: boolean;
  /** Detached HEAD / an unborn branch beside others: which branch cards
   *  start from. */
  asksBranch: boolean;
  /** 1.171.0 D3 (FR-5): the folder is on a branch with changes not saved
   *  in Git — save them first, or start from the last saved version. */
  unsavedWork: UnsavedWorkChoice | null;
}

/** 1.171.0 D3: the choice above Add to Plyloft. */
export type UnsavedWorkWay = "save" | "skip";
export interface UnsavedWorkChoice {
  text: string;
  options: { value: UnsavedWorkWay; label: string; hint: string }[];
}

/** "12 files or folders" / "1 file or folder": Git's status counts a new
 *  folder once. */
export function filesOrFolders(n: number): string {
  return n === 1 ? "1 file or folder" : `${count(n)} files or folders`;
}

const SKIP_OPTION = {
  value: "skip" as const,
  label: "Leave my changes in the folder",
  hint: "They stay as they are; cards start from the last saved version and won't have them.",
};

/** 1.171.0 D3 (FR-5): the folder's changes Git hasn't saved, and the two
 *  ways. 1.174.0 C16 (NIW-6): "Leave my changes in the folder" comes first
 *  and is the default (`DEFAULT_WORK_WAY`) — it writes nothing; "Save" is
 *  one commit on the folder's own branch, here only, and names that branch.
 *  While Git is mid-way combining changes (`blocked`, Rust's words), only
 *  "Leave" is offered. */
export function unsavedWorkChoice(changed: number, branch: string, blocked: string | null = null): UnsavedWorkChoice {
  const text =
    changed > 0
      ? `This folder has changes that aren't saved in Git yet (${filesOrFolders(changed)}). Cards only see what's saved.`
      : "This folder has changes that aren't saved in Git yet. Cards only see what's saved.";
  if (blocked) return { text: `${text} ${blocked}`, options: [SKIP_OPTION] };
  return {
    text,
    options: [
      SKIP_OPTION,
      {
        value: "save",
        label: `Save them as a commit on ${branch} first`,
        hint: "One commit in this folder only. Nothing is uploaded.",
      },
    ],
  };
}

/** 1.174.0 C16 (NIW-6, owner answer 14): preselected, since it writes
 *  nothing (reverses 1.171.0 D3's "save" default). */
export const DEFAULT_WORK_WAY: UnsavedWorkWay = "skip";

/** Saving needs Git's name and email, as the first commit does. */
export const IDENTITY_FOR_SAVE = "Git needs your name and email before Plyloft can save your work.";

/** The primary for the choice: Save and add opens the sheet. */
export const SAVE_WORK_LABEL = "Save and add";

/** Said once the project is in without its changes ("skip"). */
export function unsavedSkippedNote(changed: number): string {
  return changed > 0
    ? `Cards start from the last saved version. The changes in ${filesOrFolders(changed)} stay in the folder, and cards won't have them.`
    : "Cards start from the last saved version. Your changes stay in the folder, and cards won't have them.";
}

/** A detached folder can't be saved on a branch: the hint only. */
export const UNSAVED_HINT = "Your changes that aren't saved in Git stay in the folder. Cards start from the last saved version.";

export const IDENTITY_FOR_COMMIT = "Git needs your name and email before Plyloft can make the first commit.";
export const PARTIAL_DOWNLOAD =
  "This folder holds a download from GitHub that didn't finish. Remove the folder and get the project again.";

/** "1 240 files, 18 MB." — with "at least" when the count stopped early. */
export function saveLine(summary: ProjectSaveSummary): string {
  const files = summary.files === 1 ? "1 file" : `${count(summary.files)} files`;
  return summary.complete ? `${files}, ${size(summary.bytes)}.` : `At least ${files}, ${size(summary.bytes)}.`;
}

export const IGNORE_LINE = "Plyloft adds a .gitignore that leaves out node_modules, build output and .env files.";

/** Spec §5 step 8a's outcome table, as one screen. */
export function folderView(insp: ProjectInspection): FolderView {
  const q = (s: string) => `“${s}”`;
  const view: FolderView = {
    title: "",
    text: null,
    primary: { label: "Choose another folder", action: "choose-again" },
    secondary: null,
    notes: [],
    blocked: null,
    needsIdentity: false,
    asksBranch: false,
    unsavedWork: null,
  };
  if (insp.sharedDefinition) view.notes.push("This project brings its own Plyloft settings.");
  switch (insp.outcome) {
    case "refused":
      view.title = insp.refusedWords ?? "Choose a project folder, not your whole home folder.";
      return view;
    case "already-in-ply":
      view.title = `${q(insp.existingWorkspace?.name ?? insp.name)} is already in Plyloft.`;
      view.primary = { label: "Open it", action: "open" };
      view.secondary = { label: "Choose another folder", action: "choose-again" };
      return view;
    case "inside-another-repo": {
      const top = insp.git.kind === "inside-another" ? insp.git.name : "another project";
      view.title = `This folder is inside another Git project, ${q(top)}.`;
      view.text = "Plyloft works with a whole Git project.";
      view.primary = { label: `Use ${q(top)} instead`, action: "use-top" };
      view.secondary = { label: "Choose another folder", action: "choose-again" };
      return view;
    }
    case "ready": {
      const branch = insp.git.kind === "branch" ? insp.git.branch : (insp.suggestedBranch ?? "main");
      view.title = `${q(insp.name)} is a Git project on branch ${branch}.`;
      view.primary = { label: "Add to Plyloft", action: "add" };
      if (insp.uncommittedChanges && insp.git.kind === "branch") {
        view.unsavedWork = unsavedWorkChoice(insp.uncommittedFiles ?? 0, insp.git.branch, insp.workBlocked ?? null);
      } else if (insp.uncommittedChanges) {
        view.notes.unshift(UNSAVED_HINT);
      }
      return view;
    }
    case "choose-branch":
      view.title = `${q(insp.name)} isn't on a branch right now.`;
      view.text = "Cards start from a branch and are merged back into it. Which one?";
      view.notes.unshift("Plyloft doesn't switch your folder's branch.");
      view.primary = { label: "Add to Plyloft", action: "add" };
      view.asksBranch = true;
      if (insp.uncommittedChanges) {
        view.notes.push(UNSAVED_HINT);
      }
      return view;
    case "not-a-repo":
    case "no-commits": {
      const init = insp.outcome === "not-a-repo";
      view.title = init ? `Make ${q(insp.name)} a Git project?` : `${q(insp.name)} has no saved version yet.`;
      view.text = init
        ? "Plyloft will start Git here and save everything in the folder as the first version. Nothing is uploaded."
        : "Plyloft will save everything in the folder as the first commit.";
      view.primary = { label: init ? "Start Git and add" : "Save and add", action: "save" };
      view.secondary = { label: "Choose another folder", action: "choose-again" };
      const blocked =
        (insp.partialDownload ? PARTIAL_DOWNLOAD : null) ??
        insp.ignoreProblem ??
        (insp.unnameable.length > 0 || insp.foundTruncated ? insp.scanWarning : null);
      if (blocked) {
        view.blocked = blocked;
        view.primary = { label: "Choose another folder", action: "choose-again" };
        view.secondary = null;
      } else if (insp.needsIdentity) {
        view.needsIdentity = true;
      }
      return view;
    }
  }
}

/** The branch a detached / unborn folder's cards start from, preselected:
 *  main, else master, else the most recent (Rust's `suggestedBranch`). */
export function defaultBranch(insp: ProjectInspection): string {
  return insp.suggestedBranch ?? insp.branches[0] ?? "main";
}

/** The first-commit sheet (§4: it names exactly what runs and changes). */
export interface SaveSheet {
  title: string;
  lede: string;
  /** "1 240 files, 18 MB. Plyloft adds a .gitignore …" */
  list: string;
  /** Huge: "That's a lot to save in one go. …" */
  hugeWarning: string | null;
  /** The count stopped at its bound: the person has to say go on. */
  incomplete: string | null;
  largeIntro: string | null;
  secretsIntro: string | null;
  confirm: string;
  /** Under Details. */
  commands: string[];
  /** 1.171.0 D3 (save work): new build/package folders, left out unless
   *  unticked. */
  buildIntro?: string | null;
  /** 1.171.0 D3 (save work): projects inside this one, never saved here. */
  nestedLine?: string | null;
  /** 1.171.0 D3 (save work): why it can't be saved at all (no "anyway"). */
  refused?: string | null;
  /** 1.171.0 walk fix (save work): the files it saves, by name. */
  filesLine?: string | null;
}

export const HUGE_WARNING = "That's a lot to save in one go. Check the list of what's left out before continuing.";
export const LARGE_INTRO = "These files are over 50 MB. GitHub refuses files over 100 MB, so Plyloft leaves them out:";
export const SECRETS_INTRO = "These look like passwords or keys. Plyloft leaves them out of Git:";

/** A secret the person unticked is saved in Git: say what that means. */
export function secretKeptWarning(path: string): string {
  return `“${path}” will be saved in Git. Anyone who gets a copy of this project can read it.`;
}

/** The comment Plyloft writes above the lines it adds to `.gitignore`
 *  (`project_setup::IGNORE_HEADER`). */
export const IGNORE_HEADER = "# Added by Plyloft";

/** 1.172 A3 (Windows walk 2026-10-27-211141): Details lists every line the
 *  `.gitignore` gains — the comment Plyloft writes above them included, so
 *  the file holds nothing the sheet didn't show. */
export function ignoreAddedDetails(ignore: readonly string[]): string {
  return `.gitignore, lines added:\n${[IGNORE_HEADER, ...ignore].map((l) => `  ${l}`).join("\n")}`;
}

/** `plannedIgnore`: the lines `project_init` will add for the choices on the
 *  sheet, as Rust plans them (`project_ignore_plan`: the defaults not there
 *  yet, each file left out, a `!` line for an unticked `.env`); null while
 *  that read is out. */
export function saveSheet(insp: ProjectInspection, plannedIgnore: readonly string[] | null): SaveSheet {
  const init = insp.outcome === "not-a-repo";
  const summary = insp.toSave;
  const ignore = plannedIgnore ?? [];
  const commands = [
    ...(init ? ["git init -b main"] : []),
    ...(plannedIgnore === null
      ? [".gitignore: reading what will be added…"]
      : ignore.length > 0
        ? [ignoreAddedDetails(ignore)]
        : []),
    "git add -A",
    'git commit -m "chore: first commit"',
  ];
  return {
    title: init ? `Make “${insp.name}” a Git project?` : `Save “${insp.name}”'s first version?`,
    lede: init
      ? "Plyloft will start Git here and save everything in the folder as the first version. Nothing is uploaded."
      : "Plyloft will save everything in the folder as the first commit. Nothing is uploaded.",
    list: summary ? `${saveLine(summary)} ${IGNORE_LINE}` : IGNORE_LINE,
    hugeWarning: summary?.huge ? HUGE_WARNING : null,
    incomplete: summary && !summary.complete ? (insp.scanWarning ?? null) : null,
    largeIntro: insp.largeFiles.length > 0 ? LARGE_INTRO : null,
    secretsIntro: insp.secrets.length > 0 ? SECRETS_INTRO : null,
    confirm: init ? "Start Git and add" : "Save and add",
    commands,
  };
}

/** 1.171.0 D3: the "Save my current work first" sheet — the first-commit
 *  sheet's shape, for a folder that already has commits: one commit of its
 *  changes on its own branch, here only, with no default `.gitignore`
 *  lines (only one per new file or folder left out). `insp` is
 *  `projectInspectWork`'s. `SAVE_WORK_COMMIT` is `commit_message::SAVE_WORK`
 *  (a Rust test reads this line). */
export const SAVE_WORK_COMMIT = "chore: save work before adding to Plyloft";
export const WORK_IGNORE_LINE = "Plyloft adds a line to .gitignore for each new file you leave out.";
export const BUILD_INTRO = "These new folders look like installed packages or build output. Plyloft leaves them out:";
export const WORK_TOO_BIG =
  "This folder has too many changed files for Plyloft to check them all. Leave your changes in the folder, or save them in Git yourself first.";
export function nestedLine(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const named = paths.slice(0, 3).map((p) => `“${p}”`).join(", ") + (paths.length > 3 ? "…" : "");
  return paths.length === 1
    ? `${named} is a Git project of its own, so Plyloft leaves it as it is.`
    : `${named} are Git projects of their own, so Plyloft leaves them as they are.`;
}

/** The new files and folders among those left out (the ones that get a
 *  `.gitignore` line); a file Git already has keeps its saved version. */
export function untrackedLeaveOut(insp: ProjectInspection, leaveOut: readonly string[]): string[] {
  const tracked = new Set(insp.workTracked ?? []);
  return leaveOut.filter((p) => !tracked.has(p));
}

/** 1.171.0 walk fix: the files "Save my current work first" saves, by
 *  name — the first ones (`workFiles`, at most 20) and how many more of
 *  the `total` it counts. Null when it names none. */
export function workFilesLine(names: readonly string[], total: number): string | null {
  if (names.length === 0) return null;
  const more = Math.max(0, total - names.length);
  const listed = names.join(", ");
  return more > 0 ? `It saves ${listed} and ${count(more)} more.` : `It saves ${listed}.`;
}

/** Challenger 6: the names and count the line says — `workFiles` and the
 *  large files and secrets the person chose to save (unticked), which
 *  `toSave.files` doesn't count; sorted. */
export function workFilesSaved(insp: ProjectInspection, leaveOut: readonly string[]): [string[], number] {
  const kept = [...insp.largeFiles, ...insp.secrets].map((f) => f.path).filter((p) => !leaveOut.includes(p));
  const names = [...(insp.workFiles ?? []), ...kept].sort().slice(0, 20);
  return [names, (insp.toSave?.files ?? 0) + kept.length];
}

export function saveWorkSheet(
  insp: ProjectInspection,
  plannedIgnore: readonly string[] | null,
  leaveOut: readonly string[],
): SaveSheet {
  const branch = insp.git.kind === "branch" ? insp.git.branch : "its branch";
  const summary = insp.toSave;
  const ignore = plannedIgnore ?? [];
  const ignoreLine = ignore.length > 0 ? ` ${WORK_IGNORE_LINE}` : "";
  const nested = insp.nestedProjects ?? [];
  return {
    title: `Save your current work in “${insp.name}”?`,
    lede: `Plyloft saves the folder's changes in Git as one commit on ${branch}, in this folder only. Your files stay as they are, the branch stays ${branch}, and nothing is uploaded.`,
    list: summary ? `${saveLine(summary)}${ignoreLine}` : ignoreLine.trim(),
    hugeWarning: summary?.huge ? HUGE_WARNING : null,
    // Never "save it anyway": what wasn't checked would be saved unseen.
    incomplete: null,
    refused: summary && !summary.complete ? WORK_TOO_BIG : null,
    largeIntro: insp.largeFiles.length > 0 ? LARGE_INTRO : null,
    secretsIntro: insp.secrets.length > 0 ? SECRETS_INTRO : null,
    buildIntro: (insp.buildFolders ?? []).length > 0 ? BUILD_INTRO : null,
    nestedLine: nestedLine(nested),
    filesLine: workFilesLine(...workFilesSaved(insp, leaveOut)),
    confirm: SAVE_WORK_LABEL,
    commands: [
      ...(plannedIgnore === null
        ? [".gitignore: reading what will be added…"]
        : ignore.length > 0
          ? [ignoreAddedDetails(ignore)]
          : []),
      "git add -A",
      ...(leaveOut.length > 0 || nested.length > 0
        ? [`git reset -q -- ${[...leaveOut.map((p) => p.replace(/\/$/, "")), ...nested].join(" ")}`]
        : []),
      `git commit -m "${SAVE_WORK_COMMIT}"`,
    ],
  };
}

/** A refusal's plain words, and Git's own output under Details (Rust puts
 *  it after a blank line). */
export function splitDetails(error: string): { text: string; details: string | null } {
  const at = error.indexOf("\n\n");
  return at < 0 ? { text: error, details: null } : { text: error.slice(0, at), details: error.slice(at + 2) };
}

/** What the sheet starts with ticked: every large file and secret found. */
export function initialLeaveOut(insp: ProjectInspection): string[] {
  return [...insp.largeFiles, ...insp.secrets, ...(insp.buildFolders ?? [])].map((f) => f.path);
}

// ── 8b: from GitHub ──────────────────────────────────────────────────────

/** ux PATTERNS §3: a list gets a filter field once it passes 12 rows. */
export const FILTER_AFTER = 12;

export interface RepoGroupView {
  key: string;
  label: string;
  repos: ProjectRepoEntry[];
}

const GROUP_ORDER: Record<ProjectRepoGroup, number> = { yours: 0, org: 1, shared: 2, team: 3 };

/** The picker's groups: *Yours* · each organisation · *Shared with you* ·
 *  *Your team* — filtered by `filter` (owner/name and description). */
export function repoGroups(repos: readonly ProjectRepoEntry[], filter = ""): RepoGroupView[] {
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? repos.filter(
        (r) =>
          r.nameWithOwner.toLowerCase().includes(needle) || (r.description ?? "").toLowerCase().includes(needle),
      )
    : repos;
  const groups = new Map<string, RepoGroupView & { order: number }>();
  for (const repo of shown) {
    const key = repo.group === "org" ? `org:${repo.groupOwner}` : repo.group;
    const label =
      repo.group === "yours"
        ? "Yours"
        : repo.group === "org"
          ? repo.groupOwner
          : repo.group === "shared"
            ? "Shared with you"
            : "Your team";
    const g = groups.get(key) ?? { key, label, repos: [], order: GROUP_ORDER[repo.group] };
    g.repos.push(repo);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ key, label, repos: list }) => ({ key, label, repos: list }));
}

/** `Updated 3 days ago` from GitHub's `updatedAt`. */
export function updatedLine(updatedAt: string | null, now: number = Date.now()): string | null {
  if (!updatedAt) return null;
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return null;
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  if (days < 30) return `Updated ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "Updated a month ago" : `Updated ${months} months ago`;
  const years = Math.floor(days / 365);
  return years <= 1 ? "Updated a year ago" : `Updated ${years} years ago`;
}

/** The size line of "Get “lyra”?" (`diskUsage`, KB and approximate; `0`
 *  for small non-empty repositories — emptiness is `isEmpty` only). */
export function cloneSizeLine(repo: Pick<ProjectRepoEntry, "diskUsageKb" | "isEmpty">): string | null {
  if (repo.isEmpty === true) return "It's empty on GitHub.";
  const kb = repo.diskUsageKb;
  if (kb === null || kb === undefined) return null;
  if (kb >= 1024 * 1024) return `It's ${size(kb * 1024)}, so this may take a while.`;
  if (kb === 0) return "It's small.";
  return `It's about ${size(kb * 1024)}.`;
}

export interface CloneSheet {
  title: string;
  lede: string;
  sizeLine: string | null;
  command: string;
}

export function cloneSheet(repo: ProjectRepoEntry, destShown: string): CloneSheet {
  return {
    title: `Get “${repo.name}”?`,
    lede: `Plyloft will download it into ${destShown}.`,
    sizeLine: cloneSizeLine(repo),
    command: `gh repo clone ${repo.nameWithOwner} ${destShown} -- --progress`,
  };
}

/** After a clone that didn't finish: the words and the one way out. */
export interface CloneFailureView {
  text: string;
  action: { id: "retry" | "fix-sign-in" | "authorise"; label: string } | null;
}

export function cloneFailureView(result: ProjectCloneResult, severalAccounts: boolean): CloneFailureView | null {
  const failure = result.failure;
  if (!failure) return null;
  switch (failure.kind) {
    case "auth":
      return severalAccounts
        ? { text: `${failure.words} Try with another account.`, action: null }
        : { text: failure.words, action: { id: "fix-sign-in", label: "Fix sign-in" } };
    case "sso":
      return { text: failure.words, action: failure.ssoOrg ? { id: "authorise", label: "Authorize" } : null };
    case "cancelled":
      return { text: failure.words, action: null };
    default:
      return { text: failure.words, action: { id: "retry", label: "Try again" } };
  }
}

/** What a finished clone asks next. */
export type CloneNext = "add" | "empty" | "branch" | "failed";

export function cloneNext(result: ProjectCloneResult): CloneNext {
  if (!result.cloned || result.failure) return "failed";
  if (!result.empty) return "add";
  return result.remoteBranches.length > 0 ? "branch" : "empty";
}

export function emptyRepoWords(name: string): { title: string; text: string } {
  return {
    title: `“${name}” is empty on GitHub.`,
    text: "Plyloft will add a README and save it as the first commit, then send it to GitHub so both have the same start.",
  };
}

export function firstPushSheet(name: string, branch: string): { title: string; lede: string; commands: string[] } {
  return {
    title: `Make “${name}”'s first commit?`,
    lede: "Plyloft adds a README, saves it as the first commit and sends it to GitHub.",
    commands: [`README.md: # ${name}`, "git add README.md", 'git commit -m "chore: first commit"', `git push -u origin ${branch}`],
  };
}

export function emptyBranchWords(name: string, branch: string | null): { title: string; text: string } {
  return {
    title: `“${name}”'s ${branch ?? "main"} branch has no commits yet, but other branches do.`,
    text: "Cards start from a branch and are merged back into it. Which one?",
  };
}

// ── The GitHub account (OB-7b) ───────────────────────────────────────────

/** The logins step 8 can choose from, and the one preselected (gh's
 *  active account). Only asked when gh lists more than one
 *  (`accountChoiceNeeded`). */
export function accountChoices(status: GithubStatus | null): { logins: string[]; preselected: string | null } {
  const accounts = (status?.accounts ?? []).filter((a) => a.state !== "refused");
  const logins = accounts.map((a) => a.login);
  const active = accounts.find((a) => a.active)?.login ?? logins[0] ?? null;
  return { logins, preselected: active };
}

// ── 8c: a new, empty project ─────────────────────────────────────────────

export const NAME_NEEDS_LETTERS = "Choose a name with letters or numbers.";
/** The carried-forward wording: a name in Chinese, Japanese, Korean, Arabic …
 *  has letters, but none the folder's name can use. */
export const NAME_NEEDS_LATIN =
  "The folder's name can only use the letters a to z and numbers. Add some to the name, like “Notes 2”.";

/** Rust's refusal of a name, with the wording fixed for names whose letters
 *  are all outside a–z (reserved names like `con` keep Rust's words). */
export function nameProblem(name: string, problem: string | null): string | null {
  if (!problem) return null;
  if (problem === NAME_NEEDS_LETTERS && !/[A-Za-z0-9]/.test(name) && /[\p{L}\p{N}]/u.test(name)) {
    return NAME_NEEDS_LATIN;
  }
  return problem;
}

/** The line under the name field: where it goes, or why it can't. */
export function newNameLine(name: string, preview: ProjectNewPreview | null): { text: string; problem: boolean } | null {
  if (!name.trim() || !preview || preview.name !== name.trim()) return null;
  const problem = nameProblem(name, preview.problem);
  if (problem) return { text: problem, problem: true };
  if (!preview.displayPath) return null;
  return { text: `It goes in ${preview.displayPath}.`, problem: false };
}

/** "Folder exists and is not empty": `Add that folder instead`. */
export function hasFilesOffer(preview: ProjectNewPreview | null): boolean {
  return preview?.folder === "has-files" && !preview.placeRefused && !preview.insideRepo;
}

export function githubCopyHint(login: string, slug: string): string {
  return `Creates the private repository ${login}/${slug} and sends the first version.`;
}

export interface NewSheet {
  title: string;
  lede: string;
  commands: string[];
}

export function newSheet(name: string, displayPath: string, slug: string, copyLogin: string | null): NewSheet {
  return {
    title: `Create “${name}”?`,
    lede:
      "Plyloft will make the folder, start Git in it and save a first version with a README." +
      (copyLogin ? ` Then it creates the private repository ${copyLogin}/${slug} on GitHub and sends that version.` : ""),
    commands: [
      `mkdir ${displayPath}`,
      "git init -b main",
      `README.md: # ${name}`,
      ".gitignore: .DS_Store, Thumbs.db, Desktop.ini (system files only)",
      "git add README.md .gitignore",
      `git commit -m "Start ${name}"`,
      ...(copyLogin ? [`gh repo create ${copyLogin}/${slug} --private --source . --push`] : []),
    ],
  };
}

/** What happened to the GitHub copy, when one was asked. */
export function githubCopyLine(result: GithubCopyResult | null, slug: string): string | null {
  if (!result) return null;
  switch (result.state) {
    case "created":
      return `A private copy is on GitHub at ${result.repo}.`;
    case "name-taken":
      return `You already have a repository called ${slug} on GitHub. The project was made on this computer; no copy was sent.`;
    case "failed":
      return result.words ?? "The copy on GitHub couldn't be made. The project was made on this computer.";
  }
}

// ── Step 8's success: a repo with a commit on its target branch ──────────

/**
 * One workspace's inspection: is it a Git repo with a commit on its target
 * branch? `targetBranch` is its project config's, when it has one; without
 * one, the branch it is on (or, detached, any branch with a commit). A
 * workspace inside a bigger repository counts: Plyloft works from its top.
 */
export function repoReadyOf(
  insp: Pick<ProjectInspection, "git" | "branches">,
  targetBranch: string | null,
): boolean {
  switch (insp.git.kind) {
    case "not-repo":
      return false;
    case "inside-another":
      return true;
    case "branch":
    case "detached":
    case "unborn":
      if (targetBranch) return insp.branches.includes(targetBranch);
      return insp.git.kind === "branch" || (insp.git.kind === "detached" && insp.branches.length > 0);
  }
}

/**
 * Setup's read of `projectRepoReady`: the workspaces one at a time, stopping
 * at the first that is ready. True / false when every look answered; null
 * when one couldn't be read and none was ready (never "missing" on a guess).
 * At most `limit` looks.
 */
export async function probeRepoReady(
  workspaces: readonly { id: string; cwd: string }[],
  targets: ReadonlyMap<string, string | null>,
  inspect: (cwd: string) => Promise<Pick<ProjectInspection, "git" | "branches">>,
  limit = 20,
): Promise<boolean | null> {
  if (workspaces.length === 0) return false;
  let unknown = false;
  for (const ws of workspaces.slice(0, limit)) {
    try {
      if (repoReadyOf(await inspect(ws.cwd), targets.get(ws.id) ?? null)) return true;
    } catch {
      unknown = true;
    }
  }
  if (workspaces.length > limit) unknown = true;
  return unknown ? null : false;
}
