import { create } from "zustand";
import {
  ptyKill,
  ptyWrite,
  agentRunKill,
  onAgentRunStarted,
  onAgentRunDone,
  onPtyExit,
  onSwarmMailbox,
  onTryStopped,
  swarmGet,
  type AgentRun,
  type AgentStatus,
} from "../ipc";
import { useKanban } from "./kanbanStore";
import { useSettings } from "./settingsStore";
import {
  nextReadiness,
  type Readiness,
  type ReadinessKind,
} from "../lib/tileHeaderStatus";
import { exitStatus, isRestartableKind } from "../lib/tileExit";

/** 1.174.0 E2: the session in the tile has ended. */
function isEnded(status: TileStatus): boolean {
  return status === "done" || status === "crashed" || status === "error" || status === "killed";
}
import { outputRestartsSilence } from "../lib/attention";
import { noteTileInput } from "../lib/tileScreen";
import type { TryOf } from "../lib/tryTile";
import type { StartFailure } from "../lib/startFailure";
import { tryRunKey } from "../lib/tryPanel";
import { useTryStopped } from "./tryStoppedStore";
import type { TileQuestion } from "../lib/tileStatusLine";
import { pushErrorToast } from "../lib/errorToast";
import { isPtyGone } from "../lib/ptyGone";

const AUTO_CLOSE_GRACE_MS = 5000;
const TERMINAL_RUN_STATUSES = ["done", "error", "killed", "crashed"] as const;
/** v1.34.0: drop a `markOutput` stamp that lands within this window of the
 *  previous one. The PTY data event fires per chunk while streaming; an
 *  uncoalesced `set` per chunk would storm re-renders. 1s granularity is
 *  ample against the 10s silence threshold in src/lib/attention.ts. */
const STAMP_COALESCE_MS = 1000;
/** When each PTY's terminal was last resized, by ptyId — so the redraw that
 *  follows is not taken for output (`outputRestartsSilence`). Outside the
 *  state on purpose: a window drag resizes many times a second and nothing
 *  renders from it. */
const resizedAtByPty = new Map<string, number>();
const processedSwarmTerminations = new Set<string>();

export type TileKind =
  | "shell"
  | "claude"
  /** The Codex CLI running its own TUI inside a PTY. */
  | "codex"
  /** A structured session over `codex app-server` (see CodexSession). */
  | "codex-chat"
  | "agent-run";

export type TileStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "killed"
  | "crashed";

export interface Tile {
  id: string;
  workspaceId: string;
  kind: TileKind;
  /** PTY id, set once spawned. For agent-run tiles this is the run's ptyId. */
  ptyId: string | null;
  /** Present iff kind === 'agent-run'. */
  runId?: string;
  agentId?: string;
  /** Display label (agent name | "claude" | "shell N"). */
  label: string;
  /** Terminals block P2: a Claude/Codex tile's label was given by the
   *  member (never replaced by a title from the CLI's files), or set from
   *  them (`auto`). Absent: the default label. In memory; the record keeps
   *  the title (`terminal_sessions.rs`). */
  labelSource?: "auto" | "user";
  /** P2: the member's name, still to be passed to the CLI as `/rename` once
   *  its input line is empty. */
  pendingCliRename?: string;
  /** Challenger round 1: the member's name as they gave it (the label may
   *  carry " · 2" against another tile's) — what `/rename` passes on. */
  userName?: string;
  /** The CLI conversation the tile is in now, from the record (a restart
   *  of a resumed tile resumes this one). In memory. */
  cliSessionId?: string;
  /** P2: the CLI's input line held nothing at the last settled scan. */
  inputEmpty?: boolean;
  /** QoL 1.168: the input line holds text the member typed — not the CLI's
   *  dim placeholder or suggestion. In memory. */
  inputDraft?: boolean;
  /** 1.177.0 Compare: the settled screen shows a question or a numbered menu
   *  (the decision matcher or a choice menu in view) — which the header may
   *  call "Your turn". In memory. */
  menuInView?: boolean;
  /** 1.177.0 Compare (Codex TUI): a turn was seen on the tile's buffer at a
   *  settled scan. In memory. */
  codexTurnSeen?: boolean;
  /** 1.177.0 Compare (Codex TUI): the buffer went back to Codex's start
   *  screen after a turn was on it (`/new`) — sticky for the tile's life,
   *  before any file can say so. In memory, never persisted. */
  newConversation?: boolean;
  /** QoL 1.168 (D7, Windows walk): when the member last submitted a line
   *  into the tile from its terminal (their own keys; Plyloft's own writes,
   *  such as `/rename`, don't count). A turn finishes only after one: the
   *  CLI's own startup, a redraw or a resize repaint is no turn. In memory. */
  submittedAt?: number;
  /** Terminals block P3: what the session waits on the member for, read
   *  from its drawn screen at each settled scan; null when nothing. */
  question?: TileQuestion | null;
  questionResetsAt?: string | null;
  /** 1.174.0 E2 (Challenger 1): the session ended while it asked to trust
   *  the folder (answered No) — set by `markExited`, gone with a restart.
   *  Runtime only, never persisted. */
  endedOnTrust?: boolean;
  /** 1.176.0 R7: a Claude or Codex tile whose CLI didn't start
   *  (`lib/startFailure.ts`): the line under the header offers Repair. Gone
   *  with a restart (the new tile has none). Runtime only, never persisted. */
  startFailed?: StartFailure;
  cwd: string;
  /** What the tile is running. For shell/claude this is the cmd; for agent-run, the agent name. */
  command?: string;
  args?: string[];
  startedAt: number;
  status: TileStatus;
  /** When user closes a tile, we wait for the matching exit event before fully removing. */
  pendingClose: boolean;
  /** Set this from the tile UI to take over the grid. */
  expanded: boolean;
  /** v1.34.0: wall-clock ms of the most recent PTY data event. In-memory
   *  only — ephemeral, never persisted. Drives the "wants you" attention
   *  derivation (see src/lib/attention.ts). */
  lastOutputAt?: number;
  /** v1.34.0: true iff the last settled terminal tail matched Claude's idle
   *  prompt box. In-memory only; refines wants-you → asking-you. */
  promptBoxIdle?: boolean;
  /** v1.103.0: codex-chat only — true while a turn is in flight. In-memory
   *  only, like lastOutputAt. `status` keeps meaning "the process is alive"
   *  so `Close all completed` never sweeps a live session; this is what the
   *  status pill and the close confirmation read instead. */
  sessionBusy?: boolean;
  /** v1.103.0: codex-chat only — when the in-flight turn started. */
  sessionTurnStartedAt?: number;
  /** v1.105.0: codex-chat only — when the last turn completed and the
   *  session went back to waiting for you. Undefined until a turn has
   *  actually completed (a fresh session has nothing to read). Cleared when
   *  the next turn starts. Drives the "wants you" badge for chat tiles;
   *  in-memory only, like lastOutputAt. */
  sessionIdleSince?: number;
  /** v1.105.0: codex-chat only — true while Codex is blocked on an approval
   *  request. Attention is immediate regardless of turn state. */
  sessionApprovalPending?: boolean;
  /** #47: Ply's dictation in this tile — the header's mic indicator while
   *  recording, "Transcribing…" until the text lands. In-memory only. */
  dictation?: "recording" | "transcribing";
  /** GH #70: claude, codex and shell only — what the header chip reads
   *  ("Ready", or "Working for Ns" / "Running" for a shell), folded from Terminal's readiness scans
   *  by `markReadiness`. Undefined until the first scan. In-memory only. */
  readiness?: Readiness;
  /** UX-0.1: the exit code once a PTY tile's process has ended (`null` for a
   *  signal). In-memory only. */
  exitCode?: number | null;
  /** Try it (TI-2): shell only — this tile is the Try session of that card
   *  copy (`lib/trySession.ts`). In memory only, never persisted. */
  tryOf?: TryOf;
  /** 1.179.0 (C2): claude only — the Claude account it runs on (an
   *  `ai_accounts_list` id, or C3's `MAIN_ACCOUNT_ID`; null: Main). Set when it was asked for (the
   *  new-session menu, a resumed row's), then from each look at its title
   *  (`terminal_tile_title`); absent until either. A string is what its
   *  spawn asks for. In memory only, never persisted. */
  account?: string | null;
}

interface WorkspaceTileState {
  tiles: Tile[];
  /** When set, only this tile renders; siblings hidden via display:none. */
  expandedTileId: string | null;
  /** When the user clicks "open detail" on a tile. */
  detailTileId: string | null;
  /** QoL 1.168 (block 4): its last tile was closed in this launch — the
   *  empty page says "No sessions open". In memory. */
  emptied?: boolean;
}

/** Terminals block P4: a Claude or Codex tile that resumes a conversation
 *  (Resume…) — its CLI args (`--resume <id>`, `resume <id>`) and the name
 *  the conversation had. */
export interface CliTileOpts {
  args?: string[];
  label?: string;
  labelSource?: "auto" | "user";
  /** QoL 1.168 (block 4): the conversation it resumes, known at once (Continue
   *  works before the first look at its title). */
  cliSessionId?: string;
  /** 1.179.0 (C2): Claude only — the account to run on (the new-session
   *  menu's choice, or the one a resumed conversation is kept on). */
  account?: string | null;
}

const isCliKind = (kind: TileKind) => kind === "claude" || kind === "codex";

/** Challenger round 1: a resumed tile restarts in the conversation it is in
 *  now (it may have followed a `/clear` since), not the one it opened. */
function restartArgs(prev: Tile): string[] | undefined {
  const args = prev.args;
  if (!args || !prev.cliSessionId || !isCliKind(prev.kind)) return args;
  const at = args.indexOf(prev.kind === "claude" ? "--resume" : "resume");
  if (at < 0 || at + 1 >= args.length) return args;
  const next = [...args];
  next[at + 1] = prev.cliSessionId;
  return next;
}

/** QoL 1.168 (block 4, D2): how an ended Claude or Codex tile starts again.
 *  `continue` resumes the conversation it was in (`claude --resume <id>`,
 *  `codex resume <id>`); `fresh` starts a new one under the default name (a
 *  member's own name stays). Absent: as before — a shell, a Try session, or
 *  a tile opened by Resume… restarting in the conversation it is in now. */
export type RestartHow = "continue" | "fresh";

/** The args of a CLI tile that resumes conversation `id`. */
export function resumeArgs(kind: "claude" | "codex", id: string): string[] {
  return kind === "claude" ? ["--resume", id] : ["resume", id];
}

/** A label no other tile of the workspace has (`Title · 2`). */
function uniqueLabel(tiles: Tile[], label: string): string {
  const taken = new Set(tiles.map((t) => t.label));
  let out = label;
  for (let n = 2; taken.has(out); n += 1) out = `${label} · ${n}`;
  return out;
}

interface TileStore {
  byWorkspace: Record<string, WorkspaceTileState>;

  // queries
  getTileByPtyId: (ptyId: string) => Tile | null;
  getTileByRunId: (runId: string) => Tile | null;

  // mutations
  addShellTile: (
    workspaceId: string,
    cwd: string,
    /** Try it (TI-2): a card copy's Try session, under its own title. */
    opts?: { tryOf?: TryOf; label?: string },
  ) => Tile;
  addClaudeTile: (workspaceId: string, cwd: string, opts?: CliTileOpts) => Tile;
  addCodexTile: (workspaceId: string, cwd: string, opts?: CliTileOpts) => Tile;
  /** v1.103.0: a structured App Server session, not a PTY. */
  addCodexChatTile: (workspaceId: string, cwd: string) => Tile;
  addAgentRunTile: (run: AgentRun, agentName: string, cwd: string) => Tile;
  /**
   * Spawn a list of tiles in order — used by the optional tile-layout flow.
   * Claude tiles are skipped when `claudeAvailable` is false.
   * Returns the count of tiles actually spawned (may be < seeds.length).
   */
  addTilesFromTemplate: (
    workspaceId: string,
    cwd: string,
    seeds: ReadonlyArray<{ kind: "shell" | "claude" }>,
    claudeAvailable: boolean,
  ) => number;
  setPtyId: (tileId: string, ptyId: string) => void;
  setStatus: (tileId: string, status: TileStatus) => void;
  /**
   * UX-0.1: a PTY tile's process ended. The tile stays with its output:
   * `done` for exit code 0, `crashed` otherwise. Idempotent — Terminal and
   * the PTY-exit listener both report it; a later `null` never erases a code.
   */
  markExited: (tileId: string, code: number | null) => void;
  /** 1.176.0 R7: the tile's CLI didn't start (Terminal's rule). */
  markStartFailed: (tileId: string, failure: StartFailure) => void;
  /**
   * UX-0.1: start an ended shell, claude or codex tile again, in place: same
   * label, cwd and command, a new id so the grid mounts a fresh PTY.
   * QoL 1.168 (D2): `how` for a Claude/Codex tile (`RestartHow`). Returns
   * the new tile's id, or null when nothing restarted.
   */
  restartTile: (tileId: string, how?: RestartHow) => string | null;
  /**
   * v1.103.0: codex-chat only — mark a turn as in flight (or finished).
   * Never touches `status`: a chat session's process stays alive between
   * turns, and `status` is what tells the grid the process is alive.
   */
  setSessionBusy: (tileId: string, busy: boolean) => void;
  /**
   * v1.105.0: codex-chat only — mirror whether an approval request is
   * waiting on the user. Only `set`s on a real change.
   */
  setSessionApproval: (tileId: string, pending: boolean) => void;
  /**
   * v1.34.0: stamp the most recent PTY data event for a tile, keyed by
   * ptyId (Terminal knows ptyId, not tileId). Coalesces — a stamp landing
   * within STAMP_COALESCE_MS of the last is dropped without a `set`.
   */
  markOutput: (ptyId: string) => void;
  /** QoL 1.168 (D7): the member submitted a line into the tile. */
  markSubmitted: (ptyId: string) => void;
  /** The tile's terminal was just resized (window, tile or layout change):
   *  the TUI's redraw that follows does not restart the silence clock. */
  noteResize: (ptyId: string) => void;
  /**
   * v1.34.0: record whether the tile's settled terminal tail looks like
   * Claude's idle prompt box. Keyed by ptyId; only `set`s on a real change.
   */
  markPromptBox: (ptyId: string, idle: boolean, inputEmpty?: boolean, inputDraft?: boolean) => void;
  /** P2: a title from the CLI's files — kept unless the member named the
   *  tile; `user` when the member renamed it inside the CLI. A label another
   *  tile has gets ` · 2`. */
  setTitleLabel: (tileId: string, title: string, source: "auto" | "user") => void;
  /** P2: the member renamed the tile (after `renameTile` succeeded): their
   *  name wins from now on and is passed to the CLI when it can be. */
  markUserLabel: (tileId: string, label: string) => void;
  /** P3: what the tile's session waits on the member for (Terminal's scan). */
  markMenu: (ptyId: string, menu: boolean) => void;
  /** Codex's settled scan of its whole buffer: `turn` a turn is on it,
   *  `start` it is the start screen (`lib/tileScreen`). */
  markCodexScreen: (ptyId: string, turn: boolean, start: boolean) => void;
  markQuestion: (ptyId: string, question: TileQuestion | null, resetsAt?: string | null) => void;
  /** Challenger round 1: "Use the automatic name" — the member's name goes;
   *  the conversation's title comes back at the next look. */
  dropUserLabel: (tileId: string) => void;
  setCliSession: (tileId: string, cliSessionId: string) => void;
  /** 1.179.0 (C2): the Claude account a look at the tile's title found. */
  setTileAccount: (tileId: string, account: string | null) => void;
  /** P2: the pending `/rename`, taken once (it is typed now). */
  takePendingCliRename: (ptyId: string) => string | null;
  /**
   * GH #70: fold one readiness scan into the tile's header state (see
   * src/lib/tileHeaderStatus.ts). Keyed by ptyId; only `set`s when the
   * header would change.
   */
  markReadiness: (
    ptyId: string,
    kind: ReadinessKind,
    observed: { lastOutputAt: number; matcherIdle: boolean | null; waiting?: boolean; background?: boolean; running?: boolean },
  ) => void;
  /** #47: mirror a tile's dictation phase onto its header. Only `set`s on a
   *  real change. */
  setDictation: (tileId: string, phase: Tile["dictation"] | null) => void;
  setExpanded: (workspaceId: string, tileId: string | null) => void;
  setDetail: (workspaceId: string, tileId: string | null) => void;
  /**
   * Session-only rename for shell/claude tiles. Trims whitespace; rejects
   * empty and rejects duplicates against any OTHER tile in the same
   * workspace (shell+claude share the namespace; agent-run tiles are
   * included in the duplicate scan since their labels live in the same
   * visual namespace). Self-rename to the current label is a natural
   * success — the renaming tile is excluded by id.
   */
  renameTile: (
    workspaceId: string,
    tileId: string,
    newLabel: string,
  ) => { ok: true } | { ok: false; reason: "empty" | "duplicate" };
  closeTile: (tileId: string) => Promise<void>;
  /** Synchronously remove (used by exit listeners after pendingClose). */
  removeTile: (tileId: string) => void;
  reset: (workspaceId: string) => void;
}

let counter = 0;
const newTileId = () => `tile-${Date.now()}-${counter++}`;

function nextLabel(
  tiles: Tile[],
  kind: TileKind,
  fallback: string,
  /** What the user reads. Defaults to the kind; `codex-chat` reads better
   *  as "codex chat 1" than as its hyphenated internal name. */
  display: string = kind,
): string {
  if (kind === "agent-run") return fallback;
  // 1.174.0 walk G3b: the highest number in use + 1, never the count + 1 —
  // after codex 1 closes, codex 2 and codex 3 are joined by codex 4, not a
  // second codex 3.
  const prefix = `${display} `;
  let highest = 0;
  for (const t of tiles) {
    if (!t.label.startsWith(prefix)) continue;
    const rest = t.label.slice(prefix.length);
    if (/^\d+$/.test(rest)) highest = Math.max(highest, Number(rest));
  }
  return `${display} ${highest + 1}`;
}

function ensureWs(
  state: TileStore["byWorkspace"],
  wsId: string,
): WorkspaceTileState {
  return (
    state[wsId] ?? { tiles: [], expandedTileId: null, detailTileId: null }
  );
}

function statusFromAgent(s: AgentStatus): TileStatus {
  switch (s) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "killed":
      return "killed";
    default:
      return "running";
  }
}

export const useTiles = create<TileStore>((set, get) => ({
  byWorkspace: {},

  getTileByPtyId: (ptyId) => {
    const all = get().byWorkspace;
    for (const ws of Object.values(all)) {
      const found = ws.tiles.find((t) => t.ptyId === ptyId);
      if (found) return found;
    }
    return null;
  },

  getTileByRunId: (runId) => {
    const all = get().byWorkspace;
    for (const ws of Object.values(all)) {
      const found = ws.tiles.find((t) => t.runId === runId);
      if (found) return found;
    }
    return null;
  },

  addShellTile: (workspaceId, cwd, opts) => {
    const ws = ensureWs(get().byWorkspace, workspaceId);
    const tile: Tile = {
      id: newTileId(),
      workspaceId,
      kind: "shell",
      ptyId: null,
      label: opts?.label ?? nextLabel(ws.tiles, "shell", "shell"),
      cwd,
      // GH #68: stamped at creation, so changing the tile shell in Settings
      // starts new tiles in it and never respawns an open one.
      command: useSettings.getState().settings.shell.tileShell?.trim() || undefined,
      startedAt: Date.now(),
      status: "running",
      pendingClose: false,
      expanded: false,
      ...(opts?.tryOf ? { tryOf: { ...opts.tryOf } } : {}),
    };
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ensureWs(s.byWorkspace, workspaceId),
          tiles: [...ensureWs(s.byWorkspace, workspaceId).tiles, tile],
          // v1.59.0 (bug #4): collapse any maximized tile when a new one is
          // added, so the new tile is visible in the grid alongside the
          // running session instead of staying hidden behind the expanded one.
          expandedTileId: null,
        },
      },
    }));
    return tile;
  },

  addClaudeTile: (workspaceId, cwd, opts) => {
    const ws = ensureWs(get().byWorkspace, workspaceId);
    const named = opts?.label?.trim();
    const tile: Tile = {
      id: newTileId(),
      workspaceId,
      kind: "claude",
      ptyId: null,
      ...(opts?.account ? { account: opts.account } : {}),
      label: named ? uniqueLabel(ws.tiles, named) : nextLabel(ws.tiles, "claude", "claude"),
      ...(named ? { labelSource: opts?.labelSource ?? "auto" } : {}),
      // Challenger round 2: a member's name from the record is theirs here
      // too (a `/clear` passes it on).
      ...(named && opts?.labelSource === "user" ? { userName: named } : {}),
      ...(opts?.args?.length ? { args: opts.args } : {}),
      ...(opts?.cliSessionId ? { cliSessionId: opts.cliSessionId } : {}),
      cwd,
      startedAt: Date.now(),
      status: "running",
      pendingClose: false,
      expanded: false,
    };
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ensureWs(s.byWorkspace, workspaceId),
          tiles: [...ensureWs(s.byWorkspace, workspaceId).tiles, tile],
          // v1.59.0 (bug #4): collapse any maximized tile when a new one is
          // added, so the new tile is visible in the grid alongside the
          // running session instead of staying hidden behind the expanded one.
          expandedTileId: null,
        },
      },
    }));
    return tile;
  },

  addCodexTile: (workspaceId, cwd, opts) => {
    const ws = ensureWs(get().byWorkspace, workspaceId);
    const named = opts?.label?.trim();
    const tile: Tile = {
      id: newTileId(),
      workspaceId,
      kind: "codex",
      ptyId: null,
      label: named ? uniqueLabel(ws.tiles, named) : nextLabel(ws.tiles, "codex", "codex"),
      ...(named ? { labelSource: opts?.labelSource ?? "auto" } : {}),
      // Challenger round 2: a member's name from the record is theirs here
      // too (a `/clear` passes it on).
      ...(named && opts?.labelSource === "user" ? { userName: named } : {}),
      ...(opts?.args?.length ? { args: opts.args } : {}),
      ...(opts?.cliSessionId ? { cliSessionId: opts.cliSessionId } : {}),
      cwd,
      startedAt: Date.now(),
      status: "running",
      pendingClose: false,
      expanded: false,
    };
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ensureWs(s.byWorkspace, workspaceId),
          tiles: [...ensureWs(s.byWorkspace, workspaceId).tiles, tile],
          // v1.59.0 (bug #4): collapse any maximized tile when a new one is
          // added, so the new tile is visible in the grid alongside the
          // running session instead of staying hidden behind the expanded one.
          expandedTileId: null,
        },
      },
    }));
    return tile;
  },

  addCodexChatTile: (workspaceId, cwd) => {
    const ws = ensureWs(get().byWorkspace, workspaceId);
    const tile: Tile = {
      id: newTileId(),
      workspaceId,
      kind: "codex-chat",
      ptyId: null,
      label: nextLabel(ws.tiles, "codex-chat", "codex chat", "codex chat"),
      cwd,
      startedAt: Date.now(),
      status: "running",
      pendingClose: false,
      expanded: false,
    };
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ensureWs(s.byWorkspace, workspaceId),
          tiles: [...ensureWs(s.byWorkspace, workspaceId).tiles, tile],
          // v1.59.0 (bug #4): collapse any maximized tile when a new one is
          // added, so the new tile is visible in the grid alongside the
          // running session instead of staying hidden behind the expanded one.
          expandedTileId: null,
        },
      },
    }));
    return tile;
  },

  addTilesFromTemplate: (workspaceId, cwd, seeds, claudeAvailable) => {
    let spawned = 0;
    for (const seed of seeds) {
      if (seed.kind === "shell") {
        get().addShellTile(workspaceId, cwd);
        spawned++;
      } else if (seed.kind === "claude" && claudeAvailable) {
        get().addClaudeTile(workspaceId, cwd);
        spawned++;
      }
      // claude seed when claude unavailable — silently skipped
    }
    return spawned;
  },

  addAgentRunTile: (run, agentName, cwd) => {
    // Don't add a duplicate if we already have a tile for this run
    const existing = get().getTileByRunId(run.id);
    if (existing) return existing;
    const tile: Tile = {
      id: newTileId(),
      workspaceId: run.workspaceId,
      kind: "agent-run",
      ptyId: run.ptyId ?? null,
      runId: run.id,
      agentId: run.agentId,
      label: agentName || run.agentName || "agent",
      cwd,
      startedAt: run.startedAt,
      status: statusFromAgent(run.status),
      pendingClose: false,
      expanded: false,
    };
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [run.workspaceId]: {
          ...ensureWs(s.byWorkspace, run.workspaceId),
          tiles: [
            ...ensureWs(s.byWorkspace, run.workspaceId).tiles,
            tile,
          ],
          // v1.77.0: same rule as the v1.59 fix on the add*Tile actions —
          // collapse any maximized tile so the new run's tile is visible in
          // the grid instead of spawning hidden behind the expanded one.
          expandedTileId: null,
        },
      },
    }));
    return tile;
  },

  setPtyId: (tileId, ptyId) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx >= 0) {
          const updated = [...ws.tiles];
          updated[idx] = { ...updated[idx], ptyId };
          next[wsId] = { ...ws, tiles: updated };
          break;
        }
      }
      return { byWorkspace: next };
    }),

  setStatus: (tileId, status) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx >= 0) {
          const updated = [...ws.tiles];
          updated[idx] = { ...updated[idx], status };
          next[wsId] = { ...ws, tiles: updated };
          break;
        }
      }
      return { byWorkspace: next };
    }),

  markExited: (tileId, code) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const prev = ws.tiles[idx];
        const exitCode = code ?? prev.exitCode ?? null;
        const status = exitStatus(exitCode);
        if (prev.status === status && prev.exitCode === exitCode) return s;
        const updated = [...ws.tiles];
        // E2: what it ended on, kept past any later scan.
        const endedOnTrust = isEnded(prev.status) ? Boolean(prev.endedOnTrust) : prev.question === "trust";
        updated[idx] = { ...prev, status, exitCode, endedOnTrust };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  markStartFailed: (tileId, failure) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const prev = ws.tiles[idx];
        if (prev.startFailed?.tool === failure.tool && prev.startFailed.cause === failure.cause) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...prev, startFailed: failure };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  restartTile: (tileId, how) => {
    let restarted: string | null = null;
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const prev = ws.tiles[idx];
        if (!isRestartableKind(prev.kind)) return s;
        if (prev.status !== "done" && prev.status !== "crashed") return s;
        const cli = prev.kind === "claude" || prev.kind === "codex" ? prev.kind : null;
        // QoL 1.168 (D2): Continue needs the conversation's id.
        const going = cli && how === "continue" && prev.cliSessionId ? "continue" : cli && how === "fresh" ? "fresh" : null;
        const userNamed = prev.labelSource === "user" && !!prev.userName;
        const others = ws.tiles.filter((t) => t.id !== tileId);
        const label =
          going === "fresh" && !userNamed ? uniqueLabel(others, nextLabel(others, prev.kind, prev.kind)) : prev.label;
        const args =
          going === "continue" && cli
            ? resumeArgs(cli, prev.cliSessionId!)
            : going === "fresh"
              ? undefined
              : restartArgs(prev);
        const keepsConversation = going !== "fresh";
        const fresh: Tile = {
          id: newTileId(),
          workspaceId: prev.workspaceId,
          kind: prev.kind,
          ptyId: null,
          label,
          cwd: prev.cwd,
          command: prev.command,
          ...(args ? { args } : {}),
          // Challenger round 1: a member's name goes with the restart, to the
          // CLI too (`/rename`) and, from the next look, the record. A fresh
          // start drops the conversation's own title (D2).
          ...(prev.labelSource && (keepsConversation || userNamed) ? { labelSource: prev.labelSource } : {}),
          ...(userNamed
            ? { userName: prev.userName, ...(isCliKind(prev.kind) ? { pendingCliRename: prev.userName } : {}) }
            : {}),
          ...(prev.cliSessionId && keepsConversation ? { cliSessionId: prev.cliSessionId } : {}),
          // 1.179.0 (C2): a conversation goes on where it is kept; a fresh
          // start is a new session, on the account new sessions start on.
          ...(prev.kind === "claude" && keepsConversation && prev.account !== undefined ? { account: prev.account } : {}),
          startedAt: Date.now(),
          status: "running",
          pendingClose: false,
          expanded: prev.expanded,
          // TI-2: a restarted Try session is still that copy's.
          ...(prev.tryOf ? { tryOf: prev.tryOf } : {}),
        };
        const updated = [...ws.tiles];
        updated[idx] = fresh;
        next[wsId] = {
          ...ws,
          tiles: updated,
          expandedTileId:
            ws.expandedTileId === tileId ? fresh.id : ws.expandedTileId,
          detailTileId: ws.detailTileId === tileId ? null : ws.detailTileId,
        };
        restarted = fresh.id;
        return { byWorkspace: next };
      }
      return s;
    });
    return restarted;
  },

  setSessionBusy: (tileId, busy) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        if ((tile.sessionBusy ?? false) === busy) return s;
        const updated = [...ws.tiles];
        const now = Date.now();
        updated[idx] = {
          ...tile,
          sessionBusy: busy,
          sessionTurnStartedAt: busy ? now : undefined,
          // v1.105.0: a turn that just finished hands the floor back to the
          // user; the next turn starting takes it away again.
          sessionIdleSince: busy ? undefined : now,
        };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  setSessionApproval: (tileId, pending) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        if ((tile.sessionApprovalPending ?? false) === pending) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, sessionApprovalPending: pending };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  markOutput: (ptyId) =>
    set((s) => {
      const now = Date.now();
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        // Coalesce: a stamp within STAMP_COALESCE_MS of the last is a no-op.
        if (
          tile.lastOutputAt != null &&
          now - tile.lastOutputAt < STAMP_COALESCE_MS
        ) {
          return s;
        }
        // A resize's redraw is not activity: a waiting session stays waiting.
        if (
          !outputRestartsSilence(
            { lastOutputAt: tile.lastOutputAt, resizedAt: resizedAtByPty.get(ptyId) },
            now,
          )
        ) {
          return s;
        }
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, lastOutputAt: now };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  markSubmitted: (ptyId) =>
    set((s) => {
      const now = Date.now();
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const updated = [...ws.tiles];
        updated[idx] = { ...ws.tiles[idx], submittedAt: now };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  noteResize: (ptyId) => {
    resizedAtByPty.set(ptyId, Date.now());
  },

  markPromptBox: (ptyId, idle, inputEmpty, inputDraft) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        const empty = inputEmpty ?? tile.inputEmpty;
        const draft = inputDraft ?? tile.inputDraft;
        if (tile.promptBoxIdle === idle && tile.inputEmpty === empty && tile.inputDraft === draft) return s; // unchanged — no set
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, promptBoxIdle: idle, inputEmpty: empty, inputDraft: draft };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  markReadiness: (ptyId, kind, observed) =>
    set((s) => {
      const now = Date.now();
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        // Not judged yet: working since the tile started.
        const prev = tile.readiness ?? {
          lastOutputAt: tile.startedAt,
          matcherIdle: false,
          leftReadyAt: tile.startedAt,
        };
        const readiness = nextReadiness(kind, prev, observed, now);
        if (readiness === tile.readiness) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, readiness };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  setDictation: (tileId, phase) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        if (tile.dictation === (phase ?? undefined)) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, dictation: phase ?? undefined };
        next[wsId] = { ...ws, tiles: updated };
        return { byWorkspace: next };
      }
      return s;
    }),

  setExpanded: (workspaceId, tileId) =>
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ensureWs(s.byWorkspace, workspaceId),
          expandedTileId: tileId,
        },
      },
    })),

  setDetail: (workspaceId, tileId) =>
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ensureWs(s.byWorkspace, workspaceId),
          detailTileId: tileId,
        },
      },
    })),

  setTitleLabel: (tileId, title, source) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        if (tile.labelSource === "user" && source !== "user") return s;
        const taken = new Set(ws.tiles.filter((t) => t.id !== tileId).map((t) => t.label));
        let label = title.trim();
        if (!label) return s;
        for (let n = 2; taken.has(label); n += 1) label = `${title.trim()} · ${n}`;
        if (tile.label === label && tile.labelSource === source) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, label, labelSource: source, ...(source === "user" ? { userName: title.trim() } : {}) };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  markUserLabel: (tileId, label) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        const cli = tile.kind === "claude" || tile.kind === "codex";
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, labelSource: "user", userName: label, ...(cli ? { pendingCliRename: label } : {}) };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  dropUserLabel: (tileId) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0) continue;
        const { labelSource: _l, userName: _u, pendingCliRename: _p, ...rest } = ws.tiles[idx];
        // Challenger round 2: the default name at once ("claude 2"); the
        // conversation's own title replaces it at the next look.
        const others = ws.tiles.filter((t) => t.id !== tileId);
        const updated = [...ws.tiles];
        updated[idx] = { ...rest, label: uniqueLabel(others, nextLabel(others, rest.kind, rest.kind)) };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  setCliSession: (tileId, cliSessionId) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0 || ws.tiles[idx].cliSessionId === cliSessionId) continue;
        const updated = [...ws.tiles];
        updated[idx] = { ...ws.tiles[idx], cliSessionId };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  setTileAccount: (tileId, account) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.id === tileId);
        if (idx < 0 || ws.tiles[idx].account === account) continue;
        const updated = [...ws.tiles];
        updated[idx] = { ...ws.tiles[idx], account };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  markMenu: (ptyId, menu) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        if ((ws.tiles[idx].menuInView ?? false) === menu) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...ws.tiles[idx], menuInView: menu };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),
  markCodexScreen: (ptyId, turn, start) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const t = ws.tiles[idx];
        const patch: Partial<Tile> = {};
        if (turn && !t.codexTurnSeen) patch.codexTurnSeen = true;
        if (!turn && start && t.codexTurnSeen && !t.newConversation) patch.newConversation = true;
        if (Object.keys(patch).length === 0) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...t, ...patch };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),
  markQuestion: (ptyId, question, resetsAt) =>
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        // 1.174.0 E2 (Challenger 1): an ended session asks nothing any more;
        // a scan that settles after the exit changes nothing.
        if (isEnded(tile.status)) return s;
        const at = question === "usageLimit" ? (resetsAt ?? null) : null;
        if ((tile.question ?? null) === question && (tile.questionResetsAt ?? null) === at) return s;
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, question, questionResetsAt: at };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    }),

  takePendingCliRename: (ptyId) => {
    let taken: string | null = null;
    set((s) => {
      for (const [wsId, ws] of Object.entries(s.byWorkspace)) {
        const idx = ws.tiles.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) continue;
        const tile = ws.tiles[idx];
        if (!tile.pendingCliRename) return s;
        taken = tile.pendingCliRename;
        const updated = [...ws.tiles];
        updated[idx] = { ...tile, pendingCliRename: undefined };
        return { byWorkspace: { ...s.byWorkspace, [wsId]: { ...ws, tiles: updated } } };
      }
      return s;
    });
    return taken;
  },

  renameTile: (workspaceId, tileId, newLabel) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return { ok: false, reason: "empty" };
    const ws = get().byWorkspace[workspaceId];
    if (!ws) return { ok: false, reason: "empty" };
    const collision = ws.tiles.some(
      (t) => t.id !== tileId && t.label === trimmed,
    );
    if (collision) return { ok: false, reason: "duplicate" };
    set((s) => {
      const cur = s.byWorkspace[workspaceId];
      if (!cur) return s;
      const idx = cur.tiles.findIndex((t) => t.id === tileId);
      if (idx < 0) return s;
      const updated = [...cur.tiles];
      updated[idx] = { ...updated[idx], label: trimmed };
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...cur, tiles: updated },
        },
      };
    });
    return { ok: true };
  },

  closeTile: async (tileId) => {
    const tile = (() => {
      for (const ws of Object.values(get().byWorkspace)) {
        const found = ws.tiles.find((t) => t.id === tileId);
        if (found) return found;
      }
      return null;
    })();
    if (!tile) return;

    // Mark as pending so the UI shows it's closing.
    set((s) => {
      const ws = s.byWorkspace[tile.workspaceId];
      if (!ws) return s;
      const updated = ws.tiles.map((t) =>
        t.id === tileId ? { ...t, pendingClose: true } : t,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [tile.workspaceId]: { ...ws, tiles: updated },
        },
      };
    });

    try {
      if (tile.kind === "agent-run" && tile.runId && tile.status === "running") {
        await agentRunKill(tile.runId);
        // run-done listener will finalize removal
        return;
      }
      // UX-0.1: an ended PTY tile has no process left to kill, and no exit
      // event is coming; remove it now.
      const ended =
        isRestartableKind(tile.kind) &&
        (tile.status === "done" || tile.status === "crashed");
      if (tile.ptyId && !ended) {
        await ptyKill(tile.ptyId);
        // pty-exit listener finalizes removal for shell/claude tiles
        return;
      }
    } catch (e) {
      console.error("closeTile failed:", e);
      // 1.176.2 (E1, S-12): the tile goes below as if it closed; its program may not have.
      if (!isPtyGone(e)) pushErrorToast("Plyloft couldn't stop the terminal's program", e);
    }
    // Fallback: no PTY known yet — remove now
    get().removeTile(tileId);
  },

  removeTile: (tileId) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const [wsId, ws] of Object.entries(next)) {
        if (!ws.tiles.some((t) => t.id === tileId)) continue;
        const tiles = ws.tiles.filter((t) => t.id !== tileId);
        const expandedTileId =
          ws.expandedTileId === tileId ? null : ws.expandedTileId;
        const detailTileId =
          ws.detailTileId === tileId ? null : ws.detailTileId;
        next[wsId] = { ...ws, tiles, expandedTileId, detailTileId, ...(tiles.length === 0 ? { emptied: true } : {}) };
        break;
      }
      return { byWorkspace: next };
    }),

  reset: (workspaceId) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),
}));

/** Shell-side helper: write data to the tile's PTY. */
export async function writeToTilePty(
  tileId: string,
  data: Uint8Array,
): Promise<void> {
  const tile = (() => {
    for (const ws of Object.values(useTiles.getState().byWorkspace)) {
      const found = ws.tiles.find((t) => t.id === tileId);
      if (found) return found;
    }
    return null;
  })();
  if (!tile || !tile.ptyId) return;
  // Round 8 (review M2): what goes through here is the member's (a dropped
  // path, a command typed for them): it counts as their typing.
  noteTileInput(tile.id);
  await ptyWrite(tile.ptyId, data);
}

function isCardDrivenRun(workspaceId: string, runId: string): boolean {
  const ws = useKanban.getState().byWorkspace[workspaceId];
  if (!ws) return false;
  return ws.cards.some((c) => c.linkedRunId === runId);
}

function scheduleAutoClose(tileId: string): void {
  setTimeout(() => {
    const ws = useTiles.getState().byWorkspace;
    let tile: Tile | null = null;
    for (const w of Object.values(ws)) {
      const found = w.tiles.find((t) => t.id === tileId);
      if (found) {
        tile = found;
        break;
      }
    }
    if (!tile) return;
    if (tile.pendingClose) return;
    if (
      !(TERMINAL_RUN_STATUSES as readonly string[]).includes(tile.status)
    ) {
      return;
    }
    useTiles.getState().removeTile(tile.id);
  }, AUTO_CLOSE_GRACE_MS);
}

let subscriptionsStarted = false;

/**
 * Wire the tileStore to backend lifecycle events. Call once at app boot.
 */
export async function startTileSubscriptions(
  resolveAgent: (
    runId: string,
    agentId: string,
    workspaceId: string,
  ) => Promise<{ run: AgentRun; agentName: string; cwd: string } | null>,
) {
  if (subscriptionsStarted) return;
  subscriptionsStarted = true;

  await onAgentRunStarted(async (e) => {
    try {
      const resolved = await resolveAgent(e.runId, e.agentId, e.workspaceId);
      if (!resolved) return;
      useTiles
        .getState()
        .addAgentRunTile(resolved.run, resolved.agentName, resolved.cwd);
    } catch (err) {
      console.error("addAgentRunTile failed:", err);
    }
  });

  await onAgentRunDone((e) => {
    const tile = useTiles.getState().getTileByRunId(e.runId);
    if (!tile) return;
    useTiles.getState().setStatus(tile.id, statusFromAgent(e.status));
    // Was the user closing this tile?
    if (tile.pendingClose) {
      useTiles.getState().removeTile(tile.id);
      return;
    }
    // Auto-close path for card-driven single-agent runs. Swarm legs are
    // handled by the onSwarmMailbox terminate listener below — skip them
    // here so we don't double-schedule (and so a card whose swarm is
    // mid-flight doesn't close its scout tile when scout finishes).
    if (e.swarmId) return;
    if (!useSettings.getState().settings.behavior.autoCloseFinishedRunTiles) {
      return;
    }
    if (!isCardDrivenRun(tile.workspaceId, e.runId)) return;
    scheduleAutoClose(tile.id);
  });

  await onSwarmMailbox((entry) => {
    if (entry.kind !== "terminate") return;
    if (processedSwarmTerminations.has(entry.swarmId)) return;
    processedSwarmTerminations.add(entry.swarmId);
    if (!useSettings.getState().settings.behavior.autoCloseFinishedRunTiles) {
      return;
    }
    void swarmGet(entry.swarmId).then((swarm) => {
      if (!swarm) return;
      // §6.5 terminal-status set: done | failed | aborted | timed_out |
      // max_iter all close their tiles. running / suspended are non-terminal
      // and the listener short-circuits at entry.kind above anyway.
      for (const runId of swarm.runIds) {
        const tile = useTiles.getState().getTileByRunId(runId);
        if (!tile) continue;
        scheduleAutoClose(tile.id);
      }
    });
  });

  await onPtyExit((id, code) => {
    // Agent-run tiles are managed via run-done; only reap shell/claude tiles here.
    const tile = useTiles.getState().getTileByPtyId(id);
    if (!tile) return;
    if (tile.kind === "agent-run") return;
    if (tile.pendingClose) {
      useTiles.getState().removeTile(tile.id);
    } else {
      // UX-0.1: the process ended on its own (`exit`, a crash, a Claude
      // session that finished). The tile stays with its output and says how
      // it ended; the person restarts or closes it.
      useTiles.getState().markExited(tile.id, code);
    }
  });

  // Try it (TI-2): Plyloft stopped a card's Try sessions before removing its
  // copy. Their tiles go — a Restart there would start in a folder that is
  // gone. The card says why (`lib/tryTile.ts::tryStoppedWords`).
  await onTryStopped((e) => {
    // TI-4: the card's Try it panel says why (a ship's words).
    if (e.words) useTryStopped.getState().note(tryRunKey(e.workspaceId, e.cardId, e.lane), e.words);
    for (const ptyId of e.ptyIds) {
      const tile = useTiles.getState().getTileByPtyId(ptyId);
      if (tile?.tryOf) useTiles.getState().removeTile(tile.id);
    }
  });
}
