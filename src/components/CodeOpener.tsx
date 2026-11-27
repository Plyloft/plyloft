import { useWorkspaces } from "../store/workspaceStore";
import { shortcutKeys } from "../lib/shortcuts";
import { Icon } from "./ux";
import "./code.css";

/**
 * v1.83.0 (UX revamp Part 2, P2-5 — Q5): the Code mode empty state. A
 * minimal opener: Go to file…, or pick one from the tree.
 *
 * GH #266: on the one scale — Lucide icons instead of text glyphs, the
 * heading at 600, a field that rings only on focus, a kbd at caption size —
 * and without the migration footnote to "Activity", which is History now.
 */
export function CodeOpener({ workspaceId }: { workspaceId: string }) {
  const wsName = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "",
  );
  return (
    <div className="code-opener">
      <div className="code-opener-inner">
        <span className="code-opener-icon">
          <Icon name="code" />
        </span>
        <h2 className="code-opener-title">Open a file</h2>
        <p className="code-opener-sub">
          Find any file in {wsName}, or pick one from the tree on the left.
        </p>
        <button
          type="button"
          className="code-opener-jump"
          onClick={() => window.dispatchEvent(new Event("ply:open-quickopen"))}
        >
          <Icon name="search" size="sm" />
          <span className="code-opener-jump-label">Go to file…</span>
          <kbd>{shortcutKeys("files")}</kbd>
        </button>
      </div>
    </div>
  );
}
