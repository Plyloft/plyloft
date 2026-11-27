import { create } from "zustand";
import { pushToast } from "./toastStore";
import { makeWorkspaceRefresh } from "../lib/activeWorkspace";
import { invoke } from "@tauri-apps/api/core";
import type { RightTabKey } from "./uiStore";
import { pathParts } from "../lib/paths";
import { normalizeModels, type WorkspaceModels } from "../lib/workspaceModels";
import type { ListGrouping } from "../lib/boardList";
import type { ShipVia } from "../lib/shipVia";
import { pushErrorToast } from "../lib/errorToast";

/** v1.4.0 (L2): tile-grid layout preset. null/undefined/"auto" → grid
 *  auto-sizes from tile count. Other values map to fixed shapes. */
export type LayoutPreset =
  | "auto"
  | "single"
  | "split"
  | "quad"
  | "six";

/** v1.43.0 (Sidebar identity): per-workspace icon. `null`/`undefined`
 *  → FE derives a monogram from the workspace name. `{ kind: "monogram" }`
 *  is the explicit "default" sentinel after a Reset. `Emoji` + `Image`
 *  are user-customized overrides. `Image.mtime` (millis since epoch)
 *  cache-busts the `<img src>` after a replace. */
export type WorkspaceIcon =
  | { kind: "monogram" }
  | { kind: "emoji"; value: string }
  | { kind: "image"; path: string; mtime: number };

export type Workspace = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastOpenedAt: number;
  openFiles: string[];
  activeFile: string | null;
  /** v0.5.0: optional accent color (hex). null/undefined → neutral grey. */
  accentColor?: string | null;
  /** Owner, 2026-10-20: the person chose this name (added with a name other
   *  than its folder's, or renamed), so a shared `.atelier/workspace.json`
   *  never renames it. Absent on workspaces from before the field. */
  nameChosen?: boolean | null;
  /** v1.4.0: optional tile-grid layout preset. null/undefined → auto. */
  layoutPreset?: LayoutPreset | null;
  /** v1.14.0: right-tabs pin order. GH #95 (ADR 0005): the right panel is
   *  retired — still decoded so old workspaces.json files load unchanged,
   *  and ignored by the shell. Nothing writes it any more. */
  pinnedRightTabs?: RightTabKey[] | null;
  /** v1.43.0: per-workspace icon override. See `WorkspaceIcon`. */
  icon?: WorkspaceIcon | null;
  /** v1.57.0 (Cycle 3): kanban backing mode. `local` (default) keeps the
   *  board in app-data only; `githubIssues` mirrors cards to issues in
   *  `githubOwnerRepo` (claim via assignee, sync on open / Sync button). */
  kanbanSyncMode?: KanbanSyncMode;
  /** v1.57.0 (Cycle 3): `owner/repo` backing the kanban board when
   *  `kanbanSyncMode` is `githubIssues`. null for local-only workspaces. */
  githubOwnerRepo?: string | null;
  /** Onboarding (ONBOARDING_SPEC §8.4): the GitHub login Ply uses for this
   *  workspace's GitHub calls when several accounts are signed in. Absent or
   *  null = gh's active account. Personal to this Mac; never in `.atelier/`. */
  githubAccount?: string | null;
  /** SL-3: "Merge when checks pass", remembered per workspace on this Mac.
   *  1.171.0 B3: Ship ▾'s pull request choices write it (merge when checks
   *  pass: on; pull request only: off) and a `pr` ship follows it. Absent =
   *  off. */
  mergeWhenChecksPass?: boolean;
  /** G1 (1.170.0): how Ship it ships — `"github"` (a pull request that
   *  merges when its checks pass) or `"local"` (on this Mac only).
   *  Absent = GitHub where a pull request can be opened (`shipItGoesToGitHub`).
   *  Personal to this Mac. */
  shipVia?: string | null;
  /** G1: the one-time "Ship it now puts the card on GitHub" notice was
   *  answered. Absent = not yet. */
  shipNoticeSeen?: boolean;
  /** CL-4: this workspace's own Builder/Challenger models, merged field by
   *  field over the app's `behavior.models`. Absent = the app rows. Personal
   *  to this Mac; never in `.atelier/` (ADR 0003). */
  models?: WorkspaceModels | null;
  /** CL-9: how the Board's List view groups its rows — `"stage"`, or by
   *  attention (the columns) when absent. Personal to this Mac. A value a
   *  later build writes reads as attention (`listGroupingOf`). */
  listGrouping?: string | null;
  /** N18: "Delete card branches when their trash expires" is off for this
   *  workspace. Absent = on. Personal to this Mac. */
  keepCardBranches?: boolean;
  /** F1 (1.172.1): *I don't work here* — the project folder's "Your project
   *  folder is from …" notice and toast stop for this workspace. Absent =
   *  off. Personal to this Mac. */
  dontWorkHere?: boolean;
  /** G7: the workspace's default for "Fix failing checks by itself" (off). */
  fixFailingChecks?: boolean;
  /** G7 fixes (Minor 5): since when that default is on (ms); it covers
   *  failures first seen after it. Absent while off (and on a file from
   *  before it: every failure counts). */
  fixFailingChecksSince?: number | null;
  /** 1.175.0 F7: the "Turn on" offer was answered in this project (Turn on
   *  or Not now) — it isn't offered again. Absent = not yet. Personal to this Mac. */
  fixFailingChecksOffered?: boolean;
  /** N18: the answer to the one-time offer to delete old card branches. */
  branchBacklog?: { answer: string; at: number } | null;
  /** 1.173.0 (B2): the area the picker starts at on this Mac (an area id).
   *  Absent = *All areas*; an id the repository no longer lists reads as
   *  *All areas* too. Personal to this Mac. */
  defaultArea?: string | null;
  /** 1.173.0 (B2): *Not now* on the Board's two-products notice. Absent =
   *  not answered. Personal to this Mac. */
  areaNoticeDismissed?: boolean;
};

/** CL-9: the List's grouping for a workspace — "stage" only when it says so. */
export function listGroupingOf(ws: Pick<Workspace, "listGrouping"> | undefined): ListGrouping {
  return ws?.listGrouping === "stage" ? "stage" : "attention";
}

/** v1.57.0 (Cycle 3): how a workspace's kanban board is backed. */
export type KanbanSyncMode = "local" | "githubIssues";

type WorkspacesFile = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
};

type WorkspaceState = {
  workspaces: Workspace[];
  activeId: string | null;
  cwdMissing: Record<string, boolean>;
  /** OB-15: the list has been read at least once. Until then `workspaces` is
   *  `[]` because nothing is known, not because there are none (a failed
   *  read leaves it false). */
  loaded: boolean;
  refresh: () => Promise<void>;
  create: (cwd: string, name?: string) => Promise<Workspace>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  setFiles: (
    id: string,
    openFiles: string[],
    activeFile: string | null,
  ) => Promise<void>;
  /** v1.4.0 (L2): set per-workspace tile-grid layout preset. null/undefined
   *  / "auto" clears any override. */
  setLayoutPreset: (
    id: string,
    preset: LayoutPreset | null,
  ) => Promise<void>;
  /** v1.43.0: set a non-image icon (monogram sentinel or emoji). Pass
   *  `null` to clear the override (FE falls back to monogram derived
   *  from the workspace name). Image uploads go through `setIconImage`. */
  setIcon: (id: string, icon: WorkspaceIcon | null) => Promise<void>;
  /** v1.43.0: upload an external image file as the workspace icon. The
   *  backend copies it into the app config dir, validates magic bytes
   *  (PNG/JPEG/WebP only — SVG rejected), enforces a 2 MB cap, and
   *  returns the canonical path. Refreshes the workspaces list on
   *  success so the new icon variant is reflected. */
  setIconImage: (id: string, srcPath: string) => Promise<void>;
  /** SL-3: remember "Merge when checks pass" for the workspace. */
  setMergeWhenChecksPass: (id: string, on: boolean) => Promise<void>;
  /** G1: Settings › Shipping › How Ship it ships (`null` = the
   *  default). */
  setShipVia: (id: string, via: ShipVia | null) => Promise<void>;
  /** G1: the one-time Ship it notice was answered for the workspace. */
  markShipNoticeSeen: (id: string) => Promise<void>;
  /** N18: Settings › Board and worktrees › Delete card branches when their
   *  trash expires. */
  setDeleteCardBranches: (id: string, on: boolean) => Promise<void>;
  /** F1: *I don't work here* on or off for the workspace's project folder. */
  setDontWorkHere: (id: string, on: boolean) => Promise<void>;
  /** 1.173.0 (B2): *Make <area> this Mac's default* (`null` = All areas). */
  setDefaultArea: (id: string, area: string | null) => Promise<void>;
  /** 1.173.0 (B2): *Not now* on the two-products notice, for good. */
  dismissAreaNotice: (id: string) => Promise<void>;
  /** G7: the workspace's default for "Fix failing checks by itself". */
  setFixFailingChecks: (id: string, on: boolean) => Promise<void>;
  /** 1.175.0 F7: the "Turn on" offer was answered here. */
  markFixFailingChecksOffered: (id: string) => Promise<void>;
  /** CL-9: remember how the List view groups for the workspace. The store
   *  changes at once; a refused write puts the previous choice back. */
  setListGrouping: (id: string, grouping: ListGrouping) => Promise<void>;
  /** CL-4: change this workspace's own model rows (`null` = the app's).
   *  `change` gets the latest rows — including edits still being saved — so
   *  quick successive edits never overwrite each other. The store changes at
   *  once; the writes reach the backend one at a time, in order; after a
   *  refused one the workspaces are reloaded from the backend. */
  updateModels: (
    id: string,
    change: (current: WorkspaceModels | null) => WorkspaceModels | null,
  ) => Promise<void>;
};

function basename(path: string): string {
  const parts = pathParts(path);
  return parts[parts.length - 1] ?? "workspace";
}

/** CL-4 (F1): each workspace's model writes, chained so they reach the
 *  backend in the order they were made. */
const modelWrites = new Map<string, Promise<unknown>>();

export const useWorkspaces = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeId: null,
  cwdMissing: {},
  loaded: false,

  // GH #79: sequenced — a background refresh started before a delete or
  // create can't overwrite the list their own refresh applied.
  refresh: makeWorkspaceRefresh<Workspace>({
    list: () => invoke<WorkspacesFile>("workspace_list"),
    cwdExists: (id) => invoke<boolean>("workspace_cwd_exists", { id }),
    activeId: () => get().activeId,
    apply: (next) => set({ ...next, loaded: true }),
  }),

  create: async (cwd, name) => {
    const ws = await invoke<Workspace>("workspace_create", {
      cwd,
      name: name ?? basename(cwd),
    });
    await get().refresh();
    await get().setActive(ws.id);
    // v1.113.0: the backend applied the repo's committed
    // `.atelier/workspace_default.json`; say so, or the board looks like
    // it silently chose GitHub on its own.
    if (ws.kanbanSyncMode === "githubIssues" && ws.githubOwnerRepo) {
      pushToast({
        kind: "info",
        title: `Board backed by GitHub Issues · ${ws.githubOwnerRepo}`,
        body: "From the project's .atelier/workspace_default.json. Change it in Settings › Project › General.",
      });
    }
    return ws;
  },

  remove: async (id) => {
    await invoke<void>("workspace_delete", { id });
    await get().refresh();
  },

  setActive: async (id) => {
    // Optimistic: flip `activeId` synchronously so the sidebar + right-panel
    // tabs swap on the click frame. Persisting the active workspace is
    // best-effort — fire the IPC without awaiting so the backend round-trip
    // never gates the visible switch. (Awaiting it here was a freeze
    // contributor: nothing moved on screen until the round-trip returned.)
    set({ activeId: id });
    invoke<void>("workspace_set_active", { id }).catch((e) => {
      console.error("workspace_set_active failed:", e);
      // 1.176.2 (E1, S-9): the switch shows now; it isn't kept for the next launch.
      pushErrorToast("Plyloft couldn't remember which project is open", e);
    });
  },

  rename: async (id, name) => {
    await invoke<void>("workspace_rename", { id, name });
    await get().refresh();
  },

  setFiles: async (id, openFiles, activeFile) => {
    await invoke<void>("workspace_set_files", { id, openFiles, activeFile });
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, openFiles, activeFile } : w,
      ),
    }));
  },

  setLayoutPreset: async (id, preset) => {
    // Treat "auto" same as null — back-compat with the no-override case.
    const normalized = preset && preset !== "auto" ? preset : null;
    await invoke<void>("workspace_set_layout_preset", {
      id,
      preset: normalized,
    });
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, layoutPreset: normalized } : w,
      ),
    }));
  },

  setIcon: async (id, icon) => {
    await invoke<void>("workspace_set_icon", { id, icon });
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, icon } : w,
      ),
    }));
  },

  setMergeWhenChecksPass: async (id, on) => {
    await invoke<void>("workspace_set_merge_when_checks_pass", { id, on });
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, mergeWhenChecksPass: on } : w,
      ),
    }));
  },

  setShipVia: async (id, via) => {
    await invoke<void>("workspace_set_ship_via", { id, via });
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, shipVia: via } : w)),
    }));
  },

  markShipNoticeSeen: async (id) => {
    await invoke<void>("workspace_mark_ship_notice_seen", { id });
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, shipNoticeSeen: true } : w)),
    }));
  },

  setDontWorkHere: async (id, on) => {
    await invoke<void>("workspace_set_dont_work_here", { id, on });
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, dontWorkHere: on } : w)),
    }));
  },

  setDefaultArea: async (id, area) => {
    await invoke<void>("workspace_set_default_area", { id, area });
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, defaultArea: area } : w)),
    }));
  },

  dismissAreaNotice: async (id) => {
    await invoke<void>("workspace_dismiss_area_notice", { id });
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, areaNoticeDismissed: true } : w)),
    }));
  },

  setDeleteCardBranches: async (id, on) => {
    await invoke<void>("workspace_set_delete_card_branches", { id, on });
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, keepCardBranches: !on } : w,
      ),
    }));
  },

  setFixFailingChecks: async (id, on) => {
    const since = await invoke<number | null>("workspace_set_fix_failing_checks", { id, on });
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, fixFailingChecks: on, fixFailingChecksSince: since ?? null } : w,
      ),
    }));
  },

  markFixFailingChecksOffered: async (id) => {
    await invoke<void>("workspace_fix_failing_checks_offered", { id });
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, fixFailingChecksOffered: true } : w)),
    }));
  },

  setListGrouping: async (id, grouping) => {
    const before = get().workspaces.find((w) => w.id === id)?.listGrouping ?? null;
    const put = (listGrouping: string | null) =>
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, listGrouping } : w)),
      }));
    put(grouping === "stage" ? "stage" : null);
    try {
      await invoke<void>("workspace_set_list_grouping", { id, grouping });
    } catch (e) {
      put(before);
      throw e;
    }
  },

  updateModels: async (id, change) => {
    const current = () => get().workspaces.find((w) => w.id === id)?.models ?? null;
    const next = normalizeModels(change(current()));
    const put = (models: WorkspaceModels | null) =>
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, models } : w)),
      }));
    put(next);
    const write = (modelWrites.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => invoke<void>("workspace_set_models", { id, models: next }));
    modelWrites.set(id, write);
    try {
      await write;
    } catch (e) {
      // Round 3 (F5): after any refused save the backend is the source of
      // truth. Wait for the writes queued behind this one, then reload the
      // workspaces from it rather than guessing what to roll back.
      await (modelWrites.get(id) ?? Promise.resolve()).catch(() => {});
      await get().refresh().catch(() => {});
      throw e;
    } finally {
      if (modelWrites.get(id) === write) modelWrites.delete(id);
    }
  },

  setIconImage: async (id, srcPath) => {
    // Backend copies the file + returns the canonical path; we refresh
    // workspaces so the new Image variant (with its mtime cache-buster)
    // shows up across the app.
    await invoke<string>("workspace_set_icon_image", { id, srcPath });
    await get().refresh();
  },
}));
