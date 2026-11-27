// Tile: a grid pane (shell/claude terminal or agent-run) with header, status pill, expand/close, drop target.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as TerminalView } from "./Terminal";
import { isRestartableKind } from "../lib/tileExit";
import { isWindows } from "../lib/platform";
import { closeQuestion } from "../lib/tileClose";
import { handOverFrom, onTileCloseRequest, tileCloseAsks, toggleExpandTile } from "../store/tileActions";
import { STARTING, STARTING_MS, tileStatusLine, type TileStatusLine } from "../lib/tileStatusLine";
import { Icon } from "./ux";
import "./terminals.css";
import { AgentRunView } from "./AgentRunView";
import { useTiles, writeToTilePty } from "../store/tileStore";
import { useAgents } from "../store/agentStore";
import { useSwarms } from "../store/swarmStore";
import { useWorkspaces } from "../store/workspaceStore";
import {
  EMPTY_COORDINATION_STATUS,
  useCoordination,
} from "../store/coordinationStore";
import { usePageVisible } from "../hooks/usePageVisible";
import { headerTurnsReadyAt } from "../lib/tileHeaderStatus";
import { visibleModalOpen } from "../lib/visibleModal";
import { shellQuoteJoin } from "../lib/shellQuote";
import {
  TILE_DROP_KINDS,
  acceptsAttr,
  acceptsDrag,
  asDropTarget,
  dragPayloadFor,
  nestedZoneOwnsDrop,
} from "../lib/dropGuard";
import { codexChatRefusalWords, dragFileCount } from "../lib/terminalDropWords";
import { dictationModeFor } from "../lib/spaceHold";
import { ConfirmDialog } from "./ConfirmDialog";
import { CodexSession } from "./CodexSession";
import type { Tile as TileT, TileKind } from "../store/tileStore";
import { resolveAccent } from "../lib/repositoryAccent";
import type { AgentRun, ShellEnvInfo } from "../ipc";
import { fallbackTileShell, tileShellArgs } from "../lib/tileShell";
import type { TryOf } from "../lib/tryTile";
import { restartTrySession } from "../lib/trySession";
import { setupIsOpen } from "../store/setupStore";
import { SkillDriftChip } from "./SkillDriftNotice";
import { terminalTileAutoName, terminalTileRename, terminalTileTitle } from "../ipc";
import { lookSoon } from "../store/tileTitles";
import { canContinue, restartForTheme, restartSession } from "../store/tileRestart";
import { ThemeRestartLine } from "./ThemeRestartLine";
import { TileStartFailedLine } from "./TileStartFailedLine";
import { FolderVersionLine } from "./FolderVersionLine";
import { SameFolderChip } from "./SameFolderChip";
import { CopyTileMark } from "./CopyTileMark";
import { CARD_TRUST_TILE_LINE, copyTrustRefusedLine, copyTrustTileLine, isCardFolder } from "../lib/copyWords";
import { useKanban } from "../store/kanbanStore";
import { copyForCwd, useWorkspaceCopies } from "../store/copiesStore";
import { pushErrorToast } from "../lib/errorToast";
import { useClaudeAccountRows } from "../store/claudeAccountsStore";
import { shownAccountName, tileAccountTitle, tileAccountWords } from "../lib/claudeAccountNames";

type Props = {
  tile: TileT;
  env: ShellEnvInfo | null;
  workspaceCwd: string;
  hidden: boolean;
  /** 1.174.0 E8 (T16): the last tile takes the columns left in its row
   *  (`lastTileSpan`), so the grid leaves no empty cell. */
  span?: number;
  /** 1.179.0 Compare with two pairs: this tile is one of a pair's two. */
  comparePair?: TileComparePair | null;
  /** 1.179.0: Auto layout's visual place (CSS `order`), so a pair's two
   *  tiles sit side by side; the DOM order, and the terminal, stay. */
  order?: number;
};

/** 1.179.0: a paired tile's marks — the pair's dot, and its name for the
 *  project folder's pair (a copy's tiles already say "Copy · name") — and
 *  the quiet outline while its pair is pointed at. */
export interface TileComparePair {
  slot: "a" | "b";
  name: string;
  inProject: boolean;
  linked: boolean;
  onHover: (slot: "a" | "b" | null) => void;
}

/** UX-8.2: the mono kind glyph at the header's start. */
const NO_ARGS: string[] = [];

const KIND_GLYPH: Record<TileKind, string> = {
  shell: "$",
  claude: "✦",
  codex: "◆",
  "codex-chat": "◈",
  "agent-run": "⚙",
};

const KIND_NAME: Record<TileKind, string> = {
  shell: "Shell",
  claude: "Claude",
  codex: "Codex",
  "codex-chat": "Codex chat",
  "agent-run": "Agent run",
};

// Spelled out so a search for the class finds it.
const STATUS_CLASS: Record<TileStatusLine["tone"], string> = {
  running: "tile-status tile-status--running",
  ready: "tile-status tile-status--ready",
  pending: "tile-status tile-status--pending",
  done: "tile-status tile-status--done",
  exited: "tile-status tile-status--exited",
  failed: "tile-status tile-status--failed",
  crashed: "tile-status tile-status--crashed",
  ended: "tile-status tile-status--ended",
  quiet: "tile-status tile-status--quiet",
  asks: "tile-status tile-status--asks",
};

/** The status on the header's right: a dot (when the state has one) and words.
 *  1.174.0 E4 (P21): a question also carries its short form ("Asks: trust"),
 *  which a narrow tile (≤ 480 px, `@container tile`) shows instead; the full
 *  words stay in the tooltip and, visually hidden, what a screen reader
 *  reads (the short form is aria-hidden). */
export function TileStatus({ line }: { line: TileStatusLine }) {
  const dot =
    line.tone === "running" ||
    line.tone === "done" ||
    line.tone === "failed" ||
    line.tone === "crashed" ||
    line.tone === "quiet" ||
    // QoL 1.168 (block 10, A6): a question has its filled amber dot too.
    line.tone === "asks";
  return (
    <span className={STATUS_CLASS[line.tone]} role="status" title={line.title ?? line.text}>
      {dot && (
        <span
          className={line.live ? "tile-status-dot tile-status-dot--live" : "tile-status-dot"}
          aria-hidden="true"
        />
      )}
      {line.short ? (
        <>
          <span className="tile-status-full">{line.text}</span>
          <span className="tile-status-short" aria-hidden="true">
            {line.short}
          </span>
        </>
      ) : (
        line.text
      )}
    </span>
  );
}

export function Tile({ tile, env, workspaceCwd, hidden, span, comparePair = null, order }: Props) {
  const setPtyId = useTiles((s) => s.setPtyId);
  const closeTile = useTiles((s) => s.closeTile);
  const setExpanded = useTiles((s) => s.setExpanded);
  const renameTile = useTiles((s) => s.renameTile);
  // v1.4.0 (L3): pull the workspace's accent color (v0.5.0 field) so the
  // expanded tile can border-color itself with it. No new persisted concept.
  const accentColor = resolveAccent(
    useWorkspaces(
      (s) => s.workspaces.find((w) => w.id === tile.workspaceId)?.accentColor ?? null,
    ),
  );
  const expandedTileId = useTiles(
    (s) => s.byWorkspace[tile.workspaceId]?.expandedTileId ?? null,
  );
  const coordination = useCoordination(
    (s) => s.byWorkspace[tile.workspaceId]?.status ?? EMPTY_COORDINATION_STATUS,
  );

  // Agent run lookup (live status pulled from agentStore, not just the snapshot)
  const liveRun = useAgents((s) => {
    if (tile.kind !== "agent-run" || !tile.runId) return null;
    const ws = s.byWorkspace[tile.workspaceId];
    return ws?.runs.find((r) => r.id === tile.runId) ?? null;
  });

  // v1.0 R1: when this tile is part of a swarm, surface a chip in the header
  // and rewrite the close-confirm copy to warn that closing aborts the swarm.
  // 1.179.0 (C2): a Claude tile names its account, only with more than one.
  const accountRows = useClaudeAccountRows();
  const accountName =
    tile.kind === "claude" && tile.account !== undefined ? shownAccountName(accountRows, tile.account) : null;
  const swarm = useSwarms((s) => {
    const swarmId = liveRun?.swarmId ?? null;
    if (!swarmId) return null;
    return s.byWorkspace[tile.workspaceId]?.swarms.find((sw) => sw.id === swarmId) ?? null;
  });
  const coordinationSession = coordination.activeSessions.find((session) =>
    tile.ptyId
      ? session.ptyId === tile.ptyId
      : Boolean(tile.runId && session.runId === tile.runId),
  );
  const coordinationWarnings = coordinationSession
    ? coordination.liveWarnings.filter(
        (warning) => warning.sessionId === coordinationSession.id,
      )
    : [];
  const [, force] = useState(0);

  // 1Hz tick for the playful status pill — only when running
  // v1.63.0: and only while the window is visible (the resume flip itself
  // re-renders, so the elapsed text recomputes immediately on return).
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    if (
      tile.status !== "running" &&
      tile.status !== "pending" &&
      !(liveRun?.status === "running" || liveRun?.status === "pending")
    ) {
      return;
    }
    // v1.103.0 (D7): a chat session between turns shows a static "Ready".
    // Its process is alive — status stays "running" — but there is no
    // elapsed time worth re-rendering once a second.
    if (tile.kind === "codex-chat" && !tile.sessionBusy) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [
    tile.status,
    tile.kind,
    tile.sessionBusy,
    liveRun?.status,
    pageVisible,
  ]);

  // 1.169.0 (B3 walk): the header turns Ready by time alone (quiet for
  // READY_QUIET_MS after an idle verdict), with no store update to redraw
  // it. The 1 Hz tick stops when the page reads as hidden, so a one-shot
  // redraw at that moment keeps a stale "Working" from outliving the turn
  // (a return to the page redraws as well, `usePageVisible`).
  const readyAt = headerTurnsReadyAt(tile.readiness);
  useEffect(() => {
    if (readyAt == null) return;
    const wait = readyAt - Date.now();
    if (wait < 0) return;
    const id = window.setTimeout(() => force((n) => n + 1), wait + 50);
    return () => window.clearTimeout(id);
  }, [readyAt]);

  const now = Date.now();
  const effectiveStatus =
    tile.kind === "agent-run" && liveRun ? liveRun.status : tile.status;
  // UX-8.2: the header's right-hand words and their tone (lib/tileStatusLine).
  const statusLine = tileStatusLine({
    kind: tile.kind,
    status: effectiveStatus,
    exitCode: tile.exitCode ?? null,
    startFailed: !!tile.startFailed,
    // An agent-run tile counts its run: from its start to its end once it
    // ended, so "Done · 7s" stays 7s.
    startedAt: tile.kind === "agent-run" && liveRun ? liveRun.startedAt : tile.startedAt,
    endedAt: tile.kind === "agent-run" && liveRun ? liveRun.endedAt : null,
    sessionBusy: tile.sessionBusy,
    sessionTurnStartedAt: tile.sessionTurnStartedAt,
    readiness: tile.readiness,
    lastOutputAt: tile.lastOutputAt,
    question: tile.question ?? null,
    questionResetsAt: tile.questionResetsAt ?? null,
    windows: isWindows(),
    now,
  });
  // 1.172.0 B3 (walk 2026-10-27): "Starting…" ends by time alone
  // (`STARTING_MS`), with no store update to redraw it. The 1 Hz tick stops
  // while the page reads as hidden (a window behind others), so a tile that
  // came up at its prompt then kept "Starting…" until the next keystroke. A
  // one-shot redraw at that moment lets the header say what its scans found.
  const startingEndsAt =
    statusLine.text === STARTING && (tile.kind === "claude" || tile.kind === "codex")
      ? tile.startedAt + STARTING_MS
      : null;
  useEffect(() => {
    if (startingEndsAt == null) return;
    const wait = startingEndsAt - Date.now();
    if (wait < 0) return;
    const id = window.setTimeout(() => force((n) => n + 1), wait + 50);
    return () => window.clearTimeout(id);
  }, [startingEndsAt]);

  // UX-0.1: an ended PTY tile offers Restart.
  const exited =
    isRestartableKind(tile.kind) &&
    (tile.status === "done" || tile.status === "crashed");

  // 1.176.0 R3: a Claude or Codex tile names its CLI and the backend runs its
  // own checked path for it (`cli_fresh`). Not the window's `claudePath`: a
  // fresh snapshot (Look again, a spawn that looked again) changed the
  // command and restarted every open tile, and a path from an older snapshot
  // than the backend's started the tile as a plain shell.
  const cmd = useMemo(() => {
    if (tile.kind === "shell") return tile.command ?? env?.shell ?? fallbackTileShell();
    if (tile.kind === "claude") return "claude";
    if (tile.kind === "codex") return "codex";
    return "";
  }, [tile.kind, tile.command, env?.shell]);

  const args = useMemo(() => {
    if (tile.kind === "shell") return tileShellArgs(cmd);
    // Terminals block P4: a tile opened by Resume… resumes its conversation.
    if (tile.kind === "claude" || tile.kind === "codex") return tile.args ?? NO_ARGS;
    return NO_ARGS;
  }, [tile.kind, cmd, tile.args]);

  const onPtyId = useCallback(
    (ptyId: string) => {
      setPtyId(tile.id, ptyId);
    },
    [setPtyId, tile.id],
  );

  // HTML5 drop target — accept file paths from FilesPanel and inject as text
  const dropRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Structured Codex has its own composer. It intentionally does not accept
    // shell-quoted PTY input because there is no opaque terminal behind it.
    // The `codex` tile is a real PTY again (v1.103.0) and keeps its drops.
    if (tile.kind === "codex-chat") return;
    const node = dropRef.current;
    if (!node) return;

    function onDragOver(e: DragEvent) {
      // GH #138: the same question this tile's `data-drop-accepts` marker
      // asks. A Finder file also carries text/plain, and the old types check
      // claimed it here — putting the copy cursor and the highlight back on
      // a drop the shell's guard had just refused, for a payload this
      // listener does not read.
      if (!acceptsDrag(e, TILE_DROP_KINDS)) return;
      if (e.dataTransfer) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        node?.classList.add("tile-drop-active");
      }
    }
    function onDragLeave() {
      node?.classList.remove("tile-drop-active");
    }
    async function onDrop(e: DragEvent) {
      node?.classList.remove("tile-drop-active");
      if (!acceptsDrag(e, TILE_DROP_KINDS)) return;
      // GH #138 F13: the terminal pane inside this tile is a drop zone of
      // its own and writes the path itself. This listener runs first, while
      // the event bubbles, so without standing down the path was typed
      // twice — the pane's `stopPropagation` comes too late to undo it.
      // The tile header and the rest of the tile are still this one's.
      if (nestedZoneOwnsDrop(asDropTarget(e.target), node)) return;
      if (!e.dataTransfer) return;
      const path =
        e.dataTransfer.getData("application/x-atelier-path") ||
        e.dataTransfer.getData("text/plain");
      if (!path) return;
      e.preventDefault();
      const text = shellQuoteJoin([path]) + " ";
      const enc = new TextEncoder();
      try {
        await writeToTilePty(tile.id, enc.encode(text));
      } catch (err) {
        console.error("tile drop write failed:", err);
        pushErrorToast("The file's path wasn't typed into the terminal", err);
      }
    }

    node.addEventListener("dragover", onDragOver);
    node.addEventListener("dragleave", onDragLeave);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("dragover", onDragOver);
      node.removeEventListener("dragleave", onDragLeave);
      node.removeEventListener("drop", onDrop);
    };
  }, [tile.id, tile.kind]);

  // 1.174.0 E6 (P23): a Codex chat takes no files, and says so over itself
  // for the whole time a file is dragged over it — where the file can go
  // instead. The shell's guard has already refused the drop (the tile is a
  // zone that accepts nothing) and keeps its generic toast down here.
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (tile.kind !== "codex-chat") return;
    const node = dropRef.current;
    if (!node) return;
    let depth = 0;
    let stale = 0;
    function show(words: string | null) {
      if (stale !== 0) {
        window.clearTimeout(stale);
        stale = 0;
      }
      setRefusal((now) => (now === words ? now : words));
      node?.classList.toggle("tile-drop-refusing", words !== null);
      // A drag that leaves without a dragleave stops sending dragover.
      if (words !== null) stale = window.setTimeout(() => show(null), 1000);
    }
    function onOver(e: DragEvent) {
      const payload = dragPayloadFor(e);
      if (!payload.files && !payload.path) return;
      show(codexChatRefusalWords(payload.files ? dragFileCount(e.dataTransfer) : 1));
    }
    function onEnter(e: DragEvent) {
      depth += 1;
      onOver(e);
    }
    function onLeave() {
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        show(null);
      }
    }
    function onDrop() {
      depth = 0;
      show(null);
    }
    node.addEventListener("dragenter", onEnter);
    node.addEventListener("dragover", onOver);
    node.addEventListener("dragleave", onLeave);
    node.addEventListener("drop", onDrop);
    return () => {
      if (stale !== 0) window.clearTimeout(stale);
      node.removeEventListener("dragenter", onEnter);
      node.removeEventListener("dragover", onOver);
      node.removeEventListener("dragleave", onLeave);
      node.removeEventListener("drop", onDrop);
    };
  }, [tile.kind]);

  const isExpanded = expandedTileId === tile.id;

  // Esc collapses the expanded tile (only fire when this tile is the expanded one)
  useEffect(() => {
    if (!isExpanded) return;
    function onEsc(e: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      if (e.key === "Escape") {
        // Only handle if no input/textarea has focus and no modal is open
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        if (visibleModalOpen()) return;
        setExpanded(tile.workspaceId, null);
      }
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [isExpanded, setExpanded, tile.workspaceId]);

  function onExpandClick(e: React.MouseEvent) {
    e.stopPropagation();
    // QoL 1.168 (A1): the keyboard stays in the tile either way.
    toggleExpandTile(tile.workspaceId, tile.id);
  }

  // v1.0.x: native `window.confirm()` is silently auto-accepted by Tauri 2's
  // WKWebView (no dialog renders). Use the project's React modal instead so
  // the destructive close warning actually surfaces.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const renameable =
    tile.kind === "shell" ||
    tile.kind === "claude" ||
    tile.kind === "codex" ||
    tile.kind === "codex-chat";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<"duplicate" | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  function beginRename(e: React.MouseEvent) {
    e.stopPropagation();
    if (!renameable) return;
    setDraft(tile.label);
    setRenameError(null);
    setEditing(true);
  }

  /** The member's name goes, here and in the record; the conversation's own
   *  title comes back at the next look (a name given inside the CLI with
   *  `/rename` is the CLI's and stays). */
  function takeAutomaticName() {
    useTiles.getState().dropUserLabel(tile.id);
    if (tile.ptyId) {
      const ptyId = tile.ptyId;
      // The conversation's current title at once, when the CLI has one.
      void terminalTileAutoName(ptyId)
        .then(() => terminalTileTitle(ptyId))
        .then((got) => {
          if (got?.title) useTiles.getState().setTitleLabel(tile.id, got.title, got.titleSource === "user" ? "user" : "auto");
          else lookSoon(ptyId);
        })
        .catch(() => lookSoon(ptyId));
    }
  }

  function cancelRename() {
    setEditing(false);
    setRenameError(null);
  }

  function commitRename() {
    const result = renameTile(tile.workspaceId, tile.id, draft);
    if (result.ok) {
      setEditing(false);
      setRenameError(null);
      // Terminals block P2: the member's name wins over the conversation's
      // title from now on, is kept in the sessions record, and goes to the
      // CLI too (`/rename`, once its input line is empty).
      if (draft.trim() && draft.trim() !== tile.label && (tile.kind === "claude" || tile.kind === "codex")) {
        useTiles.getState().markUserLabel(tile.id, draft.trim());
        if (tile.ptyId) void terminalTileRename(tile.ptyId, draft.trim()).catch((err) =>
          pushErrorToast("The new name wasn't passed to the session", err),
        );
      }
      return;
    }
    if (result.reason === "empty") {
      setEditing(false);
      setRenameError(null);
      return;
    }
    setRenameError("duplicate");
    queueMicrotask(() => renameInputRef.current?.focus());
  }

  // QoL 1.168 (D4): closing asks only when something would be lost — a
  // session working or waiting on the member, a shell running a command
  // (`closeAsks`). v1.103.0 (D7) already spared an idle Codex chat. The
  // keyboard's ⌘⇧W comes the same way and hands the keyboard on after.
  const fromKeyboard = useRef(false);
  async function requestClose(viaKeyboard: boolean) {
    fromKeyboard.current = viaKeyboard;
    const latest = useTiles.getState().byWorkspace[tile.workspaceId]?.tiles.find((t) => t.id === tile.id) ?? tile;
    if (latest.pendingClose) return;
    if (await tileCloseAsks(latest, effectiveStatus)) {
      setCloseConfirmOpen(true);
      return;
    }
    performClose();
  }

  function onCloseClick(e: React.MouseEvent) {
    e.stopPropagation();
    void requestClose(false);
  }

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(
    () => onTileCloseRequest((id) => {
      if (id === tile.id) void requestCloseRef.current(true);
    }),
    [tile.id],
  );

  function performClose() {
    setCloseConfirmOpen(false);
    handOverFrom(tile.workspaceId, tile.id, { focus: fromKeyboard.current });
    closeTile(tile.id).catch((e) => console.error("closeTile failed", e));
  }

  // v1.4.0 (L3): when expanded, color the tile's outer border with the
  // workspace accent so the user sees which workspace this expanded tile
  // belongs to (relevant when the right-tab strip is hidden). Hidden /
  // non-expanded tiles keep the default border.
  const expandedBorderStyle =
    isExpanded && accentColor ? { borderColor: accentColor } : undefined;

  return (
    <div
      ref={dropRef}
      data-tile-id={tile.id}
      data-tile-workspace={tile.workspaceId}
      className={`tile tile-kind-${tile.kind}${tile.pendingClose ? " pending-close" : ""}${isExpanded ? " expanded" : ""}${statusLine.tone === "asks" ? " tile--asks" : ""}${comparePair?.linked ? " tile--pair-linked" : ""}`}
      data-compare-pair={comparePair?.slot}
      onMouseEnter={comparePair ? () => comparePair.onHover(comparePair.slot) : undefined}
      onMouseLeave={comparePair ? () => comparePair.onHover(null) : undefined}
      // GH #138: the tile's own listener writes a dropped path into the PTY
      // (external files are the terminal pane's, inside). 1.174.0 E6: a
      // `codex-chat` tile is a zone that takes nothing and refuses in its own
      // words (`refusingZoneKind`), not the shell's generic ones.
      data-drop-zone={tile.kind === "codex-chat" ? "codex-chat" : "tile"}
      data-drop-accepts={
        tile.kind === "codex-chat" ? undefined : acceptsAttr(TILE_DROP_KINDS)
      }
      data-drop-refusal={tile.kind === "codex-chat" ? "codex-chat" : undefined}
      style={
        hidden
          ? { display: "none" }
          : span && span > 1
            ? { ...expandedBorderStyle, gridColumn: `span ${span}`, ...(order !== undefined ? { order } : {}) }
            : order !== undefined
              ? { ...expandedBorderStyle, order }
              : expandedBorderStyle
      }
    >
      <div className="tile-header">
        {comparePair && <span className={comparePair.slot === "a" ? "ux-pair-dot ux-pair-dot--a" : "ux-pair-dot ux-pair-dot--b"} aria-hidden="true" />}
        <span
          className={`tile-kind-icon kind-${tile.kind}`}
          title={KIND_NAME[tile.kind]}
          aria-hidden="true"
        >
          {KIND_GLYPH[tile.kind]}
        </span>
        {editing && renameable ? (
          <>
            <input
              ref={renameInputRef}
              className={`tile-edit-input${renameError === "duplicate" ? " has-error" : ""}`}
              value={draft}
              aria-label="Tile name"
              autoFocus
              onChange={(e) => {
                setDraft(e.target.value);
                if (renameError) setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelRename();
                }
              }}
              onBlur={() => {
                if (editing) commitRename();
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {renameError === "duplicate" && (
              <span className="tile-edit-hint">Name taken</span>
            )}
          </>
        ) : (
          <>
            <span className="tile-label" title={`${KIND_NAME[tile.kind]} in ${tile.cwd}`}>
              {tile.label}
            </span>
            {renameable && (
              <button
                type="button"
                className="tile-icon-btn tile-on-hover"
                onClick={beginRename}
                title="Rename"
                aria-label="Rename tile"
              >
                <Icon name="rename" size="sm" />
              </button>
            )}
            {/* Challenger round 1 (owner): back to the conversation's own name. */}
            {(tile.kind === "claude" || tile.kind === "codex") && tile.labelSource === "user" && (
              <button
                type="button"
                className="tile-icon-btn tile-on-hover"
                onClick={(e) => {
                  e.stopPropagation();
                  takeAutomaticName();
                }}
                title="Use the automatic name"
                aria-label="Use the automatic name"
              >
                <Icon name="undo" size="sm" />
              </button>
            )}
          </>
        )}
        {accountName && (
          <span className="tile-chip" title={tileAccountTitle(accountName)} data-ply-tile-account="">
            <span className="tile-chip-text">{tileAccountWords(accountName)}</span>
          </span>
        )}
        {/* 1.173.0 (A3): a terminal in a copy says so, and its setup. */}
        <CopyTileMark tile={tile} />
        {/* 1.179.0: the project folder's pair is named as a copy's is. */}
        {comparePair?.inProject && <span className="tile-copy-mark tile-pair-mark">{comparePair.name}</span>}
        {swarm && (
          <span className="tile-chip" title={`Part of a multi-AI run: ${swarm.goal}`}>
            <span className="tile-chip-text">Multi-AI</span>
          </span>
        )}
        {(tile.kind === "claude" || tile.kind === "codex") && tile.ptyId && (
          <SkillDriftChip ptyId={tile.ptyId} />
        )}
        {/* 1.173.0 (A4): a terminal sharing its folder says with whom, and
            offers a new terminal in a copy. */}
        {coordinationWarnings.length > 0 && (
          <SameFolderChip
            tile={tile}
            session={coordinationSession ?? null}
            warnings={coordinationWarnings}
            sessions={coordination.activeSessions}
            hidden={hidden}
          />
        )}
        {tile.dictation && (
          <span
            className="tile-dictation"
            role="status"
            title={
              tile.dictation === "recording"
                ? "Dictating — release Space to transcribe, Esc to cancel"
                : "Transcribing with whisper.cpp — Esc to cancel"
            }
          >
            {tile.dictation === "recording" ? (
              <>
                <span className="tile-dictation-dot" aria-hidden="true" />
                Listening
              </>
            ) : (
              "Transcribing…"
            )}
          </span>
        )}
        <TileStatus line={statusLine} />
        <div className="tile-actions">
          {exited && canContinue(tile) && !tile.tryOf && (
            <>
              {/* QoL 1.168 (block 4, D2): Continue picks the conversation up
                  again; Start fresh is the other way. */}
              <button
                type="button"
                className="tile-restart"
                onClick={(e) => {
                  e.stopPropagation();
                  void restartSession(tile, "continue");
                }}
                title={`Pick this ${KIND_NAME[tile.kind]} conversation up where it ended`}
                aria-label="Continue"
              >
                <Icon name="restart" size="sm" />
                <span className="tile-restart-word">Continue</span>
              </button>
              <button
                type="button"
                className="tile-restart tile-restart--quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  void restartSession(tile, "fresh");
                }}
                title={`A new ${KIND_NAME[tile.kind]} conversation in this folder`}
                aria-label="Start fresh"
              >
                <Icon name="add" size="sm" />
                <span className="tile-restart-word">Start fresh</span>
              </button>
            </>
          )}
          {exited && !(canContinue(tile) && !tile.tryOf) && (
            <button
              type="button"
              className="tile-restart"
              onClick={(e) => {
                e.stopPropagation();
                // TI-2: a Try session starts its command again, and never
                // in a copy that was removed.
                if (tile.tryOf) {
                  void restartTrySession(tile.id).catch((err) =>
                    console.error("restart Try session failed:", err),
                  );
                } else {
                  void restartSession(tile);
                }
              }}
              title={tile.kind === "shell" ? "Start this shell again" : `A new ${KIND_NAME[tile.kind]} conversation in this folder`}
              aria-label="Restart"
            >
              <Icon name="restart" size="sm" />
              <span className="tile-restart-word">Restart</span>
            </button>
          )}
          <button
            type="button"
            className="tile-icon-btn tile-on-hover"
            onClick={onExpandClick}
            aria-label={isExpanded ? "Restore tile" : "Expand tile"}
            title={isExpanded ? "Restore (Esc)" : "Expand to the whole grid"}
          >
            <Icon name={isExpanded ? "restore" : "maximize"} size="sm" />
          </button>
          <button
            type="button"
            className="tile-icon-btn tile-on-hover"
            onClick={onCloseClick}
            aria-label="Close tile"
            title="Close"
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      </div>
      {tile.kind === "claude" && !exited && (
        <ThemeRestartLine
          ptyId={tile.ptyId}
          vendor="claude"
          className="tile-theme-restart"
          onRestart={canContinue(tile) ? () => restartForTheme(tile) : undefined}
        />
      )}
      {/* An agent REPL run: no Restart of its own, so the line says how. */}
      {tile.kind === "agent-run" && liveRun?.provider === "claude" && liveRun.runtimeMode === "repl" &&
        (liveRun.status === "running" || liveRun.status === "pending") && (
          <ThemeRestartLine ptyId={liveRun.ptyId} vendor="claude" className="tile-theme-restart" />
        )}
      {/* 1.176.0 R7: its CLI didn't start — the words and Repair. */}
      <TileStartFailedLine tile={tile} />
      {/* 1.174.0 E2: in a copy, the trust question explained. */}
      <CopyTrustLine tile={tile} />
      {/* 1.174.1 P1: a Codex Builder in a card's folder, the same line. */}
      <CardTrustLine tile={tile} />
      {/* F1 (1.172.1): after "I don't work here", a terminal in the project
          folder says which version it shows. */}
      {(tile.kind === "shell" || tile.kind === "claude" || tile.kind === "codex") && (
        <FolderVersionLine workspaceId={tile.workspaceId} where={tile.cwd} />
      )}
      <div className="tile-body">
        <TileBody
          tileId={tile.id}
          kind={tile.kind}
          cmd={cmd}
          args={args}
          cwd={tile.cwd}
          runId={tile.runId ?? null}
          liveRun={liveRun}
          workspaceCwd={workspaceCwd}
          workspaceId={tile.workspaceId}
          onPtyId={onPtyId}
          tryOf={tile.tryOf}
          account={tile.kind === "claude" && typeof tile.account === "string" ? tile.account : undefined}
        />
        {/* E6: over the chat, never in the way (no pointer events). */}
        {refusal && (
          <div className="terminal-drop-hint tile-drop-refusal" aria-hidden="true">
            <span>
              <span className="tile-drop-refusal-dot" />
              {refusal}
            </span>
          </div>
        )}
      </div>
      {closeConfirmOpen && (() => {
        // GH #327: what happens and what is kept, in words.
        const q = closeQuestion(tile.kind, tile.label);
        return (
          <ConfirmDialog
            title={swarm ? "Closing this tile stops the multi-AI run" : q.title}
            body={
              swarm
                ? `The current step (${tile.label}) and the multi-AI run will both be marked stopped.`
                : q.body
            }
            confirmLabel={swarm ? "Stop the run" : q.confirmLabel}
            destructive
            onConfirm={performClose}
            onCancel={() => setCloseConfirmOpen(false)}
          />
        );
      })()}
    </div>
  );
}

interface TileBodyProps {
  tileId: string;
  kind: TileKind;
  cmd: string;
  args: string[];
  cwd: string;
  runId: string | null;
  liveRun: AgentRun | null;
  workspaceCwd: string;
  /** v1.63.0: gates the WebGL renderer to the active workspace. */
  workspaceId: string;
  onPtyId: (ptyId: string) => void;
  /** Try it (TI-2): a shell tile that is a card copy's Try session. Fixed
   *  for the tile's life, like its kind. */
  tryOf?: TryOf;
  /** 1.179.0 (C2): the Claude account the tile was asked to run on. Fixed
   *  for the tile's life, like its kind: read once at the spawn. */
  account?: string;
}

/**
 * The heavy half of a Tile (xterm canvas or AgentRunView). Memoized so the
 * 1Hz status-pill tick in the parent doesn't force-rerender it. Only re-
 * renders when its cmd/cwd/runId/ptyId-bearing inputs actually change.
 */
const TileBody = memo(
  function TileBody({
    kind,
    cmd,
    args,
    cwd,
    liveRun,
    workspaceCwd,
    workspaceId,
    onPtyId,
    tileId,
    tryOf,
    account,
  }: TileBodyProps) {
    if (kind === "codex-chat") {
      return (
        <CodexSession
          sessionId={tileId}
          workspaceId={workspaceId}
          cwd={cwd}
        />
      );
    }
    if (kind === "agent-run") {
      if (liveRun) {
        return (
          <AgentRunView
            run={liveRun}
            workspaceCwd={workspaceCwd}
            compact
          />
        );
      }
      return <div className="tile-empty">Waiting for run record…</div>;
    }
    // #47: Codex TUI and shell tiles only; a Claude tile gets no dictation
    // and Space is never intercepted there.
    const dictationMode = dictationModeFor(kind);
    const readiness =
      kind === "claude" || kind === "codex" || kind === "shell" ? kind : undefined;
    return (
      <TerminalView
        cmd={cmd}
        args={args}
        cwd={cwd}
        workspaceId={workspaceId}
        onPtyId={onPtyId}
        cli={kind === "claude" || kind === "codex" ? kind : undefined}
        account={kind === "claude" ? account : undefined}
        screenTileId={kind === "claude" || kind === "codex" ? tileId : undefined}
        tryTarget={kind === "shell" && tryOf ? { cardId: tryOf.cardId, lane: tryOf.lane ?? null } : undefined}
        dictation={
          dictationMode === "codex-tui" || dictationMode === "shell"
            ? { tileId, mode: dictationMode }
            : undefined
        }
        readiness={readiness}
        onStartFailed={(failure) => useTiles.getState().markStartFailed(tileId, failure)}
        onExit={(code) => {
          // UX-0.1: the process ended (`exit`, a crash). The PTY-exit listener
          // reports the same; marking here makes the header flip at once.
          useTiles.getState().markExited(tileId, code);
        }}
      />
    );
  },
  (prev, next) => {
    if (prev.kind !== next.kind) return false;
    if (prev.tileId !== next.tileId) return false;
    if (prev.cmd !== next.cmd) return false;
    if (prev.cwd !== next.cwd) return false;
    if (prev.runId !== next.runId) return false;
    if (prev.workspaceId !== next.workspaceId) return false;
    // For agent-run tiles, only re-render when the run's identity changes
    // (status/elapsed deltas should be handled by AgentRunView's internal
    // event subscription, not via parent re-render).
    if ((prev.liveRun?.id ?? null) !== (next.liveRun?.id ?? null)) return false;
    // args is built via useMemo from kind and cmd, both compared above
    return true;
  },
);

/** 1.174.1 P1 (T1): under a Codex tile in a card's folder
 *  (`.plyloft-worktrees/card-…`, or the worktree a card records), the
 *  quiet line while Codex asks to trust it (`question === "trust"`). Codex
 *  only, only while the question is open; a copy's tile has its own line
 *  (`CopyTrustLine`). Never answers it. */
export function CardTrustLine({
  tile,
}: {
  tile: Pick<TileT, "workspaceId" | "cwd" | "kind" | "status" | "question">;
}) {
  const rows = useWorkspaceCopies(tile.workspaceId);
  const ended = tile.status === "done" || tile.status === "crashed" || tile.status === "error" || tile.status === "killed";
  const asking = tile.kind === "codex" && !ended && tile.question === "trust";
  const projectCwd = useWorkspaces((s) => s.workspaces.find((w) => w.id === tile.workspaceId)?.cwd ?? null);
  const inCard = useKanban((s) =>
    asking
      ? isCardFolder(tile.cwd, (s.byWorkspace[tile.workspaceId]?.cards ?? []).map((c) => c.worktreePath), projectCwd)
      : false,
  );
  if (!asking || !inCard || copyForCwd(rows, tile.cwd)) return null;
  return (
    <div className="tile-copy-trust" role="note">
      {CARD_TRUST_TILE_LINE}
    </div>
  );
}

/** 1.174.0 E2 (P19, D12 a, owner: only in copy tiles): a quiet line under
 *  the header while Claude or Codex asks to trust the copy's folder — the
 *  same read as the header's amber words (`question === "trust"`) — and,
 *  once the session ended on that question (answered No), why and how to
 *  ask again. Never answers it. */
export function CopyTrustLine({
  tile,
}: {
  tile: Pick<TileT, "workspaceId" | "cwd" | "kind" | "status" | "question" | "endedOnTrust">;
}) {
  const rows = useWorkspaceCopies(tile.workspaceId);
  const copy = copyForCwd(rows, tile.cwd);
  if (!copy || (tile.kind !== "claude" && tile.kind !== "codex")) return null;
  const ended = tile.status === "done" || tile.status === "crashed" || tile.status === "error" || tile.status === "killed";
  // Challenger 1 (E2-3): once ended, what it ended on (`markExited`), not
  // the question a later scan may have cleared.
  if (ended) {
    if (!tile.endedOnTrust) return null;
    return (
      <div className="tile-copy-trust" role="note">
        {copyTrustRefusedLine(tile.kind)}
      </div>
    );
  }
  if (tile.question !== "trust") return null;
  return (
    <div className="tile-copy-trust" role="note">
      {copyTrustTileLine(tile.kind)}
    </div>
  );
}
