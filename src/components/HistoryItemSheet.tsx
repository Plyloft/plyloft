import { useEffect, useState } from "react";
import { agentRunGet, type AgentRun, type MailboxEntry } from "../ipc";
import { useUi, type HistorySheetTarget } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useSwarms } from "../store/swarmStore";
import { AgentRunView } from "./AgentRunView";
import { MailboxFeed, RoleStatusStrip } from "./SwarmRunViews";
import { CBtn, Sheet } from "./ux";
import { machineWords } from "../lib/platform";

/**
 * QoL 11.3: what a History row or a ⌘⇧H hit opens when there is no card to
 * open — a run's output, read-only once it has ended, with the changes it
 * saved (`AgentRunView`, the same view a run's tile shows), or a
 * brainstorm's mailbox (the feed a card's brainstorm shows). Mounted once,
 * in App; `uiStore.historySheet` names what it shows.
 *
 * Read-only (Challenger 3): a run here has no Requeue and takes no typing,
 * and a brainstorm offers no "Show the run" and nothing to promote — what
 * acts on them is in their own workspace.
 */
export function HistoryItemSheet() {
  const target = useUi((s) => s.historySheet);
  if (!target) return null;
  const close = () => useUi.getState().openHistorySheet(null);
  return target.kind === "run" ? (
    <RunSheet key={target.runId} target={target} onClose={close} />
  ) : (
    <BrainstormSheet key={target.swarmId} target={target} onClose={close} />
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <CBtn tone="strong" onClick={onClose}>
      Close
    </CBtn>
  );
}

function RunSheet({
  target,
  onClose,
}: {
  target: Extract<HistorySheetTarget, { kind: "run" }>;
  onClose: () => void;
}) {
  const cwd = useWorkspaces((s) => s.workspaces.find((w) => w.id === target.workspaceId)?.cwd ?? null);
  const workspacesLoaded = useWorkspaces((s) => s.workspaces.length > 0);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    agentRunGet(target.runId)
      .then((r) => live && setRun(r))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [target.runId]);

  return (
    <Sheet
      title={run ? run.agentName : "Run"}
      lede={missing ? undefined : "What the run wrote, and the changes it saved."}
      size="wide"
      onClose={onClose}
      actions={<CloseButton onClose={onClose} />}
    >
      {missing ? (
        <p className="ux-card-muted" role="status">
          {machineWords("This run's record isn't on this Mac any more: it may have been cleared, or it ran on another computer.")}
        </p>
      ) : workspacesLoaded && cwd == null ? (
        <p className="ux-card-muted" role="status">
          {machineWords("This run's project isn't on this Mac any more, so its output can't be shown here.")}
        </p>
      ) : run && cwd ? (
        <div className="history-item-run">
          <AgentRunView run={run} workspaceCwd={cwd} readOnly />
        </div>
      ) : (
        <p className="ux-card-muted">Opening the run…</p>
      )}
    </Sheet>
  );
}

const EMPTY_MAILBOX: MailboxEntry[] = [];

function BrainstormSheet({
  target,
  onClose,
}: {
  target: Extract<HistorySheetTarget, { kind: "brainstorm" }>;
  onClose: () => void;
}) {
  const { workspaceId: ws, swarmId } = target;
  const swarm = useSwarms((s) => s.byWorkspace[ws]?.swarms.find((x) => x.id === swarmId) ?? null);
  const mailbox = useSwarms((s) => s.byWorkspace[ws]?.mailboxes[swarmId] ?? EMPTY_MAILBOX);
  const cached = useSwarms((s) => !!s.byWorkspace[ws]?.mailboxes[swarmId]);

  useEffect(() => {
    if (!cached) void useSwarms.getState().loadMailbox(ws, swarmId);
  }, [cached, ws, swarmId]);
  useEffect(() => {
    if (!swarm) void useSwarms.getState().refreshSwarm(ws, swarmId);
  }, [swarm, ws, swarmId]);

  return (
    <Sheet
      title="Brainstorm"
      lede={swarm?.goal}
      size="wide"
      onClose={onClose}
      actions={<CloseButton onClose={onClose} />}
    >
      <div className="ux-card-outcome">
        {swarm && <RoleStatusStrip workspaceId={ws} swarm={swarm} mailbox={mailbox} readOnly />}
        <MailboxFeed entries={mailbox} workspaceId={ws} swarmId={swarmId} readOnly />
      </div>
    </Sheet>
  );
}
