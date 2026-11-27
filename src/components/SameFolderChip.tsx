// 1.173.0 (A4): the "Same folder as <other>" chip in a tile's header and its
// popover. A real button (Tab reaches it, Enter or Space opens the popover,
// Esc closes it and gives focus back). The popover offers a new terminal in
// a copy (A3's sheet, through `openNewCopySheet`) — only in a git project,
// where a copy can exist — and Show <other>; the running session never
// moves. Mockup: next-1173/mockups/copies.html, 1.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CBtn } from "./ux";
import { useEscapeFirst } from "./ux/useEscapeFirst";
import { useTiles, type Tile } from "../store/tileStore";
import { showTile } from "../store/tileActions";
import { useWorkspaces } from "../store/workspaceStore";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import {
  copyStartPoint,
  projectConfigGet,
  projectLocalOrigin,
  type CoordinationLiveWarning,
  type CoordinationSession,
} from "../ipc";
import {
  SAME_FOLDER_COPY,
  SAME_FOLDER_SHORT,
  folderPeerName,
  folderSelfName,
  sameFolderBody,
  sameFolderChip,
  sameFolderHeadline,
  sameFolderHint,
  sameFolderShow,
  type CopyStart,
} from "../lib/sameFolder";
import { changedSince, checkIgnored, folderIsWatched, useFolderChanges } from "../store/folderChanges";
import { useSettings } from "../store/settingsStore";
import { useAreasView, useCurrentArea } from "../store/areaStore";
import { copyBranch } from "../lib/areaPicker";
import { machineWords } from "../lib/platform";
import { newCopyProviderFor, openNewCopySheet } from "../lib/newCopySheet";

const POPOVER_WIDTH = 340;
const GAP = 6;
/** How long the popover waits for where a copy starts before showing. */
export const START_WAIT_MS = 800;

type Peer = { name: string; tile: Tile | null; startedAt: number | null };

type Props = {
  tile: Tile;
  /** This tile's own coordination session (Tile resolves it). */
  session: CoordinationSession | null;
  warnings: CoordinationLiveWarning[];
  sessions: CoordinationSession[];
  /** The tile is hidden behind an expanded one. With it, another workspace
   *  or mode in front closes the popover. */
  hidden: boolean;
};

function samePeer(session: CoordinationSession | undefined, t: Tile): boolean {
  if (!session) return false;
  if (session.ptyId && t.ptyId === session.ptyId) return true;
  return Boolean(session.runId && t.runId === session.runId);
}

/** A copy can exist only for a git project (A2 makes it a git worktree). */
function copyPossible(session: CoordinationSession | null): boolean {
  return session?.project.kind === "project" && session.project.git === true;
}

/** Below the chip, or above it when the measured popover would pass the
 *  window's bottom; never past the right edge. */
function place(anchor: DOMRect, height: number): { top: number; left: number } {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const flipUp = vh - anchor.bottom < height + GAP * 2 && anchor.top > height + GAP * 2;
  const top = flipUp ? Math.max(GAP, anchor.top - height - GAP) : anchor.bottom + GAP;
  const left = Math.min(Math.max(GAP, anchor.left), vw - POPOVER_WIDTH - GAP);
  return { top, left };
}

export function SameFolderChip({ tile, session, warnings, sessions, hidden }: Props) {
  const tiles = useTiles((s) => s.byWorkspace[tile.workspaceId]?.tiles);
  const expandedTileId = useTiles((s) => s.byWorkspace[tile.workspaceId]?.expandedTileId ?? null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [start, setStart] = useState<CopyStart | null>(null);
  const [startTimedOut, setStartTimedOut] = useState(false);
  const open = anchor !== null;
  // The workspace's host is hidden by visibility, never unmounted: another
  // workspace or another mode in front means the tile isn't on screen.
  const away = useWorkspaces((s) => s.activeId !== tile.workspaceId);
  const offTerminals = useUi((s) => effectiveCenterMode(s.centerMode, tile.workspaceId) !== "terminals");
  const offScreen = hidden || away || offTerminals;
  const canCopy = copyPossible(session);
  const workspaceCwd = useWorkspaces((s) => s.workspaces.find((w) => w.id === tile.workspaceId)?.cwd ?? null);
  // Challenger 1 (E1-3): the watcher reports nothing with its setting off
  // or for a workspace whose folder is missing (never watched).
  const watcherOn = useSettings((s) => s.settings.behavior.fileWatcherEnabled !== false);
  const cwdMissing = useWorkspaces((s) => Boolean(s.cwdMissing?.[tile.workspaceId]));
  // Round 2 (E1 2): the branch a copy starts from, as the sheet reads it —
  // the current area's, else the workspace's target.
  const areaView = useAreasView(tile.workspaceId);
  const area = useCurrentArea(tile.workspaceId);
  const branch = copyBranch(areaView, area?.id ?? null);

  const seen = new Set<string>();
  const peers: Peer[] = [];
  for (const warning of warnings) {
    if (seen.has(warning.peerSessionId)) continue;
    seen.add(warning.peerSessionId);
    const peerSession = sessions.find((s) => s.id === warning.peerSessionId);
    const peerTile =
      (tiles ?? []).find((t) => t.id !== tile.id && !t.pendingClose && samePeer(peerSession, t)) ?? null;
    peers.push({
      name: folderPeerName(peerTile, peerSession?.provider, tile),
      tile: peerTile,
      startedAt: peerTile?.startedAt ?? peerSession?.startedAt ?? null,
    });
  }
  const names = peers.map((p) => p.name);
  const chip = sameFolderChip(names);
  const self = folderSelfName(tile, peers.map((p) => p.tile));
  const shown = peers.find((p) => p.tile !== null) ?? null;
  // 1.174.0 E1 (P18, D7 b, owner: any changed file): the risk is real only
  // once a file in the folder changed after the younger of the two opened —
  // in the project folder or in a copy (the watcher reports both; a copy's
  // files never count for the project folder). Files git ignores don't
  // count. With nothing reported (watcher off, folder missing, a folder
  // outside the workspace) the old rule holds: it warns at once.
  const since = Math.max(tile.startedAt ?? 0, ...peers.map((p) => p.startedAt ?? 0));
  const watched = watcherOn && !cwdMissing && folderIsWatched(tile.cwd, workspaceCwd);
  // Primitives only, so a burst of changes elsewhere re-renders nothing.
  const changedCount = useFolderChanges((s) =>
    watched ? changedSince(s.byWorkspace[tile.workspaceId], tile.cwd, since, s.ignored[tile.workspaceId] ?? {}).count : 0,
  );
  const unknownCount = useFolderChanges((s) =>
    watched
      ? changedSince(s.byWorkspace[tile.workspaceId], tile.cwd, since, s.ignored[tile.workspaceId] ?? {}).unknown.length
      : 0,
  );
  const quiet = watched && changedCount === 0;
  const hasPeers = peers.length > 0;

  // E1-4 (b): before the chip shows, ask git which of the changed files it
  // ignores (once per file).
  useEffect(() => {
    if (!watched || !hasPeers || unknownCount === 0) return;
    const s = useFolderChanges.getState();
    const { unknown } = changedSince(s.byWorkspace[tile.workspaceId], tile.cwd, since, s.ignored[tile.workspaceId] ?? {});
    if (unknown.length > 0) void checkIgnored(tile.workspaceId, tile.cwd, unknown);
  }, [watched, hasPeers, unknownCount, tile.workspaceId, tile.cwd, since]);

  function close(returnFocus: boolean) {
    setAnchor(null);
    setPosition(null);
    setStart(null);
    setStartTimedOut(false);
    if (returnFocus) chipRef.current?.focus();
  }

  useEscapeFirst(open, popoverRef, () => close(true));

  // The host went hidden (⌘-digit to another workspace, another mode): the
  // popover on document.body would outlive it.
  useEffect(() => {
    if (offScreen && open) close(false);
  }, [offScreen, open]);

  // Where the copy starts, from this Mac's own refs (no fetch): the target
  // branch, else origin's default branch, and whether origin is GitHub.
  useEffect(() => {
    if (!open || !canCopy) return;
    let live = true;
    Promise.all([
      projectConfigGet(tile.workspaceId).catch(() => null),
      projectLocalOrigin(tile.workspaceId).catch(() => null),
      // E1-7: the sheet's own start point (its branch, the area's) —
      // whether the copy starts from this Mac's branch, or leaves steps out
      // (diverged). The folder's changed files aren't read for this.
      copyStartPoint(tile.workspaceId, branch, true).catch(() => null),
    ]).then(([config, origin, point]) => {
      if (!live) return;
      setStart({
        targetBranch: point?.target?.trim() || config?.targetBranch || null,
        defaultBranch: origin?.hasOrigin ? origin.defaultBranch : null,
        githubRepo: origin?.hasOrigin ? (origin.githubRepo ?? null) : null,
        localAhead: point?.localAhead ?? null,
        startsLocal: point?.startsLocal ?? false,
      });
    });
    return () => {
      live = false;
    };
  }, [open, canCopy, tile.workspaceId, branch]);

  // A read that hangs never keeps the popover invisible: after a short wait
  // it shows with what it knows.
  useEffect(() => {
    if (!open || !canCopy) return;
    const id = window.setTimeout(() => setStartTimedOut(true), START_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [open, canCopy]);

  // With a copy offered, the sentence names where it starts: the popover
  // shows once that is read (or the wait ran out), so it never changes under
  // a screen reader.
  const ready = !canCopy || start !== null || startTimedOut;
  const placed = position !== null;

  // Placed once, from its real height, before it paints.
  useLayoutEffect(() => {
    if (!anchor || !ready || placed) return;
    const height = popoverRef.current?.getBoundingClientRect().height ?? 0;
    setPosition(place(anchor, height));
  }, [anchor, ready, placed]);

  // Focus goes into the popover once it shows, on its first action (a
  // hidden element can't take focus).
  useEffect(() => {
    if (!placed) return;
    (firstActionRef.current ?? popoverRef.current)?.focus();
  }, [placed]);

  // A click anywhere else, focus leaving both chip and popover, the window
  // resizing or the grid scrolling closes it.
  useEffect(() => {
    if (!open) return;
    function inside(node: Node | null): boolean {
      return Boolean(
        node && (popoverRef.current?.contains(node) || chipRef.current?.contains(node)),
      );
    }
    function onDown(e: MouseEvent) {
      if (!inside(e.target as Node)) close(false);
    }
    function onFocus(e: FocusEvent) {
      if (!inside(e.target as Node)) close(false);
    }
    function onMoved(e: Event) {
      // Only a scroll that moves the chip (the document, the grid, a pane
      // around the tile) — not a transcript or list scrolling elsewhere.
      if (e.type === "scroll") {
        const t = e.target;
        if (!(t instanceof Node) || !chipRef.current || !t.contains(chipRef.current)) return;
      }
      close(false);
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onMoved);
    document.addEventListener("scroll", onMoved, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onMoved);
      document.removeEventListener("scroll", onMoved, true);
    };
  }, [open]);

  if (peers.length === 0 || quiet) return null;

  function openCopy() {
    close(false);
    openNewCopySheet({
      workspaceId: tile.workspaceId,
      provider: newCopyProviderFor(tile.kind, session?.provider),
      // E1: the toast after the copy offers "Close {self}".
      from: { tileId: tile.id, self, peer: names[0] ?? "" },
    });
  }
  const changed = watched
    ? changedSince(
        useFolderChanges.getState().byWorkspace[tile.workspaceId],
        tile.cwd,
        since,
        useFolderChanges.getState().ignored[tile.workspaceId] ?? {},
      )
    : null;
  // 1.174.1 P6: "since they opened" with three or more tiles here.
  const body = sameFolderBody(start, canCopy, changed, names.length + 1);

  function showPeer() {
    if (!shown?.tile) return;
    close(false);
    // With one tile filling the grid, the other takes its place.
    showTile(tile.workspaceId, shown.tile.id, { expand: expandedTileId !== null });
  }

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="tile-chip tile-chip--folder"
        aria-label={chip}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={chip}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close(true);
          else setAnchor(e.currentTarget.getBoundingClientRect());
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="tile-chip-dot" aria-hidden="true" />
        {/* 1.174.0 E4 (P21, mockup terminals.html §1): the full name; at
            ≤ 480 px the tile shows "Same folder" instead, at ≤ 320 px the
            dot only (`@container tile`). The button keeps its full name in
            aria-label and title either way. */}
        <span className="tile-chip-full">{chip}</span>
        <span className="tile-chip-short" aria-hidden="true">
          {SAME_FOLDER_SHORT}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="ux-popover tile-folder-pop"
            style={{
              position: "fixed",
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              width: POPOVER_WIDTH,
              visibility: position ? "visible" : "hidden",
            }}
            role="dialog"
            aria-label={chip}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {/* Challenger 1 (E4): plain paragraphs, spaced by
                `.tile-folder-pop > p:not(.tile-folder-pop-hint)` in
                terminals.css (the margin the old line class held). */}
            <p>
              <b>{sameFolderHeadline(self, names)}</b>
            </p>
            <p>
              {body.risk}
              {body.copy && (
                <>
                  <br />
                  {machineWords(body.copy)}
                </>
              )}
            </p>
            {(canCopy || shown) && (
              <div className="tile-folder-pop-actions">
                {canCopy && (
                  <CBtn ref={firstActionRef} tone="strong" size="sm" onClick={openCopy}>
                    {SAME_FOLDER_COPY}
                  </CBtn>
                )}
                {shown && (
                  <CBtn ref={canCopy ? undefined : firstActionRef} size="sm" onClick={showPeer}>
                    {sameFolderShow(shown.name)}
                  </CBtn>
                )}
              </div>
            )}
            {canCopy && <p className="tile-folder-pop-hint">{sameFolderHint(self)}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
