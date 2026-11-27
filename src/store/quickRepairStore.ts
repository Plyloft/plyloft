import { create } from "zustand";
import type { CliTool } from "../lib/cliHealthIpc";

/**
 * 1.176.0 seams: what Diagnostics' quick repair read (`RepairGroup`) found
 * about each tool's Update — `updateBlocked`: the copy Plyloft runs can't be
 * updated by its own updater. The tool rows read it to offer Repair instead
 * of an Update Setup would refuse. In memory; set at each quick read.
 */
interface QuickRepairState {
  updateBlocked: Partial<Record<CliTool, boolean>>;
  setUpdateBlocked: (tool: CliTool, blocked: boolean) => void;
}

export const useQuickRepair = create<QuickRepairState>((set) => ({
  updateBlocked: {},
  setUpdateBlocked: (tool, blocked) =>
    set((s) => (s.updateBlocked[tool] === blocked ? s : { updateBlocked: { ...s.updateBlocked, [tool]: blocked } })),
}));
