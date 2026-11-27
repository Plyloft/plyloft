// 1.173.0 A3: a terminal in a copy says so in its head — "Copy · <name>" —
// and, while the copy's setup runs, "Setting up…"; a setup that failed says
// why, with Retry (or "Allow and run" when this Mac hasn't allowed the
// command yet: the cards' own approval, `setupHold`).
import { useState } from "react";
import { copySetupRetry } from "../ipc";
import { copyTileMark, plainCopyError } from "../lib/copyWords";
import { machineWords } from "../lib/platform";
import { setupHold } from "../lib/worktreeSetup";
import { copyForCwd, useCopies, useWorkspaceCopies } from "../store/copiesStore";
import { pushToast } from "../store/toastStore";
import type { Tile } from "../store/tileStore";

export function CopyTileMark({ tile }: { tile: Pick<Tile, "workspaceId" | "cwd"> }) {
  const rows = useWorkspaceCopies(tile.workspaceId);
  const copy = copyForCwd(rows, tile.cwd);
  const [retrying, setRetrying] = useState(false);
  if (!copy) return null;
  const hold = setupHold(copy.setup);
  const reason = copy.setup?.reason ?? "The setup command failed.";

  async function retry(allow: string | null) {
    if (!copy || retrying) return;
    setRetrying(true);
    try {
      await copySetupRetry(tile.workspaceId, copy.id, allow);
      await useCopies.getState().refresh(tile.workspaceId);
    } catch (e) {
      const said = plainCopyError(e);
      pushToast({ kind: "error", title: "Setup didn't start", body: machineWords(said.body), details: said.details });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <>
      <span className="tile-copy-mark" title={machineWords(`In its own copy of the project: ${copy.path}`)}>
        {copyTileMark(copy.name)}
      </span>
      {hold === "running" && (
        <span className="tile-copy-setup" role="status">
          Setting up…
        </span>
      )}
      {(hold === "failed" || hold === "approval") && (
        <span className="tile-copy-setup" role="status" title={machineWords(reason)}>
          {hold === "approval" ? "Setup needs your OK" : "Setup failed"}
          <button
            type="button"
            className="tile-copy-retry"
            disabled={retrying}
            onClick={(e) => {
              e.stopPropagation();
              void retry(hold === "approval" ? (copy.setup?.command ?? null) : null);
            }}
            title={machineWords(reason)}
          >
            {hold === "approval" ? "Allow and run" : "Retry"}
          </button>
        </span>
      )}
    </>
  );
}
