// A card start or a Ship in a workspace that was never set up is refused by
// the backend (`project_config::not_set_up`) in words that name the page and
// the button that set it up. This finds that refusal, so the surface that
// shows it can offer the one way out: `Set up`, which opens that page on its
// Re-detect row. Pure (no React, no stores), so node runs it
// (`src/lib/projectSetup.test.ts`).

/** `project_config::SET_UP_TODO`, word for word (the test reads it there). */
export const SET_UP_TODO =
  "Open Settings › Cards › Building and checking and press Re-detect";
/** 1.174.0 (DS9): `project_config::SET_UP_TODO_1173` — the words refusals
 *  already on cards carry; still found. */
export const SET_UP_TODO_1173 =
  "Open Settings › This repository › Build and release and press Re-detect";

/** The way out, named by its outcome. */
export const SET_UP_LABEL = "Set up";

/** Where `Set up` lands: the Settings entry, and the row it marks. */
export const SET_UP_PAGE = "build-release";
export const SET_UP_ROW = "Read the repository again";

/** The same refusal in a shared repository this account can't write: there
 *  Re-detect is not a button, so there is no `Set up` — only who can. */
export const SET_UP_NEEDS_WRITE = "someone with write access has to press Re-detect";

function textOf(error: unknown): string {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? "");
}

/** The sentence for `worktree_setup::project_folder_problem`'s refusal (U32).
 *  The backend knows the board: only a GitHub Issues board has a claim to avoid,
 *  so only its refusal says none was made. */
export function projectFolderWords(e: unknown): string {
  const text = String((e as Error | null)?.message ?? e);
  const claim = /nothing was claimed/.test(text) ? ", so nothing was claimed" : "";
  return /isn't a git repository/.test(text)
    ? `This project's folder isn't a git repository${claim}. Put its repository back, or move the folder aside.`
    : `This project's folder isn't where Plyloft left it${claim}. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.`;
}

/** U32: refused before a start, and before a GitHub Issues board's claim. */
export function projectFolderGone(e: unknown): boolean {
  return /^This project's folder isn't /.test(String((e as Error | null)?.message ?? e));
}

/** True when `error` is the backend's "isn't set up yet" refusal. */
export function needsSetUp(error: unknown): boolean {
  const text = textOf(error);
  return text.includes(SET_UP_TODO) || text.includes(SET_UP_TODO_1173);
}

/** True when it is, and only someone with write access can set it up. */
export function needsSetUpByWriter(error: unknown): boolean {
  return textOf(error).includes(SET_UP_NEEDS_WRITE);
}

/** 1.174.4: the branch a start refused because it's nowhere (`worktrees.rs`
 *  `resolve_base_commit`), or null for any other refusal. */
export function missingBranchOf(error: unknown): string | null {
  return /branch `([^`]+)` is neither on origin nor in this repository/.exec(textOf(error))?.[1] ?? null;
}

// ── n16: a start refused for no config sets it up and goes on ──────────────

/** True when a start refused with `error` may set the repository up on its
 *  own and try once more: the writable refusal only. Shared settings this
 *  account can't write keep their message (`needsSetUpByWriter`). */
export function canSetUpOnStart(error: unknown): boolean {
  return needsSetUp(error) && !needsSetUpByWriter(error);
}

/** The info toast after a start set the repository up on its own and
 *  then started (its action, Change, opens Shipping on Cards go to). */
export function setUpOnStartNotice(name: string, branch: string): { title: string; body: string } {
  return {
    title: `“${name}” is set up for builds`,
    body: `Plyloft builds from ${branch}. Change it in Settings › Cards › Shipping.`,
  };
}

/** 1.171.0 walk fix (Challenger 1): said when Add a project set a project
 *  up from a branch a start wouldn't have taken on its own (a feature
 *  branch, the one the folder is on) — with Change, never silently. */
export function setUpOnAddNotice(name: string, branch: string): { title: string; body: string } {
  return {
    title: `“${name}” is set up for builds`,
    body: `Cards start from ${branch} and are merged back into it. Change it in Settings › Cards › Shipping.`,
  };
}

/** n16: whether a start may set the repository up on its own with
 *  `branch` (the branch Setup's step 9 proposes: HEAD's, else `main`). Only
 *  when it is plainly the one to build from: with an origin, origin's own
 *  default (`refs/remotes/origin/HEAD`, read locally) — none recorded (a
 *  repository pushed rather than cloned) is not safe; with no origin,
 *  `main`, `master` or the repository's only branch. Anything else (a
 *  feature branch checked out) is the person's call: the start keeps its
 *  Set up. */
export function autoSetUpBranchIsSafe(
  branch: string,
  branches: readonly string[],
  origin: { hasOrigin: boolean; defaultBranch: string | null },
  /** 1.171.0 walk fix: the person has just added this folder (Add a
   *  project). With no origin, the branch it is on is the one they added —
   *  the one Add a project's "Save my current work first" saved on, and
   *  the one "Cards only see what's saved" means. With an origin that
   *  names no default (pushed, not cloned), `main`, `master` or the only
   *  branch, as without one. An origin's own default still decides. */
  justAdded = false,
): boolean {
  if (!branch) return false;
  const plain = branch === "main" || branch === "master" || (branches.length === 1 && branches[0] === branch);
  if (origin.hasOrigin) {
    if (origin.defaultBranch != null) return branch === origin.defaultBranch;
    return justAdded && plain && branches.includes(branch);
  }
  if (justAdded && branches.includes(branch)) return true;
  return plain;
}

/** n16: run a start; if it is refused because the repository isn't set up
 *  (the writable refusal), `setUp` writes the detected config once and the
 *  start runs once more. `setUp` resolves what to say once that retry went
 *  through, or `null` (nothing to propose, the save failed) — or throws:
 *  the first refusal is then thrown as it was. Never more than one set-up
 *  and one retry. */
export async function startSettingUpOnce<T>(
  run: () => Promise<T>,
  setUp: () => Promise<(() => void) | null>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!canSetUpOnStart(e)) throw e;
    const announce = await setUp().catch(() => null);
    if (!announce) throw e;
    const result = await run();
    announce();
    return result;
  }
}
