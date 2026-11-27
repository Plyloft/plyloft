/**
 * 1.173.0 A2: copies without a card — the shape the backend's
 * `copies::CopyView` takes, with every field a later build may leave out
 * defaulted (`copies.json` is default-tolerant on both sides).
 */
import type { BaseSource, BranchCleanup, WorktreeSetupRecord } from "../ipc";

/** `active`: its folder is there to work in; `trashed`: in the worktree
 *  Trash for 7 days. A state a later build writes is passed through. */
export type ProjectCopyState = "active" | "trashed" | (string & {});

export interface CopyPr {
  number: number;
  url: string;
  /** A3: `open`, `merged` or `closed`, as GitHub last said; absent = open. */
  state?: "open" | "merged" | "closed" | (string & {}) | null;
  headSha?: string | null;
  openedAt?: number | null;
  /** A3: why its branch stayed on GitHub after the merge. */
  branchKept?: string | null;
}

/** `copies::CopyEntry` (one row of `projects/<ws>/copies.json`). */
export interface CopyEntry {
  id: string;
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
  baseCommit: string;
  baseSource?: BaseSource | null;
  baseNote?: string | null;
  createdAt: number;
  state: ProjectCopyState;
  trashedAt?: number | null;
  trashEntry?: string | null;
  /** A3: the card *Make it a card* gave the copy to. */
  cardId?: string | null;
  /** A3: the pull request *Open a pull request* opened. */
  pr?: CopyPr | null;
  /** What the sheet chose to open in it. */
  open?: "claude" | "codex" | "shell" | (string & {}) | null;
  setup?: WorktreeSetupRecord | null;
  branchCleanup?: BranchCleanup | null;
  /** A3: its port block (`worktree_ports`), handed out on first use. */
  portBase?: number | null;
}

export interface ChangedFiles {
  count: number;
  /** The first five, repository-relative. */
  files: string[];
  /** Git couldn't be read: the count is unknown. */
  unreadable?: boolean;
}

/** `copies::CopyView`: the entry plus what can be seen of it now. */
export interface CopyView extends CopyEntry {
  changed: ChangedFiles;
  /** Live shell, Claude or Codex tiles whose folder is in the copy. */
  terminals: number;
  /** The folder is there. */
  present: boolean;
  /** In the Trash and can still come back. */
  restorable: boolean;
  /** A3: commits since its start that exist nowhere else (Throw away asks). */
  saved: number;
}

/** `copies::StartPoint`: where a new copy would start, read without fetching. */
export interface CopyStartPoint {
  /** Empty when the workspace isn't set up. */
  target: string;
  /** origin is a GitHub repository. */
  fromGitHub: boolean;
  /** When this computer last read the branch from origin (unix ms). */
  readAt?: number | null;
  /** WALKFIX-3: the branch is gone from GitHub — C5's sentence. Absent: it's there. */
  gone?: string | null;
  /** 1.174.0 E2 (P20): files changed in the project folder, none of them in
   *  a copy. Absent when it couldn't be read (or an older build): no row. */
  projectChanged?: number | null;
  /** Steps saved on this computer's branch that origin's doesn't have (no
   *  fetch), counted only when the two diverged: the copy then starts from
   *  origin's and leaves them out. Absent without both refs. */
  localAhead?: number | null;
  /** 1.174.0 E2 (Challenger 1): this computer's branch is strictly ahead of
   *  origin's, so the copy starts from it, with those steps. False from an
   *  older build (`normalizeCopyStartPoint`). */
  startsLocal?: boolean;
  /** 1.174.0 walk G3b: Claude already trusts the project folder, so a copy
   *  inside it isn't asked about. Absent when unknown. */
  claudeTrusted?: boolean | null;
}

/** A start point as the backend sent it, `startsLocal` defaulted. */
export function normalizeCopyStartPoint(raw: Partial<CopyStartPoint> | null | undefined): CopyStartPoint | null {
  if (!raw) return null;
  return { ...raw, target: raw.target ?? "", fromGitHub: raw.fromGitHub ?? false, startsLocal: raw.startsLocal ?? false };
}

/** An entry as the backend sent it, every field a later or earlier build
 *  may leave out filled with its default. */
export function normalizeCopyEntry(raw: Partial<CopyEntry> & { id: string }): CopyEntry {
  return {
    ...raw,
    id: raw.id,
    name: raw.name || raw.id,
    branch: raw.branch ?? "",
    path: raw.path ?? "",
    baseBranch: raw.baseBranch ?? "",
    baseCommit: raw.baseCommit ?? "",
    createdAt: raw.createdAt ?? 0,
    state: raw.state ?? "active",
  };
}

/** A row as the backend sent it, defaulted like [`normalizeCopyEntry`]. */
export function normalizeCopyView(raw: Partial<CopyView> & { id: string }): CopyView {
  const changed = raw.changed ?? { count: 0, files: [] };
  return {
    ...raw,
    ...normalizeCopyEntry(raw),
    changed: { count: changed.count ?? 0, files: changed.files ?? [], unreadable: changed.unreadable ?? false },
    terminals: raw.terminals ?? 0,
    present: raw.present ?? false,
    restorable: raw.restorable ?? false,
    saved: raw.saved ?? 0,
  };
}
