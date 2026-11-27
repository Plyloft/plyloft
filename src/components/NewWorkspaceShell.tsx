import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { SidebarSlot } from "./SidebarSlot";
import { ModeHeader } from "./ModeHeader";
import { CBtn } from "./ui/primitives";
import { ADD_PROJECT_LABEL, useAddProject } from "../store/addProjectStore";
import { platform } from "../lib/platform";
import { TileGrid, TileGridEmpty } from "./TileGrid";
import { KanbanBoard } from "./KanbanBoard";
import { CardDetailPanel } from "./CardDetailPanel";
import { InboxPanel } from "./InboxPanel";
import { ActivityView } from "./ActivityView";
import { CodeModeHost } from "./CodeModeHost";
import { LibraryModeHost } from "./library/LibraryModeHost";
import { AllSkillsPage } from "./allSkills/AllSkillsPage";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
import { CentreErrorBoundary } from "./CentreErrorBoundary";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { settleFocus } from "../lib/hiddenFocus";
import { nextFrameOrTimer } from "../lib/nextFrame";
import type { ShellEnvInfo } from "../ipc";
import type { Workspace } from "../store/workspaceStore";

type Props = {
  env: ShellEnvInfo | null;
  warmed: Set<string>;
  workspaces: Workspace[];
  activeId: string | null;
};

/**
 * v1.31.0: incremental-mount stages for a freshly-warmed workspace.
 * The heavy per-workspace subtree is mounted in chunks, one stage per
 * animation frame, so no single React commit blocks the main thread:
 *   0 — skeleton only; nothing per-workspace mounted
 *   1 — TileGrid mounted
 *   2 — center card-detail host (xterm) mounted; hydration complete
 *       (v1.76.0: moved from RightTabs to the center stage — STEP6 D6)
 *
 * GH #95 (ADR 0005): the right panel's two stages (RightTabs shell, then
 * its body) went with the panel; CodeMirror mounts with Code mode.
 *
 * Why staging and not `startTransition` alone (App.tsx already wraps the
 * `warmed` update in a transition): a transition only makes the *render*
 * phase interruptible. The commit phase and the synchronous flush of
 * passive effects — xterm `terminal.open()` runs inside `useEffect` — are
 * NOT time-sliced and would flush in one batch right after the transition
 * commits. Splitting the mount across separate animation-frame *tasks* is
 * what actually keeps every main-thread block short enough that macOS
 * never beachballs.
 */
const FINAL_MOUNT_STAGE = 2;

/**
 * v0.5.1 shell: workspace sidebar (left) + the center stage, which runs to
 * the right edge of the window. GH #95 (ADR 0005): the Live rail and the
 * pinned right panel are retired — live sessions are listed in the sidebar
 * under Terminals. GH #96: the Library is the center mode that replaced the
 * temporary Knowledge one.
 *
 * Shell visibility is controlled by the sidebar/mode context; at least one
 * content surface remains visible.
 *
 * The middle column renders one TileGrid per *warmed* workspace. The
 * active one is visible; the rest are hidden via CSS (`visibility:
 * hidden`). This keeps each workspace's xterm scrollback + PTY streams
 * alive across workspace switches — see CLAUDE.md gotcha re: per-workspace
 * UI and the warmed-workspace render pattern.
 *
 * v1.31.0: a workspace's first warm hydrates its heavy subtree in stages
 * (one chunk per animation frame — see FINAL_MOUNT_STAGE) so the switch
 * never blocks the main thread into a macOS beachball. Already-warmed
 * workspaces are at the final stage, so switching back to them is still
 * an instant `.hidden` toggle with no remount.
 *
 * This is Ply's sole workspace shell. Compatibility settings from the
 * retired pre-v0.5 shell are still decoded but do not select runtime UI.
 */
export function NewWorkspaceShell({
  env,
  warmed,
  workspaces,
  activeId,
}: Props) {
  const leftOpen = useUi((s) => s.leftPanelOpen);
  const gridOpen = useUi((s) => s.gridVisible);
  // v1.67.0 (UX revamp step 3a): the center Panel is a mode-switched
  // stage. The Terminals host (today's tile-grid-stack) is ALWAYS
  // mounted and CSS-hidden when another mode is active — PTYs must
  // never die to a mode switch (decision card #2). Board/Inbox/Code
  // hosts mount for the active workspace's mode only (pure store views;
  // the editor's loss profile matches today's right-tab switching).
  const activeMode = useUi((s) => effectiveCenterMode(s.centerMode, activeId));
  // v1.76.0 (STEP6 D6): per-workspace open-card state — the center card
  // hosts below read both maps (stable refs; zustand identity rules).
  const centerModes = useUi((s) => s.centerMode);
  const selectedCardIds = useUi((s) => s.selectedCardId);
  // Skills hub H7 (R4): All skills, the first app-level centre page.
  const allSkillsOpen = useUi((s) => s.allSkillsOpen);
  const activeWs = activeId
    ? workspaces.find((w) => w.id === activeId) ?? null
    : null;

  // v1.31.0: per-workspace mount stage (see FINAL_MOUNT_STAGE doc above).
  // A workspace is keyed in here the moment it enters `warmed`; its stage
  // is advanced one step per animation frame until hydration completes.
  const [mountStage, setMountStage] = useState<Record<string, number>>({});
  const cancelStepRef = useRef<(() => void) | null>(null);

  // GH #95 (owner Tier 4): WKWebView keeps the focus on an element that
  // became hidden, so keys typed over the Board went into the hidden editor
  // or terminal. Whenever the visible host changes, release a hidden focus
  // and give it back when its host returns (see `lib/hiddenFocus`). After
  // the commit, so the `.hidden` classes of this render are what is probed.
  const releasedFocus = useRef<HTMLElement | null>(null);
  const openCardId = activeId != null ? selectedCardIds[activeId] : null;
  useLayoutEffect(() => {
    releasedFocus.current = settleFocus(releasedFocus.current);
  }, [activeId, activeMode, openCardId, allSkillsOpen]);

  // Choosing another workspace (the switcher, a row of the stack) is leaving
  // All skills, as choosing a mode is (`setCenterMode`).
  const shownWorkspace = useRef(activeId);
  useEffect(() => {
    if (shownWorkspace.current === activeId) return;
    shownWorkspace.current = activeId;
    useUi.getState().setAllSkillsOpen(false);
  }, [activeId]);

  /**
   * GH #95 (Challenger P1 ×2): Code and the Library are STICKY hosts — the
   * first time a workspace shows one it mounts, and from then on it is
   * only CSS-hidden, one host per warmed workspace (the `.tile-grid-host`
   * pattern). Without this, a mode flip or a workspace switch unmounted
   * `CodeModeHost` (CodeMirror's `EditorView` is destroyed on cleanup —
   * undo history and view state gone) and the Library (whose Notes page is
   * the Knowledge panel, and an unsaved note draft lives in local React
   * state; GH #96 kept the host it inherited). Conditional-on-first-visit
   * rather
   * than always-mounted so a warmed workspace the user never opened in
   * Code still pays nothing for CodeMirror.
   *
   * Keyed `${workspaceId}:${mode}`; entries drop when the workspace leaves
   * `warmed`, alongside its mount stage.
   */
  const [stickyHosts, setStickyHosts] = useState<Record<string, true>>({});
  const stickyMode =
    activeMode === "code" || activeMode === "library" ? activeMode : null;
  useEffect(() => {
    if (activeId == null || stickyMode == null) return;
    const key = `${activeId}:${stickyMode}`;
    setStickyHosts((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, [activeId, stickyMode]);
  useEffect(() => {
    setStickyHosts((prev) => {
      const next: Record<string, true> = {};
      let changed = false;
      for (const key of Object.keys(prev)) {
        if (warmed.has(key.slice(0, key.lastIndexOf(":")))) next[key] = true;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [warmed]);

  // Seed stage 0 for newly-warmed workspaces and drop entries for
  // workspaces that left `warmed` (LRU eviction / removal) so a future
  // re-warm hydrates from the skeleton again.
  useEffect(() => {
    setMountStage((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const id of warmed) {
        if (prev[id] === undefined) changed = true;
        next[id] = prev[id] ?? 0;
      }
      for (const id of Object.keys(prev)) {
        if (!(id in next)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [warmed]);

  // Advance one not-yet-fully-hydrated workspace by one stage per
  // animation frame. Each stage is a separate React commit in a separate
  // event-loop task, so its passive-effect flush can't pile onto another
  // stage's. The effect re-runs after every bump (mountStage dep) and
  // stops scheduling once every warmed workspace has reached the final
  // stage.
  //
  // The *active* workspace is hydrated first: if the user switches to a
  // brand-new workspace while an older one is still mid-hydration, the
  // one actually on screen finishes before we resume background warming.
  // Without this, the active workspace would queue behind the older one's
  // remaining stages and the skeleton would linger longer than the mount
  // actually costs.
  useEffect(() => {
    const order =
      activeId != null && warmed.has(activeId)
        ? [activeId, ...[...warmed].filter((id) => id !== activeId)]
        : [...warmed];
    const incomplete = order.some(
      (id) => (mountStage[id] ?? 0) < FINAL_MOUNT_STAGE,
    );
    if (!incomplete || cancelStepRef.current != null) return;
    // 2026-09-30: a frame, or a timer when WebKit sends no frames (locked
    // screen, covered window) — otherwise the stages stop and the card host
    // never mounts (`lib/nextFrame`).
    cancelStepRef.current = nextFrameOrTimer(() => {
      cancelStepRef.current = null;
      setMountStage((prev) => {
        const next = { ...prev };
        for (const id of order) {
          const stage = next[id] ?? 0;
          if (stage < FINAL_MOUNT_STAGE) {
            next[id] = stage + 1;
            return next;
          }
        }
        return prev;
      });
    });
    return () => {
      if (cancelStepRef.current != null) {
        cancelStepRef.current();
        cancelStepRef.current = null;
      }
    };
  }, [warmed, mountStage, activeId]);

  // v1.31.0: stage of the active workspace's incremental mount.
  //   -1 — `activeId` has flipped (urgent, on the click frame) but the
  //        warming transition in App.tsx hasn't committed it into
  //        `warmed` yet, so it isn't keyed into `mountStage` either.
  //   0..1 — keyed, mounting in chunks (one stage per animation frame).
  //   FINAL_MOUNT_STAGE — fully hydrated.
  // `warming` is true for every state short of full hydration; while it
  // holds, the content stacks show a skeleton instead of a frozen (or
  // empty) frame. Switching to an already-warmed workspace skips this
  // entirely (its stage is already final) so it stays instant.
  const activeStage =
    activeId == null ? FINAL_MOUNT_STAGE : mountStage[activeId] ?? -1;
  const warming = activeId != null && activeStage < FINAL_MOUNT_STAGE;

  return (
    <div className="ws-shell">
      {/* v1.82.0 (Part 2 P2-4, Q2): the AppToolbar is RETIRED — the
          sidebar is the navigation (mode rows + global zone); env/ship/
          settings demoted to its footer; the panel toggles are absorbed
          (mode implies layout; ◨ survives in the footer); ⚡ Now is dead
          (Q3). GH #95: liveness lives in the sidebar under Terminals. */}
      <div className="ws-shell-body">
        {/* UX-3.4: the sidebar is a fixed-pixel column (240, dragged
            200–320, ⌘\\ hides it; below 1000 px an overlay) — no longer a
            percentage panel, so a narrow window never squeezes the stage. */}
        {leftOpen && (
          <SidebarSlot>
            {(onNavigate) => <WorkspaceSidebar env={env} onNavigate={onNavigate} />}
          </SidebarSlot>
        )}
        {gridOpen && (
          <div className="ws-shell-grid shell-stage">
            {/* Skills hub H7: with All skills open every host below stays
                mounted and is hidden by visibility (App.css), never
                unmounted — no terminal or editor dies to a visit there. */}
            <div className={`center-stage${allSkillsOpen ? " center-stage--app-page" : ""}`}>
              {/* v1.113.0: with no workspace the stage had nothing to
                  draw — the only hint was the sidebar's one-liner. The
                  global modes (Inbox, Activity) still own the center
                  when chosen. */}
              {workspaces.length === 0 &&
                activeMode !== "inbox" &&
                activeMode !== "activity" && (
                  <div className="center-mode-host center-empty">
                    {/* QoL 7.2 (B2): the one Add a project sheet. */}
                    <h2 className="center-empty-title">{ADD_PROJECT_LABEL}</h2>
                    <p className="center-empty-sub">
                      Plyloft keeps a Board, terminals and a Library for each
                      project. Add a folder on this{" "}
                      {platform() === "windows" ? "PC" : "Mac"}, get one from
                      GitHub, or start a new one.
                    </p>
                    <CBtn
                      tone="accent"
                      onClick={() => useAddProject.getState().openAddProject()}
                    >
                      {ADD_PROJECT_LABEL}…
                    </CBtn>
                  </div>
                )}
              {/* Terminals mode = today's stack, mounted regardless
                  of mode (CSS-hidden only) so every PTY survives. */}
              <div
                className={`center-mode-host${
                  activeMode === "terminals" ? "" : " hidden"
                }`}
              >
                <div className="tile-grid-stack">
                  {warmed.size === 0 && !warming && <TileGridEmpty />}
                  {[...warmed].map((id) => {
                    const ws = workspaces.find((w) => w.id === id);
                    if (!ws) return null;
                    const visible = id === activeId;
                    const stage = mountStage[id] ?? 0;
                    return (
                      <div
                        key={ws.id}
                        className={`tile-grid-host${visible ? "" : " hidden"}`}
                      >
                        {stage >= 1 && (
                          <CentreErrorBoundary view="Terminals" reach="terminals">
                            <TileGrid
                              env={env}
                              workspace={ws}
                            />
                          </CentreErrorBoundary>
                        )}
                      </div>
                    );
                  })}
                  {warming && <WorkspaceSkeleton />}
                </div>
              </div>
              {activeMode === "board" && activeWs && (
                <div
                  className={`center-mode-host center-mode-board${
                    selectedCardIds[activeWs.id] != null ? " hidden" : ""
                  }`}
                >
                  <CentreErrorBoundary view="The Board" resetKey={activeWs.id}>
                    <KanbanBoard workspaceId={activeWs.id} />
                  </CentreErrorBoundary>
                </div>
              )}
              {/* v1.76.0 (STEP6 D6): the lifecycle owns the center —
                  one always-mounted card host per warmed workspace
                  (the intake xterm must survive workspace switches
                  AND mode flips; same warmed-host pattern as
                  .tile-grid-host). Visible over the Board when that
                  workspace is active and has an open card. Stage 4
                  gates the xterm-backed mount (moved here from
                  RightTabs' deferCardHost). */}
              {[...warmed].map((id) => {
                const stage = mountStage[id] ?? 0;
                const visible =
                  id === activeId &&
                  selectedCardIds[id] != null &&
                  effectiveCenterMode(centerModes, id) === "board";
                return (
                  <div
                    key={id}
                    className={`center-card-host${
                      visible ? "" : " hidden"
                    }`}
                  >
                    {stage >= FINAL_MOUNT_STAGE && (
                      <CentreErrorBoundary view="The card" resetKey={selectedCardIds[id] ?? null}>
                        <CardDetailPanel workspaceId={id} />
                      </CentreErrorBoundary>
                    )}
                  </div>
                );
              })}
              {activeMode === "inbox" && (
                <div className="center-mode-host center-mode-inbox">
                  <CentreErrorBoundary view="The Inbox">
                    <InboxPanel />
                  </CentreErrorBoundary>
                </div>
              )}
              {/* v1.80.0 (P2-2): Activity — global content like Inbox;
                  no PTYs, so conditional mount is safe. */}
              {activeMode === "activity" && (
                <div className="center-mode-host center-mode-activity">
                  <CentreErrorBoundary view="Activity">
                    <ActivityView env={env} />
                  </CentreErrorBoundary>
                </div>
              )}
              {/* Code: one sticky host per warmed workspace (see
                  `stickyHosts`) — the editor survives mode flips and
                  workspace switches with its undo history. */}
              {[...warmed].map((id) => {
                const ws = workspaces.find((w) => w.id === id);
                if (!ws || !stickyHosts[`${id}:code`]) return null;
                const visible = id === activeId && activeMode === "code";
                return (
                  <div
                    key={`code-${id}`}
                    className={`center-mode-host center-mode-sticky${
                      visible ? "" : " hidden"
                    }`}
                  >
                    <CentreErrorBoundary view="Code" reach="code">
                      <CodeModeHost workspaceId={ws.id} cwd={ws.cwd} />
                    </CentreErrorBoundary>
                  </div>
                );
              })}
              {/* Skills hub H7 (R4): All skills — app-level, over every
                  workspace host. No PTY, no editor: mounted while open. */}
              {allSkillsOpen && (
                <div className="center-mode-host center-mode-allskills">
                  <CentreErrorBoundary view="All skills">
                    <ModeHeader mode={null} label="All skills" title={null} />
                    <AllSkillsPage />
                  </CentreErrorBoundary>
                </div>
              )}
              {/* GH #96 (ADR 0005): the Library — Instructions · Skills ·
                  Notes across the four scopes, the centre mode that
                  replaced the temporary Knowledge one. Sticky host, for
                  the same reason Knowledge was: its Notes page is the
                  Knowledge panel, and an unsaved draft is local React
                  state. Hidden by `visibility`, so no terminal and no
                  editor is ever unmounted by a visit here. */}
              {[...warmed].map((id) => {
                const ws = workspaces.find((w) => w.id === id);
                if (!ws || !stickyHosts[`${id}:library`]) return null;
                const visible = id === activeId && activeMode === "library";
                return (
                  <div
                    key={`library-${id}`}
                    className={`center-mode-host center-mode-sticky center-mode-library${
                      visible ? "" : " hidden"
                    }`}
                  >
                    {/* UX-3.5: the screen header; the Library's own
                        pages keep their titles underneath. */}
                    <CentreErrorBoundary view="The Library">
                      <ModeHeader mode="library" workspaceId={ws.id} />
                      <LibraryModeHost
                        workspaceId={ws.id}
                        cwd={ws.cwd}
                        visible={visible}
                      />
                    </CentreErrorBoundary>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
