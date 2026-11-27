import { useMemo, useState, type ReactNode } from "react";
import { useShipReadyTotal } from "../store/shipReadyHooks";
import { openHeaderRelease, useHeaderRelease } from "../store/projectRelease";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles } from "../store/tileStore";
import { showTile } from "../store/tileActions";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import type { KanbanCard, ShellEnvInfo } from "../ipc";
import { useNeedsYou, useNow } from "../hooks/useNeedsYou";
import { EMPTY_ARRAY } from "../lib/empties";
import { useCardPresenter } from "../hooks/useCardLive";
import {
  effectiveCenterMode,
  goToCenterMode,
  openCenterMode,
  useUi,
  type CenterMode,
} from "../store/uiStore";
import {
  capSessionRows,
  SESSION_ROW_CAP,
  sessionRows,
  terminalsCount,
  type SessionRow,
  type SessionTarget,
} from "../lib/sessionRows";
import { Icon } from "./ux";
import { shortcutKeys } from "../lib/shortcuts";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AreaPicker } from "./AreaPicker";
import { WorkspaceStack } from "./WorkspaceStack";
import { machineWords, windowDragRegion } from "../lib/platform";
import {
  NeedsAttentionRow,
  PlanStatusRow,
  SetupFinishRow,
  ShipStatusRows,
  useMissingTools,
} from "./SidebarStatus";
import { UpdateStatusRow } from "./UpdatePrompt";
import { useSetupFinishFeed, useSetupRequired } from "../store/setupFinishStore";
import { useAllSkills } from "../store/allSkillsStore";
import { SHIP_BATCH_BY_AREA, SHIP_BATCH_BY_PROJECT, shipBatchLabel, shipBatchShown } from "../lib/boardSemantics";
import { navDestination, type NavDestinationId } from "../lib/sidebarNav";
import { HelpMenu, TutorialStatusRow } from "./tutorial/HelpMenu";

/**
 * UX-3.3 (the Shell board, ADR 0007): the sidebar, top to bottom —
 *
 *   title bar strip  the traffic lights (UX-3.2)
 *   switcher         the current workspace; a popover switches, searches,
 *                    adds and manages workspaces
 *   app section      Search (⌘K) · Inbox · History · All skills (Skills hub
 *                    H7: every skill on this Mac; a muted count, never the
 *                    Inbox's accent one — C9)
 *   <workspace>      Board · Code · Terminals (its live sessions) · Library
 *   other workspaces the ones where something waits, failed or works, each
 *                    expandable to its sessions, then the ones used recently
 *                    this session (five rows at most); the rest stay in the
 *                    switcher behind "N more workspaces" (WorkspaceStack)
 *   Help             "? Help", a row above the foot's line (C9)
 *   foot             status rows · "Ship N in a batch" · Settings
 *
 * Every nav row is drawn from `NAV_DESTINATIONS` (lib/sidebarNav.ts): its
 * words, its icon and its tour anchor (TUTORIAL_SPEC §4.3, §12.1). The
 * sidebar is drawn once, for the active workspace, so each anchor is on one
 * element.
 *
 * Rows are 32 px in `ui` 14 px with a 16 px Lucide icon; the selected one is
 * a `--selected` fill, no bar. Shortcuts live in tooltips and ⌘/, never on
 * the rows. Not every workspace is listed here — only the active and recent
 * others; all are in the switcher, which is also where one is removed (with
 * a confirmation).
 */

type Props = {
  env: ShellEnvInfo | null;
  /** A nav choice was made — the overlay sidebar (UX-3.4) closes on it. */
  onNavigate?: () => void;
};

/** App.tsx owns the command palette (⌘K); the Search row opens it through
 *  this event so the sidebar needs no handle on it. */
export const OPEN_PALETTE_EVENT = "ply:open-palette";

export function WorkspaceSidebar({ env, onNavigate }: Props) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const centreMode = useUi((s) => effectiveCenterMode(s.centerMode, activeId));
  // Skills hub H7: while All skills is open no mode of the workspace is the
  // page you are on.
  const allSkillsOpen = useUi((s) => s.allSkillsOpen);
  const allSkillsCount = useAllSkills((s) => s.attention);
  const mode: CenterMode | null = allSkillsOpen ? null : centreMode;
  // UX-4.4: the one attention signal — the Inbox row's count is what needs
  // you across every workspace, the same sum the switcher splits by
  // workspace. One ticker drives both (paused while the window is hidden).
  const now = useNow();
  const attention = useNeedsYou(now);
  const needsYou = attention.total;

  function go(m: CenterMode) {
    if (!activeId) return;
    goToCenterMode(activeId, m);
    onNavigate?.();
  }

  return (
    <aside className="shell-sidebar" aria-label="Sidebar">
      {/* UX-3.2: the overlay title bar's traffic lights sit here; the strip
          drags the window and a double-click zooms it. Windows (W4) has
          its native title bar, so the strip is flat and not a drag region. */}
      <div className="shell-titlebar" data-tauri-drag-region={windowDragRegion()} />
      <WorkspaceSwitcher now={now} />
      {/* 1.173.0 (B2): only with two areas or more. */}
      {activeId && <AreaPicker workspaceId={activeId} />}
      <nav className="shell-nav" aria-label="Navigation">
        <NavItem
          dest="search"
          title={`Search (${shortcutKeys("palette")})`}
          onClick={() => {
            window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
            onNavigate?.();
          }}
        />
        <NavItem
          dest="inbox"
          title={`Inbox (${shortcutKeys("modeInbox")})`}
          selected={mode === "inbox"}
          count={needsYou}
          attention
          disabled={!activeId}
          onClick={() => go("inbox")}
        />
        <NavItem
          dest="history"
          title={`History — runs, ships and costs (${shortcutKeys("modeHistory")})`}
          selected={mode === "activity"}
          disabled={!activeId}
          onClick={() => go("activity")}
        />
        {/* R4: app-level — it works with no workspace open. */}
        <NavItem
          dest="all-skills"
          title={machineWords("All skills — every skill on this Mac, and where each one is used")}
          selected={allSkillsOpen}
          count={allSkillsCount}
          onClick={() => {
            useUi.getState().setAllSkillsOpen(true);
            onNavigate?.();
          }}
        />
        {active && (
          <WorkspaceSection ws={active} mode={mode} go={go} onNavigate={onNavigate} />
        )}
        <WorkspaceStack now={now} waiting={attention.waiting} onNavigate={onNavigate} />
      </nav>
      {/* 1.169.0 (C9): Help is a row of its own, at the bottom of the
          navigation above the foot's line — out of the scrolling list, so
          a long stack of workspaces never hides it. */}
      <div className="shell-help-row">
        <HelpMenu
          onNavigate={onNavigate}
          trigger={({ ref, props, label, icon, dot }) => (
            <button ref={ref} type="button" className="shell-nav-item" {...props}>
              <Icon name={icon} />
              <span className="shell-nav-label">{label}</span>
              {dot && <span className="ux-more-dot" aria-hidden="true" />}
            </button>
          )}
        />
      </div>
      <SidebarFoot env={env} onNavigate={onNavigate} />
    </aside>
  );
}

function NavItem({
  dest,
  label,
  title,
  selected = false,
  count = 0,
  attention = false,
  disabled = false,
  onClick,
}: {
  /** The row's destination: its words, icon and tour anchor. */
  dest: NavDestinationId;
  /** Words that are not the list's own (Ship batch's count). */
  label?: ReactNode;
  title?: string;
  selected?: boolean;
  count?: number;
  /** The count is something waiting for the person (`--claude-accent`). */
  attention?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const nav = navDestination(dest);
  return (
    <button
      type="button"
      className={`shell-nav-item${selected ? " is-selected" : ""}`}
      aria-current={selected ? "page" : undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-ply-tour={nav.tour}
    >
      <Icon name={nav.icon} />
      <span className="shell-nav-label">{label ?? nav.label}</span>
      {count > 0 && (
        <span className={`shell-count${attention ? " shell-count--attention" : ""}`}>
          {count}
        </span>
      )}
    </button>
  );
}

/** The current workspace's modes, under a caption with its name. */
function WorkspaceSection({
  ws,
  mode,
  go,
  onNavigate,
}: {
  ws: Workspace;
  mode: CenterMode | null;
  go: (m: CenterMode) => void;
  onNavigate?: () => void;
}) {
  const tiles = useTiles((s) => s.byWorkspace[ws.id]?.tiles ?? EMPTY_ARRAY);
  const cards = useKanban(
    (s) => s.byWorkspace[ws.id]?.cards ?? (EMPTY_ARRAY as KanbanCard[]),
  );
  // GH #293: the rows read what the tile headers read; the clock turns a
  // silent tile amber as its header does.
  const now = useNow();
  // CL-7: who is working — the Builder runtimes the attached xterms keep
  // (last output, the prompt scans). Read, never polled: the one-second
  // clock above already redraws these rows.
  const byKey = useBuilder((s) => s.byCard);
  const sentAt = useBuilder((s) => s.sentAt);
  const submittedAt = useBuilder((s) => s.submittedAt);
  const doneAt = useBuilder((s) => s.doneAt);
  // P-A (UX P1 point 2): a Builder row's card says what its Board card says.
  const presenter = useCardPresenter();
  const rows = useMemo(() => {
    const presentOf = (cardId: string) => {
      const card = cards.find((c) => c.id === cardId);
      return card ? presenter(card) : null;
    };
    // Windows walk (block 10): the row reads the clock when it is drawn, as
    // the tile header does (`Date.now()` at render) — a store change (a
    // ConPTY scan saying Ready) redraws both, and a ticker that paused or
    // lags must not leave the row on an older verdict than its header.
    return sessionRows(tiles, cards, Math.max(now, Date.now()), { byKey, sentAt, submittedAt, doneAt, presentOf });
  }, [tiles, cards, now, byKey, sentAt, submittedAt, doneAt, presenter]);
  // GH #117: the count is the rows listed beneath, Builders included.
  const liveCount = terminalsCount(rows);
  return (
    <>
      <div className="shell-caption" title={ws.cwd}>
        {ws.name}
      </div>
      <NavItem
        dest="board"
        title={`Board (${shortcutKeys("modeBoard")})`}
        selected={mode === "board"}
        onClick={() => go("board")}
      />
      <NavItem
        dest="code"
        title={`Code (${shortcutKeys("modeCode")})`}
        selected={mode === "code"}
        onClick={() => go("code")}
      />
      <NavItem
        dest="terminals"
        title={`Terminals (${shortcutKeys("modeTerminals")})`}
        selected={mode === "terminals"}
        count={liveCount}
        onClick={() => go("terminals")}
      />
      <NavSessions ws={ws} rows={rows} mode={mode} onNavigate={onNavigate} />
      <NavItem
        dest="library"
        title={`Library (${shortcutKeys("modeLibrary")})`}
        selected={mode === "library"}
        onClick={() => go("library")}
      />
    </>
  );
}

/** GH #95: one row per live session of the workspace — Builder sessions of
 *  cards, then the grid's tiles. Presentation only: a click opens the card
 *  or the tile and never touches a PTY. At most eight, then Show all. */
function NavSessions({
  ws,
  rows,
  mode,
  onNavigate,
}: {
  ws: Workspace;
  rows: readonly SessionRow[];
  mode: CenterMode | null;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // E4 (owner, 2026-10-28): the only rows with a highlight are the
  // session(s) of the card open in the centre — on the Board; both builds of
  // a card built by both share its target — or the tile expanded on Terminals.
  const openCardId = useUi((s) => s.selectedCardId[ws.id] ?? null);
  const expandedTileId = useTiles((s) => s.byWorkspace[ws.id]?.expandedTileId ?? null);
  const isOpen = (target: SessionTarget) =>
    target.kind === "card"
      ? mode === "board" && openCardId === target.cardId
      : mode === "terminals" && target.tileId != null && expandedTileId === target.tileId;
  const view = capSessionRows(rows, expanded);
  if (rows.length === 0) return null;

  function open(target: SessionTarget) {
    if (target.kind === "card") {
      useUi.getState().selectCard(ws.id, target.cardId);
    } else {
      // QoL 1.168 (A1): on Terminals, with the keyboard in it.
      if (target.tileId) showTile(ws.id, target.tileId);
      else {
        openCenterMode(ws.id, "terminals");
        useTiles.getState().setExpanded(ws.id, null);
      }
    }
    onNavigate?.();
  }

  return (
    // The card sessions under Terminals (B6 points here): the one list of
    // them that is drawn whatever the Terminals page holds.
    <div className="shell-sessions" aria-label="Live sessions" data-ply-tour="terminals-card-sessions">
      {view.visible.map((row) => (
        <button
          key={row.key}
          type="button"
          className={`shell-session${row.kind === "builder" || row.stateLine ? " shell-session--builder" : ""}${row.dot === "warn" ? " shell-session--asks" : ""}${isOpen(row.target) ? " is-selected" : ""}`}
          aria-current={isOpen(row.target) ? "true" : undefined}
          onClick={() => open(row.target)}
          data-ply-rule={row.rule}
          aria-label={`${row.name}, ${row.spokenState}`}
          title={
            row.target.kind === "card"
              ? `${row.name} — ${row.state}. Opens the card.`
              : `${row.name} — ${row.state}. Opens it in Terminals.`
          }
        >
          <span className={`shell-dot shell-dot--${row.dot}`} aria-hidden="true" />
          {row.kind === "builder" || row.stateLine ? (
            // CL-7: a Builder row says who is working under its card's name —
            // "Claude · building · 4m", "Codex · reviewing". QoL 1.168 (D7):
            // so does a tile waiting on the member, quiet or failed ("Claude ·
            // usage limit · resets 6pm"); a working or Ready tile's state
            // stays in its header (and this row's tooltip).
            <span className="shell-session-text">
              <span className={`shell-session-name${row.plainShell ? " is-shell" : ""}`}>{row.name}</span>
              <span className="shell-session-state" aria-hidden="true">
                {row.state}
              </span>
            </span>
          ) : (
            <span className={`shell-session-name${row.plainShell ? " is-shell" : ""}`}>
              {row.name}
            </span>
          )}
        </button>
      ))}
      {/* GH #95 (review 2): expands in place — a Builder session lives in its
          card, so sending the overflow to the tile grid would strand it. */}
      {view.hidden > 0 && (
        <button
          type="button"
          className="shell-session shell-session--more"
          onClick={() => setExpanded(true)}
          title={`${view.hidden} more live session${view.hidden === 1 ? "" : "s"}`}
        >
          Show all
        </button>
      )}
      {expanded && rows.length > SESSION_ROW_CAP && (
        <button
          type="button"
          className="shell-session shell-session--more"
          onClick={() => setExpanded(false)}
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

/** Status rows, then "Release N…" (Ship batch) when the batch has two or more
 *  cards (1.171.0 E3, owner D5), then
 *  Settings on its own line (Help sits above the foot's line, C9). */
function SidebarFoot({
  env,
  onNavigate,
}: {
  env: ShellEnvInfo | null;
  onNavigate?: () => void;
}) {
  // QoL 1.168 C7: the one list every "Ship N" reads. 1.174.0 (DR3 round 1):
  // the row is the active project's — a release is of one project, and
  // its sheet opens on that project's ready cards.
  const activeId = useWorkspaces((s) => s.activeId);
  // 1.174.1 P3 (T3): the same count and press as the Board header's — on
  // All areas of a project with areas, the one area the sheet opens.
  const activeRelease = useHeaderRelease(activeId);
  // Challenger P3-2: the active project's count, read or not (it falls back
  // to the Board's own ready cards); the backend's total over every project
  // only with no active project.
  const total = useShipReadyTotal();
  const pendingCount = activeId ? activeRelease.cardIds.length : total;
  // 1.171.0 E3 (owner D5): two or more cards.
  // Reads the doctor report once if nobody has yet.
  useMissingTools();
  useSetupFinishFeed();
  const finish = useSetupRequired().finish;
  return (
    <div className="shell-foot">
      {/* UX-3.8: what floated over the window as banners is a quiet row
          here — an update, a missing tool, a drain. */}
      <UpdateStatusRow />
      {/* QoL 12.4 (G21): a plan problem is seen here, not only in Settings. */}
      <PlanStatusRow />
      {/* OB-15 (§9.1): one row, not two, for the same fact — while Setup
          isn't finished its row says what the doctor's would. */}
      {finish ? (
        <SetupFinishRow finish={finish} />
      ) : (
        <>
          {/* 1.176.1: one row for what needs the person, by priority. */}
          <NeedsAttentionRow env={env} />
          {/* TU-4 (§3.4): the tour's row, in the Setup row's slot — the
              Setup row wins when both apply. */}
          <TutorialStatusRow />
        </>
      )}
      <ShipStatusRows />
      {shipBatchShown(pendingCount) && (
        <NavItem
          dest="ship-batch"
          // SP-D: the row is the Ship batch's — it counts what a batch takes,
          // fewer than the Board's "Ready to ship" chips when an approved
          // Builder card's session is still open (1.171.0 F1).
          label={shipBatchLabel(pendingCount)}
          title={activeRelease.asks ? SHIP_BATCH_BY_AREA : SHIP_BATCH_BY_PROJECT}
          onClick={() => {
            // 1.174.0 (DR3): the active project's Release sheet, its ready
            // cards ticked (1.174.1 P3: as the Board header opens it).
            if (activeId) openHeaderRelease(activeId, activeRelease);
            onNavigate?.();
          }}
        />
      )}
      <NavItem
        dest="settings"
        title={`Settings (${shortcutKeys("settings")})`}
        onClick={() => {
          useUi.getState().setSettingsOverlayOpen(true);
          onNavigate?.();
        }}
      />
    </div>
  );
}
