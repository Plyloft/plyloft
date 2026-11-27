import type { ReactNode } from "react";
import { useWorkspaces } from "../store/workspaceStore";
import type { CenterMode } from "../store/uiStore";
import { ScreenHeader } from "./ux";
import { SidebarToggle } from "./SidebarSlot";
import { windowDragRegion } from "../lib/platform";

/** The words for each centre mode — the sidebar's and the header's. */
export const MODE_LABEL: Record<CenterMode, string> = {
  inbox: "Inbox",
  board: "Board",
  code: "Code",
  terminals: "Terminals",
  // UX-3.3, UX-4.5: the mode keeps its id; the page is History.
  activity: "History",
  library: "Library",
};

/** Modes that show every workspace rather than the current one. */
const GLOBAL_MODES: ReadonlySet<CenterMode> = new Set(["inbox", "activity"]);

/**
 * UX-3.5 (the Shell board): the top of every mode — the sidebar button, then
 * the `ScreenHeader`: `Workspace › Mode`, the title, and the mode's actions
 * (at most one primary and a `⋯`). The strip is the window's drag region
 * (UX-3.2); its controls stay clickable.
 */
export function ModeHeader({
  mode,
  label: labelOverride,
  workspaceId,
  title,
  trail,
  actions,
  subtitle,
  size,
  onModeCrumb,
  belowMode,
}: {
  mode: CenterMode | null;
  /** Skills hub H7: an app-level page that is no mode (All skills) names
   *  itself; its scope is every workspace. */
  label?: string;
  /** C6: `display` on a card page. */
  size?: "title" | "display";
  /** C6: the mode's crumb leads back to it (a card page's `Board`). */
  onModeCrumb?: () => void;
  /** 1.174.0 E3: the title names a page below the mode (Terminals ›
   *  Copies), so the mode's crumb is a link with its › even with no trail. */
  belowMode?: boolean;
  /** UX-8.5: crumbs after the mode's — Code's open file's folders. */
  trail?: string[];
  /** The workspace the screen belongs to; the active one when omitted. */
  workspaceId?: string;
  /** GH #254: null draws the crumbs only (a card page's title heads its
   *  page column, beside its ⋯). */
  title?: ReactNode | null;
  actions?: ReactNode;
  /** 1.172.1 (F2): a quiet line under the title. */
  subtitle?: ReactNode;
}) {
  const name = useWorkspaces((s) => {
    const id = workspaceId ?? s.activeId;
    return s.workspaces.find((w) => w.id === id)?.name ?? null;
  });
  const label = labelOverride ?? (mode ? MODE_LABEL[mode] : "");
  const scope = mode === null || GLOBAL_MODES.has(mode) ? "All workspaces" : name ?? "No workspace";
  return (
    <div className="shell-stage-header" data-tauri-drag-region={windowDragRegion()}>
      <SidebarToggle />
      <div className="shell-stage-header-main">
        <ScreenHeader
          crumbs={[
            { label: scope },
            { label, onClick: onModeCrumb, parent: belowMode && !trail?.length },
            ...(trail ?? []).map((t) => ({ label: t })),
          ]}
          title={title === null ? null : title ?? label}
          size={size}
          actions={actions}
          subtitle={subtitle}
        />
      </div>
    </div>
  );
}
