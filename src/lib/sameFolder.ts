// 1.173.0 (A4): the words of a tile's "Same folder as <other>" chip and its
// popover. Two Claude/Codex terminals in one folder (`two-provider-tiles`),
// or a terminal beside an unattended writer, can change the same files
// without seeing each other's edits; the chip says so and offers a copy.
//
// Pure: no React, no store. Copy in docs/onboarding/USER_GUIDE.md and the
// mockup ~/ply-build/next-1173/mockups/copies.html, scene 1.

/** What names a terminal here: its title, else its AI. */
export interface FolderTileName {
  kind: string;
  label: string;
  /** Present when the title came from the conversation or the member. */
  labelSource?: "auto" | "user";
}

export type FolderPeerProvider = "system" | "shell" | "claude" | "codex";

const PROVIDER_NAME: Record<FolderPeerProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  shell: "a terminal",
  system: "another session",
};

/** The AI (or shell) a tile with its default label ("codex 1") is named by. */
const KIND_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  "codex-chat": "Codex chat",
  shell: "Shell",
};

/** A tile's name in these sentences: the title the conversation or the
 *  member gave it, else its AI ("Codex", not "codex 1"). An agent run keeps
 *  its agent's name. */
export function folderTileName(tile: FolderTileName): string {
  const label = tile.label.trim();
  if (tile.labelSource && label) return label;
  const kind = KIND_NAME[tile.kind];
  if (kind) return kind;
  if (!label) return "this terminal";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** 1.174.0 E1 (T2 b): two tiles of one AI, both with their default
 *  labels, are told apart by those labels ("codex 2"), not both "Codex". */
function sameAiDefaults(a: FolderTileName, b: FolderTileName): boolean {
  return (
    a.kind === b.kind &&
    Boolean(KIND_NAME[a.kind]) &&
    !a.labelSource &&
    !b.labelSource &&
    Boolean(a.label.trim()) &&
    Boolean(b.label.trim())
  );
}

/** The peer's name: its tile's, or, when it has no tile here (a card's
 *  session, an agent run), its AI. Beside a tile of the same AI (`self`),
 *  its label. */
export function folderPeerName(
  tile: FolderTileName | null | undefined,
  provider: FolderPeerProvider | null | undefined,
  self?: FolderTileName | null,
): string {
  if (tile && self && sameAiDefaults(tile, self)) return tile.label.trim();
  if (tile) return folderTileName(tile);
  return PROVIDER_NAME[provider ?? "system"];
}

/** This tile's own name in these sentences: its label when a peer of the
 *  same AI is beside it ("codex 1"), else as `folderTileName`. */
export function folderSelfName(self: FolderTileName, peerTiles: ReadonlyArray<FolderTileName | null>): string {
  if (peerTiles.some((t) => t && sameAiDefaults(t, self))) return self.label.trim();
  return folderTileName(self);
}

/** 1.174.0 E4 (P21): the chip's short form in a tile of 480 px or less; the
 *  full name stays its tooltip and screen-reader label. */
export const SAME_FOLDER_SHORT = "Same folder";

/** The chip, which is also its screen-reader label. */
export function sameFolderChip(peers: string[]): string {
  const [first, ...rest] = peers;
  if (!first) return "Same folder";
  return rest.length === 0
    ? `Same folder as ${first}`
    : `Same folder as ${first} and ${rest.length} more`;
}

/** The popover's bold line. */
export function sameFolderHeadline(self: string, peers: string[]): string {
  const [first, ...rest] = peers;
  if (!first) return `${self} shares this folder.`;
  if (rest.length > 0) {
    return `${self} and ${peers.length} other terminals are working in the same folder.`;
  }
  if (first === self) return `Both ${self} terminals are working in the same folder.`;
  return `${self} and ${first} are working in the same folder.`;
}

/** Where a new copy starts, as far as this Mac's own refs say (no fetch):
 *  the workspace's target branch, else origin's default branch; and whether
 *  origin is on GitHub. A2 starts a copy from origin's branch when there is
 *  an origin and from the local branch when there isn't (LocalNoRemote). */
export interface CopyStart {
  targetBranch?: string | null;
  defaultBranch?: string | null;
  /** origin's `owner/repo` when it is on GitHub. */
  githubRepo?: string | null;
  /** 1.174.0 E1-7 (`copy_start_point`): steps this Mac's branch has that
   *  origin's doesn't, counted only when the two diverged — the copy then
   *  leaves them out. */
  localAhead?: number | null;
  /** This Mac's branch is strictly ahead of origin's: the copy starts from
   *  it, with those steps. */
  startsLocal?: boolean;
}

/** "main on GitHub" only when origin is GitHub; "main" otherwise; never a
 *  bare "GitHub". */
export function copyStartWords(start: CopyStart | null | undefined): string {
  const branch = start?.targetBranch?.trim() || start?.defaultBranch?.trim() || "";
  const github = Boolean(start?.githubRepo?.trim());
  const name = branch || "the project's main branch";
  if (start?.startsLocal) return `${name} on this Mac`;
  return github ? `${name} on GitHub` : name;
}

const SAME_FILES = "They can change the same files without seeing each other's edits.";

/** 1.174.0 E1 (P18, D7 b): what changed in the folder since both opened —
 *  Plyloft can't tell who wrote it, so it says only that it changed. */
export interface FolderChanged {
  count: number;
  /** File names, most recent first. */
  names: readonly string[];
}

function namesWords(names: readonly string[], count: number): string {
  const shown = names.slice(0, 2);
  const more = count - shown.length;
  if (shown.length === 0) return "";
  if (more <= 0) return shown.join(", ");
  return `${shown.join(", ")} and ${more} more`;
}

/** "2 files changed here since both opened: a.tsx, b.ts." — 1.174.1 P6
 *  (T6): "since they opened" with three or more tiles in the folder. */
export function sameFolderChanged(changed: FolderChanged, tiles = 2): string {
  const n = changed.count;
  const since = tiles >= 3 ? "since they opened" : "since both opened";
  const head = n === 1 ? `1 file changed here ${since}` : `${n} files changed here ${since}`;
  const names = namesWords(changed.names, n);
  return names ? `${head}: ${names}.` : `${head}.`;
}

/** The popover's sentences under it: the risk (with what changed, when
 *  known), and — with a copy possible (a git project) — where a copy
 *  starts and what it leaves out. */
export function sameFolderBody(
  start: CopyStart | null | undefined,
  copyPossible = true,
  changed?: FolderChanged | null,
  /** The tiles in the folder, this one included. */
  tiles = 2,
): { risk: string; copy: string | null } {
  const risk = changed && changed.count > 0 ? `${sameFolderChanged(changed, tiles)} ${SAME_FILES}` : SAME_FILES;
  if (!copyPossible) return { risk, copy: null };
  // E1-7: said only when it is true — origin's branch and this Mac's have
  // diverged, so the copy starts from GitHub's and leaves this Mac's steps out.
  const leftOut = Boolean(start?.githubRepo?.trim()) && !start?.startsLocal && (start?.localAhead ?? 0) > 0;
  const copy =
    `Start the next session in a copy of its own instead. It starts from ${copyStartWords(start)}` +
    (leftOut ? "; changes not yet on GitHub aren't in it." : ".");
  return { risk, copy };
}

export const SAME_FOLDER_COPY = "Start a new one in a copy";

export function sameFolderShow(peer: string): string {
  return `Show ${peer}`;
}

/** Under the actions: how the warning ends. */
export function sameFolderHint(self: string): string {
  return `Then close ${self} here: its conversation stays in Resume…`;
}

/** 1.174.0 E1 (P18, 1c): after "Start a new one in a copy", the toast with
 *  the one press that clears the warning. */
export function copyMadeToastWords(
  made: string,
  self: string,
  peer: string,
): { title: string; body: string; action: string } {
  return {
    title: `${made} is in its own copy`,
    body: `${self} still shares the folder with ${peer}. Its conversation stays in Resume…`,
    action: `Close ${self}`,
  };
}
