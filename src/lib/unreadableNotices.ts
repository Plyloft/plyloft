import { invoke } from "@tauri-apps/api/core";
import { pushToast, useToasts, type Toast } from "../store/toastStore";
import { noteProjectListTrouble } from "../store/projectListTrouble";
import { platformWord } from "./platform";

// 1.175.0 (round 2; owner, 2026-11-09): what Plyloft couldn't read when it
// opened, said once (`unreadable_notices.rs`). The words are the designer's
// (`STRINGS-immediacy.md`, "Blocco A · due avvisi all'avvio"): the title
// names what couldn't be read, the body what Plyloft did, and only the path
// sits behind Details.

type NoticeToast = Omit<Toast, "id" | "createdAt">;

/** What became of a board file that couldn't be read. */
export interface BoardUnreadableNotice {
  /** The last saved copy was opened; `false`: the board started empty. */
  restored: boolean;
  /** Where the file that couldn't be read is kept. */
  keptAs: string;
  /** Round 4 (T4): on how many restored cards "Merge when checks pass" was
   *  turned off (`pr_merge::turn_off_on_restore`); 0 or absent: on none. */
  autoMergeOff?: number;
}

/** Once per board that couldn't be read, the first time it is asked after
 *  that; `null` otherwise (and in a harness with no backend). */
export async function boardUnreadableNotice(workspaceId: string): Promise<BoardUnreadableNotice | null> {
  return (await invoke<BoardUnreadableNotice | null>("board_unreadable_notice", { workspaceId })) ?? null;
}

/** One board's trouble as the launch asks for all of them
 *  (`board_unreadable_notices`). */
export interface LaunchBoardNotice extends BoardUnreadableNotice {
  workspaceId: string;
  /** `null` for a board whose project isn't in the list. */
  projectName: string | null;
  /** Its cards come from GitHub Issues: restored, it is read from GitHub
   *  before anything of it is sent there. */
  githubIssues: boolean;
}

/** What the launch is told about the boards. */
export interface LaunchBoardTroubles {
  /** Every trouble not said yet. */
  notices: LaunchBoardNotice[];
  /** Round 6 (W2): the workspaces whose GitHub Issues board was opened from
   *  its last saved copy and hasn't been read from GitHub since — also one
   *  whose notice was shown at an earlier launch. */
  awaitingRead: string[];
}

/** Round 4 (T1): every board trouble not said yet, each handed out once.
 *  Asked at launch: a board is restored when Plyloft starts, also the board
 *  of a project nobody opens that day. */
export async function boardUnreadableNotices(): Promise<LaunchBoardTroubles> {
  const told = await invoke<Partial<LaunchBoardTroubles> | null>("board_unreadable_notices");
  return { notices: told?.notices ?? [], awaitingRead: told?.awaitingRead ?? [] };
}

/** Round 6 (W3): the window has shown this board's notice. Until then the
 *  backend has only handed it out, and hands it out again at the next
 *  launch. */
export function boardUnreadableSaid(workspaceId: string) {
  return invoke<void>("board_unreadable_said", { workspaceId });
}

/** W3: the file the board's notice names, selected in Finder (File Explorer
 *  on Windows). The page says which board; the path is the backend's own. */
export function boardUnreadableReveal(workspaceId: string) {
  return invoke<void>("board_unreadable_reveal", { workspaceId });
}

/** A notice and what to do once it is on screen. */
export interface NoticeInTurn {
  toast: NoticeToast;
  onShown?: () => void;
}

/** Round 4 (T1): show notices one after the other, each once the one before
 *  it has left the screen (it was dismissed, or its action pressed).
 *  Round 6 (W3): `onShown` runs when the toast is the one on screen — not
 *  when it is pushed, which may only queue it behind an Undo. The notices
 *  still waiting their turn have not been shown: a quit then must not count
 *  them as said. */
export function showInTurn(notices: NoticeInTurn[]): void {
  const [first, ...rest] = notices;
  if (!first) return;
  const id = pushToast(first.toast);
  let shown = false;
  const look = (s: { toasts: Toast[]; queue: Toast[] }) => {
    const onScreen = s.toasts.some((t) => t.id === id);
    if (onScreen && !shown) {
      shown = true;
      first.onShown?.();
    }
    if (onScreen || s.queue.some((t) => t.id === id)) return false;
    return true;
  };
  if (look(useToasts.getState())) return showInTurn(rest);
  const unsubscribe = useToasts.subscribe((s) => {
    if (!look(s)) return;
    unsubscribe();
    // After the store has finished what took it off the screen (a dismiss
    // sets the screen twice): a push from inside it would be wiped.
    queueMicrotask(() => showInTurn(rest));
  });
}

/** The toast can come at launch, over another project: its title names the
 *  board's project when there is one. */
export function boardUnreadableTitle(projectName: string | undefined): string {
  return projectName ? `The board of ${projectName} couldn't be read` : "The board couldn't be read";
}

export const BOARD_RESTORED_BODY =
  "Plyloft opened the last saved copy. Anything changed after that copy was saved isn't in it.";
export const BOARD_EMPTY_BODY = "Plyloft started an empty board.";

/** Round 4 (T4): the last saved copy may be from before the person turned
 *  "Merge when checks pass" off, and a merge can't be taken back: a restore
 *  turns Plyloft's own off on the restored cards, and the notice says on how
 *  many. `null` when no card had it on. (Proposed: `STRINGS-immediacy.md`,
 *  "Da approvare".) */
export function autoMergeOffLine(cards: number | undefined): string | null {
  if (!cards || cards < 1) return null;
  const on = cards === 1 ? "1 card" : `${cards} cards`;
  return `Merge when checks pass was turned off on ${on}: turn it on again where you want it.`;
}

export function boardUnreadableToast(projectName: string | undefined, notice: BoardUnreadableNotice): NoticeToast {
  const kept = `The file that couldn't be read is kept as ${notice.keptAs}.`;
  const turnedOff = notice.restored ? autoMergeOffLine(notice.autoMergeOff) : null;
  return {
    kind: "error",
    title: boardUnreadableTitle(projectName),
    body: notice.restored ? BOARD_RESTORED_BODY : BOARD_EMPTY_BODY,
    details: turnedOff ? `${kept}\n${turnedOff}` : kept,
  };
}

/** Round 6 (W3; decided while the owner is away): the board's notice with
 *  the project-list notice's own action, *Show in Finder* (File Explorer on
 *  Windows) on the file it names. A toast with an action stays until it is
 *  dismissed: without one this was a timed error, which any later error
 *  toast replaced within seconds. Pressing the action takes the toast away,
 *  so when the file can't be shown the notice comes back, with the reason
 *  added behind Details. */
export function boardNoticeToast(
  workspaceId: string,
  projectName: string | undefined,
  notice: BoardUnreadableNotice,
  failure?: string,
): NoticeToast {
  const toast = boardUnreadableToast(projectName, notice);
  return {
    ...toast,
    details: failure ? `${toast.details}\n${failure}` : toast.details,
    action: {
      label: platformWord("showIn"),
      onClick: () => {
        void boardUnreadableReveal(workspaceId).catch((e) =>
          pushToast(boardNoticeToast(workspaceId, projectName, notice, String((e as Error)?.message ?? e))),
        );
      },
    },
  };
}

/** W3: a board notice in its turn, acknowledged to the backend once it is on
 *  screen. */
export function boardNoticeInTurn(
  workspaceId: string,
  projectName: string | undefined,
  notice: BoardUnreadableNotice,
): NoticeInTurn {
  return {
    toast: boardNoticeToast(workspaceId, projectName, notice),
    onShown: () => void boardUnreadableSaid(workspaceId).catch((e) => console.warn(`board notice of ${workspaceId}: not acknowledged:`, e)),
  };
}

/** What became of a project list this launch couldn't use
 *  (`workspace::ListTrouble`). */
export type ProjectListNotice =
  /** It wasn't a project list: kept at `path`, and a new list starts. */
  | { kind: "setAside"; path: string }
  /** A project list this Plyloft doesn't write over (a newer one saved it,
   *  or it holds a value this one can't read): untouched at `path`; `why`
   *  is what every save answers. */
  | { kind: "refused"; path: string; why: string };

/** Once per launch, when the project list couldn't be used; `null` after
 *  that, and when it was read. */
export async function projectListNotice(): Promise<ProjectListNotice | null> {
  return (await invoke<ProjectListNotice | null>("project_list_notice")) ?? null;
}

/** Y3 round 3: whether the project list was in trouble this launch, and
 *  which way, for as long as Plyloft runs. It takes nothing, so a window that
 *  loads again still gets it (the notice above is given once). */
export async function projectListTrouble(): Promise<ProjectListNotice["kind"] | null> {
  return (await invoke<ProjectListNotice["kind"] | null>("project_list_trouble")) ?? null;
}

/** The file the notice names, selected in Finder (File Explorer on Windows). */
export function projectListNoticeReveal() {
  return invoke<void>("project_list_notice_reveal");
}

export const PROJECT_LIST_TITLE = "Your project list couldn't be read";
export const PROJECT_LIST_SET_ASIDE_BODY = "Plyloft started with none. The old file is kept.";
export const PROJECT_LIST_REFUSED_BODY =
  "Plyloft started with none and left the file as it is. A newer Plyloft may have saved it: update Plyloft to open your projects.";
/** Round 4 (T7): the way out when updating doesn't help — an entry damaged
 *  by hand is refused on the newest Plyloft too, and every add with it.
 *  Behind Details, after the reason and the path; Show in Finder puts the
 *  file within reach. (Proposed: `STRINGS-immediacy.md`, "Da approvare".) */
export const PROJECT_LIST_REFUSED_WAY_OUT =
  "If Plyloft is already up to date: quit Plyloft, move that file somewhere else, and open Plyloft again to start with no projects.";

/** The launch toast. It carries an action, so it stays until it is
 *  dismissed: by then the app shows no projects, and the notice is the only
 *  word about why. */
export function projectListToast(notice: ProjectListNotice, onReveal: () => void): NoticeToast {
  const refused = notice.kind === "refused";
  return {
    kind: "error",
    title: PROJECT_LIST_TITLE,
    body: refused ? PROJECT_LIST_REFUSED_BODY : PROJECT_LIST_SET_ASIDE_BODY,
    details: refused
      ? `${notice.why} The file is ${notice.path}.\n${PROJECT_LIST_REFUSED_WAY_OUT}`
      : `The old file is kept as ${notice.path}.`,
    action: { label: platformWord("showIn"), onClick: onReveal },
  };
}

/** At launch, once the window is up: say that the project list couldn't be
 *  read, if it couldn't (`App.tsx`). Never throws. Pressing the action takes
 *  the toast away, so when the file can't be shown the notice comes back,
 *  with the reason added behind Details: the path must stay within reach. */
export async function sayProjectListNotice(): Promise<void> {
  // Y3: asked in the same turn as the first read of the list, so an empty
  // list is never taken for "no project yet" before this answers; and the
  // answer is kept for the session (the backend gives it once).
  noteProjectListTrouble("pending");
  // Round 3: the fact comes from a read that takes nothing — a window that
  // loads again in the same run (the web view's own Reload on a Mac) gets no
  // notice a second time, and must still not read its empty list as a first
  // run. Not known (the read failed): the notice's own answer, else none.
  const kind = await projectListTrouble().catch((e) => {
    console.warn("project list trouble not read:", e);
    return null;
  });
  if (kind) noteProjectListTrouble(kind);
  try {
    const notice = await projectListNotice();
    noteProjectListTrouble(kind ?? notice?.kind ?? null);
    if (!notice) return;
    const show = (failure?: string) => {
      const toast = projectListToast(notice, () => {
        void projectListNoticeReveal().catch((e) => show(String((e as Error)?.message ?? e)));
      });
      pushToast(failure ? { ...toast, details: `${toast.details}\n${failure}` } : toast);
    };
    show();
  } catch (e) {
    // The notice wasn't read: what the first read said stands.
    noteProjectListTrouble(kind);
    console.warn("project list notice failed:", e);
  }
}
