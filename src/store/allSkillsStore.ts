import { create } from "zustand";
import {
  onFileChange,
  onSkillsHubDecision,
  onSkillsHubIndex,
  onSkillsHubLibrary,
  onWorkspaceDefinitionRefreshed,
  skillsHubIndex,
  skillsHubIndexRefresh,
  type CopyFrom,
  type HubIndex,
  type DefinitionRefreshReport,
  type HubIndexEvent,
  type LibraryPullView,
} from "../ipc";
import { useSkillsHub } from "./skillsHubStore";
import { useUi } from "./uiStore";
import {
  applyIndexEvent,
  attentionCount,
  DEFAULT_FILTERS,
  EMPTY_INDEX,
  flattenIndex,
  linkedFrom,
  nameIndex,
  type HubFilters,
  type HubRow,
  type NameIndex,
} from "../lib/allSkills";

/**
 * Skills hub H7 (R4): All skills' index in the page — the cached index at
 * once, then what the backend's refresh streams (`skills-hub://index`).
 *
 * The derived values (`rows`, `names`, `attention`) are computed once per
 * change of the index, in the store, so every selector returns a field as it
 * is — never a fresh array (docs/PATTERNS.md, zustand selector stability).
 *
 * Nothing is read at launch but the cache file (`index.json`), a few seconds
 * in, for the sidebar's muted count; the skill folders are read when the page
 * opens, when a watched skill root changes (warmed workspaces only; Plyloft's
 * own editor saves too, `noteFileSaved`), when a definition refresh moved a
 * skill on the branch (not the routine ones at launch), when a
 * pull of the team library brought something (its commit moved — not every
 * background pull, which runs every 10 minutes and mostly brings nothing),
 * and once an hour while the window is visible (§14 Q17). An OK given to a
 * team skill's scripts reads the libraries alone, not the workspaces.
 */
interface AllSkillsState {
  index: HubIndex;
  /** The cache (or a refresh) has answered once. */
  loaded: boolean;
  refreshing: boolean;
  /** Workspaces being read now, as a set (stable until it changes). */
  reading: Readonly<Record<string, true>>;
  rows: readonly HubRow[];
  names: NameIndex;
  /** The sidebar's muted count. */
  attention: number;
  /** The page's own state: filters, the open row, the active row, the
   *  groups shown whole. Session-only, like the Library's. */
  filters: HubFilters;
  openKey: string | null;
  activeKey: string | null;
  expanded: Readonly<Record<string, boolean>>;
  /** Skills hub H8: Copy to… open over the page, for this skill. */
  copy: CopyFrom | null;
  /** Where closing it goes: back to the page, or — opened from a Library
   *  row — out of All skills, back to that Library. */
  copyBack: "page" | "library";

  load: (refresh?: boolean) => Promise<void>;
  apply: (event: HubIndexEvent) => void;
  setFilters: (patch: Partial<HubFilters>) => void;
  setOpenKey: (key: string | null) => void;
  setActiveKey: (key: string | null) => void;
  expand: (scope: string) => void;
  setCopy: (from: CopyFrom | null, back?: "page" | "library") => void;
}

const EMPTY_ROWS: readonly HubRow[] = [];
const EMPTY_NAMES: NameIndex = new Map();
const EMPTY_READING: Readonly<Record<string, true>> = {};

function derived(index: HubIndex) {
  const rows = flattenIndex(index);
  return { index, rows, names: nameIndex(rows), attention: attentionCount(rows) };
}

function readingOf(ids: readonly string[]): Readonly<Record<string, true>> {
  if (ids.length === 0) return EMPTY_READING;
  const out: Record<string, true> = {};
  for (const id of ids) out[id] = true;
  return out;
}

export const useAllSkills = create<AllSkillsState>((set, get) => ({
  index: EMPTY_INDEX,
  loaded: false,
  refreshing: false,
  reading: EMPTY_READING,
  rows: EMPTY_ROWS,
  names: EMPTY_NAMES,
  attention: 0,
  filters: DEFAULT_FILTERS,
  openKey: null,
  activeKey: null,
  expanded: {},
  copy: null,
  copyBack: "page",

  load: async (refresh = false) => {
    try {
      const view = await skillsHubIndex(refresh);
      // The backend's copy follows its stream workspace by workspace, so
      // what it answers is never older than what was painted.
      const state = get();
      set({
        ...derived(view.index),
        loaded: true,
        refreshing: view.refreshing,
        reading: view.reading.length > 0 ? readingOf(view.reading) : state.reading,
      });
    } catch (e) {
      console.warn("all skills: the index could not be read", e);
      set({ loaded: true, refreshing: false });
    }
  },

  apply: (event) => {
    const state = get();
    if (event.kind === "started") {
      const fresh = event.workspaceIds.filter((id) => !state.reading[id]);
      if (fresh.length === 0) {
        if (!state.refreshing) set({ refreshing: true });
        return;
      }
      const reading = { ...state.reading };
      for (const id of fresh) reading[id] = true;
      set({ refreshing: true, reading });
      return;
    }
    const index = applyIndexEvent(state.index, event);
    const patch: Partial<AllSkillsState> = index === state.index ? {} : derived(index);
    if (event.kind === "workspace" && state.reading[event.workspace.id]) {
      const reading = { ...state.reading };
      delete reading[event.workspace.id];
      patch.reading = Object.keys(reading).length === 0 ? EMPTY_READING : reading;
    }
    if (event.kind === "done") {
      patch.refreshing = false;
      patch.loaded = true;
      if (Object.keys(state.reading).length > 0) {
        const reading = { ...state.reading };
        for (const id of event.workspaceIds) delete reading[id];
        patch.reading = Object.keys(reading).length === 0 ? EMPTY_READING : reading;
      }
    }
    set(patch);
  },

  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  setOpenKey: (key) => set((s) => (s.openKey === key ? s : { openKey: key, activeKey: key ?? s.activeKey })),
  setActiveKey: (key) => set((s) => (s.activeKey === key ? s : { activeKey: key })),
  expand: (scope) => set((s) => (s.expanded[scope] ? s : { expanded: { ...s.expanded, [scope]: true } })),
  setCopy: (from, back = "page") => set((s) => (s.copy === from && s.copyBack === back ? s : { copy: from, copyBack: back })),
}));

/** Skills hub H8: open Copy to… from a workspace's Library row — over All
 *  skills, which closes again with it. */
export function openCopyTo(from: CopyFrom): void {
  useAllSkills.getState().setCopy(from, "library");
  useUi.getState().setAllSkillsOpen(true);
}

/** Close Copy to…, back where it was opened from. */
export function closeCopyTo(): void {
  const { copyBack, setCopy } = useAllSkills.getState();
  setCopy(null);
  if (copyBack === "library") useUi.getState().setAllSkillsOpen(false);
}

/** Read everything again (the page opening, the hourly sweep). */
export function refreshAllSkills(): void {
  void useAllSkills.getState().load(true);
}

/** H8 (Windows walk): read these workspaces again, not every one — after
 *  Copy to… only the workspaces it touched changed (a whole read of 42
 *  workspaces left a row on "reading…" for most of a minute). */
export function refreshAllSkillsFor(workspaceIds: readonly string[]): void {
  if (workspaceIds.length === 0) return;
  void skillsHubIndexRefresh([...new Set(workspaceIds)]).catch((e) => console.warn("all skills: read again failed", e));
}

/** The libraries alone, from their clones here, with no workspace and nothing
 *  asked of GitHub: after a change to the team library this Mac just made. */
export function refreshAllSkillsLibraries(): void {
  void skillsHubIndexRefresh([], true).catch((e) => console.warn("all skills: read again failed", e));
}

/** A skill root of a warmed workspace changed (`fs://changed`). */
export const SKILL_ROOT_PATH = /(^|[\\/])\.(claude|agents|codex)[\\/]skills([\\/]|$)/;

/** Changes under a skill root wait this long, then one read per workspace. */
export const DEBOUNCE_MS = 2000;
/** The sweep while the window is visible (§14 Q17). */
export const SWEEP_MS = 60 * 60 * 1000;
/** Whether a definition refresh changed a skill All skills reads: its
 *  library sync brought or published one, or it was this Mac's first read. */
export function definitionMovedSkills(report: DefinitionRefreshReport): boolean {
  if (report.firstRead) return true;
  const library = report.library;
  if (!library) return false;
  return library.updates.some((u) => u.kind === "skill") || library.published.some((p) => p.kind === "skill");
}

/** A decision event this soon after a pull's library event is the pull's. */
const PULL_ECHO_MS = 5000;

/** What of the team library's pull record moves All skills' rows. */
export function libraryKey(team: LibraryPullView | null): string {
  if (!team) return "none";
  return [team.repo, team.lastPullCommit, team.hasClone, team.switchedOff, team.accessLost, team.leftAt].join("|");
}

/** The cache, for the sidebar's count, a little after launch. */
const CACHE_AFTER_MS = 4000;

let started = false;
let stops: (() => void)[] = [];
/** While subscribed: a skill file changed under `workspaceId`. */
let skillRootChanged: ((workspaceId: string) => void) | null = null;

/**
 * Plyloft's own editor saved `path` (⌘S). The watcher drops its own writes
 * (`SelfWriteTracker`), so no `fs://changed` comes for them; a save under a
 * skill root is told here instead.
 */
export function noteFileSaved(workspaceId: string, path: string): void {
  if (SKILL_ROOT_PATH.test(path)) skillRootChanged?.(workspaceId);
}

/** Tests: the next start subscribes again (each test has its own Tauri). */
export function stopAllSkillsSubscriptions(): void {
  for (const stop of stops) stop();
  stops = [];
  started = false;
  skillRootChanged = null;
}

export function startAllSkillsSubscriptions(): void {
  if (started) return;
  started = true;
  const keep = (unlisten: Promise<() => void>) => {
    void unlisten.then((fn) => stops.push(fn)).catch(() => {});
  };
  keep(onSkillsHubIndex((event) => useAllSkills.getState().apply(event)));

  const pending = new Set<string>();
  let libraries = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const whole = pending.has("*");
      const ids = [...pending].filter((id) => id !== "*");
      const withLibraries = libraries;
      pending.clear();
      libraries = false;
      void skillsHubIndexRefresh(whole ? undefined : ids, withLibraries).catch((e) =>
        console.warn("all skills: refresh failed", e),
      );
    }, DEBOUNCE_MS);
  };
  const later = (workspaceId: string | null) => {
    // Nothing to keep current before anything was read.
    const state = useAllSkills.getState();
    if (!state.loaded) return;
    pending.add(workspaceId ?? "*");
    // Skills hub H8: the copies linked to this workspace's skills read their
    // state again with it (a change committed here is their upstream).
    if (workspaceId) {
      const repo = state.index.workspaces.find((w) => w.id === workspaceId)?.repo ?? null;
      for (const id of linkedFrom(state.rows, workspaceId, repo)) pending.add(id);
    }
    flush();
  };
  keep(
    onFileChange((e) => {
      if (SKILL_ROOT_PATH.test(e.path)) later(e.workspaceId);
    }),
  );
  skillRootChanged = (workspaceId) => later(workspaceId);
  // A definition refresh runs for every warmed workspace at launch and
  // again later; only one whose sync moved a skill on the branch (or set
  // this Mac up) changes what All skills shows.
  keep(
    onWorkspaceDefinitionRefreshed((report) => {
      if (definitionMovedSkills(report)) later(report.workspaceId);
    }),
  );
  // A pull of the team library that brought something (its commit moved), a
  // team joined or left, the library switched off or lost: its rows, and
  // every link. The record as this Mac first reads it is no change.
  let seen: string | undefined;
  stops.push(
    useSkillsHub.subscribe((next) => {
      const key = libraryKey(next.team);
      if (seen === undefined) {
        seen = key;
        return;
      }
      if (key === seen) return;
      seen = key;
      later(null);
    }),
  );
  // An OK given to a team skill's scripts (skills-hub://decision): the
  // team rows' "waiting for this Mac's OK". A pull says it too, right after
  // its library event — that one is judged above.
  let lastPull = 0;
  keep(onSkillsHubLibrary(() => (lastPull = Date.now())));
  keep(
    onSkillsHubDecision(() => {
      if (Date.now() - lastPull < PULL_ECHO_MS) return;
      if (!useAllSkills.getState().loaded) return;
      libraries = true;
      flush();
    }),
  );

  const first = setTimeout(() => {
    if (!useAllSkills.getState().loaded) void useAllSkills.getState().load(false);
  }, CACHE_AFTER_MS);
  const sweep = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!useAllSkills.getState().loaded) return;
    refreshAllSkills();
  }, SWEEP_MS);
  stops.push(() => {
    clearTimeout(first);
    clearInterval(sweep);
    if (timer) clearTimeout(timer);
  });
}
