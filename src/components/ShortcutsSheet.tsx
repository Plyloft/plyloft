import { useUi } from "../store/uiStore";
import { SHORTCUT_GROUPS, listedShortcuts, sheetKeys, shortcutKeys } from "../lib/shortcuts";
import { isWindows } from "../lib/platform";
import { Sheet } from "./ux";
import { CBtn } from "./ui/primitives";

/** 1.174.0 E5 (P22): the sheet's note on Windows. */
export const SHEET_WINDOWS_NOTE =
  "In a terminal, Ctrl and a letter go to the program in it (PowerShell, Claude, Codex). Plyloft's own keys there add Shift, or Alt for a new tile.";

/**
 * UX-3.7 (the Shell board): ⌘/ lists every keyboard shortcut. It draws
 * `SHORTCUTS` — the list App.tsx's key handler matches with — so the sheet
 * cannot name a shortcut that does nothing or miss one that exists — only
 * a retired key kept for muscle memory is left out (GH #322).
 */
export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  if (!open) return null;
  const close = () => useUi.getState().setShortcutsOpen(false);
  return (
    <Sheet
      title="Keyboard shortcuts"
      lede={`${shortcutKeys("palette")} finds everything else by name.`}
      onClose={close}
      // W5: on Windows a terminal keeps its program's Ctrl keys; 1.174.0 E5:
      // Plyloft's own there add Shift, or Alt (lib/shortcuts.ts).
      footNote={isWindows() ? <span className="shell-shortcuts-note">{SHEET_WINDOWS_NOTE}</span> : undefined}
      actions={
        <CBtn tone="strong" onClick={close}>
          Close
        </CBtn>
      }
    >
      <div className="shell-shortcuts">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group} className="shell-shortcuts-group" aria-label={group}>
            <h3 className="shell-shortcuts-heading">{group}</h3>
            <dl className="shell-shortcuts-list">
              {listedShortcuts().filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="shell-shortcuts-row">
                  <dt className="shell-shortcuts-label">{s.label}</dt>
                  <dd className="shell-shortcuts-keys">
                    {/* E5: both forms on Windows where a terminal changes it. */}
                    <kbd>{sheetKeys(s.id)}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
