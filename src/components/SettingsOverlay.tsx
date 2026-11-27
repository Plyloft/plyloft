import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useTeamModels } from "../store/teamModelsStore";
import { useUi } from "../store/uiStore";
import { useSettings, type SurfaceSize } from "../store/settingsStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useDefinitionReading } from "../store/definitionReadStore";
import { useProjectPageReads } from "../hooks/useProjectPageReads";
import { useBoundedHold } from "../hooks/useBoundedHold";
import { planSearchFlags } from "../lib/planPage";
import { useAccount, useTeamAllowed } from "../store/accountStore";
import { useSolo } from "../store/workModeStore";
import { showKanbanBacking } from "../lib/adoption";
import {
  SOLO_HIDDEN_NOTE,
  WORK_WITH_A_TEAM,
  entryHiddenInSolo,
  entryWords,
  fitSettingsSize,
  flowOfLink,
  isCompactNav,
  groupOf,
  isPartId,
  partAnchorId,
  partIsItsPage,
  linkHiddenInSolo,
  navGroups as navGroupsFor,
  reopenEntry,
  retiredLinkNote,
  movedRow,
  movedRowNote,
  movedRowFoundBy,
  settingsLinkTarget,
  type EntryId,
} from "../lib/settingsNav";
import { ELSEWHERE, currentValueOf, entryOfRowToken, visibleIndex } from "../lib/settingsIndex";
import { openCenterMode, openLibraryPage } from "../store/uiStore";
import { useKanban } from "../store/kanbanStore";
import { keptBranches } from "../lib/branchCleanup";
import { EMPTY_ARRAY } from "../lib/empties";
import { openWhatsNew, useHelp } from "../store/helpStore";
import { openGuide } from "../store/tutorialStore";
import { openUserGuide } from "./tutorial/HelpMenu";
import {
  NO_LANDING,
  absentRowNote,
  rowLanding,
  rowToken,
  searchElsewhere,
  searchSettings,
  type ElsewhereEntry,
  type SettingsSearchResult,
} from "../lib/settingsSearch";
import type { Values } from "../lib/repositoryPage";
import { useDialogFocus } from "../lib/dialogFocus";
import { leavePage } from "../lib/leaveGuard";
import { sheetAbove } from "../lib/visibleModal";
import {
  closeSettingsFlow,
  useSettingsFlow,
  type SettingsFlowId,
} from "../store/settingsFlowStore";
import { useAdoptionStatus } from "./AdoptionBanner";
import { SettingsApp } from "./SettingsApp";
import { useRepositoryDefinition } from "../hooks/useRepositoryDefinition";
import { CIcon, FoundRow, NavList, NavMenuButton, Page, ProjectShareableContext, SearchField, SearchResults } from "./ux";
import { projectShareable } from "../lib/uxScope";
import { modOnly } from "../lib/platform";
import { shortcutKeys } from "../lib/shortcuts";
import { setupIsOpen } from "../store/setupStore";

/** How long the row a search landed on keeps its outline and its `Found here`
 *  (BOARDS.md §6: both gone after two seconds). */
const FOUND_MS = 2000;

/**
 * UX language card 1 (ADR 0004; docs/ux-language/boards/BOARDS.md §2): the
 * Settings shell. A large modal over the app — resizable, its size
 * remembered on this Mac (`settings.json` › `windows.settings`), default
 * 1100 × 800, least 820 × 560 — with a 44 px header (`Settings`, `⌘,`, ✕;
 * Esc closes) and a 240 px navigation by scope, which becomes a menu in the
 * header below 900 px. The pages are SettingsApp's; the old panels sit
 * under each page's header unchanged until their own card migrates them.
 *
 * Card 7 (GH #107) switched the search field on. Since UX-9.4 the results
 * are drawn in the page area, full width, while the field holds text — the
 * navigation stays beside them, and the page stays mounted underneath. Enter
 * or a click opens the page, scrolls to the row and marks it for two seconds.
 * Settings reopens on the page it was on when it last closed (UX-9.4). Esc clears the
 * field first — `ux/useEscapeFirst` answers on `window` one step before the
 * dialog stack — and closes Settings once it is empty. ⌘F puts the caret back
 * in the field.
 */
export function SettingsOverlay() {
  const open = useUi((s) => s.settingsOverlayOpen);
  if (!open) return null;
  return <SettingsSurface />;
}

function SettingsSurface() {
  const setOpen = useUi((s) => s.setSettingsOverlayOpen);
  // GH #103: a flow is a focused surface with no navigation beside it
  // (PATTERNS.md §6). It lives in a store slot so this shell can take the
  // navigation away while one is up, the way the Library's host does.
  const flow = useSettingsFlow((s) => s.flow);
  // GH #107: what the search field holds. Declared here because Esc's order
  // below is written in terms of it.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  // The field's id is made with `useId()` further down, where the field is; Esc
  // needs it up here, and a ref carries it without moving either.
  const searchIdRef = useRef("");
  // UX language card 2: a page holding changes nobody else has asks once
  // before Settings closes or switches entry (BOARDS.md §6).
  const close = useCallback(() => {
    closeSettingsFlow();
    leavePage(() => setOpen(false));
  }, [setOpen]);
  // Esc takes the flow down first, the way it closes a sheet before the
  // surface under it: a flow is the thing in front of you. Then it clears the
  // search field, and only an empty field lets it close Settings (GH #107).
  // A filled field that has the focus clears itself one step earlier
  // (ux/useEscapeFirst); this is the same order for a focus that has moved on
  // to a result.
  const dismiss = useCallback(() => {
    if (useSettingsFlow.getState().flow !== null) {
      closeSettingsFlow();
      return;
    }
    if (query.trim().length > 0) {
      setQuery("");
      // The focus may be on a result that is about to go; Esc should leave it
      // where the next keystroke belongs, not on the document (review 1, N10).
      const field = document.getElementById(searchIdRef.current);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    close();
  }, [close, query]);
  // A flow never outlives the page that opened it.
  useEffect(() => closeSettingsFlow, []);
  const saved = useSettings((s) => s.settings.windows?.settings ?? null);

  // ── Size: what the person asked for, fitted to the window ──────────
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [wanted, setWanted] = useState<SurfaceSize | null>(saved);
  const dragging = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const size = fitSettingsSize(wanted, viewport);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!dragging.current) setWanted(saved);
  }, [saved]);

  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persist = useCallback((next: SurfaceSize) => {
    // Only the size, applied to the settings as they are when the write
    // runs: a preference save in flight is never undone (Challenger F1).
    void useSettings
      .getState()
      .update((latest) => {
        const was = latest.windows?.settings;
        if (was && was.width === next.width && was.height === next.height) return latest;
        return { ...latest, windows: { ...latest.windows, settings: next } };
      })
      .catch((e) => console.warn("settings size not saved:", e));
  }, []);

  function onGripDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height };
  }
  function onGripMove(e: PointerEvent<HTMLDivElement>) {
    const d = dragging.current;
    if (!d) return;
    // The modal is centred, so each edge moves by half the change.
    setWanted(
      fitSettingsSize(
        { width: d.w + 2 * (e.clientX - d.x), height: d.h + 2 * (e.clientY - d.y) },
        viewport,
      ),
    );
  }
  function onGripUp() {
    if (!dragging.current) return;
    dragging.current = null;
    persist(sizeRef.current);
  }
  function onGripKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 64 : 16;
    const delta: Record<string, [number, number]> = {
      ArrowRight: [step, 0],
      ArrowLeft: [-step, 0],
      ArrowDown: [0, step],
      ArrowUp: [0, -step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const next = fitSettingsSize(
      { width: size.width + d[0], height: size.height + d[1] },
      viewport,
    );
    setWanted(next);
    persist(next);
  }

  // ── Navigation by scope ─────────────────────────────────────────────
  const activeWs = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));
  const activeId = activeWs?.id ?? null;
  const { status, settled, changing } = useAdoptionStatus(activeId);
  const definitionReading = useDefinitionReading(activeId);
  // Two-account walk: where the cards live isn't known before the status's first
  // answer, while a read of the definition may be about to change it, or until
  // the status after a read that changed something lands. Never for long.
  const boardReading = useBoundedHold(
    !!activeId && (!settled || changing || definitionReading),
    activeId,
  );
  const licensed = useTeamAllowed();
  // The repository's shared definition sets the board: Board and worktrees
  // says so in the Board part, and a search leaves the Board rows out.
  const boardNotSetByRepository =
    !activeWs ||
    showKanbanBacking(status, licensed, activeWs.kanbanSyncMode === "githubIssues");
  // UX-9.3: every entry is shown, whatever the workspace — a page with
  // nothing to show says so on the page, never by disappearing. The one
  // exception is solo mode (onboarding §10 row 1): the Team group is not drawn.
  const solo = useSolo();
  const groups = navGroupsFor(solo);
  // UX-9.4: Settings reopens on the page it was on when it last closed,
  // remembered on this Mac (`settings.json` › `windows.settingsPage`). An id
  // from before C9 opens the page that holds it now; anything else, Appearance.
  const remembered = useSettings((s) => s.settings.windows?.settingsPage ?? null);
  const [entry, setEntry] = useState<EntryId>(() => reopenEntry(remembered, solo));
  // Settings can open before `settings.json` has been read; the page it names
  // is taken once it arrives, unless the person or a link has moved already.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) return;
    const next = reopenEntry(remembered, solo);
    // OB-9: a remembered Team page redirected to Setup counts as a move, so
    // turning Work with a team on there does not pull the page back to Team.
    if (solo && remembered && next === "setup" && remembered !== "setup") moved.current = true;
    setEntry(next);
  }, [remembered, solo]);
  // OB-9: a page solo mode hides is never left on screen — the mode can turn
  // while Settings is open (Setup's step 2, another window's save).
  useEffect(() => {
    if (solo && entryHiddenInSolo(entry)) {
      moved.current = true;
      setEntry("setup");
    }
  }, [solo, entry]);
  useEffect(() => {
    if (!moved.current) return;
    // Only the page, applied to the settings as they are when the write runs,
    // like the size above: a preference save in flight is never undone.
    void useSettings
      .getState()
      .update((latest) =>
        latest.windows?.settingsPage === entry
          ? latest
          : { ...latest, windows: { ...latest.windows, settingsPage: entry } },
      )
      .catch((e) => console.warn("settings page not remembered:", e));
  }, [entry]);
  // GH #171: a link to a retired page (Agents, Role bindings, Swarm templates)
  // lands on the page that replaced it and says why, until the person moves.
  const [retiredNote, setRetiredNote] = useState<string | null>(null);
  const shown = entry;
  // Two-account walks: Settings › Project keeps the project's definition current
  // while it is open, so a member doesn't act on the last read's answer.
  useProjectPageReads(activeId, groupOf(shown).id === "project", shown, !!status?.hasDefinition && !solo);
  /** Every way of choosing a page — the navigation, a result, a link. */
  const goTo = useCallback((id: EntryId) => {
    moved.current = true;
    setEntry(id);
  }, []);
  const note = retiredNote;
  // Read by the callback that answers "the page drew no such row", which must
  // not be rebuilt on every page change. Written after the commit, not during
  // the render (review 2, F5).
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  // ── Search (GH #107) ────────────────────────────────────────────────
  // What the pages themselves use to decide whether a conditional row is
  // drawn, so the search offers exactly the rows that are there.
  // Onboarding §11.1: the team this Mac is in — the setting.
  const settingsTeamRepo = useSettings((s) => s.settings.team?.teamRepo ?? null);
  // Launch A3: Settings › Plan offers Manage subscription to a Team owner, and Start a team to anyone not on one.
  const accountInfo = useAccount((s) => s.info);
  const teamShared = useTeamModels(activeWs?.id).shared;
  const hasKeptBranches = useKanban(
    (s) => keptBranches((activeWs && s.byWorkspace[activeWs.id]?.cards) || EMPTY_ARRAY).length > 0,
  );
  const visibility = useMemo(
    () => ({
      boardNotSetByRepository,
      boardIsGithubBacked: activeWs?.kanbanSyncMode === "githubIssues",
      hasTeam: settingsTeamRepo !== null,
      ...planSearchFlags(accountInfo),
      // Who owns the team is in the manifest, which only Team's own read reads:
      // left open here, and landing on such a row says so.
      isTeamOwner: true,
      // §10: solo mode hides the Team pages and the GitHub Issues board from
      // the search, as it does from the pages.
      teamMode: !solo,
      // 1.169.0 (A2): Suggested for the team is drawn for a shared repository only.
      repositorySharesSettings: teamShared,
      // 1.174.0 (DS2): Shipping's Kept after shipping, drawn when the
      // cleanup kept a branch.
      hasKeptBranches,
    }),
    [
      solo,
      teamShared,
      hasKeptBranches,
      boardNotSetByRepository,
      activeWs?.kanbanSyncMode,
        settingsTeamRepo,
        accountInfo,
    ],
  );
  const searchId = useId();
  useEffect(() => {
    searchIdRef.current = searchId;
  }, [searchId]);
  const headingId = useId();
  // The row a search (or a link) landed on: marked, in view, and forgotten two
  // seconds later — and, when the page drew no such row, the sentence that says
  // so. Which of those is true when is `rowLanding`'s, in the pure layer, where
  // the order can be tested (review 2, F1). Nothing about it is stored.
  const [landing, dispatch] = useReducer(rowLanding, NO_LANDING);
  const { token: foundToken, nonce: foundNonce, marked, absent, focus: foundFocus } = landing;
  const foundTimer = useRef<number | null>(null);
  const markFound = useCallback((token: string, focus = false) => {
    if (foundTimer.current !== null) window.clearTimeout(foundTimer.current);
    dispatch({ kind: "land", token, focus });
    foundTimer.current = window.setTimeout(() => {
      foundTimer.current = null;
      dispatch({ kind: "forget" });
    }, FOUND_MS);
  }, []);
  /** Every way of moving that is not a landing: nothing said about the row
   *  survives it. */
  const leaveRow = useCallback(() => {
    if (foundTimer.current !== null) window.clearTimeout(foundTimer.current);
    foundTimer.current = null;
    dispatch({ kind: "leave" });
  }, []);
  useEffect(
    () => () => {
      if (foundTimer.current !== null) window.clearTimeout(foundTimer.current);
    },
    [],
  );

  // The repository's own values, so a result can show what a shared setting
  // holds (`Verify pipeline · npm run verify`). Read only while somebody is
  // searching, by the same hook the Repository pages use.
  const [repoValues, setRepoValues] = useState<Values | null>(null);
  const settings = useSettings((s) => s.settings);
  // A link can name a row the open page does not draw — a conditional row, or
  // one whose condition the caller could not know. Landing on nothing has to
  // say so, in the page's own status line (review 1, MAJOR 2).
  const onRowMissing = useCallback((token: string) => {
    dispatch({
      kind: "missing",
      token,
      note: absentRowNote(token, entryOfRowToken(token, shownRef.current)),
    });
  }, []);
  /** The row turned up after all — late reads do that — so the sentence goes. */
  // Walk 3: arriving from the sidebar opens Settings first, and its page
  // draws the row after the two seconds had begun: the mark counts its two
  // seconds from the row's arrival, once per landing.
  const nonceNow = useRef(foundNonce);
  nonceNow.current = foundNonce;
  const restartedFor = useRef(-1);
  const onRowArrived = useCallback((token: string) => {
    dispatch({ kind: "arrived", token });
    if (foundTimer.current !== null && restartedFor.current !== nonceNow.current) {
      restartedFor.current = nonceNow.current;
      window.clearTimeout(foundTimer.current);
      foundTimer.current = window.setTimeout(() => {
        foundTimer.current = null;
        dispatch({ kind: "forget" });
      }, FOUND_MS);
    }
  }, []);

  // DS8: the version decides whether a moved row's old name is said (read
  // by Help at launch; unknown says it).
  const appVersion = useHelp((s) => s.version);
  const results = useMemo(
    () =>
      // A row that is not drawn is not offered (the two swarm notifications
      // with advanced swarms off); a page that is not shown still is, because
      // a link to one lands on the nearest one that is, and says so.
      searchSettings(query, visibleIndex(visibility), {
        // Not `entry`: that is the page this shell is showing.
        currentValue: (item) => currentValueOf(item, settings, repoValues),
        appVersion,
      }),
    [query, settings, repoValues, visibility, appVersion],
  );
  // 1.169.0 walk: nothing drawn matched — a row the conditions hide may have;
  // its own note says why it isn't here (the team's rows without a shared
  // repository).
  const absentNote = useMemo(() => {
    if (!query.trim() || results.length > 0) return null;
    const hidden = searchSettings(query, visibleIndex({ ...visibility, repositorySharesSettings: true }), {
      currentValue: (item) => currentValueOf(item, settings, repoValues),
    });
    const note = hidden.map((r) => r.entry.absentNote).find(Boolean);
    return note ?? null;
  }, [query, results.length, visibility, settings, repoValues]);

  // 1.174.0 (DS1): the part a link named, until it is on screen.
  const [partTarget, setPartTarget] = useState<string | null>(null);
  const deepLink = useUi((s) => s.settingsSection);
  const deepLinkRow = useUi((s) => s.settingsRow);
  const deepLinkFocus = useUi((s) => s.settingsRowFocus);
  const consumeSettingsSection = useUi((s) => s.consumeSettingsSection);
  useEffect(() => {
    if (!deepLink) return;
    // §10 row 1: in solo mode a link to a Team page opens Account › Setup with `Work with a team` marked, and the
    // status line says why.
    if (solo && linkHiddenInSolo(deepLink)) {
      closeSettingsFlow();
      leavePage(() => {
        goTo("setup");
        setRetiredNote(SOLO_HIDDEN_NOTE);
        markFound(WORK_WITH_A_TEAM);
      });
      consumeSettingsSection();
      return;
    }
    // 1.174.0 (DS2): a link that names a row by its old words lands on the
    // row as it is now, and the status line says so (scene 15).
    const moved = movedRow(deepLink, deepLinkRow);
    const target = moved ? moved.to : settingsLinkTarget(deepLink);
    // A deep link moves the page too, so it asks about a draft like any
    // other way out (card #94 review, F13).
    if (target) {
      closeSettingsFlow();
      const row = moved ? moved.now : deepLinkRow;
      const retired = moved ? movedRowNote(moved) : retiredLinkNote(deepLink);
      const flowLink = flowOfLink(deepLink);
      leavePage(() => {
        goTo(target);
        setRetiredNote(retired);
        // A link that names a flow (`board-repo`) opens it on its page.
        if (flowLink) useSettingsFlow.getState().open(flowLink as SettingsFlowId);
        // GH #107: a link may name a row as well as a page (the command
        // palette's `Settings: Verify pipeline`); one that names no row moves
        // the page, so nothing said about the last row holds.
        if (row) markFound(row, deepLinkFocus);
        else leaveRow();
        // 1.174.0 (DS1): a link that names a part (`board`, drawn on
        // General) lands on the part, not on the top of the page.
        // 1.174.0 (DS5): a part that is its whole page (`worktrees`, Cards'
        // copies) has no anchor of its own: the page's top is where it is.
        if (!row && !flowLink && isPartId(deepLink) && !partIsItsPage(deepLink)) {
          setPartTarget(partAnchorId(deepLink));
        }
      });
    }
    consumeSettingsSection();
  }, [deepLink, deepLinkRow, deepLinkFocus, consumeSettingsSection, markFound, leaveRow, goTo, solo]);

  // The part may be drawn after the page's first read has landed: wait for
  // it (a few seconds at most), then bring it to the top of the page.
  useEffect(() => {
    if (!partTarget) return;
    const root = surface.current;
    let done = false;
    const land = () => {
      const el = document.getElementById(partTarget);
      if (!el || done) return false;
      done = true;
      el.scrollIntoView?.({ block: "start" });
      setPartTarget(null);
      return true;
    };
    if (land()) return;
    const watch = new MutationObserver(() => {
      if (land()) watch.disconnect();
    });
    if (root) watch.observe(root, { childList: true, subtree: true });
    const giveUp = window.setTimeout(() => {
      watch.disconnect();
      setPartTarget(null);
    }, 5000);
    return () => {
      done = true;
      watch.disconnect();
      window.clearTimeout(giveUp);
    };
  }, [partTarget]);

  // ⌘F puts the caret in the field while Settings is open. Captured, so the
  // app's own ⌘⇧F and a tile's find are not what answers it; and only when
  // the field is really there (a flow takes it away), so nothing else is
  // swallowed. A dialog or a sheet above Settings keeps it, the way it keeps
  // Esc (`yieldTo` below): pulling the focus behind a surface the person is
  // looking at is worse than not answering at all (review 1, N7).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      if (!modOnly(e)) return;
      if (e.key.toLowerCase() !== "f") return;
      if (sheetAbove()) return;
      const el = document.getElementById(searchId);
      if (!(el instanceof HTMLInputElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      el.focus();
      el.select();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [searchId]);

  // ── Esc closes; Tab stays inside; focus comes back where it was ──────
  // The shared dialog stack (lib/dialogFocus): a dialog opened from a page
  // (a confirmation, the template editor) is above Settings and takes Esc
  // first; a menu or a filled search field takes it before either
  // (ux/useEscapeFirst). A sheet the user can actually see — drawn over
  // Settings, wherever it was opened from — keeps Settings open
  // (Challenger F6, F7, F13) and gets Esc and Tab itself: Settings leaves
  // both keys to it (owner-side review). One parked in a hidden workspace
  // host does not.
  const surface = useRef<HTMLDivElement>(null);
  useDialogFocus({
    containerRef: surface,
    initialFocusRef: surface,
    onDismiss: dismiss,
    yieldTo: () => sheetAbove(),
  });

  const compact = isCompactNav(size.width);
  const navGroups = groups.map((g) => ({
    label: g.label,
    icon: g.icon,
    entries: g.entries.map((e) => ({
      id: e.id,
      label: entryWords(e.id).label,
    })),
  }));
  const select = (id: string) => {
    closeSettingsFlow();
    leavePage(() => {
      goTo(id as EntryId);
      leaveRow();
      setRetiredNote(null);
      // UX-9.4: the navigation stays beside the results; choosing a page from
      // it is done searching.
      setQuery("");
    });
  };
  // A result opens its page and marks its row. UX-9.4: the results are drawn in
  // the page area, over the page, so landing clears the field to show it.
  // QoL 1.168 G2: what is not in Settings — Help, the Library — and the
  // whole app's search when Settings has nothing.
  const elsewhere = useMemo(
    () => searchElsewhere(query, ELSEWHERE, { hasWorkspace: Boolean(activeWs) }),
    [query, activeWs],
  );
  const leaveSettingsFor = (then: () => void) => {
    closeSettingsFlow();
    leavePage(() => {
      setOpen(false);
      then();
    });
  };
  const openElsewhere = (e: ElsewhereEntry) =>
    leaveSettingsFor(() => {
      switch (e.id) {
        case "shortcuts":
          useUi.getState().setShortcutsOpen(true);
          return;
        case "skills":
        case "instructions":
          if (activeWs) openLibraryPage(activeWs.id, e.id);
          return;
        case "whats-new":
          openWhatsNew();
          return;
        case "guide":
          openUserGuide();
          return;
        case "getting-started":
          void openGuide();
          return;
        // 1.174.0 (DS8): the Board's ⋯ entries, on the open workspace's Board.
        case "go-live":
        case "release":
          if (activeWs) {
            openCenterMode(activeWs.id, "board");
            // An open card's page covers the Board; what the ask opens
            // is drawn over the Board itself.
            useUi.getState().selectCard(activeWs.id, null);
            useUi.getState().askBoard(activeWs.id, e.id);
          }
          return;
        case "my-library":
          useUi.getState().setAllSkillsOpen(true);
          return;
      }
    });
  const searchApp = () => {
    const typed = query.trim();
    leaveSettingsFor(() => useUi.getState().openPalette("commands", typed));
  };
  const openResult = (result: SettingsSearchResult) => {
    closeSettingsFlow();
    leavePage(() => {
      goTo(result.entry.page);
      // G1 walk: found by a moved row's old name, it says so, as a link does.
      const moved = result.entry.kind === "setting" ? movedRowFoundBy(result.entry.page, result.entry.label, query) : null;
      setRetiredNote(moved ? movedRowNote(moved) : null);
      // A page result is not about a row, so nothing said about the last one is
      // true any more (review 2, F1).
      if (result.entry.kind === "setting") markFound(rowToken(result.entry));
      // G2 walk: a page result with a row of its own name marks that row.
      else if (result.landsOn) markFound(result.landsOn);
      else leaveRow();
      setQuery("");
    });
  };
  const openFirstResult = () => {
    const first = results[0];
    if (first) openResult(first);
  };
  const field = (
    <SearchField
      value={query}
      onChange={setQuery}
      placeholder="Search settings"
      inputId={searchId}
      onEnter={openFirstResult}
      describedBy={searching ? headingId : undefined}
    />
  );

  return (
    <div className="ux-backdrop" onClick={close}>
      <div
        ref={surface}
        className="ux-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        style={{ width: size.width, height: size.height }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ux-surface-header">
          <h2 className="ux-surface-title">Settings</h2>
          {compact && !flow && (
            <>
              <NavMenuButton
                groups={navGroups}
                active={shown}
                onSelect={select}
                label="Settings sections"
              />
              {field}
            </>
          )}
          <span className="ux-surface-spacer" />
          <span className="ux-surface-shortcut" aria-hidden>
            {shortcutKeys("settings")}
          </span>
          <CIcon
            icon="close"
            className="ux-icon-sm"
            aria-label="Close settings"
            title="Close settings (Esc)"
            onClick={close}
          />
        </div>
        <div className="ux-surface-body">
          {!compact && !flow && (
            <div className="ux-surface-nav">
              {field}
              {/* UX-9.4: the navigation stays while the field holds text; the
                  results are drawn in the page area, full width. GH #316: the
                  results are then the one current view, so no entry is marked;
                  choosing one still opens it and ends the search. */}
              <NavList
                groups={navGroups}
                active={searching ? null : shown}
                onSelect={select}
                label="Settings sections"
              />
            </div>
          )}
          <div className="ux-surface-main">
            {searching && !flow && (
              <Page>
                <SearchResults
                  query={query}
                  results={results}
                  headingId={headingId}
                  onOpen={openResult}
                  elsewhere={elsewhere}
                  onElsewhere={openElsewhere}
                  onSearchApp={searchApp}
                  absentNote={absentNote}
                />
              </Page>
            )}
            {/* The page stays mounted under the results — hidden, not gone — so
                a draft on it survives a search (a Repository page's changes
                not yet published). */}
            <div className="ux-surface-page" hidden={searching && !flow}>
              <FoundRow
                token={foundToken}
                nonce={foundNonce}
                marked={marked}
                focus={foundFocus === true}
                onArrived={onRowArrived}
                onMissing={onRowMissing}
              >
                {/* G3a walk: every project mark of every page knows whether
                    this project can be shared at all. */}
                <ProjectShareableContext.Provider value={projectShareable(status, solo)}>
                  <SettingsApp
                    entry={shown}
                    hiddenNote={note ?? absent}
                    boardSetByRepository={!boardNotSetByRepository}
                    boardAdoption={status}
                    boardReading={boardReading}
                  />
                </ProjectShareableContext.Provider>
              </FoundRow>
            </div>
          </div>
        </div>
        {searching && activeWs && (
          <RepositoryValues workspaceId={activeWs.id} onValues={setRepoValues} />
        )}
        <div
          className="ux-surface-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize settings, ${size.width} by ${size.height}. Arrow keys resize.`}
          tabIndex={0}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onKeyDown={onGripKey}
        />
      </div>
    </div>
  );
}

/**
 * The repository's own settings, for the results that show what a shared
 * setting holds (`Verify pipeline · npm run verify`). It draws nothing: it
 * exists so the read happens while somebody is searching rather than on every
 * ⌘,.
 *
 * It is the hook the two Repository pages use — no new IPC command, no new
 * subscription kind — but it **is** a second reader: searching while Build &
 * release or General is open reads the definition twice, once for the page and
 * once for the results (review 1, MINOR 6). Lifting the page's own values out
 * of it would mean a context around the whole router for a value only the
 * results use; the read is three commands on a query and none at rest.
 */
function RepositoryValues({
  workspaceId,
  onValues,
}: {
  workspaceId: string;
  onValues: (values: Values | null) => void;
}) {
  const repo = useRepositoryDefinition(workspaceId);
  const values = repo.loading ? null : repo.values;
  useEffect(() => {
    onValues(values);
  }, [values, onValues]);
  return null;
}
