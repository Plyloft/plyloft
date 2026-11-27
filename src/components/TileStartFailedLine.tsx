import type { Tile as TileT } from "../store/tileStore";
import { openRepair } from "../lib/openRepair";
import { repairLabel, startFailureLine } from "../lib/startFailure";
import { CBtn } from "./ux";
import { useSettings } from "../store/settingsStore";
import { hasPathOverride } from "../lib/diagnostics";
import { OPEN_PROGRAM_FOLDERS_LABEL, openProgramFolders } from "../lib/errorButtons";

/**
 * 1.176.0 R7: under the header of a Claude or Codex tile whose CLI didn't
 * start (`lib/startFailure.ts`), what happened in plain words and Repair —
 * a real button, beside the header's own Restart. Only once the tile has
 * ended; a restart makes a new tile without it. What the CLI printed stays
 * in the terminal below.
 */
export function TileStartFailedLine({ tile }: { tile: Pick<TileT, "kind" | "status" | "startFailed"> }) {
  const failed = tile.startFailed;
  const folders = useSettings((s) => hasPathOverride(s.settings.shell.pathOverride));
  const ended = tile.status === "done" || tile.status === "crashed";
  if (!failed || !ended || (tile.kind !== "claude" && tile.kind !== "codex")) return null;
  return (
    <div className="ux-tile-start-failed" role="status" data-ply-start-failed={failed.tool}>
      <span className="ux-tile-start-failed-dot" aria-hidden="true" />
      <span>{startFailureLine(failed, folders)}</span>
      <CBtn tone="quiet" onClick={() => void openRepair(failed.tool)}>
        {repairLabel(failed.tool)}
      </CBtn>
      {/* 1.176.3: the setting is the cause only while it is set and the tool wasn't found in it. */}
      {folders && failed.cause === "gone" && (
        <CBtn tone="quiet" onClick={openProgramFolders}>
          {OPEN_PROGRAM_FOLDERS_LABEL}
        </CBtn>
      )}
    </div>
  );
}
