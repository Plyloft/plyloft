import { useEffect, useState } from "react";
import { useEditor } from "../store/editorStore";
import { codeownersCheck } from "../ipc";
import { Icon } from "./ux";

/**
 * v1.62.0 (Phase 6): read-only ribbon above the editor. When the active file is
 * covered by the repo's `.github/CODEOWNERS`, it warns that the edit will need
 * the owner's review. Parses the *real* CODEOWNERS (backend), so it self-gates
 * to nothing when the file isn't flagged, there's no active file, or the repo
 * has no CODEOWNERS — and works for any repo that ships one, not just Ply.
 */
export function CodeownersRibbon({ workspaceId }: { workspaceId: string }) {
  const activePath = useEditor(
    (s) => s.byWorkspace[workspaceId]?.activePath ?? null,
  );
  const [owners, setOwners] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!activePath) {
      setOwners([]);
      return;
    }
    codeownersCheck(workspaceId, activePath)
      .then((r) => {
        if (!cancelled) setOwners(r.flagged ? r.owners : []);
      })
      .catch(() => {
        if (!cancelled) setOwners([]); // quiet degrade
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, activePath]);

  if (owners.length === 0) return null;

  // v1.78.0 (P2-0): English-only + name the actual CODEOWNERS entries instead
  // of a hardcoded person — works for any repo that ships a CODEOWNERS.
  return (
    <div className="ux-codeowners-ribbon" role="note">
      <span className="ux-codeowners-ribbon-icon">
        <Icon name="warning" size="sm" />
      </span>
      <span>
        Owned in CODEOWNERS: this change will need a review from {owners.join(", ")}.
      </span>
    </div>
  );
}
