import { useRepair } from "../store/repairStore";
import { useSetup } from "../store/setupStore";
import { useUi } from "../store/uiStore";
import type { CliTool } from "./cliHealthIpc";

/**
 * 1.176.0 R6: open the guided Repair of `tool`. Settings opens on
 * Diagnostics (where the Repair group lives) and the Repair sheet over it. From
 * Setup, whose overlay covers Settings, the sheet opens over Setup instead:
 * it is hosted above both (`RepairSheetHost`). `reinstall` offers it as
 * "Reinstall anyway" from the start.
 */
export function openRepair(tool: CliTool, options?: { reinstall?: boolean }): void {
  if (!useSetup.getState().open) useUi.getState().openSettingsSection("diagnostics");
  useRepair.getState().show(tool, options);
}
