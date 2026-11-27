import { useCompare } from "../store/compareStore";
import { useEffect, useMemo, useRef, useState } from "react";
import { checkForUpdates } from "./tutorial/HelpMenu";
import { useReleaseScopes, useScopesReading } from "../store/releaseScopeStore";
import { openRelease } from "../store/projectRelease";
import { useAreasView } from "../store/areaStore";
import { pickerAreas } from "../lib/areaPicker";
import { openProgramFoldersAction } from "../lib/errorButtons";
import { openRepair } from "../lib/openRepair";
import { repairLabel } from "../lib/startFailure";
import { hasPathOverride } from "../lib/diagnostics";
import { releaseLabel } from "../lib/projectRelease";
import { releaseOpener } from "../lib/releaseSheet";
import { fuzzyScore } from "../lib/fuzzyScore";
import { useWorkspaces } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import type { KanbanCard } from "../ipc";
import { useAgents } from "../store/agentStore";
import { isFileDirty, useEditor } from "../store/editorStore";
import { saveAllInWorkspace } from "../lib/editorSave";
import { useTiles } from "../store/tileStore";
import {
  goToCenterMode,
  openCenterMode,
  toggleSidebar,
  useUi,
  type CenterMode,
  type PaletteScope,
} from "../store/uiStore";
import { pushToast } from "../store/toastStore";
import { requestBoardNewTask, requestBoardPrReview } from "../lib/boardCommands";
import { ADD_PROJECT_LABEL, useAddProject } from "../store/addProjectStore";
import {
  INSTALLED_SELF_CHECK_QUERY,
  hiddenSelfCheckCommandVisible,
} from "../lib/installedSelfCheck";
import { currentValueOf, visibleIndex } from "../lib/settingsIndex";
import { rowToken, searchSettings } from "../lib/settingsSearch";
import { entryById } from "../lib/settingsNav";
import { shortcutKeys } from "../lib/shortcuts";
import { useSettings } from "../store/settingsStore";
import { planSearchFlags } from "../lib/planPage";
import { useAccount } from "../store/accountStore";
import { useSolo } from "../store/workModeStore";
import { useNeedsYou } from "../hooks/useNeedsYou";
import { Icon, type IconName } from "./ux";
import { MODE_LABEL } from "./ModeHeader";
import { TextResults, openWorkspaceFile, useFileMatches } from "./PaletteScopes";
import { HistoryResults } from "./HistoryResults";
import { mod } from "../lib/platform";
import { basename as pathBasename, dirname, lastSeparator, relativeTo } from "../lib/paths";
import { setupIsOpen, useSetup } from "../store/setupStore";
import { CREATE_AND_PLAN_LABEL } from "../lib/planExchangeView";
import { usePlanExchange } from "../store/planExchangeStore";
import { FailureText } from "./ux/FailureText";
import { focusActivePane, openNewTile, showTile, useDefaultNewTileKind } from "../store/tileActions";
import type { ShellEnvInfo } from "../ipc";
import { pushErrorToast } from "../lib/errorToast";

/** How many matches the list shows at once, and how many of them a Settings
 *  search may take (GH #107). */
const MAX_MATCHES = 60;
const SETTINGS_SLOTS = 12;
/** How many file names the Commands scope shows under a query. */
const FILES_IN_COMMANDS = 5;
/** QoL 1.168 (block 10, C6): how many of the workspace's cards the Commands
 *  scope shows under a query, by title or #issue. */
const CARDS_IN_COMMANDS = 5;
const NO_CARDS: KanbanCard[] = [];

type Command = {
  id: string;
  label: string;
  hint?: string;
  /** The row's tooltip — what the first layer leaves out (a path). */
  title?: string;
  group?: string;
  /** The Lucide icon by meaning, when the command has one. */
  icon?: IconName;
  /** The caption it is listed under; "Commands" unless said. */
  section?: string;
  /** Switches the scope instead of closing the surface. */
  keepOpen?: boolean;
  /** G2 (1.173.0): an old name that still finds it, never shown. */
  aliases?: string[];
  run: () => void;
};

type Props = {
  activeWorkspaceId: string | null;
  claudeAvailable: boolean;
  /** Post-1.167 block A: the shell environment, for New Codex session
   *  (shown when Codex is on PATH). */
  env?: ShellEnvInfo | null;
  onOpenInstalledSelfCheck: () => void;
};

/** The four scopes, in the order of their tabs. */
export const PALETTE_SCOPES: {
  id: PaletteScope;
  label: string;
  shortcut: string;
  placeholder: string;
}[] = [
  {
    id: "commands",
    label: "Commands",
    shortcut: "palette",
    placeholder: "Search commands, files and settings",
  },
  { id: "files", label: "Files", shortcut: "files", placeholder: "Find a file by name" },
  {
    id: "text",
    label: "In files",
    shortcut: "text",
    placeholder: "Search text in this workspace",
  },
  {
    id: "history",
    label: "History",
    shortcut: "history",
    placeholder: "Search inside past sessions",
  },
];

const MODE_ICON: Record<CenterMode, IconName> = {
  inbox: "inbox",
  board: "board",
  code: "code",
  terminals: "terminals",
  activity: "history",
  library: "library",
};

/** GH #284: where a settings row lives — its trail without the row itself. */
function placeOf(trail: string): string {
  return trail.split(" › ").slice(0, -1).join(" › ");
}

/** GH #284: a row's label, with its page named when the label alone is the
 *  same on every page that has it. */
function settingsRowLabel(entry: { page: string; label: string }): string {
  if (entry.label === "Reset this page to defaults") {
    return `Reset ${entryById(entry.page as Parameters<typeof entryById>[0]).label} to defaults`;
  }
  return entry.label;
}

/**
 * UX-3.6 (the Shell board): the one search surface. ⌘K opens it on Commands;
 * ⌘P on Files (what Quick Open did), ⌘⇧F on text In files (the search modal),
 * ⌘⇧H on History (the history search modal). One field, one chrome; the
 * scopes are tabs, and the query travels when the scope changes. Each scope
 * keeps its own back end and IPC.
 */
export function CommandPalette({
  activeWorkspaceId,
  claudeAvailable,
  env = null,
  onOpenInstalledSelfCheck,
}: Props) {
  const codexAvailable = Boolean(env?.codexPath);
  const open = useUi((s) => s.palette.open);
  const scope = useUi((s) => s.palette.scope);
  const onClose = useUi((s) => s.closePalette);
  const setScope = (next: PaletteScope) => {
    useUi.getState().openPalette(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // QoL 1.168 (block 10, C6): the Board's cards, found from anywhere.
  const boardCards = useKanban((s) =>
    activeWorkspaceId ? s.byWorkspace[activeWorkspaceId]?.cards ?? NO_CARDS : NO_CARDS,
  );
  const setActiveWorkspace = useWorkspaces((s) => s.setActive);
  const wsAgents = useAgents((s) =>
    activeWorkspaceId ? s.byWorkspace[activeWorkspaceId] : undefined,
  );
  const startRun = useAgents((s) => s.startRun);
  const setSelectedRun = useAgents((s) => s.setSelectedRun);
  const editor = useEditor((s) =>
    activeWorkspaceId ? s.byWorkspace[activeWorkspaceId] : undefined,
  );
  const setActiveFile = useEditor((s) => s.setActive);
  const defaultTileKind = useDefaultNewTileKind(env);
  // 1.174.0 (DR3): the active project's areas and what each would release,
  // read when the palette opens.
  const releaseView = useAreasView(activeWorkspaceId ?? null);
  const releaseAreas = useMemo(() => pickerAreas(releaseView), [releaseView]);
  const releaseScopesNow = useScopesReading(activeWorkspaceId ?? null).scopes;
  useEffect(() => {
    if (open && activeWorkspaceId) void useReleaseScopes.getState().read(activeWorkspaceId);
  }, [open, activeWorkspaceId]);
  // GH #107: the rows that are drawn right now, so the palette never offers a
  // setting the page it opens does not have — and the values, so a command's
  // command or path can be matched here too. The repository's own values are
  // not read from outside Settings: they belong to a workspace's definition,
  // and reading it to fill a palette nobody has searched yet would be a round
  // trip per keystroke.
  const settings = useSettings((s) => s.settings);
  // Onboarding §10 rows 2 and 7: in solo mode no Team or Join or create a team.
  // Launch A3: the plan decides which of Plan's rows are drawn.
  const accountInfo = useAccount((s) => s.info);
  const solo = useSolo();
  const boardIsGithubBacked = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.kanbanSyncMode === "githubIssues",
  );
  // GH #321: a workspace row's hint is what waits there, as the switcher
  // counts it — read when the surface opens.
  const openedAt = useMemo(() => Date.now(), [open]);
  const attention = useNeedsYou(openedAt).byWorkspace;
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    // The modes — the sidebar's places, reachable without the mouse.
    if (activeWorkspaceId) {
      const modes: [CenterMode, string][] = [
        ["inbox", "modeInbox"],
        ["board", "modeBoard"],
        ["code", "modeCode"],
        ["terminals", "modeTerminals"],
        ["activity", "modeHistory"],
        ["library", "modeLibrary"],
      ];
      for (const [mode, shortcut] of modes) {
        cmds.push({
          id: `mode:${mode}`,
          label: `Go to ${MODE_LABEL[mode]}`,
          hint: shortcutKeys(shortcut),
          group: "View",
          icon: MODE_ICON[mode],
          run: () => goToCenterMode(activeWorkspaceId, mode),
        });
      }
    }

    // Workflow
    if (activeWorkspaceId) {
      cmds.push({
        id: "new-task",
        label: "New card…",
        group: "Workflow",
        icon: "add",
        hint: shortcutKeys("newCard"),
        run: () => {
          usePlanExchange.getState().armNewCardPlan(null);
          useUi.getState().selectCard(activeWorkspaceId, null, false);
          openCenterMode(activeWorkspaceId, "board");
          requestBoardNewTask(activeWorkspaceId);
        },
      });
      // QoL 1.168 (block 10): the Board's ⋯ › Review a pull request…, here too.
      cmds.push({
        id: "review-pr",
        label: "Review a pull request…",
        group: "Workflow",
        icon: "board",
        hint: "The Reviewer reviews an open pull request on a card of its own",
        run: () => {
          useUi.getState().selectCard(activeWorkspaceId, null, false);
          openCenterMode(activeWorkspaceId, "board");
          requestBoardPrReview(activeWorkspaceId);
        },
      });
      // Plan with two AIs: the card made next opens on the Plan form.
      cmds.push({
        id: "new-task-plan-two-ais",
        label: `${CREATE_AND_PLAN_LABEL}…`,
        group: "Workflow",
        icon: "add",
        run: () => {
          usePlanExchange.getState().armNewCardPlan(activeWorkspaceId);
          useUi.getState().selectCard(activeWorkspaceId, null, false);
          openCenterMode(activeWorkspaceId, "board");
          requestBoardNewTask(activeWorkspaceId);
        },
      });
    }
    // 1.174.0 (DR3): Release <Area>… for each area of the active project
    // (Release… without areas), saying what is new since its last tag once
    // that is read — the Release sheet, on every plan. "Ship batch" and
    // "Release several cards" still find it (aliases, never shown).
    if (activeWorkspaceId) {
      const scopeOf = (id: string | null) => releaseScopesNow?.find((sc) => sc.area === id);
      const openerOf = (id: string | null, name: string | null) => {
        const sc = scopeOf(id) ?? (releaseScopesNow?.length === 1 && id === null ? releaseScopesNow[0] : undefined);
        return sc ? releaseOpener(sc, name, openedAt) : null;
      };
      const releaseHintOf = (id: string | null, name: string | null) => openerOf(id, name)?.hint;
      // Walk fix (DR3 early walk): an area that can release comes first; one
      // that can't (its branch isn't on GitHub, say) says why, after them.
      const releaseRows: { id: string | null; name: string | null }[] = (
        releaseAreas.length >= 2 ? releaseAreas.map((a) => ({ id: a.id, name: a.name.trim() || a.id })) : [{ id: null, name: null }]
      )
        .map((row, i) => ({ row, i, off: openerOf(row.id, row.name)?.off === true }))
        .sort((x, y) => Number(x.off) - Number(y.off) || x.i - y.i)
        .map((x) => x.row);
      for (const row of releaseRows) {
        cmds.push({
          id: row.id === null ? "ship-batch" : `ship-batch:${row.id}`,
          label: releaseLabel(row.name),
          group: "Workflow",
          icon: "shipBatch",
          hint: releaseHintOf(row.id, row.name),
          aliases: ["Ship batch", "Release several cards"],
          run: () => openRelease({ workspaceId: activeWorkspaceId, areaId: row.id }),
        });
      }
    }

    // Workspaces
    cmds.push({
      id: "add-project",
      label: `${ADD_PROJECT_LABEL}…`,
      hint: "A folder, from GitHub, or a new one",
      group: "Workspace",
      icon: "add",
      run: () => useAddProject.getState().openAddProject(),
    });
    if (activeWorkspaceId) {
      cmds.push({
        id: "rename-workspace",
        label: "Rename workspace…",
        hint: activeWs?.name,
        group: "Workspace",
        icon: "rename",
        run: () => useUi.getState().requestWorkspaceRename(activeWorkspaceId),
      });
    }
    // GH #321: no path in the first layer — it is the row's tooltip.
    for (const w of workspaces) {
      const waiting = attention[w.id] ?? 0;
      cmds.push({
        id: `ws:${w.id}`,
        label: `Switch to workspace: ${w.name}`,
        hint: waiting > 0 ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : undefined,
        title: w.cwd,
        group: "Workspace",
        icon: "choose",
        // QoL 1.168 (A1): the keyboard goes into that workspace's page.
        run: () => {
          void setActiveWorkspace(w.id);
          focusActivePane(w.id);
        },
      });
    }

    // Open files (current workspace)
    if (editor && activeWorkspaceId) {
      for (const f of editor.openFiles) {
        const basename = pathBasename(f.path);
        cmds.push({
          id: `file:${f.path}`,
          label: `Open file: ${basename}`,
          // Windows walk of block 6: "\README.md" there — the relative path,
          // on either platform's separators.
          hint: (activeWs ? relativeTo(f.path, activeWs.cwd) : null) ?? f.path,
          title: f.path,
          group: "File",
          icon: "code",
          // QoL 3.1 (E8): to the file, in Code — from the Board too.
          run: () => {
            setActiveFile(activeWorkspaceId, f.path);
            openCenterMode(activeWorkspaceId, "code");
          },
        });
      }
      // QoL 1.168 E4: Save all, while a file of this workspace is unsaved.
      if (editor.openFiles.some((f) => isFileDirty(f) && !f.refused)) {
        cmds.push({
          id: "save-all",
          label: "Save all files",
          hint: shortcutKeys("saveAll"),
          group: "File",
          icon: "code",
          run: () => void saveAllInWorkspace(activeWorkspaceId),
        });
      }
    }

    // Agents (current workspace)
    if (wsAgents && activeWorkspaceId) {
      for (const a of wsAgents.agents) {
        cmds.push({
          id: `agent-run:${a.id}`,
          label: `Run agent: ${a.name}`,
          hint: a.description || a.runtimeMode,
          group: "Agent",
          icon: "builder",
          run: () => {
            if (!claudeAvailable) {
              pushToast({
                kind: "error",
                title: "Claude binary not found",
                body: "Set its path in Settings › Look and feel › Editor and terminals.",
                // 1.176.3: with Program folders set, that list is where it was looked for.
                ...(hasPathOverride(useSettings.getState().settings.shell.pathOverride)
                  ? { action: openProgramFoldersAction }
                  : { action: { label: repairLabel("claude"), onClick: () => void openRepair("claude") } }),
              });
              return;
            }
            startRun(activeWorkspaceId, wsAgents.cwd, a).catch((e) => {
              pushErrorToast(`Could not start ${a.name}`, e);
            });
          },
        });
      }
      // Recent runs (jump-to)
      for (const r of wsAgents.runs.slice(0, 10)) {
        cmds.push({
          id: `run-open:${r.id}`,
          label: `Open run: ${r.agentName}`,
          hint: `${r.status} · ${r.trigger}`,
          group: "Run",
          icon: "status",
          run: () => setSelectedRun(activeWorkspaceId, r.id),
        });
      }
    }

    // App
    cmds.push(
      {
        id: "settings",
        label: "Settings",
        hint: shortcutKeys("settings"),
        group: "App",
        icon: "settings",
        run: () => {
          // v1.73.0 (step 5b-3): Settings lives in the shell now.
          useUi.getState().setSettingsOverlayOpen(true);
        },
      },
      {
        // OB-15 (onboarding §3.3, §9.2): Setup again, re-detecting every step
        // and starting at the first one not settled.
        id: "open-setup",
        label: "Open setup",
        hint: "Onboarding",
        group: "App",
        icon: "checks",
        run: () => useSetup.getState().openSetup("rerun"),
      },
      {
        id: "toggle-sidebar",
        label: "Show or hide the sidebar",
        hint: shortcutKeys("sidebar"),
        group: "App",
        icon: "sidebar",
        run: toggleSidebar,
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        hint: shortcutKeys("shortcuts"),
        group: "App",
        icon: "shortcuts",
        run: () => useUi.getState().setShortcutsOpen(true),
      },
      {
        // QoL 1.168 S3: look for a new version now.
        id: "check-updates",
        label: "Check for updates",
        group: "App",
        icon: "help",
        run: checkForUpdates,
      },
    );

    if (activeWorkspaceId) {
      cmds.push(
        {
          id: "search-files",
          label: "Find in files…",
          hint: shortcutKeys("text"),
          group: "View",
          icon: "search",
          keepOpen: true,
          run: () => setScope("text"),
        },
        {
          id: "quick-open",
          label: "Go to file…",
          hint: shortcutKeys("files"),
          group: "View",
          icon: "code",
          keepOpen: true,
          run: () => setScope("files"),
        },
      );
      cmds.push({
        id: "search-history",
        label: "Search inside past sessions…",
        hint: shortcutKeys("history"),
        group: "View",
        icon: "history",
        keepOpen: true,
        run: () => setScope("history"),
      });
      // GH #322: "Go to Library" is the Library's one command; ⌘⇧E, kept
      // from the retired Notes, opens it without a second row.
      const wsCwd = activeWs?.cwd;
      if (wsCwd) {
        cmds.push({
          id: "tile-shell",
          label: "New terminal",
          hint: defaultTileKind === "shell" ? shortcutKeys("newShell") : undefined,
          group: "Tile",
          icon: "terminals",
          // QoL 1.168 (D1, A1): on Terminals, with the keyboard in it.
          run: () => openNewTile(activeWorkspaceId, wsCwd, "shell", env),
        });
        if (claudeAvailable) {
          cmds.push({
            id: "tile-claude",
            label: "New Claude session",
            hint: shortcutKeys(defaultTileKind === "claude" ? "newShell" : "newClaude"),
            group: "Tile",
            icon: "terminals",
            run: () => openNewTile(activeWorkspaceId, wsCwd, "claude", env),
          });
        }
        if (codexAvailable) {
          cmds.push({
            id: "tile-codex",
            label: "New Codex session",
            hint: shortcutKeys(defaultTileKind === "codex" ? "newShell" : "newCodex"),
            group: "Tile",
            icon: "terminals",
            // With Codex's own checks, mounted Terminals or not.
            run: () => openNewTile(activeWorkspaceId, wsCwd, "codex", env),
          });
        }
      }
      // 1.177.0 Compare: the relay bar under the tile grid, on or off.
      if (wsCwd) {
        const compareOn = useCompare.getState().byWorkspace[activeWorkspaceId]?.on === true;
        cmds.push({
          id: "compare-toggle",
          label: compareOn ? "Turn Compare off" : "Turn Compare on",
          group: "Tile",
          icon: "terminals",
          run: () => {
            useCompare.getState().setOn(activeWorkspaceId, !compareOn);
            if (!compareOn) openCenterMode(activeWorkspaceId, "terminals");
          },
        });
      }
      // Tile lifecycle commands (operate on the focused workspace's tiles)
      const tileWs = useTiles.getState().byWorkspace[activeWorkspaceId];
      if (tileWs && tileWs.tiles.length > 0) {
        cmds.push({
          id: "tile-collapse",
          label: tileWs.expandedTileId
            ? "Restore tile (collapse expanded)"
            : "Expand last tile",
          group: "Tile",
          icon: tileWs.expandedTileId ? "restore" : "maximize",
          run: () => {
            if (tileWs.expandedTileId) {
              const was = tileWs.expandedTileId;
              useTiles.getState().setExpanded(activeWorkspaceId, null);
              showTile(activeWorkspaceId, was, { expand: false });
            } else {
              const last = tileWs.tiles[tileWs.tiles.length - 1];
              if (last) showTile(activeWorkspaceId, last.id);
            }
          },
        });
      }
    }

    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaces,
    attention,
    activeWs,
    wsAgents,
    editor,
    activeWorkspaceId,
    claudeAvailable,
    codexAvailable,
    releaseAreas,
    releaseScopesNow,
    setActiveWorkspace,
    setActiveFile,
    startRun,
    setSelectedRun,
    defaultTileKind,
    env,
  ]);

  // Opening resets the field and remembers where focus was; closing gives it
  // back. Switching scope while open keeps the query.
  useEffect(() => {
    if (!open) return;
    setQuery(useUi.getState().palette.query ?? "");
    setActive(0);
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      const el = restoreFocusRef.current;
      if (el && typeof el.focus === "function") {
        try {
          el.focus();
        } catch {
          // ignore
        }
      }
    };
  }, [open]);

  // The Files scope, and the few names the Commands scope shows under a query.
  const wantFiles = open && activeWs != null && (scope === "files" || (scope === "commands" && query.trim() !== ""));
  const files = useFileMatches(
    activeWorkspaceId,
    activeWs?.cwd ?? null,
    query,
    wantFiles,
  );

  const commandMatches = useMemo(() => {
    if (!open) return [];
    if (
      activeWorkspaceId &&
      hiddenSelfCheckCommandVisible(query)
    ) {
      return [
        {
          cmd: {
            id: "installed-self-check",
            label: INSTALLED_SELF_CHECK_QUERY,
            group: "Diagnostics",
            icon: "checks",
            run: onOpenInstalledSelfCheck,
          } as Command,
          score: Number.MAX_SAFE_INTEGER,
        },
      ];
    }
    const q = query.trim();
    if (!q) {
      return commands.slice(0, MAX_MATCHES).map((c, idx) => ({ cmd: c, score: -idx }));
    }
    const scored: { cmd: Command; score: number }[] = [];
    for (const c of commands) {
      const labelScore = fuzzyScore(q, c.label);
      const aliasScores = (c.aliases ?? []).map((a) => fuzzyScore(q, a)).filter((x): x is number => x != null);
      const shownHint = c.hint ? fuzzyScore(q, c.hint) : null;
      const hintScore = aliasScores.length || shownHint != null ? Math.max(shownHint ?? -Infinity, ...aliasScores) : null;
      const best =
        labelScore != null && hintScore != null
          ? Math.max(labelScore, hintScore - 5) // hint matches worth slightly less
          : labelScore != null
          ? labelScore
          : hintScore != null
          ? hintScore - 5
          : null;
      // Walk of 2026-11-03: a title typed in full leads, whatever else matches.
      const exact = c.label.toLowerCase() === q.toLowerCase();
      if (best !== null) scored.push({ cmd: c, score: exact ? Number.MAX_SAFE_INTEGER : best });
    }
    scored.sort((a, b) => b.score - a.score);
    // GH #107: the same results the field in Settings gives, from the same
    // index and the same matcher — `Verify pipeline`, opening Settings on
    // that row. They come after the app's own commands: the palette is for
    // doing things, and a setting is a place to go. GH #284: under their
    // Settings caption the rows carry no "Settings:" prefix; the hint is
    // where the row lives, and a label that is the same on every page
    // ("Reset this page to defaults") names its page.
    const settingsMatches = searchSettings(
      q,
      visibleIndex({
        boardIsGithubBacked,
        // Onboarding §11.1: the team this Mac is in — the setting.
        hasTeam: (settings.team?.teamRepo ?? null) !== null,
        ...planSearchFlags(accountInfo),
        teamMode: !solo,
      }),
      { currentValue: (e) => currentValueOf(e, settings, null) },
    )
      .slice(0, SETTINGS_SLOTS)
      .map((r, i) => ({
        cmd: {
          id: `settings-row:${r.entry.page}:${r.entry.section ?? ""}:${r.entry.label}`,
          label: settingsRowLabel(r.entry),
          // `This repository › Build and release`, and why a value-only
          // match is in the list at all.
          hint: r.why ? `${placeOf(r.trail)} — ${r.why}` : placeOf(r.trail),
          icon: "settings",
          group: "Settings",
          run: () =>
            useUi.getState().openSettingsSection(r.entry.page, {
              row: r.entry.kind === "setting" ? rowToken(r.entry) : undefined,
            }),
        },
        score: -1000 - i,
      }));
    // The settings keep their slots: appending them and cutting at 60 meant a
    // query matching sixty commands buried every one of them (review 1, N12).
    return [
      ...scored.slice(0, Math.max(0, MAX_MATCHES - settingsMatches.length)),
      ...settingsMatches,
    ];
  }, [
    commands,
    query,
    open,
    activeWorkspaceId,
    settings,
    solo,
    accountInfo,
    boardIsGithubBacked,
    onOpenInstalledSelfCheck,
  ]);

  // What the list shows, in the scope's order: in Commands, the commands and
  // settings, then (under a query) a few file names and the two ways to
  // search deeper; in Files, the file names.
  const items = useMemo<Command[]>(() => {
    if (!open) return [];
    const wsId = activeWorkspaceId;
    const cwd = activeWs?.cwd ?? null;
    const fileItem = (path: string): Command => ({
      id: `path:${path}`,
      label: pathBasename(path),
      hint: lastSeparator(path) >= 0 ? dirname(path) : undefined,
      icon: "code",
      section: "Files",
      run: () => {
        if (wsId && cwd) void openWorkspaceFile(wsId, cwd, path);
      },
    });
    if (scope === "files") return files.matches.map(fileItem);
    if (scope !== "commands") return [];
    const out: Command[] = commandMatches.map((m) => {
      const c = m.cmd as Command;
      return { ...c, section: c.group === "Settings" ? "Settings" : c.section ?? "Commands" };
    });
    const q = query.trim();
    if (q && !hiddenSelfCheckCommandVisible(query)) {
      // QoL 1.168 (block 10, C6): cards by title, or by "#42".
      if (wsId) {
        const issue = /^#?(\d+)$/.exec(q)?.[1];
        const found: { card: KanbanCard; score: number }[] = [];
        for (const card of boardCards) {
          if (card.archived) continue;
          if (issue && String(card.ghIssueNumber ?? "") === issue) {
            found.push({ card, score: Number.MAX_SAFE_INTEGER });
            continue;
          }
          const score = fuzzyScore(q, card.title);
          if (score != null) found.push({ card, score });
        }
        found.sort((a, b) => b.score - a.score);
        const cardItems = found.slice(0, CARDS_IN_COMMANDS).map(({ card }) => ({
            id: `card:${card.id}`,
            label: card.title,
            hint: card.ghIssueNumber != null ? `#${card.ghIssueNumber}` : undefined,
            icon: "board" as IconName,
            section: "Cards",
            run: () => useUi.getState().selectCard(wsId, card.id),
          }));
        // Block 10 Mac walk: a card whose title matches better than every
        // command heads the list, so Enter opens it (the settings and the
        // file search come after commands anyway).
        const bestCommand = commandMatches.find((m) => (m.cmd as Command).group !== "Settings")?.score;
        if (found.length > 0 && (bestCommand === undefined || found[0].score >= bestCommand)) {
          out.unshift(...cardItems);
        } else {
          out.push(...cardItems);
        }
      }
      out.push(...files.matches.slice(0, FILES_IN_COMMANDS).map(fileItem));
      if (wsId) {
        out.push({
          id: "jump:text",
          label: `Search "${q}" in files`,
          hint: shortcutKeys("text"),
          icon: "search",
          section: "In files · History",
          keepOpen: true,
          run: () => setScope("text"),
        });
      }
      out.push({
        id: "jump:history",
        label: `Search "${q}" inside past sessions`,
        hint: shortcutKeys("history"),
        icon: "history",
        section: "In files · History",
        keepOpen: true,
        run: () => setScope("history"),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, commandMatches, files.matches, query, activeWorkspaceId, activeWs, boardCards]);

  const listed = scope === "commands" || scope === "files";

  // Windows walk of block 6: a new query starts at its best match, wherever
  // the pointer or the arrows had left the selection for the last one.
  useEffect(() => {
    setActive(0);
  }, [query, scope]);

  // Keep `active` in range when the list changes.
  useEffect(() => {
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, items.length - 1)));
  }, [items]);

  // Scroll the active row into view.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function runItem(item: Command) {
    if (item.keepOpen) {
      item.run();
      return;
    }
    onClose();
    // Deferred, so focus restoration happens first.
    setTimeout(() => item.run(), 0);
  }

  // Keys: Esc closes; in a listed scope ↑ ↓ move and Enter runs; ⌘R in Files
  // re-scans. Capture, so the host listener doesn't see them.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!listed) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.min(items.length - 1, a + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const item = items[active];
        if (item) runItem(item);
      } else if (scope === "files" && e.key === "r" && mod(e) && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        files.reload();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, active, onClose, listed, scope]);

  if (!open) return null;
  const current = PALETTE_SCOPES.find((s) => s.id === scope) ?? PALETTE_SCOPES[0];

  let body: React.ReactNode;
  if (scope === "text") {
    body = activeWs ? (
      <TextResults workspaceId={activeWs.id} cwd={activeWs.cwd} query={query} onClose={onClose} />
    ) : (
      <div className="palette-empty">Open a workspace to search its files.</div>
    );
  } else if (scope === "history") {
    body = <HistoryResults query={query} onClose={onClose} />;
  } else if (scope === "files" && !activeWs) {
    body = <div className="palette-empty">Open a workspace to find its files.</div>;
  } else if (scope === "files" && files.error) {
    body = (
      <div className="palette-empty">
        <FailureText failure={files.error} />
      </div>
    );
  } else if (scope === "files" && files.loading && !files.index) {
    body = <div className="palette-empty">Indexing files…</div>;
  } else if (items.length === 0) {
    body = (
      <div className="palette-empty">
        {scope === "files" && files.index?.paths.length === 0
          ? "No files in this workspace"
          : "No matches"}
      </div>
    );
  } else {
    body = (
      <ul className="palette-list" ref={listRef} role="listbox" aria-label={current.label}>
        {items.map((item, i) => {
          const section = item.section ?? "Commands";
          const caption = i === 0 || (items[i - 1].section ?? "Commands") !== section;
          return (
            <li key={item.id} role="presentation" data-section={section}>
              {caption && <div className="palette-section">{section}</div>}
              <div
                role="option"
                aria-selected={i === active}
                data-index={i}
                title={item.title}
                className={`palette-item${i === active ? " active" : ""}`}
                // A list redrawn under a pointer that hasn't moved must not take
                // the selection from the query's best match (Enter would run it).
                onMouseMove={() => setActive(i)}
                onClick={() => runItem(item)}
              >
                <span className="palette-item-main">
                  <span className="palette-item-icon">
                    {item.icon && <Icon name={item.icon} />}
                  </span>
                  <span className={`palette-item-label${section === "Files" ? " is-path" : ""}`}>
                    {item.label}
                  </span>
                </span>
                {item.hint && <span className="palette-item-hint">{item.hint}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette-card"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query's best match is the one Enter runs.
              setActive(0);
            }}
            placeholder={current.placeholder}
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
          {scope === "files" && activeWs && (
            <button
              type="button"
              className="palette-rescan"
              onClick={files.reload}
              disabled={files.loading}
              title={`Re-scan the files (${shortcutKeys("rescanFiles")})`}
            >
              Re-scan
            </button>
          )}
        </div>
        <div className="palette-scopes" role="tablist" aria-label="Search in">
          {PALETTE_SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === scope}
              className={`palette-scope${s.id === scope ? " is-selected" : ""}`}
              title={`${s.label} (${shortcutKeys(s.shortcut)})`}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="palette-body">{body}</div>
        {scope === "files" && files.index?.truncated && (
          <div className="palette-foot">
            This project has more files than Go to file lists (10,000). In files searches all of them.
          </div>
        )}
      </div>
    </div>
  );
}
