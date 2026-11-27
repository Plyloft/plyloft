// 1.173.0 (B2): "Area: Site ⌄" under the workspace's name (mockup
// areas.html scene 2). Only with two areas or more, none held. A real menu
// button (MoreMenu's MenuList: ↑ ↓ Home End, Enter, Esc): All areas · each
// area with where its cards go · Make <area> this Mac's default · Edit areas….
import { Icon, MoreMenu, type MenuItem } from "./ux";
import { machineWords } from "../lib/platform";
import {
  ALL_AREAS,
  AREA_MENU_LABEL,
  EDIT_AREAS,
  areaName,
  cardsGoTo,
  makeDefaultItem,
  pickerAreas,
  pickerLabel,
} from "../lib/areaPicker";
import { openAreasSettings, useAreas, useAreasView, useCurrentArea } from "../store/areaStore";
import { useWorkspaces } from "../store/workspaceStore";
import { pushToast } from "../store/toastStore";

export function AreaPicker({ workspaceId }: { workspaceId: string }) {
  const view = useAreasView(workspaceId);
  const current = useCurrentArea(workspaceId);
  const defaultArea = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.defaultArea ?? null,
  );
  const areas = pickerAreas(view);
  if (areas.length === 0) return null;

  const choose = (id: string | null) => useAreas.getState().choose(workspaceId, id);
  const makeDefault = makeDefaultItem(current, defaultArea, view);
  const items: MenuItem[] = [
    { label: ALL_AREAS, checked: current === null, onSelect: () => choose(null) },
    ...areas.map((a) => ({
      label: areaName(a),
      hint: cardsGoTo(a),
      checked: current?.id === a.id,
      onSelect: () => choose(a.id),
    })),
    "divider",
    ...(makeDefault
      ? [
          {
            label: machineWords(makeDefault.label),
            // Checked while the area shown is this Mac's default: pressing
            // it then goes back to All areas, in place.
            checked: makeDefault.checked,
            toggle: true,
            onSelect: () => {
              // The area shown stays shown: only where the next launch
              // starts changes.
              choose(current?.id ?? null);
              void useWorkspaces
                .getState()
                .setDefaultArea(workspaceId, makeDefault.next)
                .catch((err) =>
                  pushToast({
                    kind: "error",
                    title: machineWords("This Mac's default area wasn't saved"),
                    details: String(err),
                  }),
                );
            },
          },
        ]
      : []),
    { label: EDIT_AREAS, onSelect: () => openAreasSettings(workspaceId) },
  ];
  const label = pickerLabel(current);

  return (
    <div className="shell-area-row">
      <MoreMenu
        label={AREA_MENU_LABEL}
        items={items}
        tour="sidebar-area"
        trigger={({ ref, props }) => (
          <button
            ref={ref}
            type="button"
            className="shell-area-trigger"
            {...props}
            aria-label={`${label}, choose an area`}
            title={current ? `${label} — ${cardsGoTo(current)}` : label}
          >
            <span className="shell-area-name">{label}</span>
            <Icon name="expand" size="sm" />
          </button>
        )}
      />
    </div>
  );
}
