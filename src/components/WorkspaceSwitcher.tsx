import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { switchToWorkspace, useUi } from "../store/uiStore";
import { useNeedsYou } from "../hooks/useNeedsYou";
import { workspaceAccentColor } from "../lib/workspaceColor";
import { sharedNameIds, switcherFolder } from "../lib/workspacePath";
import { isWindows } from "../lib/platform";
import { ADD_PROJECT_LABEL, useAddProject } from "../store/addProjectStore";
import { CBtn, Icon, MoreMenu, Popover, Sheet } from "./ux";
import { WorkspaceIconChip } from "./WorkspaceIconChip";
import { WorkspaceIconPicker } from "./WorkspaceIconPicker";

/** GH #287: a failure in words, where it happened. */
function failureText(what: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause ?? "");
  return detail ? `${what}: ${detail}` : `${what}.`;
}

/** More than this many workspaces and the popover offers a search field. */
export const SWITCHER_SEARCH_FROM = 6;

/**
 * UX-3.3 (the Shell board, the WorkspaceSwitcher spec): the first row of the
 * sidebar names the current workspace; clicking it opens a popover to switch,
 * search, add or manage workspaces. It replaces the sidebar's list of every
 * workspace.
 *
 * - Recent first (`lastOpenedAt`), each with its attention count; a search
 *   field when there are more than five.
 * - Per workspace, beside it (never inside it — the GH #181 pattern), a `⋯`
 *   with Rename, Icon and colour, Remove. Remove confirms first.
 * - Enter opens the focused workspace, F2 renames it. ⌘1–9 still switch
 *   without opening the popover (App.tsx).
 */
export function WorkspaceSwitcher({ now }: { now: number }) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const refresh = useWorkspaces((s) => s.refresh);
  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [iconPicker, setIconPicker] = useState<
    { workspaceId: string; anchor: { left: number; top: number; bottom: number } } | null
  >(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  // GH #287: failures shown where they happened, never only in the console.
  const [renameError, setRenameError] = useState<{ id: string; text: string } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Destructive: focus opens on Cancel, so Enter never removes (SHEET.md).
  const removeCancelRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // UX-4.4: the one count, split by workspace — the same sum the sidebar's
  // Inbox row shows. GH #286: the counts are per row in the popover; the
  // trigger carries none (a number beside the current name read as its own),
  // only a dot, named in its accessible name, when another workspace waits.
  const attention = useNeedsYou(now).byWorkspace;
  const elsewhere = workspaces.reduce(
    (n, w) => (w.id === activeId ? n : n + (attention[w.id] ?? 0)),
    0,
  );

  // 1.174.0 (TX2, T9; D-T5): two workspaces with the same name each show
  // their folder, in a quiet line under the name; a unique name shows none.
  const shared = useMemo(() => sharedNameIds(workspaces), [workspaces]);
  const [home, setHome] = useState<string | null>(null);
  const needsHome = open && shared.size > 0 && home === null;
  useEffect(() => {
    if (!needsHome) return;
    let live = true;
    homeDir()
      .then((h) => live && setHome(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needsHome]);

  // ⌘K "Rename workspace" asks for the active one here.
  const renameRequest = useUi((s) => s.renameWorkspaceRequest);
  useEffect(() => {
    if (!renameRequest) return;
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === renameRequest);
    useUi.getState().requestWorkspaceRename(null);
    if (!ws) return;
    setOpen(true);
    setQuery("");
    setDraft(ws.name);
    setEditing(ws.id);
  }, [renameRequest]);

  // The sidebar's "N more workspaces" row opens the popover from outside.
  const openRequest = useUi((s) => s.switcherOpenRequest);
  useEffect(() => {
    if (!openRequest) return;
    useUi.getState().requestSwitcherOpen(false);
    setQuery("");
    setEditing(null);
    setOpen(true);
  }, [openRequest]);

  const searchable = workspaces.length >= SWITCHER_SEARCH_FROM;
  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...workspaces]
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
      .filter(
        (w) =>
          !q || w.name.toLowerCase().includes(q) || w.cwd.toLowerCase().includes(q),
      );
  }, [workspaces, query]);

  // Opening puts focus in the popover: the field when there is one, else the
  // current workspace — so Enter, F2 and the arrows work straight away.
  useEffect(() => {
    if (!open || editing) return;
    const id = requestAnimationFrame(() => {
      if (searchRef.current) {
        searchRef.current.focus();
        return;
      }
      const rows = listRef.current?.querySelectorAll<HTMLButtonElement>(".shell-switcher-item");
      const current =
        listRef.current?.querySelector<HTMLButtonElement>(".shell-switcher-item[aria-current]") ??
        rows?.[0];
      current?.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close(refocus = true) {
    setOpen(false);
    setQuery("");
    setEditing(null);
    if (refocus) triggerRef.current?.focus();
  }

  function choose(ws: Workspace) {
    close();
    // UX-4.3: where it opens is `switchToWorkspace`'s — the sidebar's stack
    // of other workspaces switches the same way.
    switchToWorkspace(ws.id);
  }

  function startRename(ws: Workspace) {
    setDraft(ws.name);
    setRenameError(null);
    setEditing(ws.id);
  }

  async function commitRename(ws: Workspace) {
    setEditing(null);
    const name = draft.trim();
    if (!name || name === ws.name) {
      setRenameError(null);
      return;
    }
    try {
      await useWorkspaces.getState().rename(ws.id, name);
      setRenameError(null);
    } catch (e) {
      // GH #287: the field stays open with what was typed and the reason.
      setRenameError({ id: ws.id, text: failureText("Couldn't rename it", e) });
      setEditing(ws.id);
    }
  }

  /** GH #287: rejects so the picker shows the failure in its own slot. */
  async function handleAccentChange(workspaceId: string, color: string | null) {
    await invoke<void>("workspace_set_accent_color", { id: workspaceId, color });
    await refresh();
  }

  async function confirmRemove(ws: Workspace) {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await useWorkspaces.getState().remove(ws.id);
      setRemoving(null);
    } catch (e) {
      // GH #287: the sheet stays up with the reason.
      setRemoveError(failureText("Couldn't remove it", e));
    } finally {
      setRemoveBusy(false);
    }
  }

  function moveFocus(from: HTMLElement, delta: number) {
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(".shell-switcher-item") ?? []),
    ];
    const at = rows.indexOf(from as HTMLButtonElement);
    const next = rows[at + delta];
    if (next) next.focus();
    else if (delta < 0) searchRef.current?.focus();
  }

  const iconPickerWs = iconPicker
    ? workspaces.find((w) => w.id === iconPicker.workspaceId) ?? null
    : null;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="shell-switcher-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={
        (active ? `${active.name}, switch workspace` : "No workspace, switch workspace") +
        (elsewhere > 0 ? ", other workspaces need you" : "")
      }
      title={
        (active ? `${active.name} — switch workspace` : ADD_PROJECT_LABEL) +
        (elsewhere > 0 ? " · other workspaces need you" : "")
      }
      onClick={() => (open ? close(false) : setOpen(true))}
    >
      {active ? (
        <WorkspaceIconChip
          icon={active.icon ?? null}
          name={active.name}
          accent={workspaceAccentColor(active.accentColor, active.name)}
          size="xs"
        />
      ) : (
        <Icon name="add" />
      )}
      <span className="shell-switcher-name">{active?.name ?? "No workspace"}</span>
      {elsewhere > 0 && (
        <span className="shell-dot shell-dot--info shell-switcher-elsewhere" aria-hidden="true" />
      )}
      <Icon name="choose" />
    </button>
  );

  return (
    <div className="shell-switcher">
      <Popover trigger={trigger} open={open} onClose={() => close(false)} label="Workspaces">
        {searchable && (
          <label className="shell-switcher-search">
            <Icon name="search" size="sm" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="Find a workspace"
              aria-label="Find a workspace"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ordered[0]) {
                  e.preventDefault();
                  choose(ordered[0]);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  listRef.current
                    ?.querySelector<HTMLButtonElement>(".shell-switcher-item")
                    ?.focus();
                }
              }}
            />
          </label>
        )}
        <div className="shell-caption">Recent</div>
        <div ref={listRef} className="shell-switcher-list">
          {ordered.length === 0 && (
            <p className="shell-switcher-empty">
              {workspaces.length === 0 ? "No workspaces yet." : "No workspace matches."}
            </p>
          )}
          {ordered.map((w) => {
            const isActive = w.id === activeId;
            const count = attention[w.id] ?? 0;
            const folder = shared.has(w.id) ? switcherFolder(w.cwd, home, isWindows()) : null;
            const named = folder ? `${w.name}, in ${folder}` : w.name;
            return (
              <div key={w.id} className="shell-switcher-row">
                {editing === w.id ? (
                  <span className="shell-switcher-rename-field">
                    <input
                      className="shell-switcher-rename"
                      value={draft}
                      autoFocus
                      aria-label={`Rename ${w.name}`}
                      aria-invalid={renameError?.id === w.id || undefined}
                      aria-describedby={
                        renameError?.id === w.id ? `ws-rename-error-${w.id}` : undefined
                      }
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => void commitRename(w)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitRename(w);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenameError(null);
                          setEditing(null);
                        }
                      }}
                    />
                    {renameError?.id === w.id && (
                      <span
                        id={`ws-rename-error-${w.id}`}
                        className="shell-switcher-rename-error"
                        role="alert"
                      >
                        {renameError.text}
                      </span>
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="shell-switcher-item"
                    aria-current={isActive ? "true" : undefined}
                    aria-label={count > 0 ? `${named}, ${count} ${count === 1 ? "needs" : "need"} you` : named}
                    title={`${w.cwd} — F2 renames`}
                    onClick={() => choose(w)}
                    onKeyDown={(e) => {
                      if (e.key === "F2") {
                        e.preventDefault();
                        startRename(w);
                      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        moveFocus(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
                      }
                    }}
                  >
                    <WorkspaceIconChip
                      icon={w.icon ?? null}
                      name={w.name}
                      accent={workspaceAccentColor(w.accentColor, w.name)}
                      size="xs"
                    />
                    {folder ? (
                      <span className="shell-switcher-names">
                        <span className="shell-switcher-name">{w.name}</span>
                        <span className="shell-switcher-folder">{folder}</span>
                      </span>
                    ) : (
                      <span className="shell-switcher-name">{w.name}</span>
                    )}
                    {count > 0 && (
                      <span
                        className="shell-count shell-count--attention"
                        aria-label={`${count} ${count === 1 ? "needs" : "need"} you`}
                      >
                        {count}
                      </span>
                    )}
                    {isActive && <Icon name="current" label="Current workspace" />}
                  </button>
                )}
                <MoreMenu
                  label={`More for ${w.name}`}
                  items={[
                    { label: "Rename", onSelect: () => startRename(w) },
                    {
                      label: "Icon and colour",
                      onSelect: () => {
                        const r = triggerRef.current?.getBoundingClientRect();
                        close(false);
                        setIconPicker({
                          workspaceId: w.id,
                          anchor: { left: r?.left ?? 0, top: r?.top ?? 0, bottom: r?.bottom ?? 0 },
                        });
                      },
                    },
                    "divider",
                    {
                      label: "Remove…",
                      danger: true,
                      onSelect: () => {
                        close(false);
                        setRemoving(w);
                      },
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
        <div className="shell-switcher-divider" role="separator" />
        <button
          type="button"
          className="shell-switcher-item shell-switcher-new"
          onClick={() => {
            close(false);
            useAddProject.getState().openAddProject();
          }}
        >
          <Icon name="add" />
          <span className="shell-switcher-name">{ADD_PROJECT_LABEL}…</span>
        </button>
      </Popover>
      {iconPicker && iconPickerWs && (
        <WorkspaceIconPicker
          workspaceId={iconPickerWs.id}
          name={iconPickerWs.name}
          icon={iconPickerWs.icon ?? null}
          accentColor={iconPickerWs.accentColor ?? null}
          anchor={iconPicker.anchor}
          onClose={() => setIconPicker(null)}
          onAccentChange={(c) => handleAccentChange(iconPickerWs.id, c)}
        />
      )}
      {removing && (
        // GH #287: up while the press runs (`canDismiss`), and a refusal
        // stays on it in `ux-sheet-alert`.
        <Sheet
          // GH #320: what leaves, in words — the sidebar no longer lists
          // workspaces, and the folder is never touched.
          title={`Remove ${removing.name} from Plyloft?`}
          lede="Its board and sessions leave Plyloft. The folder on disk stays as it is."
          size="confirm"
          canDismiss={!removeBusy}
          onClose={() => {
            setRemoveError(null);
            setRemoving(null);
          }}
          initialFocusRef={removeCancelRef}
          actions={
            <>
              <CBtn
                ref={removeCancelRef}
                disabled={removeBusy}
                onClick={() => {
                  setRemoveError(null);
                  setRemoving(null);
                }}
              >
                Cancel
              </CBtn>
              <CBtn
                tone="danger"
                className="ux-danger-fill"
                disabled={removeBusy}
                onClick={() => void confirmRemove(removing)}
              >
                {removeBusy ? "Removing…" : "Remove"}
              </CBtn>
            </>
          }
        >
          {removeError && (
            <p className="ux-sheet-alert" role="alert">
              {removeError}
            </p>
          )}
        </Sheet>
      )}
    </div>
  );
}
