import { CBtn } from "../ui/primitives";
import { backendMarkTool } from "../../lib/backendMarks";
import { repairLabelFor } from "../../lib/cliNotStarting";
import { openRepair } from "../../lib/openRepair";

/** 1.176.0 seams: "Repair Claude Code" / "Repair Codex" beside a backend
 *  text that carries a mark naming that tool (`lib/backendMarks`); nothing
 *  otherwise. The text itself is shown through `showBackendText`. */
export function RepairFor({ texts, size = "sm" }: { texts: ReadonlyArray<string | null | undefined>; size?: "sm" | "md" }) {
  const tool = texts.map((t) => backendMarkTool(t)).find((t) => t !== null) ?? null;
  if (!tool) return null;
  return (
    <CBtn size={size} tone="quiet" onClick={() => openRepair(tool)}>
      {repairLabelFor(tool)}
    </CBtn>
  );
}
