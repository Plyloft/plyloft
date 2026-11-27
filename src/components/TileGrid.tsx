import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useWorkspaces,
  type LayoutPreset,
  type Workspace,
} from "../store/workspaceStore";
import { useTiles } from "../store/tileStore";
import { Tile } from "./Tile";
import { CentreErrorBoundary } from "./CentreErrorBoundary";
import type { ShellEnvInfo } from "../ipc";
import { EMPTY_ARRAY } from "../lib/empties";
import { useKanban } from "../store/kanbanStore";
import { openCardStep } from "../store/uiStore";
import { cardSessionLinks, terminalsEmptyWords } from "../lib/sessionRows";
import { useBuildBoth } from "../store/buildBothStore";
import type { KanbanCard } from "../ipc";
import type { CodexTileKind } from "../lib/codexTileLaunch";
import { openCodexTile } from "../store/openCodexTile";
import { closeAllTiles, openNewTile, OPEN_RESUME_EVENT, requestCloseTile, showNewTile, TILE_SHOWN_EVENT, useDefaultNewTileKind } from "../store/tileActions";
import { useDoctor } from "../store/doctorStore";
import { WorkspaceTemplateModal } from "./WorkspaceTemplateModal";
import { ResumeConversationSheet } from "./ResumeConversationSheet";
import { ReopenSessionsOffer, useReopenOffer } from "./ReopenSessionsOffer";
import { useSettings } from "../store/settingsStore";
import { noSessionsOpenWords, resumableKinds } from "../lib/terminalConversations";
import { terminalConversations } from "../ipc";
import { ModeHeader } from "./ModeHeader";
import { EmptyState, MenuButton, MoreMenu, type MenuItem } from "./ux";
import { CBtn } from "./ui/primitives";
import { shortcutKeys, type ShortcutId } from "../lib/shortcuts";
import type { WorkspaceTemplate } from "../lib/workspaceTemplates";
import { NewCopySheet } from "./NewCopySheet";
import { CopiesView } from "./CopiesView";
import { CompareBars, useComparePairs } from "./CompareBar";
import { pairState, useCompare, useWsCompare } from "../store/compareStore";
import { COMPARE_NEW_COPY_HINT, COMPARE_NEW_COPY_MENU, COMPARE_TOGGLE, COMPARE_TOGGLE_TITLE } from "../lib/compareWords";
import { closeComposer, tilePlace } from "../store/compareActions";
import { PROJECT_PLACE, pairTileOrder, resolvePair } from "../lib/compareView";
import type { TileComparePair } from "./Tile";
import { onOpenNewCopySheet, type NewCopyFrom, type NewCopyProvider } from "../lib/newCopySheet";
import { copyMadeToastWords } from "../lib/sameFolder";
import { listenForFolderChanges } from "../store/folderChanges";
import { pushToast } from "../store/toastStore";
import { COPIES_TITLE, NEW_COPY_MENU, NEW_COPY_MENU_HINT } from "../lib/copyWords";
import { listenForCopies, useCopies, useWorkspaceCopies } from "../store/copiesStore";
import { useClaudeAccountRows } from "../store/claudeAccountsStore";
import { newSessionChoices } from "../lib/claudeAccountNames";

/** 1.174.0 E6 (T11, P23): what New › Codex chat lacks, under its name. The
 *  rest (Throw away doesn't wait for it, the Inbox doesn't reopen it) is in
 *  the guide. */
export const CODEX_CHAT_MENU_HINT =
  "A chat view with fewer features: it takes no files, and isn't counted in Same folder warnings.";

/** 1.174.0 E5 (P22, D5 b): Terminals names the keys that work with the
 *  cursor in a terminal — on Windows Ctrl+Alt+T for a new tile, Ctrl+Shift
 *  for the rest; the same keys as everywhere on the Mac. */
function keysHere(id: ShortcutId): string {
  return shortcutKeys(id, { terminal: true });
}

type Props = {
  env: ShellEnvInfo | null;
  workspace: Workspace;
};

/** v1.14.0: layout preset options moved here from AppToolbar (S1 of the
 *  chrome restructure). The `<select>` now lives next to + shell / + claude
 *  in the tile-grid toolbar. */
const LAYOUT_PRESET_OPTIONS: Array<{ value: LayoutPreset; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "single", label: "Single tile" },
  { value: "split", label: "Split (1×2)" },
  { value: "quad", label: "Quad (2×2)" },
  { value: "six", label: "Six (2×3)" },
];

/**
 * Auto-tile bucket: given N tiles, return [rows, cols] for the grid.
 * Pure function — covered by /tmp/playfulStatus_test.mjs (tier 3).
 */
export function gridLayout(n: number): [number, number] {
  if (n <= 1) return [1, 1];
  if (n === 2) return [1, 2];
  if (n <= 4) return [2, 2];
  if (n <= 6) return [2, 3];
  if (n <= 9) return [3, 3];
  if (n <= 12) return [3, 4];
  return [4, 4]; // caps at 16, anything more overflows visually
}

/**
 * v1.4.0 (L2): preset-aware tile bucket. When `preset` is set to a
 * known value, return its fixed shape regardless of tile count (extra
 * tiles overflow visually — the user opted in). Unrecognized presets
 * (including null / undefined / "auto") fall through to `gridLayout(n)`.
 */
export function gridLayoutForPreset(
  n: number,
  preset?: string | null,
): [number, number] {
  switch (preset) {
    case "single":
      return [1, 1];
    case "split":
      return [1, 2];
    case "quad":
      return [2, 2];
    case "six":
      return [2, 3];
    default:
      return gridLayout(n);
  }
}

/** 1.174.0 E7: one way to start, on the empty Terminals page. */
type EmptyStart = {
  kind: "claude" | "codex" | "shell" | "resume" | "several";
  label: string;
  title: string;
  keys?: string;
  open: () => void;
};

/** 1.174.0 E7 (G16): the empty page's one strong button — the AI Setup
 *  chose for the Builder when it is installed, else the one that is (Codex
 *  on a Codex-only computer), else a shell. */
export function emptyStrongKind(
  setupVendor: string | null | undefined,
  installed: { claude: boolean; codex: boolean },
): "claude" | "codex" | "shell" {
  if (setupVendor === "codex" && installed.codex) return "codex";
  if (setupVendor === "claude" && installed.claude) return "claude";
  if (installed.claude) return "claude";
  if (installed.codex) return "codex";
  return "shell";
}

/** The quiet line's ways to start, each a quiet button with its keys. */
function startLinks(list: EmptyStart[]) {
  return list.map((x, i) => (
    <span key={x.kind} className="tile-grid-empty-link">
      {i > 0 && <span aria-hidden="true">·</span>}
      <CBtn size="sm" tone="quiet" onClick={x.open} title={x.title}>
        {x.label}
        {x.keys && <kbd>{x.keys}</kbd>}
      </CBtn>
    </span>
  ));
}

/**
 * 1.174.0 E8 (T16): with fewer tiles than cells, the last tile spans the
 * columns left in its row — 3 in 2×2 → 2, 5 in 2×3 → 2, 4 in Six → 3. None
 * when the grid is full or overflows (a preset with more tiles than cells),
 * and none while one tile is expanded. Pure.
 */
export function lastTileSpan(n: number, rows: number, cols: number, expanded: boolean): number {
  if (expanded || n <= 0 || n >= rows * cols) return 1;
  return cols - ((n - 1) % cols);
}

/** Empty state shown by NewWorkspaceShell when no workspace is selected. */
export function TileGridEmpty() {
  return (
    <main className="tile-grid-empty">
      <EmptyState>No workspace is open. Add a project from the sidebar.</EmptyState>
    </main>
  );
}

export function TileGrid({ env, workspace }: Props) {
  const ws = workspace;
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false);
  // Terminals block P4: New › Resume….
  const [resumeOpen, setResumeOpen] = useState(false);
  const canResume = Boolean(env?.claudePath || env?.codexPath);
  // 1.179.0 (C2): New's "Claude on {name}" entries.
  const accountRows = useClaudeAccountRows();
  // QoL 1.168 (D3): ⌘T's hint sits beside the kind it opens.
  const defaultKind = useDefaultNewTileKind(env);
  // 1.173.0 A3: New › In a new copy… (and A4's "Same folder" popover) opens
  // the sheet; Terminals › Copies lists them, over the grid.
  // 1.179.0: "pair" — New › Compare in a new copy… opens a Claude and a
  // Codex tile in it.
  const [newCopy, setNewCopy] = useState<NewCopyProvider | "pair" | null>(null);
  // 1.174.0 E1: asked from a Same folder chip — who asked, for the toast.
  const [newCopyFrom, setNewCopyFrom] = useState<NewCopyFrom | null>(null);
  const [view, setView] = useState<"tiles" | "copies">("tiles");
  const copies = useWorkspaceCopies(ws.id);
  // 1.177.0 Compare: the relay bar under the grid, on or off for this workspace.
  const compareState = useWsCompare(ws.id);
  const compareOn = compareState.on;
  const toggleCompare = () => {
    if (compareOn) closeComposer(ws.id);
    useCompare.getState().setOn(ws.id, !compareOn);
  };
  // Walk fix (e): the count is the copies to work in; one in the Trash stays
  // reachable inside (Bring it back) while any copy is listed.
  const copiesShown = copies.filter((c) => c.state === "active").length;
  const copiesListed = copies.some((c) => c.state === "active" || c.restorable);
  useEffect(() => {
    listenForCopies();
    listenForFolderChanges();
    void useCopies.getState().refresh(ws.id);
  }, [ws.id]);
  // Walk fix (blocks 1+2): any path that opens or focuses a tile here — a
  // card's "Open a terminal in the card's copy", New, Resume…, Show <other>
  // — shows the grid with that tile; Copies opens only from its own button.
  const tileIds = useTiles((s) => (s.byWorkspace[ws.id]?.tiles ?? []).map((t) => t.id).join("\u0000"));
  const seenTiles = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = new Set(tileIds ? tileIds.split("\u0000") : []);
    const before = seenTiles.current;
    seenTiles.current = now;
    if (before && [...now].some((id) => !before.has(id))) setView("tiles");
  }, [tileIds]);
  useEffect(() => {
    function onShown(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (useTiles.getState().byWorkspace[ws.id]?.tiles.some((t) => t.id === id)) setView("tiles");
    }
    window.addEventListener(TILE_SHOWN_EVENT, onShown);
    return () => window.removeEventListener(TILE_SHOWN_EVENT, onShown);
  }, [ws.id]);
  // A4's contract: every warmed workspace mounts its own Terminals, and only
  // the one asked answers.
  useEffect(
    () =>
      onOpenNewCopySheet((request) => {
        if (request.workspaceId === ws.id) {
          setNewCopy(request.provider);
          setNewCopyFrom(request.from ?? null);
        }
      }),
    [ws.id],
  );

  const tiles = useTiles(
    (s) => s.byWorkspace[ws.id]?.tiles ?? EMPTY_ARRAY,
  );
  // QoL 1.168 (block 4): the member closed this launch's last tile here.
  const emptied = useTiles((s) => s.byWorkspace[ws.id]?.emptied ?? false);
  const expandedTileId = useTiles(
    (s) => s.byWorkspace[ws.id]?.expandedTileId ?? null,
  );

  // SP-7: an empty page names the card sessions that live on their cards.
  const cards = useKanban((s) => s.byWorkspace[ws.id]?.cards ?? (EMPTY_ARRAY as KanbanCard[]));
  const sessionLinks = useMemo(() => cardSessionLinks(cards), [cards]);
  const cardSessionCount = sessionLinks.length;

  // Shared with the background updater: an update no longer gates the tile,
  // it only annotates the button.
  const codexUpdating = useDoctor((s) => s.codexUpdating);
  const addTilesFromTemplate = useTiles((s) => s.addTilesFromTemplate);
  const removeTile = useTiles((s) => s.removeTile);
  const setExpanded = useTiles((s) => s.setExpanded);
  const setLayoutPreset = useWorkspaces((s) => s.setLayoutPreset);

  // GH #325: every session that has ended — exited, crashed, errored or
  // stopped — so the item says "ended", not "completed".
  const endedTileIds = useMemo(
    () =>
      tiles
        .filter(
          (t) =>
            t.status === "done" ||
            t.status === "error" ||
            t.status === "killed" ||
            t.status === "crashed",
        )
        .map((t) => t.id),
    [tiles],
  );

  const onCloseEnded = useCallback(() => {
    for (const id of endedTileIds) removeTile(id);
  }, [endedTileIds, removeTile]);

  // QoL 1.168 (A1): a new tile takes the keyboard (`tileActions`).
  const onAddShell = useCallback(() => {
    openNewTile(ws.id, ws.cwd, "shell", env);
  }, [ws, env]);

  const onAddClaude = useCallback(() => {
    if (!env?.claudePath) return;
    openNewTile(ws.id, ws.cwd, "claude", env);
  }, [ws, env]);

  // v1.103.0 (D1): one handler, two tile kinds (`openCodexTile`, shared with
  // ⌘⇧X and the command search).
  const onAddCodex = useCallback(
    (tile: CodexTileKind) => showNewTile(openCodexTile(ws.id, ws.cwd, env, tile)),
    [ws, env],
  );

  const onApplyLayout = useCallback(
    (template: WorkspaceTemplate) => {
      addTilesFromTemplate(
        ws.id,
        ws.cwd,
        template.tiles,
        Boolean(env?.claudePath),
      );
      setLayoutPickerOpen(false);
    },
    [addTilesFromTemplate, env?.claudePath, ws],
  );

  const layoutPicker = layoutPickerOpen ? (
    <WorkspaceTemplateModal
      workspaceLabel={ws.name}
      claudeAvailable={Boolean(env?.claudePath)}
      onConfirm={onApplyLayout}
      onCancel={() => setLayoutPickerOpen(false)}
    />
  ) : null;

  const newCopySheet =
    newCopy !== null ? (
      <NewCopySheet
        workspaceId={ws.id}
        env={env}
        provider={newCopy}
        // 1.179.0: Claude and Codex together, asked from New (not from a
        // Same folder chip, which asks for one tile's AI).
        offerPair={newCopyFrom === null}
        onClose={() => {
          setNewCopy(null);
          setNewCopyFrom(null);
        }}
        onMade={(made) => {
          setView("tiles");
          // E1 (P18, 1c): the one press that clears the Same folder warning.
          const from = newCopyFrom;
          if (from && made && useTiles.getState().byWorkspace[ws.id]?.tiles.some((t) => t.id === from.tileId)) {
            const words = copyMadeToastWords(made.label, from.self, from.peer);
            pushToast({
              kind: "info",
              title: words.title,
              body: words.body,
              action: { label: words.action, onClick: () => requestCloseTile(from.tileId) },
            });
          }
        }}
      />
    ) : null;
  const copiesView = (
    <CopiesView workspaceId={ws.id} env={env} onShowTerminals={() => setView("tiles")} />
  );

  const resumeSheet = resumeOpen ? (
    <ResumeConversationSheet
      workspaceId={ws.id}
      workspaceName={ws.name}
      cwd={ws.cwd}
      env={env}
      onClose={() => setResumeOpen(false)}
    />
  ) : null;

  // QoL 1.168 (D8): ⌘⇧R opens this page's Resume… (`openResume`). Each
  // warmed workspace has its own TileGrid; only the one asked answers.
  useEffect(() => {
    function onResume(e: Event) {
      const detail = (e as CustomEvent<{ workspaceId: string }>).detail;
      if (detail?.workspaceId === ws.id && canResume) setResumeOpen(true);
    }
    window.addEventListener(OPEN_RESUME_EVENT, onResume);
    return () => window.removeEventListener(OPEN_RESUME_EVENT, onResume);
  }, [ws.id, canResume]);

  const [rows, cols] = useMemo(
    () => gridLayoutForPreset(tiles.length, ws.layoutPreset),
    [tiles.length, ws.layoutPreset],
  );
  const span = lastTileSpan(tiles.length, rows, cols, Boolean(expandedTileId));
  // 1.179.0 Compare with two pairs: each paired tile's dot (and the project
  // pair's name), the quiet outline of the pair pointed at, and in Auto a
  // pair's two tiles side by side (CSS order only: nothing remounts).
  const pairsView = useComparePairs(ws.id, ws.name);
  const [hoverSlot, setHoverSlot] = useState<"a" | "b" | null>(null);
  const twoPairs = compareOn && pairsView.mode === "two";
  const paired = twoPairs
    ? pairsView.pairs.map((p) => {
        const st = pairState(compareState, p.place);
        const r = resolvePair(
          tiles.filter((t) => p.tileIds.includes(t.id)).map((t) => ({ id: t.id, vendor: t.kind === "codex" ? ("codex" as const) : ("claude" as const) })),
          st?.claudeId ?? null,
          st?.codexId ?? null,
        );
        return { ...p, claudeId: r.claude?.id ?? null, codexId: r.codex?.id ?? null };
      })
    : [];
  const pairMarkOf = (id: string): TileComparePair | null => {
    const p = paired.find((x) => x.claudeId === id || x.codexId === id);
    return p ? { slot: p.slot, name: p.name, inProject: p.place === PROJECT_PLACE, linked: hoverSlot === p.slot, onHover: setHoverSlot } : null;
  };
  const visualOrder =
    twoPairs && (ws.layoutPreset ?? "auto") === "auto" && !expandedTileId
      ? pairTileOrder(tiles.map((t) => ({ id: t.id, place: tilePlace(ws.id, t.cwd) })), paired)
      : null;
  // The span goes to the tile drawn last.
  const lastShown = visualOrder ? [...visualOrder.entries()].find(([, i]) => i === tiles.length - 1)?.[0] : tiles[tiles.length - 1]?.id;
  const gridStyle = expandedTileId
    ? { gridTemplateRows: "1fr", gridTemplateColumns: "1fr" }
    : {
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      };

  // UX-8.2 (the Terminals board): two header controls. "New ▾" opens every
  // kind of session and several at once; the ⋯ holds the layout presets and Close
  // ended sessions. GH #325: the sidebar is the way back to the Board, so
  // the ⋯ no longer repeats it, and an empty page has no ⋯.
  const currentPreset = ws.layoutPreset ?? "auto";
  // 1.174.0 E6 (T11): the same order as the empty page — Claude, Codex,
  // Shell — then Codex chat, which says what it lacks (P23, D9b).
  const newItems: MenuItem[] = [];
  if (env?.claudePath) {
    newItems.push({
      label: "Claude",
      shortcut: keysHere(defaultKind === "claude" ? "newShell" : "newClaude"),
      onSelect: onAddClaude,
    });
    // 1.179.0 (C2): with more than one Claude account, one entry per
    // account, Main included (C3); plain Claude keeps starting on the
    // account for new sessions.
    for (const choice of newSessionChoices(accountRows)) {
      newItems.push({
        label: choice.label,
        onSelect: () => showNewTile(useTiles.getState().addClaudeTile(ws.id, ws.cwd, { account: choice.account })),
      });
    }
  }
  if (env?.codexPath) {
    newItems.push({
      label: codexUpdating ? "Codex (updating…)" : "Codex",
      shortcut: keysHere(defaultKind === "codex" ? "newShell" : "newCodex"),
      onSelect: () => onAddCodex("codex"),
    });
  }
  newItems.push({ label: "Shell", shortcut: defaultKind === "shell" ? keysHere("newShell") : undefined, onSelect: onAddShell });
  if (env?.codexPath) {
    newItems.push({
      // 1.176.0 R7: the Repair wording of this release.
      label: env.codexHealthy ? "Codex chat" : "Codex chat — Codex needs repairing",
      hint: CODEX_CHAT_MENU_HINT,
      disabled: !env.codexHealthy,
      onSelect: () => onAddCodex("codex-chat"),
    });
  }
  // Terminals block P4: an earlier Claude or Codex conversation of this
  // project, in a new session.
  if (canResume) {
    newItems.push({ label: "Resume…", shortcut: keysHere("resume"), onSelect: () => setResumeOpen(true) });
  }
  newItems.push("divider", {
    label: "Several sessions at once…",
    onSelect: () => setLayoutPickerOpen(true),
  });
  // 1.173.0 A3: a terminal in its own copy of the project.
  newItems.push("divider", {
    label: NEW_COPY_MENU,
    hint: NEW_COPY_MENU_HINT,
    tour: "terminals-new-copy",
    // The mockup's preselection: an AI when one is installed.
    onSelect: () => setNewCopy(env?.claudePath ? "claude" : env?.codexPath ? "codex" : "shell"),
  });
  // 1.179.0: a second Compare pair starts in a copy of its own (two Codex
  // tiles in one folder can't be told apart).
  if (compareOn) {
    newItems.push({
      label: COMPARE_NEW_COPY_MENU,
      hint: COMPARE_NEW_COPY_HINT,
      onSelect: () => setNewCopy("pair"),
    });
  }

  const moreItems: MenuItem[] = [];
  if (tiles.length > 0) {
    if (endedTileIds.length > 0) {
      moreItems.push({
        label: `Close ended sessions (${endedTileIds.length})`,
        onSelect: onCloseEnded,
      });
    }
    if (expandedTileId) {
      moreItems.push({ label: "Show the grid", onSelect: () => setExpanded(ws.id, null) });
    }
    // QoL 1.168 (D4, M4, L6): every session of the page not already
    // closing; asks once (always for more than one).
    const closable = tiles.filter((t) => !t.pendingClose).length;
    if (closable > 0) {
      moreItems.push({ label: `Close all (${closable})`, onSelect: () => void closeAllTiles(ws.id) });
    }
    moreItems.push({ heading: "Layout" });
    for (const opt of LAYOUT_PRESET_OPTIONS) {
      moreItems.push({
        // GH #325: the current layout is checked, not disabled.
        label: opt.label,
        checked: opt.value === currentPreset,
        onSelect: () => {
          // v1.77.0: picking any layout also collapses an expanded tile —
          // while expanded the grid ignores the preset entirely.
          setExpanded(ws.id, null);
          void setLayoutPreset(ws.id, opt.value === "auto" ? null : opt.value);
        },
      });
    }
  }
  // 1.174.0 E7: the empty page's ways to start. Read once here, so the offer
  // above the grid and the empty page's first row are the same offer.
  const reopenOffer = useReopenOffer(ws.id, env);
  const reopening = reopenOffer.offered.length > 0;
  // Round 1: after Not now the page says "No sessions open." — a session was
  // there — not the first-use words.
  const hadOffer = useRef(false);
  if (reopening) hadOffer.current = true;
  // Round 1 (mockup 3b): first use offers Resume… only when this project has
  // an earlier conversation to pick up (Resume…'s own list).
  const [hasEarlier, setHasEarlier] = useState(false);
  const resumeKinds = useMemo(() => resumableKinds(env), [env]);
  const noTiles = tiles.length === 0;
  useEffect(() => {
    if (!noTiles || resumeKinds.length === 0) {
      setHasEarlier(false);
      return;
    }
    let live = true;
    terminalConversations(ws.id)
      .then((all) => {
        if (live) setHasEarlier(all.some((c) => resumeKinds.includes(c.kind)));
      })
      .catch(() => {
        if (live) setHasEarlier(false);
      });
    return () => {
      live = false;
    };
  }, [ws.id, noTiles, resumeKinds]);
  const setupVendor = useSettings((s) => s.settings.behavior.builderVendor);
  const starts: EmptyStart[] = [];
  if (env?.claudePath) {
    starts.push({ kind: "claude", label: "Claude", title: `New Claude session in ${ws.cwd}`, keys: keysHere("newClaude"), open: onAddClaude });
  }
  if (env?.codexPath) {
    starts.push({ kind: "codex", label: "Codex", title: `New Codex session in ${ws.cwd}`, keys: keysHere("newCodex"), open: () => onAddCodex("codex") });
  }
  starts.push({
    kind: "shell",
    label: "Shell",
    title: `New shell in ${ws.cwd}`,
    keys: defaultKind === "shell" ? keysHere("newShell") : undefined,
    open: onAddShell,
  });
  if (canResume) {
    starts.push({ kind: "resume", label: "Resume…", title: "An earlier Claude or Codex conversation of this project", open: () => setResumeOpen(true) });
  }
  const strongKind = emptyStrongKind(setupVendor, { claude: Boolean(env?.claudePath), codex: Boolean(env?.codexPath) });
  const strongStart = starts.find((x) => x.kind === strongKind)!;
  const strong = {
    ...strongStart,
    label: strongKind === "shell" ? "New shell" : `New ${strongStart.label} session`,
  };
  const showingCopies = view === "copies";
  const header = (
    <ModeHeader
      mode="terminals"
      workspaceId={ws.id}
      // 1.174.0 E3 (P24, CP-1): Copies is the title, under "Terminals ›",
      // which leads back; the pressed toggle is the other way out.
      title={showingCopies ? COPIES_TITLE : undefined}
      belowMode={showingCopies}
      onModeCrumb={showingCopies ? () => setView("tiles") : undefined}
      actions={
        <>
          {/* 1.173.0 A3: only once a copy exists; the menu is the way in. */}
          {copiesListed && (
            <CBtn
              tone="quiet"
              active={showingCopies}
              aria-pressed={showingCopies}
              onClick={() => setView(showingCopies ? "tiles" : "copies")}
              title={showingCopies ? "Back to the terminals" : "The copies of this project made from Terminals"}
            >
              {`Copies (${copiesShown})`}
            </CBtn>
          )}
          {(compareOn || tiles.some((t) => t.kind === "claude" || t.kind === "codex")) && (
            <CBtn
              tone="quiet"
              active={compareOn}
              aria-pressed={compareOn}
              onClick={toggleCompare}
              title={COMPARE_TOGGLE_TITLE}
            >
              {COMPARE_TOGGLE}
            </CBtn>
          )}
          <MenuButton
            label="New"
            menuLabel="New session"
            icon="add"
            items={newItems}
            title={`New shell, Claude, Codex (${keysHere("newShell")} opens ${defaultKind === "shell" ? "a shell" : defaultKind === "claude" ? "Claude" : "Codex"}), an earlier conversation or several sessions at once`}
            tour="terminals-new"
          />
          {moreItems.length > 0 && <MoreMenu label="More for Terminals" items={moreItems} />}
        </>
      }
    />
  );

  if (tiles.length === 0) {
    // GH #292: an empty Terminals page is one line and two quiet ways to
    // start — the header's New ▾ is the page's one primary, and holds Codex
    // and the layouts. No dashed box, no path (the label's tooltip has it).
    return (
      <main className="tile-grid-wrap">
        {header}
        {showingCopies ? (
          <div className="tile-grid-body">{copiesView}</div>
        ) : (
        <div className="tile-grid-empty">
          {/* 1.174.0 E7 (T6, G16): one strong-bordered button — Reopen it
              when something was open at quit, otherwise the AI Setup chose
              (Codex on a Codex-only computer) — and the other ways to start
              as one quiet line. The header's New stays the one filled. */}
          {reopening ? (
            <div className="ux-group ux-empty">
              <ReopenSessionsOffer workspaceId={ws.id} variant="inline" offer={reopenOffer} />
              {cardSessionCount > 0 && <p className="ux-empty-text">{terminalsEmptyWords(cardSessionCount)}</p>}
              <p className="tile-grid-empty-links">
                <span>Or start a new session:</span>
                {startLinks(starts)}
              </p>
            </div>
          ) : (
            <EmptyState
              action={
                <div className="tile-grid-empty-actions">
                  <CBtn tone="strong" onClick={strong.open} title={strong.title}>
                    {strong.label}
                    {strong.keys && <kbd>{strong.keys}</kbd>}
                  </CBtn>
                  <p className="tile-grid-empty-links">
                    <span>or</span>
                    {startLinks([
                      ...starts.filter((x) => x.kind !== strong.kind && (x.kind !== "resume" || hasEarlier)),
                      { kind: "several", label: "Several at once…", title: "Open a set of sessions together", open: () => setLayoutPickerOpen(true) },
                    ])}
                  </p>
                </div>
              }
            >
              {(emptied || hadOffer.current) && cardSessionCount === 0
                ? noSessionsOpenWords(canResume)
                : terminalsEmptyWords(cardSessionCount)}
            </EmptyState>
          )}
          {sessionLinks.length > 0 && (
            <ul className="tile-grid-empty-cards" aria-label="Card sessions">
              {sessionLinks.map((c) => (
                <li key={c.key}>
                  <CBtn
                    tone="quiet"
                    title="Opens the card on this session."
                    onClick={() => {
                      openCardStep(ws.id, c.cardId, "run");
                      // A card built by both opens on this build's session.
                      if (c.lane) useBuildBoth.getState().showLane(ws.id, c.cardId, c.lane);
                    }}
                  >
                    {c.name}
                  </CBtn>
                </li>
              ))}
            </ul>
          )}
        </div>
        )}
        {layoutPicker}
        {resumeSheet}
        {newCopySheet}
      </main>
    );
  }

  return (
    <main className="tile-grid-wrap">
      {header}
      <ReopenSessionsOffer workspaceId={ws.id} variant="bar" offer={reopenOffer} />
      <div className="tile-grid-body">
      {/* 1.173.0 A3: Copies is drawn over the grid, which stays mounted and
          only hidden — a terminal is never unmounted to show it. */}
      <div
        className={`tile-grid${expandedTileId ? " expanded-mode" : ""}${showingCopies ? " tile-grid--behind" : ""}`}
        style={gridStyle}
        aria-hidden={showingCopies || undefined}
      >
        {/* 2026-09-30 (Challenger minor): one boundary per tile, so a
            tile that fails to draw takes only itself down — the others'
            terminals stay mounted. The Terminals host's is the last resort. */}
        {tiles.map((tile) => (
          <CentreErrorBoundary
            key={tile.id}
            view={tile.label}
            reach="tile"
            density="dense"
            onAction={(id) => {
              if (id === "close") void useTiles.getState().closeTile(tile.id);
            }}
          >
            <Tile
              tile={tile}
              env={env}
              workspaceCwd={ws.cwd}
              hidden={Boolean(expandedTileId) && tile.id !== expandedTileId}
              span={tile.id === lastShown ? span : undefined}
              comparePair={pairMarkOf(tile.id)}
              order={visualOrder?.get(tile.id)}
            />
          </CentreErrorBoundary>
        ))}
      </div>
      {showingCopies && copiesView}
      {/* 1.177.0 Compare: one line under the tiles, inside the same host, so
          nothing is unmounted; the grid refits by its own ResizeObserver. */}
      {/* 1.179.0: with two pairs, one bar each, stacked here. */}
      {!showingCopies && (
        <CompareBars workspaceId={ws.id} projectName={ws.name} expandedTileId={expandedTileId} onPairHover={setHoverSlot} />
      )}
      </div>
      {layoutPicker}
      {resumeSheet}
      {newCopySheet}
    </main>
  );
}
